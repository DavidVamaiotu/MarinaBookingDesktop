import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Preferences } from "@capacitor/preferences";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { marinaAvailabilityPeriod, marinaBookingDates, marinaBookingIsTrashed, marinaBookingPeriods, marinaBookingQueryRange, marinaBookingResourceId, marinaStayPeriod } from "../src/shared/mobile-api.js";
import { customerFromFormData } from "../src/shared/marina-customer.js";
import { MANUAL_DEPOSIT_FIELD, normalizeMarinaPayment } from "../src/shared/marina-payment.js";
import { normalizeMarinaQuote } from "../src/shared/marina-quote.js";
import * as BookingFields from "../src/shared/booking-fields.js";
import * as PricingNote from "../src/shared/pricing-note.js";
import * as MarinaConfig from "../src/shared/marina-config.js";
import * as MarinaOAuth from "../src/shared/marina-oauth.js";
import * as SagaWebApi from "../src/shared/saga-web-api.js";
import { orderMarinaResources } from "../src/shared/marina-resource-order.js";
import { parseReservationDeepLink } from "../src/shared/reservation-deep-link.js";
import * as MarinaOperationRegistry from "../src/shared/marina-operation-registry.js";
import * as MarinaSyncResponse from "../src/shared/marina-sync-response.js";
import * as MarinaConflictRecovery from "../src/shared/marina-conflict-recovery.js";

const marinaBuildConfig = MarinaConfig.createConfig({
  MARINA_INTEGRATION_ENABLED: typeof __MARINA_INTEGRATION_ENABLED__ === "undefined" ? "false" : __MARINA_INTEGRATION_ENABLED__,
  MARINA_API_BASE_URL: typeof __MARINA_API_BASE_URL__ === "undefined" ? "https://booking.husi.ro" : __MARINA_API_BASE_URL__,
  MARINA_OAUTH_CLIENT_ID: typeof __MARINA_OAUTH_CLIENT_ID__ === "undefined" ? "" : __MARINA_OAUTH_CLIENT_ID__,
  MARINA_OAUTH_SCOPES: typeof __MARINA_OAUTH_SCOPES__ === "undefined" ? "resources:read resources:write bookings:read bookings:write" : __MARINA_OAUTH_SCOPES__,
  MARINA_ROOMS_WORKSPACE_ID: typeof __MARINA_ROOMS_WORKSPACE_ID__ === "undefined" ? "" : __MARINA_ROOMS_WORKSPACE_ID__,
  MARINA_CAMPING_WORKSPACE_ID: typeof __MARINA_CAMPING_WORKSPACE_ID__ === "undefined" ? "" : __MARINA_CAMPING_WORKSPACE_ID__
});

const AutoUpdater = registerPlugin("AutoUpdater");

if (!window.marina) {
  const SOURCES = new Set(["rooms", "camping"]);
  const SETTINGS_KEY = "marina-mobile-settings-v1";
  const CACHE_KEY = "marina-mobile-cache-v1";
  const SAGA_INVOICE_SETTINGS_KEY = "marina-saga-invoice-settings-v1";
  const SAGA_WEB_TOKEN_KEY = "saga-web-api-token";
  const MARINA_REFRESH_TOKEN_KEY = "marina-oauth-refresh-token";
  // Matches src/main/marina-oauth-controller.js: only these OAuth rejections mean the
  // saved grant is definitively dead. Transient failures (offline, 5xx) must keep the
  // stored refresh token so the user is not forced back through interactive login.
  const TERMINAL_REFRESH_ERRORS = ["invalid_grant", "invalid_token", "invalid_client", "unauthorized_client"];
  const marinaMutationOperations = MarinaOperationRegistry.createOperationRegistry({ createKey: () => crypto.randomUUID() });
  const marinaRefreshInFlight = new Map();
  const marinaRefreshSequences = new Map([["rooms", 0], ["camping", 0]]);
  const marinaRanges = new Map();
  const callbacks = new Set();
  const reservationLinkCallbacks = new Set();
  const marinaNoteRequests = new Map();
  const marinaNoteOverrides = new Map();
  const marinaManualDepositOverrides = new Map();
  const sourceConnections = new Map();
  const jsonWrites = new Map();
  let secureTokenWrites = Promise.resolve();
  let marinaAuthGeneration = 0;
  const MOBILE_REFRESH_INTERVAL_MS = 5 * 60_000;
  const MOBILE_RECONNECT_INTERVAL_MS = 15_000;

  function assertWritableSource(source) {
    if (!SOURCES.has(source)) throw new TypeError("Sursa rezervărilor este invalidă.");
    if (!marinaBuildConfig.configured) throw Object.assign(new Error("Clientul OAuth public Marina nu este configurat în această versiune a aplicației."), { code: "marina_oauth_config_incomplete", permanent: true });
  }

  function assertReadableSource(source) {
    assertWritableSource(source);
  }

  App.addListener("backButton", ({ canGoBack }) => {
    const event = new Event("marina:back", { cancelable: true });
    if (!window.dispatchEvent(event)) return;
    if (canGoBack) window.history.back();
    else void App.exitApp();
  });
  const quoteCache = new Map();
  let currentSource = "rooms";
  let currentRange = null;
  let refreshTimer = null;
  let updateCheckStarted = false;
  let pendingReservationLink = null;
  let lastReservationLinkKey = "";
  let lastReservationLinkAt = 0;

  function checkForMobileUpdateOnce() {
    if (updateCheckStarted || !Capacitor.isNativePlatform()) return;
    updateCheckStarted = true;
    void AutoUpdater.checkAndInstall().catch((error) => console.error("Mobile update check failed:", error));
  }

  function connectionFor(source = currentSource) {
    return sourceConnections.get(source) || { online: false, authPaused: false, lastSuccessfulAt: 0 };
  }

  function rememberConnection(source, online, authPaused = false) {
    const previous = connectionFor(source);
    sourceConnections.set(source, {
      online,
      authPaused,
      lastSuccessfulAt: online && !authPaused ? Date.now() : previous.lastSuccessfulAt
    });
  }

  const emptyDiagnostics = (online = false, authPaused = false) => ({
    online,
    authPaused,
    queued: 0,
    sending: 0,
    failed: 0,
    conflicts: 0,
    lastSuccessfulSync: null
  });

  function marinaWorkspaceSettings(source) {
    return {
      provider: "marina",
      enabled: marinaBuildConfig.enabled,
      configured: marinaBuildConfig.configured,
      apiBaseUrl: marinaBuildConfig.apiBaseUrl,
      oauthClientConfigured: Boolean(marinaBuildConfig.clientId),
      oauthScopes: marinaBuildConfig.scopeString,
      workspaceId: marinaBuildConfig.workspaceIds[source],
      workspaceSlug: source,
      timezone: "Europe/Bucharest"
    };
  }
  const defaultSettings = () => ({
    rooms: marinaWorkspaceSettings("rooms"),
    camping: marinaWorkspaceSettings("camping")
  });
  function defaultSagaInvoiceSettings() {
    if (typeof window.SagaInvoice?.defaultSupplierSettings === "function") return window.SagaInvoice.defaultSupplierSettings();
    return { name: "Marina Park", cif: "", regCom: "", address: "", city: "", county: "", phone: "", email: "", iban: "", country: "RO", vatRate: "11" };
  }
  function normalizeSagaInvoiceSettings(value = {}) {
    if (typeof window.SagaInvoice?.normalizeSupplierSettings === "function") return window.SagaInvoice.normalizeSupplierSettings(value);
    const input = value && typeof value === "object" ? value : {};
    const pick = (...keys) => {
      for (const key of keys) {
        const candidate = String(input[key] ?? "").trim();
        if (candidate) return candidate;
      }
      return "";
    };
    return {
      name: pick("name", "supplierName", "companyName"),
      cif: pick("cif", "supplierCif", "companyCif"),
      regCom: pick("regCom", "reg_com", "supplierRegCom"),
      address: pick("address", "adresa", "supplierAddress"),
      city: pick("city", "localitate", "supplierCity"),
      county: pick("county", "judet", "supplierCounty"),
      phone: pick("phone", "telefon", "supplierPhone"),
      email: pick("email", "mail", "supplierEmail"),
      iban: pick("iban", "supplierIban"),
      country: pick("country", "tara") || "RO",
      vatRate: pick("vatRate", "vat_rate") || "11",
      sagaWebConfigured: input.sagaWebConfigured === true
    };
  }
  const marinaWorkspaceCache = (source) => ({ workspaceId: marinaBuildConfig.workspaceIds[source], workspaceSlug: source, resources: [], facilities: [], bookings: [], updatedAt: null, noteOverrides: {}, manualDepositOverrides: {} });
  const defaultCache = () => ({ rooms: marinaWorkspaceCache("rooms"), camping: marinaWorkspaceCache("camping") });

  async function readJson(key, fallback) {
    const { value } = await Preferences.get({ key });
    if (!value) return fallback();
    try { return { ...fallback(), ...JSON.parse(value) }; } catch { return fallback(); }
  }

  async function writeJson(key, value) {
    await Preferences.set({ key, value: JSON.stringify(value) });
  }

  function serializeSecureTokenWrite(operation) {
    const next = secureTokenWrites.catch(() => {}).then(operation);
    secureTokenWrites = next;
    return next.finally(() => { if (secureTokenWrites === next) secureTokenWrites = Promise.resolve(); });
  }

  async function readMarinaRefreshToken() {
    await secureTokenWrites.catch(() => {});
    return String(await SecureStorage.get(MARINA_REFRESH_TOKEN_KEY) || "");
  }

  function mutateJson(key, fallback, update) {
    const previous = jsonWrites.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const value = await readJson(key, fallback);
      const result = await update(value);
      await writeJson(key, value);
      return result;
    });
    jsonWrites.set(key, operation);
    return operation.finally(() => {
      if (jsonWrites.get(key) === operation) jsonWrites.delete(key);
    });
  }

  async function allSettings() {
    const defaults = defaultSettings();
    const stored = await readJson(SETTINGS_KEY, () => defaults);
    return MarinaConfig.mergeWorkspaceSettings(stored, defaults);
  }
  async function allCache() { return readJson(CACHE_KEY, defaultCache); }

  const marinaOverridesHydration = new Map();
  const marinaOverrideKey = (source, providerId) => `${source}:${providerId}`;
  async function ensureMarinaOverrides(source = currentSource) {
    const generation = marinaAuthGeneration;
    if (!marinaOverridesHydration.has(source)) {
      const hydration = (async () => {
      const cache = await allCache();
      if (generation !== marinaAuthGeneration) return;
      const marina = cache[source] || marinaWorkspaceCache(source);
      for (const [providerId, note] of Object.entries(marina.noteOverrides || {})) marinaNoteOverrides.set(marinaOverrideKey(source, providerId), String(note ?? "").trim());
      for (const [providerId, minor] of Object.entries(marina.manualDepositOverrides || {})) {
        const amount = Number(minor);
        if (Number.isInteger(amount) && amount >= 0) marinaManualDepositOverrides.set(marinaOverrideKey(source, providerId), amount);
      }
      })();
      marinaOverridesHydration.set(source, hydration);
    }
    await marinaOverridesHydration.get(source);
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
  }

  function storeMarinaOverrides(cache, source = currentSource) {
    cache[source] = { ...marinaWorkspaceCache(source), ...(cache[source] || {}) };
    cache[source].noteOverrides = Object.fromEntries([...marinaNoteOverrides]
      .filter(([key]) => key.startsWith(`${source}:`))
      .map(([key, value]) => [key.slice(source.length + 1), value]));
    cache[source].manualDepositOverrides = Object.fromEntries([...marinaManualDepositOverrides]
      .filter(([key]) => key.startsWith(`${source}:`))
      .map(([key, value]) => [key.slice(source.length + 1), value]));
  }

  async function persistMarinaOverrides(source = currentSource) {
    await mutateJson(CACHE_KEY, defaultCache, (cache) => { storeMarinaOverrides(cache, source); });
  }

  let marinaMetadata = null;
  let marinaPending = null;
  let marinaAccessToken = "";
  let marinaAccessExpiresAt = 0;
  let marinaRefreshTokenKnown = null;
  let marinaEffectiveScopes = [...marinaBuildConfig.scopes];
  let marinaRefreshPromise = null;
  const marinaWorkspaceIds = new Map();
  marinaWorkspaceIds.set("rooms", marinaBuildConfig.workspaceIds.rooms);
  marinaWorkspaceIds.set("camping", marinaBuildConfig.workspaceIds.camping);
  const marinaWorkspaceResolutions = new Map();

  function mobilePayload(response) {
    if (response?.data && typeof response.data === "object") return response.data;
    try { return JSON.parse(String(response?.data || "{}")); } catch { return {}; }
  }

  async function hasMarinaRefreshToken() {
    if (marinaRefreshTokenKnown !== null) return marinaRefreshTokenKnown;
    marinaRefreshTokenKnown = Boolean(await readMarinaRefreshToken());
    return marinaRefreshTokenKnown;
  }

  function marinaProblemMessage(payload, status) {
    const details = [payload?.detail, payload?.message, payload?.title]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
    if (Array.isArray(payload?.errors)) {
      for (const error of payload.errors) {
        const value = error?.detail ?? error?.message ?? error;
        if (typeof value === "string" && value.trim()) details.push(value.trim());
      }
    } else if (payload?.errors && typeof payload.errors === "object") {
      for (const [field, value] of Object.entries(payload.errors)) {
        const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
        if (text.trim()) details.push(`${field}: ${text.trim()}`);
      }
    }
    const unique = details.filter((value, index) => details.indexOf(value) === index);
    return unique.length ? `Eroare Marina: ${unique.join("; ").slice(0, 450)}` : `API-ul Marina a returnat HTTP ${status}.`;
  }

  async function marinaDiscover() {
    if (marinaMetadata) return marinaMetadata;
    const response = await CapacitorHttp.get({ url: `${marinaBuildConfig.apiBaseUrl}/.well-known/oauth-authorization-server`, headers: { Accept: "application/json" }, connectTimeout: 15000, readTimeout: 15000 });
    const payload = mobilePayload(response);
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error("Descoperirea OAuth Marina a eșuat."), { code: "marina_oauth_discovery_failed", status: response.status });
    const endpoint = (value, fallback) => {
      let url;
      let baseOrigin;
      try {
        url = new URL(value || fallback, `${marinaBuildConfig.apiBaseUrl}/`);
        baseOrigin = new URL(marinaBuildConfig.apiBaseUrl).origin;
      } catch {
        throw Object.assign(new Error("Metadatele OAuth Marina conțin un endpoint invalid."), { code: "marina_oauth_metadata_invalid" });
      }
      if (url.protocol !== "https:" || url.origin !== baseOrigin) throw Object.assign(new Error("Metadatele OAuth Marina conțin un endpoint invalid."), { code: "marina_oauth_metadata_invalid" });
      return url.toString();
    };
    marinaMetadata = {
      authorizationEndpoint: endpoint(payload.authorization_endpoint, "/oauth/authorize"),
      tokenEndpoint: endpoint(payload.token_endpoint, "/oauth/token"),
      revocationEndpoint: endpoint(payload.revocation_endpoint, "/oauth/revoke")
    };
    return marinaMetadata;
  }

  function marinaSessionSuperseded() {
    return Object.assign(new Error("Sesiunea Marina s-a schimbat."), { code: "marina_session_superseded", temporary: true });
  }

  function assertMarinaSession(generation) {
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
  }

  async function marinaTokenRequest(values, generation = marinaAuthGeneration) {
    const metadata = await marinaDiscover();
    const response = await CapacitorHttp.post({
      url: metadata.tokenEndpoint,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      data: MarinaOAuth.formBody(values),
      connectTimeout: 15000,
      readTimeout: 15000
    });
    const payload = mobilePayload(response);
    if (response.status < 200 || response.status >= 300 || !payload.access_token) throw Object.assign(new Error(payload.error_description || "Schimbul tokenului OAuth Marina a eșuat."), { code: payload.error || "marina_oauth_token_failed", auth: true, status: response.status });
    const accessToken = String(payload.access_token);
    const expiresAt = Date.now() + Math.max(0, Number(payload.expires_in) || 0) * 1000;
    const effectiveScopes = payload.scope ? MarinaConfig.normalizeScopes(payload.scope) : marinaEffectiveScopes;
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
    if (payload.refresh_token) {
      await serializeSecureTokenWrite(() => SecureStorage.set(MARINA_REFRESH_TOKEN_KEY, String(payload.refresh_token)));
    }
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
    marinaAccessToken = accessToken;
    marinaAccessExpiresAt = expiresAt;
    marinaEffectiveScopes = effectiveScopes;
    if (payload.refresh_token) marinaRefreshTokenKnown = true;
    return marinaAccessToken;
  }

  async function marinaRefreshAccessToken() {
    if (marinaRefreshPromise) return marinaRefreshPromise;
    const generation = marinaAuthGeneration;
    const refreshPromise = (async () => {
      const refreshToken = await readMarinaRefreshToken();
      marinaRefreshTokenKnown = Boolean(refreshToken);
      if (!refreshToken) throw Object.assign(new Error("Conectarea Marina este necesară."), { code: "marina_reconnect_required", auth: true, permanent: true });
      try { return await marinaTokenRequest({ grant_type: "refresh_token", client_id: marinaBuildConfig.clientId, refresh_token: refreshToken }, generation); }
      catch (error) {
        if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
        marinaAccessToken = "";
        marinaAccessExpiresAt = 0;
        // Mirror the desktop controller: a temporary outage must not erase the saved
        // grant and force another interactive login.
        if (TERMINAL_REFRESH_ERRORS.includes(error?.code) || error?.status === 401) {
          await serializeSecureTokenWrite(() => SecureStorage.remove(MARINA_REFRESH_TOKEN_KEY));
          marinaRefreshTokenKnown = false;
        }
        throw error;
      }
    })();
    marinaRefreshPromise = refreshPromise;
    try { return await refreshPromise; } finally { if (marinaRefreshPromise === refreshPromise) marinaRefreshPromise = null; }
  }

  async function marinaBearer() {
    if (marinaAccessToken && marinaAccessExpiresAt > Date.now() + 60000) return marinaAccessToken;
    return marinaRefreshAccessToken();
  }

  async function resolveMarinaWorkspaceId(source) {
    const configured = marinaWorkspaceIds.get(source);
    if (configured !== null && configured !== undefined) return configured;
    if (!marinaWorkspaceResolutions.has(source)) {
      const generation = marinaAuthGeneration;
      const resolution = (async () => {
      const payload = await marinaRequest("/v1/workspaces", { source, workspaceScoped: false });
      const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.workspaces) ? payload.workspaces : [];
      const active = rows.filter((workspace) => workspace?.active !== false);
      let selected = active.find((workspace) => String(workspace?.slug || "").trim().toLowerCase() === source);
      if (!selected && source === "rooms") {
        selected = active.find((workspace) => ["camere", "default"].includes(String(workspace?.slug || "").trim().toLowerCase()))
          || active.find((workspace) => workspace?.is_default === true);
      }
      const id = MarinaConfig.normalizeWorkspaceId(selected?.id);
      if (id === null) throw Object.assign(new Error(`Workspace-ul Marina „${source}” nu este accesibil.`), { code: "marina_workspace_missing", permanent: true });
      if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
      marinaWorkspaceIds.set(source, id);
      return id;
      })();
      marinaWorkspaceResolutions.set(source, resolution);
      resolution.catch(() => { if (marinaWorkspaceResolutions.get(source) === resolution) marinaWorkspaceResolutions.delete(source); });
    }
    return marinaWorkspaceResolutions.get(source);
  }

  async function marinaRequest(path, { method = "GET", body, retry = true, headers = {}, source = currentSource, workspaceScoped = true, generation = marinaAuthGeneration } = {}) {
    const workspaceId = workspaceScoped ? await resolveMarinaWorkspaceId(source) : null;
    const token = await marinaBearer();
    const response = await CapacitorHttp.request({
      url: `${marinaBuildConfig.apiBaseUrl}${path}`,
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
        ...(workspaceId === null ? {} : { "X-Workspace-ID": String(workspaceId) })
      },
      data: body,
      connectTimeout: 15000,
      readTimeout: 15000
    });
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
    if (response.status === 401 && retry) { await marinaRefreshAccessToken(); return marinaRequest(path, { method, body, retry: false, headers, source, workspaceScoped, generation }); }
    const payload = mobilePayload(response);
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(marinaProblemMessage(payload, response.status)), { code: payload.code || `marina_http_${response.status}`, status: response.status, auth: response.status === 401 || response.status === 403, conflict: response.status === 409 });
    return payload;
  }

  async function connectMarina() {
    if (!marinaBuildConfig.configured) throw Object.assign(new Error("Clientul OAuth public Marina nu este configurat."), { code: "marina_oauth_config_incomplete", permanent: true });
    const metadata = await marinaDiscover();
    const pair = await MarinaOAuth.createPkcePair();
    const state = MarinaOAuth.createState();
    marinaPending = { codeVerifier: pair.codeVerifier, state, generation: marinaAuthGeneration };
    const url = MarinaOAuth.buildAuthorizationUrl({ authorizationEndpoint: metadata.authorizationEndpoint, clientId: marinaBuildConfig.clientId, redirectUri: marinaBuildConfig.redirectUris.mobile, scopes: marinaBuildConfig.scopes, state, codeChallenge: pair.codeChallenge });
    await Browser.open({ url });
    return configuredState(false, true, currentSource);
  }

  async function acceptMarinaCallback(url) {
    if (!marinaPending) return;
    const callback = MarinaOAuth.parseCallbackUrl(url, { protocol: "ro.marinapark.booking.mobile:", pathname: "/callback" });
    MarinaOAuth.validateState(marinaPending.state, callback.state);
    const verifier = marinaPending.codeVerifier;
    const generation = marinaPending.generation;
    marinaPending = null;
    await marinaTokenRequest({ grant_type: "authorization_code", client_id: marinaBuildConfig.clientId, code: callback.code, redirect_uri: marinaBuildConfig.redirectUris.mobile, code_verifier: verifier }, generation);
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
    await Browser.close();
    for (const source of SOURCES) rememberConnection(source, true, false);
    if (currentRange) emit(await refresh(currentRange));
  }

  async function disconnectMarina() {
    const generation = ++marinaAuthGeneration;
    marinaAccessToken = "";
    marinaAccessExpiresAt = 0;
    marinaPending = null;
    marinaRefreshTokenKnown = false;
    marinaMutationOperations.clear();
    for (const source of SOURCES) marinaRefreshSequences.set(source, (marinaRefreshSequences.get(source) || 0) + 1);
    const refreshToken = await readMarinaRefreshToken();
    let revocationError = null;
    try {
      if (refreshToken) {
        const metadata = await marinaDiscover();
        const response = await CapacitorHttp.post({ url: metadata.revocationEndpoint, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, data: MarinaOAuth.formBody({ token: refreshToken, token_type_hint: "refresh_token", client_id: marinaBuildConfig.clientId }) });
        if (response.status < 200 || response.status >= 300) {
          const payload = mobilePayload(response);
          throw Object.assign(new Error("Contul a fost șters local, dar revocarea pe serverul Marina nu a fost confirmată."), { code: payload?.error || "marina_revocation_failed", status: response.status, temporary: response.status >= 500 });
        }
      }
    } catch (error) {
      revocationError = error;
    } finally {
      await serializeSecureTokenWrite(() => SecureStorage.remove(MARINA_REFRESH_TOKEN_KEY));
      marinaRefreshTokenKnown = false;
      marinaNoteOverrides.clear();
      marinaManualDepositOverrides.clear();
      marinaOverridesHydration.clear();
      marinaWorkspaceResolutions.clear();
      marinaNoteRequests.clear();
      quoteCache.clear();
      marinaMetadata = null;
      marinaWorkspaceIds.set("rooms", marinaBuildConfig.workspaceIds.rooms);
      marinaWorkspaceIds.set("camping", marinaBuildConfig.workspaceIds.camping);
      await mutateJson(CACHE_KEY, defaultCache, (cache) => {
        const cleared = defaultCache();
        cache.rooms = cleared.rooms;
        cache.camping = cleared.camping;
      });
      for (const source of SOURCES) rememberConnection(source, false, true);
    }
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
    let next = await configuredState(false, true, currentSource, marinaRanges.get(currentSource) || currentRange);
    if (revocationError) next = {
      ...next,
      settings: { ...next.settings, revocationUnconfirmed: true, revocationErrorCode: revocationError.code || "marina_revocation_failed" }
    };
    emit(next);
    return next;
  }

  function deliverReservationLink(link) {
    const key = `${link.source}:${link.bookingId}`;
    const now = Date.now();
    if (key === lastReservationLinkKey && now - lastReservationLinkAt < 5000) return;
    lastReservationLinkKey = key;
    lastReservationLinkAt = now;
    pendingReservationLink = link;
    for (const callback of reservationLinkCallbacks) callback(link);
  }

  function handleAppUrl(url) {
    const reservationLink = parseReservationDeepLink(url);
    if (reservationLink) {
      deliverReservationLink(reservationLink);
      return;
    }
    if (!String(url || "").startsWith("ro.marinapark.booking.mobile://oauth/callback")) return;
    void acceptMarinaCallback(url).catch((error) => {
      marinaPending = null;
      console.error("Marina OAuth callback failed:", error.code || error.message);
    });
  }

  App.addListener("appUrlOpen", ({ url }) => handleAppUrl(url));
  void App.getLaunchUrl().then((result) => {
    if (result?.url) handleAppUrl(result.url);
  }).catch((error) => console.error("Mobile launch URL could not be read:", error));

  function stateFrom(cache, settings, online = false, authPaused = false, source = currentSource, range = marinaRanges.get(source) || currentRange) {
    const sourceCache = cache[source] || defaultCache()[source];
    const sourceSettings = settings[source] || defaultSettings()[source];
    return {
      resources: sourceCache.resources || [],
      facilities: sourceCache.facilities || [],
      bookings: sourceCache.bookings || [],
      commands: [],
      diagnostics: {
        ...emptyDiagnostics(online, authPaused),
        lastSuccessfulSync: sourceCache.updatedAt || null
      },
      settings: sourceSettings,
      range: range ? { ...range } : null,
      source
    };
  }

  async function configuredState(online = false, authPaused = false, source = currentSource, range = marinaRanges.get(source) || currentRange) {
    const [settings, cache] = await Promise.all([allSettings(), allCache()]);
    const result = stateFrom(cache, settings, online, authPaused, source, range);
    const connected = Boolean(marinaAccessToken || await hasMarinaRefreshToken());
    const capabilities = MarinaConfig.capabilities(marinaEffectiveScopes);
    result.settings = {
      ...result.settings,
      workspaceId: marinaWorkspaceIds.get(source) ?? result.settings.workspaceId,
      connected,
      connecting: Boolean(marinaPending),
      credentialsConfigured: connected,
      oauthScopes: marinaEffectiveScopes.join(" "),
      capabilities,
      connectionStatus: connected ? "connected" : marinaPending ? "connecting" : marinaBuildConfig.configured ? "disconnected" : "disabled"
    };
    result.diagnostics.authPaused = !connected;
    return result;
  }

  function emit(state) { for (const callback of callbacks) callback(state); }

  function marinaFieldValue(field) {
    if (Array.isArray(field)) return field.map(marinaFieldValue).filter(Boolean).join(", ");
    if (field && typeof field === "object") {
      const key = ["value", "field_value", "raw_value", "val", "values"].find((candidate) => Object.prototype.hasOwnProperty.call(field, candidate));
      return key ? marinaFieldValue(field[key]) : "";
    }
    return field ?? "";
  }

  function marinaFormData(booking, customer, guests) {
    const formData = {};
    const add = (name, value, type = "text") => {
      const text = String(marinaFieldValue(value) ?? "");
      if (text !== "") formData[name] = { value: text, type };
    };
    for (const [name, value] of Object.entries(booking.form_data || booking.formData || {})) add(name, value?.value ?? value, value?.type || "text");
    for (const [name, value] of Object.entries(customer.custom_fields || {})) add(name, value, value?.type || "text");
    for (const [name, value] of Object.entries(customer.address || {})) add(`address_${name}`, value);
    for (const [name, value] of Object.entries(booking.custom_fields || {})) {
      if (name !== "migration" && name !== MANUAL_DEPOSIT_FIELD) add(name, value, value?.type || "text");
    }
    add("name", customer.first_name ?? customer.firstName ?? booking.name ?? "");
    add("secondname", customer.last_name ?? customer.lastName ?? "");
    add("email", customer.email ?? booking.email ?? "", "email");
    add("phone", customer.phone ?? booking.phone ?? "");
    add("visitors", guests.adults ?? booking.adults ?? 1, "selectbox-one");
    add("children", guests.children ?? booking.children ?? 0, "selectbox-one");
    return formData;
  }

  function marinaUiId(value) {
    let hash = 2166136261;
    for (const char of `marina:${value}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 1) || 1;
  }

  function normalizeMarinaResource(resource) {
    const providerId = String(resource?.id ?? resource?.resource_id ?? "").trim();
    if (!providerId) throw MarinaSyncResponse.invalidResponse("resurse");
    return {
      id: marinaUiId(providerId),
      provider: "marina",
      providerId,
      title: String(resource.title || resource.name || `Marina ${providerId}`),
      capacity: Number(resource.capacity) || null,
      capacityMode: String(resource.capacity_mode ?? resource.capacityMode ?? "exclusive"),
      capacityUnitMode: String(resource.capacity_unit_mode ?? resource.capacityUnitMode ?? "per_booking"),
      defaultForm: "marina",
      bookingMode: String(resource.booking_mode ?? resource.bookingMode ?? "date_range"),
      active: resource.active !== false,
      settings: resource.settings && typeof resource.settings === "object" ? { ...resource.settings } : {},
      version: resource.version ?? null
    };
  }

  function normalizeMarinaFacilityIds(values) {
    const ids = [...new Set((Array.isArray(values) ? values : []).map(Number))].sort((a, b) => a - b);
    if (ids.length > 64 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw Object.assign(new Error("Selecția facilităților Marina este invalidă."), { code: "marina_facility_ids_invalid", permanent: true });
    return ids;
  }

  function normalizeMarinaFacility(facility) {
    const id = Number(facility?.id);
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error("API-ul Marina a returnat o facilitate invalidă."), { code: "marina_invalid_response", permanent: true });
    const priceMinor = Number(facility.price_per_night_minor ?? facility.pricePerNightMinor);
    return {
      id,
      name: String(facility.name || "").trim(),
      currency: String(facility.currency || "RON"),
      billingPeriod: String(facility.billing_period ?? facility.billingPeriod ?? "night"),
      pricePerNightMinor: Number.isSafeInteger(priceMinor) && priceMinor >= 0 ? priceMinor : 0,
      appliesToAllResources: facility.applies_to_all_resources === true || facility.appliesToAllResources === true,
      resourceIds: (facility.resource_ids ?? facility.resourceIds ?? []).map(String),
      active: facility.active !== false,
      version: facility.version ?? null
    };
  }

  function marinaFacilitySnapshots(booking) {
    if (Array.isArray(booking?.facilities)) return booking.facilities.map((facility) => ({ id: Number(facility.id ?? facility.facility_id), name: String(facility.name || ""), currency: String(facility.currency || "RON"), billingPeriod: String(facility.billing_period ?? facility.billingPeriod ?? "night"), pricePerNightMinor: Number(facility.price_per_night_minor ?? facility.pricePerNightMinor) || 0 })).filter((facility) => Number.isSafeInteger(facility.id) && facility.id > 0);
    return normalizeMarinaFacilityIds(booking?.facility_ids).map((id) => ({ id }));
  }

  function normalizeMarinaBookingRecord(booking, resources) {
    const periods = marinaBookingPeriods(booking);
    const providerId = String(booking.id ?? booking.booking_id ?? booking.bookingId ?? booking?.booking?.id ?? booking?.booking?.booking_id ?? "").trim();
    if (!providerId) throw Object.assign(new Error("API-ul Marina a returnat o rezervare fără identificator."), { code: "marina_invalid_response", permanent: true });
    const providerResourceId = marinaBookingResourceId(booking, periods);
    const resource = resources.find((item) => item.providerId === providerResourceId);
    const dates = marinaBookingDates(booking, resource);
    const customer = booking.customer || booking.guest || {};
    const guests = booking.guests || {};
    const status = String(booking.status || "pending").toLowerCase();
    const facilities = marinaFacilitySnapshots(booking);
    return {
      localId: `marina:${providerId}`,
      serverId: providerId,
      provider: "marina",
      providerId,
      providerResourceId,
      resourceId: marinaUiId(providerResourceId),
      status: ["approved", "confirmed", "active", "completed"].includes(status) ? "approved" : "pending",
      providerStatus: status,
      trashed: marinaBookingIsTrashed(booking),
      note: marinaNoteText(booking),
      price: booking.price && typeof booking.price === "object" ? { ...booking.price } : null,
      facilities,
      facilityIds: facilities.map((facility) => facility.id),
      formData: marinaFormData(booking, customer, guests),
      dates,
      syncState: "synced",
      version: booking.version ?? booking.etag ?? null,
      serverUpdatedAt: booking.updated_at ?? booking.updatedAt ?? null
    };
  }

  function marinaNoteBodies(payload) {
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.notes)
        ? payload.data.notes
        : Array.isArray(payload?.notes)
          ? payload.notes
          : Array.isArray(payload)
            ? payload
            : [];
    return rows.map((note) => String(note?.body ?? note?.note ?? note?.text ?? "").trim()).filter(Boolean);
  }

  function marinaJoinNoteValues(values) {
    const seen = new Set();
    const rows = [];
    for (const value of values) {
      const text = String(value || "").trim();
      if (!text) continue;
      const key = text.replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(text);
    }
    return rows.join("\n\n");
  }

  function marinaNoteText(booking) {
    const hasInternalNote = Object.prototype.hasOwnProperty.call(booking || {}, "internal_note");
    const primaryNote = String(booking?.note || "").trim();
    return PricingNote.normalize(marinaJoinNoteValues(hasInternalNote ? [booking?.internal_note] : primaryNote ? [primaryNote] : marinaNoteBodies(booking)));
  }

  function fetchMarinaNotes(providerId, source = currentSource) {
    const key = marinaOverrideKey(source, providerId);
    const existing = marinaNoteRequests.get(key);
    if (existing) return existing;
    const request = marinaRequest(`/v1/bookings/${encodeURIComponent(providerId)}/notes`, { source })
      .then((payload) => marinaNoteBodies(payload))
      .finally(() => {
        if (marinaNoteRequests.get(key) === request) marinaNoteRequests.delete(key);
      });
    marinaNoteRequests.set(key, request);
    return request;
  }

  async function refresh(range, { force = false } = {}) {
    return refreshFor(currentSource, range, { force });
  }

  async function refreshFor(source, range, { force = false } = {}) {
    const capturedRange = { ...range };
    currentRange = capturedRange;
    marinaRanges.set(source, capturedRange);
    const generation = marinaAuthGeneration;
    const key = JSON.stringify([source, capturedRange.start, capturedRange.end, generation]);
    if (!force && marinaRefreshInFlight.has(key)) return marinaRefreshInFlight.get(key);
    const sequence = (marinaRefreshSequences.get(source) || 0) + 1;
    marinaRefreshSequences.set(source, sequence);
    const request = refreshOnce({ source, range: capturedRange, generation, sequence });
    marinaRefreshInFlight.set(key, request);
    try { return await request; }
    finally { if (marinaRefreshInFlight.get(key) === request) marinaRefreshInFlight.delete(key); }
  }

  async function refreshOnce({ source, range, generation, sequence }) {
    const isCurrent = () => generation === marinaAuthGeneration && sequence === marinaRefreshSequences.get(source);
    const superseded = () => Object.assign(new Error("Sincronizarea Marina a fost înlocuită de o cerere mai nouă."), { code: "marina_refresh_superseded", temporary: true });
    await ensureMarinaOverrides(source);
    if (!isCurrent()) throw superseded();
    const connected = Boolean(marinaAccessToken || await hasMarinaRefreshToken());
    if (!connected) return configuredState(false, true, source, range);
    try {
      if (!MarinaConfig.capabilities(marinaEffectiveScopes).resourcesRead) return configuredState(true, false, source, range);
      const resourcePayload = await marinaRequest("/v1/resources", { source });
      const resourceRows = MarinaSyncResponse.collection(resourcePayload, ["resources"], "resurse");
      const resources = orderMarinaResources(resourceRows.map(normalizeMarinaResource).map((item) => MarinaSyncResponse.validateRecord(item, "resurse")), { ignoreLegacy32: source !== "camping" });
      const facilityPayload = await marinaRequest("/v1/facilities", { source });
      const facilityRows = MarinaSyncResponse.collection(facilityPayload, ["facilities"], "facilități");
      const facilities = facilityRows.map(normalizeMarinaFacility).map((item) => MarinaSyncResponse.validateRecord(item, "facilități"));
      const bookings = [];
      const clearedOverrideKeys = [];
      let cursor = "";
      if (MarinaConfig.capabilities(marinaEffectiveScopes).bookingsRead) {
        const previousBookings = new Map((((await allCache())[source]?.bookings) || []).map((booking) => [booking.providerId, booking]));
        const seenCursors = new Set();
        let restartedInvalidCursor = false;
        let pages = 0;
        for (;;) {
          const params = new URLSearchParams({ ...marinaBookingQueryRange(range), limit: "200" });
          if (cursor) params.set("cursor", cursor);
          let payload;
          try {
            payload = await marinaRequest(`/v1/bookings?${params}`, { source });
          } catch (error) {
            if (cursor && error?.code === "invalid_cursor" && !restartedInvalidCursor) {
              bookings.length = 0;
              clearedOverrideKeys.length = 0;
              cursor = "";
              seenCursors.clear();
              pages = 0;
              restartedInvalidCursor = true;
              continue;
            }
            throw error;
          }
          const rows = MarinaSyncResponse.collection(payload, ["bookings"], "rezervări");
          for (const booking of rows) {
            const normalized = MarinaSyncResponse.validateRecord(normalizeMarinaBookingRecord(booking, resources), "rezervări");
            const previous = previousBookings.get(normalized.providerId);
            const overrideKey = marinaOverrideKey(source, normalized.providerId);
            if (marinaNoteOverrides.has(overrideKey)) {
              const override = marinaNoteOverrides.get(overrideKey);
              const responseHasNote = Object.prototype.hasOwnProperty.call(booking || {}, "internal_note") || Object.prototype.hasOwnProperty.call(booking || {}, "note");
              if (responseHasNote && normalized.note === override) clearedOverrideKeys.push([overrideKey, override]);
              else normalized.note = override;
            } else if (!normalized.note && previous?.note) normalized.note = previous.note;
            bookings.push(normalized);
          }
          if (typeof payload?.has_more !== "boolean") throw Object.assign(new Error("Răspunsul Marina nu conține starea paginării rezervărilor."), { code: "marina_invalid_response", temporary: true });
          if (!payload.has_more) break;
          const nextCursor = payload?.next_cursor;
          if (typeof nextCursor !== "string" || !nextCursor || seenCursors.has(nextCursor)) throw Object.assign(new Error("Răspunsul Marina conține o continuare de paginare invalidă."), { code: "marina_invalid_response", temporary: true });
          seenCursors.add(nextCursor);
          cursor = nextCursor;
          if (++pages > 50) throw Object.assign(new Error("Sincronizarea Marina a întâlnit prea multe pagini de rezervări."), { code: "marina_sync_page_limit", temporary: true });
        }
      }
      if (!isCurrent()) throw superseded();
      await mutateJson(CACHE_KEY, defaultCache, (cache) => {
        if (!isCurrent()) throw superseded();
        cache[source] = { ...marinaWorkspaceCache(source), resources, facilities, bookings, updatedAt: new Date().toISOString() };
        for (const [key, expected] of clearedOverrideKeys) if (marinaNoteOverrides.get(key) === expected) marinaNoteOverrides.delete(key);
        storeMarinaOverrides(cache, source);
      });
      if (!isCurrent()) throw superseded();
      rememberConnection(source, true, false);
      const next = await configuredState(true, false, source, range);
      if (currentSource === source && isCurrent()) emit(next);
      return next;
    } catch (error) {
      if (error?.code === "marina_refresh_superseded" || !isCurrent()) throw superseded();
      rememberConnection(source, Boolean(error.auth), Boolean(error.auth));
      const cached = await configuredState(Boolean(error.auth), Boolean(error.auth), source, range);
      if (currentSource === source) emit(cached);
      throw error;
    }
  }

  async function refreshIfConfigured({ force = false } = {}) {
    const source = currentSource;
    const range = marinaRanges.get(source) || currentRange;
    if (!range) return;
    const connection = connectionFor(source);
    if (!force && connection.online && Date.now() - connection.lastSuccessfulAt < MOBILE_REFRESH_INTERVAL_MS) return;
    if (!marinaBuildConfig.configured || !await hasMarinaRefreshToken()) return;
    try { await refreshFor(source, { ...range }, { force }); } catch {}
  }

  function startRefreshTimer() {
    if (refreshTimer) return;
    refreshTimer = window.setInterval(() => { void refreshIfConfigured(); }, MOBILE_RECONNECT_INTERVAL_MS);
  }

  function stopRefreshTimer() {
    if (!refreshTimer) return;
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }

  async function marinaCachedBooking(localId, source = currentSource) { return ((await allCache())[source]?.bookings || []).find((booking) => booking.localId === String(localId)); }
  function marinaBookingSnapshot(booking) {
    const period = marinaStayPeriod(booking.dates);
    return {
      id: booking.providerId,
      resource_id: Number(booking.providerResourceId),
      status: booking.providerStatus || booking.status,
      periods: period ? [{ ...period, units: 1 }] : [],
      customer: customerFromFormData(booking.formData),
      guests: {
        adults: Number(booking.formData?.visitors?.value) || 1,
        children: Number(booking.formData?.children?.value) || 0
      },
      internal_note: booking.note || "",
      facilities: booking.facilities || [],
      facility_ids: normalizeMarinaFacilityIds(booking.facilityIds),
      ...(booking.price ? { price: booking.price } : {}),
      version: booking.version
    };
  }
  async function storeMarinaMutationBooking(rawBooking, options = {}, source = currentSource, generation = marinaAuthGeneration) {
    await ensureMarinaOverrides(source);
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
    const cache = await allCache();
    const normalized = normalizeMarinaBookingRecord(rawBooking, cache[source].resources);
    const overrideKey = marinaOverrideKey(source, normalized.providerId);
    if (Object.prototype.hasOwnProperty.call(options, "noteOverride")) {
      const noteOverride = String(options.noteOverride ?? "").trim();
      marinaNoteOverrides.set(overrideKey, noteOverride);
      normalized.note = noteOverride;
    }
    if (Object.prototype.hasOwnProperty.call(options, "manualDepositMinor")) {
      const minor = Number(options.manualDepositMinor);
      if (Number.isInteger(minor) && minor >= 0) marinaManualDepositOverrides.set(overrideKey, minor);
    }
    await mutateJson(CACHE_KEY, defaultCache, (nextCache) => {
      if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
      const bookings = nextCache[source].bookings || [];
      const index = bookings.findIndex((booking) => booking.localId === normalized.localId);
      if (index === -1) bookings.push(normalized);
      else bookings[index] = normalized;
      nextCache[source].bookings = bookings;
      nextCache[source].updatedAt = new Date().toISOString();
      storeMarinaOverrides(nextCache, source);
    });
    if (generation !== marinaAuthGeneration) throw marinaSessionSuperseded();
    if (currentSource === source) emit(await configuredState(true, false, source));
    return normalized;
  }
  function scheduleMarinaRefresh(source = currentSource) {
    const range = marinaRanges.get(source) || currentRange;
    if (!range) return;
    const pending = [...marinaRefreshInFlight.entries()].filter(([key]) => JSON.parse(key)[0] === source).map(([, promise]) => promise);
    void Promise.allSettled(pending).then(() => refreshFor(source, { ...range }, { force: true })).catch(() => {});
  }
  async function marinaProviderResourceId(resourceId, source = currentSource) {
    const resource = ((await allCache())[source]?.resources || []).find((item) => Number(item.id) === Number(resourceId));
    if (!resource) throw Object.assign(new Error("Resursa Marina nu mai este disponibilă."), { code: "marina_resource_missing", permanent: true });
    const providerId = Number(resource.providerId);
    if (!Number.isSafeInteger(providerId) || providerId < 1) throw Object.assign(new Error("Identificatorul resursei Marina este invalid."), { code: "marina_resource_id_invalid", permanent: true });
    return providerId;
  }
  async function marinaMutation(path, body, { method = "POST", version, idempotencyKey, source = currentSource } = {}) {
    const versionedBody = version !== undefined && version !== null && (method === "PATCH" || path.endsWith("/status"))
      ? { ...body, expected_version: Number(version) }
      : body;
    let result;
    try {
      const execute = (key, preparedBody) => marinaRequest(path, {
        method,
        body: preparedBody,
        headers: {
          "Idempotency-Key": key,
          ...(version !== undefined && version !== null ? { "If-Match": String(version) } : {})
        },
        source
      });
      if (idempotencyKey) result = await execute(idempotencyKey, versionedBody);
      else {
        const scope = MarinaOperationRegistry.operationScope("mutation", source, { method, path, version: version ?? null, body: versionedBody }, []);
        result = await marinaMutationOperations.run(scope, () => structuredClone(versionedBody), (preparedBody, key) => execute(key, preparedBody));
      }
    } catch (error) {
      if (error?.status === 412) {
        const match = String(path).match(/\/bookings\/([^/]+)/);
        const bookingId = match ? decodeURIComponent(match[1]) : "";
        let recovered = false;
        if (bookingId) {
          recovered = await MarinaConflictRecovery.recoverBooking({
            bookingId,
            fetchBooking: (id) => marinaRequest(`/v1/bookings/${encodeURIComponent(id)}`, { source }),
            storeBooking: (record) => storeMarinaMutationBooking(record, {}, source)
          });
        }
        const message = recovered
          ? "Rezervarea Marina s-a schimbat între timp. Datele actualizate au fost încărcate; verificați din nou valorile înainte de salvare."
          : "Rezervarea Marina s-a schimbat între timp, dar cele mai noi date nu au putut fi încărcate. Datele existente au fost păstrate; reîncarcă înainte de salvare.";
        throw Object.assign(new Error(message), error, { code: "marina_stale_version", conflict: true, permanent: true, recoveryFailed: !recovered });
      }
      throw error;
    }
    return result?.data?.booking || result?.data || result?.booking || result;
  }
  async function marinaQuoteBody(input, source = currentSource) {
    const period = marinaStayPeriod(input.dates);
    if (!period) throw Object.assign(new Error("Cotația Marina necesită cel puțin o dată."), { code: "marina_quote_dates_missing", permanent: true });
    return {
      resource_id: await marinaProviderResourceId(input.resourceId, source),
      periods: [{ ...period, units: 1 }],
      guests: {
        adults: Number(input.formData?.visitors?.value) || 1,
        children: Number(input.formData?.children?.value) || 0
      },
      facility_ids: normalizeMarinaFacilityIds(input.facilityIds)
    };
  }
  async function marinaBookingBody(input, source = currentSource) {
    const body = await marinaQuoteBody(input, source);
    body.customer = customerFromFormData(input.formData);
    body.custom_fields = {};
    body.internal_note = String(input.note || "");
    body.send_email = Boolean(input.sendEmail);
    if (input.quoteId) body.quote_id = String(input.quoteId);
    return body;
  }
  function marinaPricingChanged(current, next) {
    const datesEqual = JSON.stringify([...new Set(current.dates || [])].map((value) => String(value).slice(0, 10)).sort()) === JSON.stringify([...new Set(next.dates || [])].map((value) => String(value).slice(0, 10)).sort());
    const adultsEqual = (Number(current.formData?.visitors?.value) || 1) === (Number(next.formData?.visitors?.value) || 1);
    const childrenEqual = (Number(current.formData?.children?.value) || 0) === (Number(next.formData?.children?.value) || 0);
    const facilitiesEqual = JSON.stringify(normalizeMarinaFacilityIds(current.facilityIds ?? current.facilities?.map((facility) => facility.id))) === JSON.stringify(normalizeMarinaFacilityIds(next.facilityIds ?? next.facilities?.map((facility) => facility.id)));
    return Number(current.resourceId) !== Number(next.resourceId) || !datesEqual || !adultsEqual || !childrenEqual || !facilitiesEqual;
  }
  async function marinaBookingPatchBody(current, patch, source = currentSource) {
    const merged = { ...current, ...patch, formData: patch.formData || current.formData, dates: patch.dates || current.dates, facilityIds: patch.facilityIds ?? current.facilityIds };
    const body = {};
    if (marinaPricingChanged(current, merged)) {
      const quote = await marinaQuoteBody(merged, source);
      body.resource_id = quote.resource_id;
      body.periods = quote.periods;
      body.guests = quote.guests;
      body.facility_ids = quote.facility_ids;
      if (patch.quoteId) body.quote_id = String(patch.quoteId);
    }
    const previousCustomer = customerFromFormData(current.formData);
    const nextCustomer = customerFromFormData(merged.formData);
    if (JSON.stringify(previousCustomer) !== JSON.stringify(nextCustomer)) body.customer = nextCustomer;
    const note = PricingNote.normalize(merged.note);
    if (String(current.note || "") !== String(note)) body.internal_note = note;
    if (Object.prototype.hasOwnProperty.call(patch, "sendEmail")) body.send_email = Boolean(patch.sendEmail);
    return body;
  }

  window.marina = Object.freeze({
    platform: "android",
    connectMarina,
    disconnectMarina,
    setSource(source) {
      if (!SOURCES.has(source)) throw new TypeError("Sursa rezervărilor este invalidă.");
      currentSource = source;
      currentRange = marinaRanges.get(source) || currentRange;
    },
    async bootstrap(range) {
      checkForMobileUpdateOnce();
      currentRange = range;
      marinaRanges.set(currentSource, { ...range });
      const connection = connectionFor();
      return configuredState(connection.online, connection.authPaused, currentSource, range);
    },
    refresh,
    onReservationLink(callback) {
      reservationLinkCallbacks.add(callback);
      if (pendingReservationLink) queueMicrotask(() => callback(pendingReservationLink));
      return () => reservationLinkCallbacks.delete(callback);
    },
    async getBookingByProviderId(value, requestedSource = currentSource) {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(requestedSource) ? requestedSource : currentSource;
      assertReadableSource(source);
      const bookingId = String(value || "").trim();
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(bookingId)) {
        throw Object.assign(new Error("Linkul rezervării conține un identificator invalid."), { code: "marina_booking_id_invalid", permanent: true });
      }
      let cache = await allCache();
      if (!(cache[source]?.resources || []).length) {
        assertMarinaSession(generation);
        const resourcePayload = await marinaRequest("/v1/resources", { source });
        assertMarinaSession(generation);
        const rows = Array.isArray(resourcePayload?.data) ? resourcePayload.data : Array.isArray(resourcePayload?.resources) ? resourcePayload.resources : Array.isArray(resourcePayload) ? resourcePayload : [];
        const resources = orderMarinaResources(rows.map(normalizeMarinaResource), { ignoreLegacy32: source !== "camping" });
        await mutateJson(CACHE_KEY, defaultCache, (nextCache) => {
          assertMarinaSession(generation);
          nextCache[source].resources = resources;
          nextCache[source].updatedAt = new Date().toISOString();
        });
        cache = await allCache();
      }
      assertMarinaSession(generation);
      const payload = await marinaRequest(`/v1/bookings/${encodeURIComponent(bookingId)}`, { source });
      assertMarinaSession(generation);
      const record = payload?.data?.booking || payload?.data || payload?.booking || payload;
      if (!record || typeof record !== "object") throw Object.assign(new Error("API-ul Marina nu a returnat rezervarea solicitată."), { code: "marina_booking_missing", permanent: true });
      return storeMarinaMutationBooking({ ...record, id: record.id ?? bookingId }, {}, source, generation);
    },
    async getBooking(id) {
      const generation = marinaAuthGeneration;
      const source = currentSource;
      await ensureMarinaOverrides(source);
      const cached = (await allCache())[source]?.bookings?.find((booking) => booking.localId === String(id)) || null;
      if (!cached) return cached;
      assertMarinaSession(generation);
      const bookingPayload = await marinaRequest(`/v1/bookings/${encodeURIComponent(cached.providerId)}`, { source });
      assertMarinaSession(generation);
      const record = bookingPayload?.data?.booking || bookingPayload?.data || bookingPayload?.booking || bookingPayload;
      const resources = (await allCache())[source].resources;
      const detailed = normalizeMarinaBookingRecord({ ...record, id: record?.id ?? cached.providerId }, resources);
      const hasInternalNote = Object.prototype.hasOwnProperty.call(record || {}, "internal_note");
      const overrideKey = marinaOverrideKey(source, cached.providerId);
      const hasNoteOverride = marinaNoteOverrides.has(overrideKey);
      const noteOverride = hasNoteOverride ? marinaNoteOverrides.get(overrideKey) : null;
      if (hasNoteOverride) {
        if (hasInternalNote && detailed.note === noteOverride) marinaNoteOverrides.delete(overrideKey);
        else detailed.note = noteOverride;
      }
      const notesPromise = hasNoteOverride || hasInternalNote || detailed.note || cached.note
        ? Promise.resolve([])
        : fetchMarinaNotes(cached.providerId, source).catch(() => []);
      const merge = (noteValues) => ({
        ...cached,
        ...detailed,
        resourceId: detailed.providerResourceId ? detailed.resourceId : cached.resourceId,
        providerResourceId: detailed.providerResourceId || cached.providerResourceId,
        dates: detailed.dates.length ? detailed.dates : cached.dates,
        note: PricingNote.normalize(marinaJoinNoteValues(hasInternalNote ? [detailed.note] : [detailed.note || cached.note, ...(!detailed.note && !cached.note ? noteValues : [])]))
      });
      let merged = merge([]);
      await mutateJson(CACHE_KEY, defaultCache, (cache) => {
        assertMarinaSession(generation);
        cache[source].bookings = cache[source].bookings.map((booking) => booking.localId === merged.localId ? merged : booking);
        cache[source].updatedAt = new Date().toISOString();
        storeMarinaOverrides(cache, source);
      });
      if (currentSource === source) emit(await configuredState(true, false, source));
      const fetchedNotes = await notesPromise;
      const withNotes = merge(fetchedNotes);
      if (withNotes.note !== merged.note) {
        merged = withNotes;
        await mutateJson(CACHE_KEY, defaultCache, (cache) => {
          assertMarinaSession(generation);
          cache[source].bookings = cache[source].bookings.map((booking) => booking.localId === merged.localId ? merged : booking);
          cache[source].updatedAt = new Date().toISOString();
          storeMarinaOverrides(cache, source);
        });
        if (currentSource === source) emit(await configuredState(true, false, source));
      }
      return merged;
    },
    async createBooking(input) {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);

        if (!input.quoteId) throw Object.assign(new Error("Rezervarea Marina necesită o cotație confirmată."), { code: "marina_quote_required", permanent: true });
        const scope = MarinaOperationRegistry.operationScope("create", source, input);
        const prepared = await marinaMutationOperations.run(scope, async () => {
          const quoteBody = await marinaQuoteBody(input, source);
          assertMarinaSession(generation);
          const quotePayload = await marinaRequest("/v1/quotes", { method: "POST", body: quoteBody, source });
          const finalQuote = normalizeMarinaQuote(quotePayload, { mode: "full" });
          const body = await marinaBookingBody({ ...input, quoteId: finalQuote.quoteId }, source);
          body.status = input.approved ? "approved" : "pending";
          return body;
        }, async (body, key) => {
          assertMarinaSession(generation);
          return { body, created: await marinaMutation("/v1/bookings", body, { idempotencyKey: key, source }) };
        });
        const { body, created } = prepared;
        const id = created?.id ?? created?.booking_id;
        const createdRecord = { ...body, ...created, id };
        if (!String(createdRecord.note || createdRecord.internal_note || "").trim() && body.internal_note) createdRecord.internal_note = body.internal_note;
        const normalized = await storeMarinaMutationBooking(createdRecord, { noteOverride: body.internal_note }, source, generation);
        scheduleMarinaRefresh(source);
        return normalized;
    },
    async editBooking(id, patch) {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(patch?.source) ? patch.source : currentSource;
      assertWritableSource(source);

        const booking = await marinaCachedBooking(id, source);
        if (!booking) throw new Error("Rezervarea Marina nu există în cache.");
        const merged = { ...booking, ...patch, formData: patch.formData || booking.formData, dates: patch.dates || booking.dates, facilityIds: patch.facilityIds ?? booking.facilityIds };
        const repricing = marinaPricingChanged(booking, merged);
        if (repricing && !patch.quoteId) throw Object.assign(new Error("Modificarea prețului Marina necesită o cotație nouă."), { code: "marina_quote_required", permanent: true });
        let body;
        let result;
        if (repricing) {
          const scope = MarinaOperationRegistry.operationScope("reprice", source, { bookingId: booking.providerId, version: booking.version, patch });
          const prepared = await marinaMutationOperations.run(scope, async () => {
            const quoteBody = await marinaQuoteBody(merged, source);
            assertMarinaSession(generation);
            const quoteId = normalizeMarinaQuote(await marinaRequest("/v1/quotes", { method: "POST", body: quoteBody, source }), { mode: "full" }).quoteId;
            return marinaBookingPatchBody(booking, { ...patch, quoteId }, source);
          }, async (preparedBody, key) => {
            assertMarinaSession(generation);
            return { body: preparedBody, result: await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, preparedBody, { method: "PATCH", version: booking.version, idempotencyKey: key, source }) };
          });
          body = prepared.body;
          result = prepared.result;
        } else {
          body = await marinaBookingPatchBody(booking, patch, source);
          assertMarinaSession(generation);
          result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, body, { method: "PATCH", version: booking.version, source });
        }
        const hasNoteMutation = Object.prototype.hasOwnProperty.call(body, "internal_note");
        const noteOverride = hasNoteMutation ? String(body.internal_note ?? "") : undefined;
        const normalized = await storeMarinaMutationBooking({ ...marinaBookingSnapshot(booking), ...body, ...result, ...(hasNoteMutation ? { internal_note: noteOverride } : {}), id: booking.providerId }, hasNoteMutation ? { noteOverride } : {}, source, generation);
        scheduleMarinaRefresh(source);
        return normalized;
    },
    setStatus: async (id, patch) => {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(patch?.source) ? patch.source : currentSource;
      assertWritableSource(source);
      const booking = await marinaCachedBooking(id, source);
      if (!booking) throw Object.assign(new Error("Rezervarea Marina nu există în cache."), { code: "marina_booking_missing", permanent: true });
      assertMarinaSession(generation);
      const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}/status`, { status: patch.status, send_email: Boolean(patch.sendEmail) }, { version: booking.version, source });
      const normalized = await storeMarinaMutationBooking({ ...marinaBookingSnapshot(booking), status: patch.status, ...result, id: booking.providerId }, {}, source, generation);
      scheduleMarinaRefresh(source);
      return normalized;
    },
    setNote: async (id, patch) => {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(patch?.source) ? patch.source : currentSource;
      assertWritableSource(source);
      const booking = await marinaCachedBooking(id, source);
      if (!booking) throw Object.assign(new Error("Rezervarea Marina nu există în cache."), { code: "marina_booking_missing", permanent: true });
      assertMarinaSession(generation);
      const note = String(patch.note ?? "");
      const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, { internal_note: note }, { method: "PATCH", version: booking.version, source });
      const normalized = await storeMarinaMutationBooking({ ...marinaBookingSnapshot(booking), ...(String(result?.id) === booking.providerId ? result : {}), internal_note: note, id: booking.providerId }, { noteOverride: note }, source, generation);
      scheduleMarinaRefresh(source);
      return normalized;
    },
    setTrash: async (id, patch) => {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(patch?.source) ? patch.source : currentSource;
      assertWritableSource(source);
      const booking = await marinaCachedBooking(id, source);
      if (!booking) throw Object.assign(new Error("Rezervarea Marina nu există în cache."), { code: "marina_booking_missing", permanent: true });
      assertMarinaSession(generation);
      const trashed = Boolean(patch.trashed);
      const status = trashed ? "cancelled" : "pending";
      const action = trashed ? "cancel" : "status";
      const send_email = Boolean(patch.sendEmail);
      const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}/${action}`, trashed ? { send_email } : { status, send_email }, { version: booking.version, source });
      const normalized = await storeMarinaMutationBooking({ ...marinaBookingSnapshot(booking), status, ...result, id: booking.providerId }, {}, source, generation);
      scheduleMarinaRefresh(source);
      return normalized;
    },
    async getPayment(id, input = {}) {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertReadableSource(source);

        await ensureMarinaOverrides(source);
        const booking = await marinaCachedBooking(id, source);
        if (!booking) throw Object.assign(new Error("Rezervarea Marina nu există în cache."), { code: "marina_booking_missing", permanent: true });
        assertMarinaSession(generation);
        const payload = await marinaRequest(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, { source });
        assertMarinaSession(generation);
        const snapshot = normalizeMarinaPayment(payload, {
          bookingId: booking.providerId,
          fallbackNote: booking.note,
          fallbackEmail: BookingFields.value(booking, "email")
        });
        const overrideKey = marinaOverrideKey(source, booking.providerId);
        if (marinaNoteOverrides.has(overrideKey)) snapshot.note = marinaNoteOverrides.get(overrideKey);
        if (marinaManualDepositOverrides.has(overrideKey)) {
          const minor = marinaManualDepositOverrides.get(overrideKey);
          const deposit = Number((minor / 100).toFixed(2));
          if (snapshot.deposit !== null && snapshot.deposit !== undefined && Math.abs(snapshot.deposit - deposit) < 0.005) {
            marinaManualDepositOverrides.delete(overrideKey);
            await persistMarinaOverrides(source);
          } else {
            snapshot.manual_deposit = deposit;
            snapshot.deposit = deposit;
            if (Number.isFinite(snapshot.total)) snapshot.balance = Number((snapshot.total - deposit).toFixed(2));
          }
        }
        assertMarinaSession(generation);
        return snapshot;
    },
    async updateDeposit(id, input) {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);

        await ensureMarinaOverrides(source);
        const booking = await marinaCachedBooking(id, source);
        if (!booking) throw Object.assign(new Error("Rezervarea Marina nu există în cache."), { code: "marina_booking_missing", permanent: true });
        assertMarinaSession(generation);
        const deposit = Number(input.deposit);
        const total = Number(input.total);
        if (!Number.isFinite(deposit) || !Number.isFinite(total) || deposit < 0 || total <= 0 || deposit > total) throw new Error("Avansul trebuie să fie între zero și costul rezervării.");
        const latestPayload = await marinaRequest(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, { source });
        const latestRecord = latestPayload?.data?.booking || latestPayload?.data || latestPayload?.booking || latestPayload || {};
        const depositMinor = Math.round(deposit * 100);
        if (!Number.isSafeInteger(depositMinor)) throw new Error("Avansul este prea mare.");
        const responseHasNote = Object.prototype.hasOwnProperty.call(latestRecord, "internal_note") || Object.prototype.hasOwnProperty.call(latestRecord, "note");
        const currentNote = responseHasNote
          ? marinaNoteText(latestRecord)
          : PricingNote.normalize(marinaJoinNoteValues(await fetchMarinaNotes(booking.providerId, source)));
        assertMarinaSession(generation);
        const nextNote = PricingNote.update(currentNote, deposit, total).note;
        const body = { deposit_minor: depositMinor, send_email: false, internal_note: nextNote };
        const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, body, { method: "PATCH", version: latestRecord.version ?? booking.version, source });
        const returnedDepositMinor = Number(result?.price?.deposit_minor ?? result?.deposit_minor);
        const responseMatchesDeposit = !Number.isSafeInteger(returnedDepositMinor) || returnedDepositMinor === depositMinor;
        const returnedNote = nextNote;
        const totalMinor = Math.round(total * 100);
        const optimisticPrice = (latestRecord?.price || booking.price)
          ? { ...(latestRecord?.price || booking.price), total_minor: totalMinor, deposit_minor: depositMinor, balance_minor: totalMinor - depositMinor }
          : undefined;
        const returnedPrice = responseMatchesDeposit ? result?.price : undefined;
        const updatedRecord = { ...latestRecord, ...result, internal_note: returnedNote, ...(returnedPrice || optimisticPrice ? { price: returnedPrice || optimisticPrice } : {}) };
        const payment = normalizeMarinaPayment({ data: updatedRecord }, {
          bookingId: booking.providerId,
          fallbackNote: returnedNote,
          fallbackEmail: BookingFields.value(booking, "email")
        });
        payment.manual_deposit = deposit;
        payment.deposit = deposit;
        payment.balance = Number((total - deposit).toFixed(2));
        const normalized = await storeMarinaMutationBooking({
          ...marinaBookingSnapshot(booking),
          ...updatedRecord,
          internal_note: returnedNote,
          id: booking.providerId
        }, { noteOverride: returnedNote, manualDepositMinor: depositMinor }, source, generation);
        scheduleMarinaRefresh(source);
        return { ...payment, booking_id: payment.booking_id ?? booking.providerId, deposit: payment.deposit ?? deposit, total: payment.total ?? total, note: normalized.note, localId: normalized.localId };
    },
    async requestPayment(id, input = {}) {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);

        const booking = await marinaCachedBooking(id, source);
        const bookingId = input.bookingId ?? booking?.providerId;
        if (bookingId === undefined || bookingId === null || String(bookingId).trim() === "") throw Object.assign(new Error("Rezervarea nu are un ID Marina valid."), { code: "marina_booking_id_missing", permanent: true });
        assertMarinaSession(generation);
        const result = await marinaMutation(`/v1/admin/bookings/${encodeURIComponent(bookingId)}/payment-request`, {
          send_email: true,
          payment_type: "deposit",
          payment_reason: "Avans rezervare"
        }, { method: "POST", idempotencyKey: input.idempotencyKey, source });
        const outcome = result?.mail_outcome || result?.status;
        if (!result || !["queued", "suppressed"].includes(outcome)) {
          throw Object.assign(new Error("Răspunsul Marina nu confirmă dacă emailul a fost programat."), { code: "marina_invalid_response", unknownOutcome: true });
        }
        assertMarinaSession(generation);
        return result;
    },
    checkAvailability(input) {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      return (async () => {
        const period = marinaAvailabilityPeriod(input.dates);
        if (!period) throw Object.assign(new Error("Intervalul Marina este invalid."), { code: "marina_invalid_dates", permanent: true });
        const body = { resource_id: await marinaProviderResourceId(input.resourceId, source), periods: [period], units: 1 };
        assertMarinaSession(generation);
        const payload = await marinaRequest("/v1/availability/check", { method: "POST", body, source });
        assertMarinaSession(generation);
        return payload?.data && typeof payload.data === "object" ? payload.data : payload;
      })();
    },
    async quoteBooking(input) {
      const generation = marinaAuthGeneration;
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      const body = await marinaQuoteBody(input, source);
      assertMarinaSession(generation);
      const payload = await marinaRequest("/v1/quotes", { method: "POST", body, source });
      assertMarinaSession(generation);
      return normalizeMarinaQuote(payload, { mode: input.mode || "full" });
    },
    clearQuoteCache() { quoteCache.clear(); },
    async getSagaInvoiceSettings() {
      const settings = normalizeSagaInvoiceSettings(await readJson(SAGA_INVOICE_SETTINGS_KEY, defaultSagaInvoiceSettings));
      return { ...settings, sagaWebConfigured: Boolean(await SecureStorage.get(SAGA_WEB_TOKEN_KEY)) };
    },
    async saveSagaInvoiceSettings(input) {
      const settings = normalizeSagaInvoiceSettings(input);
      const token = String(input?.sagaWebApiToken || "").trim();
      if (token) {
        if (token.length > 20_000) throw new TypeError("Cheia API SAGA Web este prea lungă.");
        await SecureStorage.set(SAGA_WEB_TOKEN_KEY, token);
      }
      await mutateJson(SAGA_INVOICE_SETTINGS_KEY, defaultSagaInvoiceSettings, (stored) => {
        Object.assign(stored, settings);
        return settings;
      });
      return { ...settings, sagaWebConfigured: Boolean(await SecureStorage.get(SAGA_WEB_TOKEN_KEY)) };
    },
    async importSagaInvoice(input) {
      const token = String(await SecureStorage.get(SAGA_WEB_TOKEN_KEY) || "");
      if (!token) throw Object.assign(new Error("Configurează cheia API SAGA Web în Setări înainte de import."), { code: "saga_web_not_configured", permanent: true });
      try {
        const result = await SagaWebApi.importSagaInvoice({ ...input, token });
        if (result.refreshToken) await SecureStorage.set(SAGA_WEB_TOKEN_KEY, result.refreshToken);
        return { success: result.success, message: result.message };
      } catch (error) {
        if (error?.refreshToken) {
          try { await SecureStorage.set(SAGA_WEB_TOKEN_KEY, error.refreshToken); }
          catch (storageError) { console.error("SAGA token rotation failed:", storageError?.code || storageError?.message); }
        }
        throw error;
      }
    },
    async getSettings(requestedSource = currentSource) {
      const source = SOURCES.has(requestedSource) ? requestedSource : currentSource;
      return (await configuredState(false, true, source)).settings;
    },
    async testConnection(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      const next = await refresh(currentRange || { start: new Date().toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) });
      return { ok: true, resources: next.resources.length };
    },
    async clearCredentials(requestedSource = currentSource) {
      if (SOURCES.has(requestedSource)) currentSource = requestedSource;
      return (await disconnectMarina()).settings;
    },
    onStateChanged(callback) { callbacks.add(callback); return () => callbacks.delete(callback); }
  });
  App.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) { stopRefreshTimer(); return; }
    startRefreshTimer();
    void refreshIfConfigured({ force: true });
  });
  window.addEventListener("online", () => { void refreshIfConfigured({ force: true }); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { void refreshIfConfigured({ force: true }); }
  });
  startRefreshTimer();
  document.documentElement.classList.add("is-mobile-app");
}
