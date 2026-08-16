import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Preferences } from "@capacitor/preferences";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { canonicalValue, createOperationSignature, marinaAvailabilityPeriod, marinaCheckoutDate, marinaStayPeriod, normalizeMobilePriceQuote, retryDelayMs, scopeMobileData, serverIdFromPayload } from "../src/shared/mobile-api.js";
import { customerFromFormData } from "../src/shared/marina-customer.js";
import { MANUAL_DEPOSIT_FIELD, marinaCustomFieldsWithDeposit, normalizeMarinaPayment } from "../src/shared/marina-payment.js";
import { normalizeMarinaQuote } from "../src/shared/marina-quote.js";
import { normalizeFormData } from "../src/shared/form-data.js";
import * as BookingFields from "../src/shared/booking-fields.js";
import * as PricingNote from "../src/shared/pricing-note.js";
import * as PaymentRequest from "../src/shared/payment-request.js";
import * as MarinaConfig from "../src/shared/marina-config.js";
import * as MarinaOAuth from "../src/shared/marina-oauth.js";
import { orderMarinaResources } from "../src/shared/marina-resource-order.js";

const marinaBuildConfig = MarinaConfig.createConfig({
  MARINA_INTEGRATION_ENABLED: typeof __MARINA_INTEGRATION_ENABLED__ === "undefined" ? "false" : __MARINA_INTEGRATION_ENABLED__,
  MARINA_API_BASE_URL: typeof __MARINA_API_BASE_URL__ === "undefined" ? "https://booking.husi.ro" : __MARINA_API_BASE_URL__,
  MARINA_OAUTH_CLIENT_ID: typeof __MARINA_OAUTH_CLIENT_ID__ === "undefined" ? "" : __MARINA_OAUTH_CLIENT_ID__,
  MARINA_OAUTH_SCOPES: typeof __MARINA_OAUTH_SCOPES__ === "undefined" ? "resources:read resources:write bookings:read bookings:write" : __MARINA_OAUTH_SCOPES__
});

const AutoUpdater = registerPlugin("AutoUpdater");
const BackgroundQueue = registerPlugin("BackgroundQueue");

if (!window.marina) {
  const SOURCES = new Set(["rooms", "camping", "marina"]);
  const SETTINGS_KEY = "marina-mobile-settings-v1";
  const CACHE_KEY = "marina-mobile-cache-v1";
  const PENDING_CREATES_KEY = "marina-mobile-pending-creates-v1";
  const ACTION_HISTORY_KEY = "marina-mobile-action-history-v1";
  const ACTION_HISTORY_LIMIT = 500;
  const MAX_AUTOMATIC_ACTION_ATTEMPTS = 2;
  const PASSWORD_PREFIX = "marina-password-";
  const MARINA_REFRESH_TOKEN_KEY = "marina-oauth-refresh-token";
  const callbacks = new Set();
  const mutationChains = new Map();
  const locallyOwnedActions = new Set();
  const inFlightCreates = new Map();
  const refreshOperations = new Map();
  const marinaNoteRequests = new Map();
  const marinaNoteOverrides = new Map();
  const paymentQueuePumps = new Map();
  const actionQueuesRecovered = new Set();
  const actionQueueTimers = new Map();
  const sourceConnections = new Map();
  let actionHistoryWrite = Promise.resolve();
  const jsonWrites = new Map();
  let backgroundQueueActivities = 0;
  let backgroundQueueTransition = Promise.resolve();
  const MOBILE_REFRESH_INTERVAL_MS = 5 * 60_000;
  const MOBILE_RECONNECT_INTERVAL_MS = 15_000;

  function assertWritableSource(source) {
    if (source === "marina" && !marinaBuildConfig.configured) throw Object.assign(new Error("Clientul OAuth public Marina nu este configurat în această versiune a aplicației."), { code: "marina_oauth_config_incomplete", permanent: true });
  }

  function assertReadableSource(source) {
    if (source === "marina" && !marinaBuildConfig.configured) throw Object.assign(new Error("Clientul OAuth public Marina nu este configurat în această versiune a aplicației."), { code: "marina_oauth_config_incomplete", permanent: true });
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
  let requestGeneration = 0;
  let refreshTimer = null;
  let updateCheckStarted = false;

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

  const defaultSettings = () => ({
    rooms: { apiBaseUrl: "", username: "", timezone: "Europe/Bucharest" },
    camping: {
      apiBaseUrl: "https://camping.marinapark.ro/wp-json/marina-booking/v1",
      username: "",
      timezone: "Europe/Bucharest"
    },
    marina: {
      provider: "marina",
      enabled: marinaBuildConfig.enabled,
      configured: marinaBuildConfig.configured,
      apiBaseUrl: marinaBuildConfig.apiBaseUrl,
      oauthClientConfigured: Boolean(marinaBuildConfig.clientId),
      oauthScopes: marinaBuildConfig.scopeString,
      timezone: "Europe/Bucharest"
    }
  });
  const defaultCache = () => ({
    rooms: { resources: [], bookings: [], updatedAt: null },
    camping: {
      resources: [
        { id: 1, title: "Corturi", capacity: 10, baseCost: null, defaultForm: "standard", active: true },
        { id: 2, title: "Rulote", capacity: 5, baseCost: null, defaultForm: "rulota", active: true }
      ],
      bookings: [],
      updatedAt: null
    },
    marina: { resources: [], bookings: [], updatedAt: null }
  });
  const defaultPendingCreates = () => ({ rooms: [], camping: [], marina: [] });
  const defaultActionHistory = () => ({ rooms: [], camping: [], marina: [] });

  async function readJson(key, fallback) {
    const { value } = await Preferences.get({ key });
    if (!value) return fallback();
    try { return { ...fallback(), ...JSON.parse(value) }; } catch { return fallback(); }
  }

  async function writeJson(key, value) {
    await Preferences.set({ key, value: JSON.stringify(value) });
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

  async function allSettings() { return readJson(SETTINGS_KEY, defaultSettings); }
  async function allCache() { return readJson(CACHE_KEY, defaultCache); }
  async function allActionHistory() { return readJson(ACTION_HISTORY_KEY, defaultActionHistory); }
  async function passwordFor(source = currentSource) { return String(await SecureStorage.get(`${PASSWORD_PREFIX}${source}`) || ""); }

  let marinaMetadata = null;
  let marinaPending = null;
  let marinaAccessToken = "";
  let marinaAccessExpiresAt = 0;
  let marinaEffectiveScopes = [...marinaBuildConfig.scopes];
  let marinaRefreshPromise = null;

  function mobilePayload(response) {
    if (response?.data && typeof response.data === "object") return response.data;
    try { return JSON.parse(String(response?.data || "{}")); } catch { return {}; }
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
      const url = new URL(value || fallback, `${marinaBuildConfig.apiBaseUrl}/`);
      if (url.protocol !== "https:" || url.origin !== new URL(marinaBuildConfig.apiBaseUrl).origin) throw Object.assign(new Error("Metadatele OAuth Marina conțin un endpoint invalid."), { code: "marina_oauth_metadata_invalid" });
      return url.toString();
    };
    marinaMetadata = {
      authorizationEndpoint: endpoint(payload.authorization_endpoint, "/oauth/authorize"),
      tokenEndpoint: endpoint(payload.token_endpoint, "/oauth/token"),
      revocationEndpoint: endpoint(payload.revocation_endpoint, "/oauth/revoke")
    };
    return marinaMetadata;
  }

  async function marinaTokenRequest(values) {
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
    marinaAccessToken = String(payload.access_token);
    marinaAccessExpiresAt = Date.now() + Math.max(0, Number(payload.expires_in) || 0) * 1000;
    if (payload.scope) marinaEffectiveScopes = String(payload.scope).split(/\s+/).filter(Boolean);
    if (payload.refresh_token) await SecureStorage.set(MARINA_REFRESH_TOKEN_KEY, String(payload.refresh_token));
    return marinaAccessToken;
  }

  async function marinaRefreshAccessToken() {
    if (marinaRefreshPromise) return marinaRefreshPromise;
    marinaRefreshPromise = (async () => {
      const refreshToken = String(await SecureStorage.get(MARINA_REFRESH_TOKEN_KEY) || "");
      if (!refreshToken) throw Object.assign(new Error("Conectarea Marina este necesară."), { code: "marina_reconnect_required", auth: true, permanent: true });
      try { return await marinaTokenRequest({ grant_type: "refresh_token", client_id: marinaBuildConfig.clientId, refresh_token: refreshToken }); }
      catch (error) { marinaAccessToken = ""; marinaAccessExpiresAt = 0; await SecureStorage.remove(MARINA_REFRESH_TOKEN_KEY); throw error; }
    })();
    try { return await marinaRefreshPromise; } finally { marinaRefreshPromise = null; }
  }

  async function marinaBearer() {
    if (marinaAccessToken && marinaAccessExpiresAt > Date.now() + 60000) return marinaAccessToken;
    return marinaRefreshAccessToken();
  }

  async function marinaRequest(path, { method = "GET", body, retry = true, headers = {} } = {}) {
    const token = await marinaBearer();
    const response = await CapacitorHttp.request({
      url: `${marinaBuildConfig.apiBaseUrl}${path}`,
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      data: body,
      connectTimeout: 15000,
      readTimeout: 15000
    });
    if (response.status === 401 && retry) { await marinaRefreshAccessToken(); return marinaRequest(path, { method, body, retry: false, headers }); }
    const payload = mobilePayload(response);
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(marinaProblemMessage(payload, response.status)), { code: payload.code || `marina_http_${response.status}`, status: response.status, auth: response.status === 401 || response.status === 403, conflict: response.status === 409 });
    return payload;
  }

  async function connectMarina() {
    if (!marinaBuildConfig.configured) throw Object.assign(new Error("Clientul OAuth public Marina nu este configurat."), { code: "marina_oauth_config_incomplete", permanent: true });
    const metadata = await marinaDiscover();
    const pair = await MarinaOAuth.createPkcePair();
    const state = MarinaOAuth.createState();
    marinaPending = { codeVerifier: pair.codeVerifier, state };
    const url = MarinaOAuth.buildAuthorizationUrl({ authorizationEndpoint: metadata.authorizationEndpoint, clientId: marinaBuildConfig.clientId, redirectUri: marinaBuildConfig.redirectUris.mobile, scopes: marinaBuildConfig.scopes, state, codeChallenge: pair.codeChallenge });
    await Browser.open({ url });
    return configuredState(false, true, "marina");
  }

  async function acceptMarinaCallback(url) {
    if (!marinaPending) return;
    const callback = MarinaOAuth.parseCallbackUrl(url, { protocol: "ro.marinapark.booking.mobile:", pathname: "/callback" });
    MarinaOAuth.validateState(marinaPending.state, callback.state);
    const verifier = marinaPending.codeVerifier;
    marinaPending = null;
    await marinaTokenRequest({ grant_type: "authorization_code", client_id: marinaBuildConfig.clientId, code: callback.code, redirect_uri: marinaBuildConfig.redirectUris.mobile, code_verifier: verifier });
    await Browser.close();
    rememberConnection("marina", true, false);
    if (currentSource === "marina" && currentRange) emit(await refresh(currentRange));
  }

  async function disconnectMarina() {
    const refreshToken = String(await SecureStorage.get(MARINA_REFRESH_TOKEN_KEY) || "");
    try {
      if (refreshToken) {
        const metadata = await marinaDiscover();
        await CapacitorHttp.post({ url: metadata.revocationEndpoint, headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, data: MarinaOAuth.formBody({ token: refreshToken, token_type_hint: "refresh_token", client_id: marinaBuildConfig.clientId }) });
      }
    } finally {
      marinaAccessToken = "";
      marinaAccessExpiresAt = 0;
      marinaPending = null;
      await SecureStorage.remove(MARINA_REFRESH_TOKEN_KEY);
      await mutateJson(CACHE_KEY, defaultCache, (cache) => { cache.marina = defaultCache().marina; });
      rememberConnection("marina", false, true);
    }
    const next = await configuredState(false, true, "marina");
    if (currentSource === "marina") emit(next);
    return next;
  }

  App.addListener("appUrlOpen", ({ url }) => { if (String(url).startsWith("ro.marinapark.booking.mobile://")) void acceptMarinaCallback(url).catch((error) => { marinaPending = null; console.error("Marina OAuth callback failed:", error.code || error.message); }); });

  function updateActionHistory(source, update) {
    const operation = actionHistoryWrite.catch(() => {}).then(async () => {
      const history = await allActionHistory();
      const items = [...(history[source] || [])];
      const updated = update(items).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      const active = updated.filter((item) => ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status));
      const completed = updated.filter((item) => !["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status)).slice(0, ACTION_HISTORY_LIMIT);
      history[source] = [...active, ...completed].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      await writeJson(ACTION_HISTORY_KEY, history);
      return history[source];
    });
    actionHistoryWrite = operation;
    return operation;
  }

  async function emitCurrentState(source) {
    if (source !== currentSource) return;
    const connection = connectionFor(source);
    emit(await configuredState(connection.online, connection.authPaused));
  }

  async function addAction(source, action) {
    await updateActionHistory(source, (items) => [action, ...items.filter((item) => item.id !== action.id)]);
    await emitCurrentState(source);
  }

  async function updateAction(source, id, patch) {
    await updateActionHistory(source, (items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
    await emitCurrentState(source);
  }

  function queuedFailure(action, error) {
    const attempt = Number(action.attempts || 0) + Math.max(1, Number(error.requestAttempts) || 1);
    const temporary = !["endpoint_changed", "queue_metadata_missing"].includes(error.code) && (error.temporary || error.rateLimited || error.unknownOutcome);
    if (temporary && attempt < MAX_AUTOMATIC_ACTION_ATTEMPTS) return { retry: true, status: "queued", attempt };
    if (temporary) {
      const uncertain = error.unknownOutcome || error.code === "marina_booking_api_request_in_progress";
      return { retry: false, status: uncertain ? "needs_attention" : "failed", attempt, limitReached: true };
    }
    return { retry: false, status: error.code === "endpoint_changed" ? "needs_attention" : (error.status === 409 || error.conflict ? "conflict" : "failed"), attempt, limitReached: false };
  }

  async function trackedMutation({ source, key, type, bookingLocalId = null, resourceId = null, payload = {}, apiBaseUrl, idempotencyKey, editIntent = null, noteIdempotencyKey = null, signature = null }, task) {
    let queuedPredecessor = null;
    if (bookingLocalId) {
      let actions = (await allActionHistory())[source] || [];
      if (actions.some((item) => item.bookingLocalId === bookingLocalId && ["deposit_update", "payment_request"].includes(item.type) && ["queued", "sending"].includes(item.status))) {
        await processPaymentQueue(source);
        actions = (await allActionHistory())[source] || [];
      }
      const unresolved = actions.find((item) => item.bookingLocalId === bookingLocalId && (
        ["failed", "conflict", "needs_attention"].includes(item.status)
        || (["deposit_update", "payment_request"].includes(item.type) && ["queued", "sending"].includes(item.status))
      ));
      if (unresolved) throw previousMutationError(unresolved);
      queuedPredecessor = actions.find((item) => item.bookingLocalId === bookingLocalId && item.status === "queued") || null;
    }
    const timestamp = new Date().toISOString();
    const action = {
      id: crypto.randomUUID(),
      type,
      bookingLocalId,
      resourceId,
      payload: canonicalValue(payload),
      apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
      idempotencyKey: idempotencyKey || null,
      noteIdempotencyKey,
      signature,
      editIntent: canonicalValue(editIntent),
      status: "queued",
      attempts: 0,
      availableAt: timestamp,
      result: null,
      dependsOnCommandId: queuedPredecessor?.id || null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    };
    action.idempotencyKey ||= action.id;
    if (type === "create") action.noteIdempotencyKey ||= crypto.randomUUID();
    locallyOwnedActions.add(action.id);
    await addAction(source, action);
    if (queuedPredecessor) {
      locallyOwnedActions.delete(action.id);
      return confirmedQueuedAction(source, action.id);
    }
    let started = false;
    try {
      return await serializeMutation(key, async () => {
        started = true;
        await updateAction(source, action.id, { status: "sending", attempts: 1, updatedAt: new Date().toISOString() });
        try {
          const result = await task(action);
          const completedAt = new Date().toISOString();
          await updateAction(source, action.id, {
            bookingLocalId: result?.localId || action.bookingLocalId,
            resourceId: result?.resourceId ?? action.resourceId,
            status: "synced",
            result: canonicalValue(result ?? null),
            errorCode: null,
            errorMessage: null,
            updatedAt: completedAt,
            completedAt
          });
          return result;
        } catch (error) {
          const failure = queuedFailure(action, error);
          const completedAt = new Date().toISOString();
          await updateAction(source, action.id, {
            status: failure.status,
            errorCode: failure.limitReached ? "automatic_retry_limit_reached" : error.code || "request_failed",
            errorMessage: failure.limitReached ? `${error.message || "Acțiunea nu a putut fi finalizată."} Acțiunea a fost oprită după două încercări.` : error.message || "Acțiunea nu a putut fi finalizată.",
            availableAt: failure.retry ? new Date(Date.now() + retryDelayMs(failure.attempt, error.retryAfter)).toISOString() : action.availableAt,
            updatedAt: completedAt,
            completedAt: failure.retry ? null : completedAt
          });
          if (failure.retry) scheduleActionQueue(source, retryDelayMs(failure.attempt, error.retryAfter));
          throw error;
        }
      });
    } catch (error) {
      if (!started) {
        const completedAt = new Date().toISOString();
        await updateAction(source, action.id, {
          status: "failed",
          errorCode: error.code || "previous_action_failed",
          errorMessage: error.message || "Acțiunea anterioară pentru acest client nu a fost finalizată.",
          updatedAt: completedAt,
          completedAt
        });
      }
      throw error;
    } finally {
      locallyOwnedActions.delete(action.id);
      scheduleActionQueue(source, 0);
    }
  }

  function normalizeBaseUrl(value) {
    const namespace = "/wp-json/marina-booking/v1";
    let url;
    try { url = new URL(String(value || "").trim().replace(/\/+$/, "")); }
    catch { throw new Error("URL-ul API este invalid."); }
    if (url.protocol !== "https:") throw new Error("URL-urile API trebuie să folosească HTTPS.");
    const sitePath = url.pathname.replace(/\/+$/, "");
    url.pathname = sitePath.endsWith(namespace) ? sitePath : `${sitePath}${namespace}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  }

  function basicAuth(username, password) {
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function endpointChangedError(method) {
    return Object.assign(new Error("Adresa API s-a schimbat în timpul operației; răspunsul vechii ținte a fost ignorat."), {
      code: "endpoint_changed",
      permanent: true,
      unknownOutcome: method !== "GET"
    });
  }

  function responseHeader(headers, name) {
    const target = name.toLowerCase();
    const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === target);
    return entry?.[1] ?? null;
  }

  function applicationError(payload, method) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const embeddedStatus = Number(payload?.data?.status ?? payload?.status_code ?? (typeof payload.status === "number" ? payload.status : NaN));
    const code = String(payload.code || payload.error?.code || "");
    const explicitFailure = payload.success === false
      || payload.ok === false
      || payload.status === "error"
      || Boolean(payload.error);
    const wordpressError = Boolean(code && payload.message);
    if (!explicitFailure && !wordpressError) return null;
    const status = Number.isFinite(embeddedStatus) && embeddedStatus >= 400 ? embeddedStatus : 400;
    const error = new Error(payload.message || payload?.data?.message || payload.error?.message || (typeof payload.error === "string" ? payload.error : "WordPress a respins operația."));
    error.code = code || "api_application_error";
    error.status = status;
    error.auth = status === 401 || status === 403 || /(auth|credential|forbidden|not_logged|cookie|nonce|invalid_username|incorrect_password)/i.test(error.code);
    const requestInProgress = error.code === "marina_booking_api_request_in_progress";
    error.rateLimited = status === 429 || requestInProgress;
    error.retryAfter = payload?.data?.retry_after !== undefined && Number.isFinite(Number(payload.data.retry_after)) ? Number(payload.data.retry_after) : null;
    error.temporary = requestInProgress || error.rateLimited || status >= 500;
    error.permanent = !error.temporary;
    error.unknownOutcome = method !== "GET" && error.temporary;
    error.payload = payload;
    return error;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function request(path, options = {}, override = null, source = currentSource) {
    const settings = override || (await allSettings())[source];
    const password = override?.password ?? await passwordFor(source);
    if (!settings?.username || !password) throw new Error("Datele de acces nu sunt configurate.");
    const configuredBaseUrl = normalizeBaseUrl(settings.apiBaseUrl);
    const expectedApiBaseUrl = options.expectedApiBaseUrl ? normalizeBaseUrl(options.expectedApiBaseUrl) : configuredBaseUrl;
    const method = options.method || "GET";
    if (configuredBaseUrl !== expectedApiBaseUrl) throw endpointChangedError(method);
    const headers = {
      Accept: "application/json",
      Authorization: `Basic ${basicAuth(settings.username, password)}`
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    const retryable = options.retry !== false && (method === "GET" || Boolean(options.idempotencyKey) || options.readOnly === true);
    const defaultAttempts = method === "GET" || options.readOnly === true ? 3 : 2;
    const maxAttempts = retryable ? Math.max(1, Number(options.maxAttempts) || defaultAttempts) : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      let error;
      try {
        response = await CapacitorHttp.request({
          url: `${expectedApiBaseUrl}${path}`,
          method,
          headers,
          data: options.body,
          connectTimeout: options.connectTimeout || options.timeout || 8000,
          readTimeout: options.timeout || 15000,
          disableRedirects: true,
          responseType: "json"
        });
      } catch (cause) {
        error = Object.assign(new Error("API-ul nu poate fi accesat momentan."), {
          code: "network_error",
          temporary: true,
          unknownOutcome: method !== "GET",
          cause
        });
      }
      if (!override) {
        const latestSettings = (await allSettings())[source];
        let latestBaseUrl = "";
        try { latestBaseUrl = normalizeBaseUrl(latestSettings?.apiBaseUrl); } catch {}
        if (latestBaseUrl !== expectedApiBaseUrl) throw endpointChangedError(method);
      }
      if (response) {
        const rawData = response.data;
        let payload = {};
        let invalidJson = false;
        const empty = rawData === null || rawData === undefined || (typeof rawData === "string" && !rawData.trim());
        if (typeof rawData === "string" && rawData.trim()) {
          try { payload = JSON.parse(rawData); }
          catch { invalidJson = true; payload = { message: rawData.slice(0, 500) }; }
        } else if (!empty) payload = rawData;
        const successfulHttp = response.status >= 200 && response.status < 300;
        if (successfulHttp && invalidJson) {
          error = Object.assign(new Error("API-ul a returnat un răspuns JSON invalid."), { code: "invalid_json_response", status: response.status, permanent: true, unknownOutcome: method !== "GET", payload });
        } else if (successfulHttp && empty && response.status !== 204) {
          error = Object.assign(new Error("API-ul a returnat un răspuns gol neașteptat."), { code: "empty_api_response", status: response.status, permanent: true, unknownOutcome: method !== "GET", payload });
        } else if (successfulHttp) {
          error = applicationError(payload, method);
          if (!error) return { payload, headers: response.headers || {} };
        }
        if (!error) {
          error = new Error(payload?.message || payload?.data?.message || `API-ul a returnat HTTP ${response.status}.`);
          error.code = payload?.code || `http_${response.status}`;
          error.status = response.status;
          error.auth = response.status === 401 || response.status === 403;
          const requestInProgress = error.code === "marina_booking_api_request_in_progress";
          error.rateLimited = response.status === 429 || requestInProgress;
          error.temporary = requestInProgress || response.status === 429 || response.status >= 500;
          error.unknownOutcome = method !== "GET" && response.status >= 500;
          const retryAfter = responseHeader(response.headers, "Retry-After");
          error.retryAfter = retryAfter === null
            ? (payload?.data?.retry_after !== undefined && Number.isFinite(Number(payload.data.retry_after)) ? Number(payload.data.retry_after) : null)
            : Number(retryAfter);
          error.payload = payload;
        }
      }
      if (!retryable || !error.temporary || attempt >= maxAttempts) {
        error.requestAttempts = attempt;
        throw error;
      }
      await wait(retryDelayMs(attempt, error.retryAfter));
    }
    throw new Error("Cererea API nu a putut fi finalizată.");
  }

  function normalizeBooking(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("Endpoint-ul rezervărilor a returnat o înregistrare invalidă."), { code: "invalid_booking_record", permanent: true, payload: raw });
    const serverId = Number(raw.booking_id ?? raw.id ?? raw.bookingId);
    const resourceId = Number(raw.resource_id ?? raw.booking_type ?? raw.type_id);
    const rawDates = Array.isArray(raw.dates) ? raw.dates : [];
    const parsedDates = rawDates.map((entry) => String(entry?.date ?? entry?.booking_date ?? entry).slice(0, 10));
    const validDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    };
    if (!Number.isInteger(serverId) || serverId <= 0 || !Number.isInteger(resourceId) || resourceId <= 0 || !parsedDates.length || parsedDates.some((date) => !validDate(date))) {
      throw Object.assign(new Error("Endpoint-ul rezervărilor a returnat o înregistrare incompletă sau invalidă."), { code: "invalid_booking_record", permanent: true, payload: raw });
    }
    const dates = [...new Set(parsedDates)].sort();
    const formData = normalizeFormData(raw.form_data || raw.form || raw.parsed_form || {});
    const datesApproved = rawDates.length > 0 && rawDates.every((entry) => Number(entry?.approved) === 1);
    return {
      localId: `server:${serverId}`,
      serverId,
      externalId: raw.external_id ?? raw.externalId ?? null,
      resourceId,
      dates,
      startDate: dates[0] || "",
      endDate: dates.at(-1) || "",
      status: raw.status === "approved" || raw.approved === true || Number(raw.approved) === 1 || datesApproved ? "approved" : "pending",
      trashed: raw.trashed === true || raw.trash === true || Number(raw.trash) === 1 || raw.is_trash === true || Number(raw.is_trash) === 1,
      note: String(raw.note ?? raw.remark ?? ""),
      formData,
      syncState: "synced",
      updatedAt: raw.updated_at ?? raw.modification_date ?? null
    };
  }

  function normalizeResource(resource) {
    const id = Number(resource?.id);
    if (!resource || typeof resource !== "object" || Array.isArray(resource) || !Number.isInteger(id) || id <= 0) {
      throw Object.assign(new Error("Endpoint-ul resurselor a returnat o înregistrare invalidă."), { code: "invalid_resource_record", permanent: true, payload: resource });
    }
    return {
      ...resource,
      id,
      title: String(resource.title || `Spațiul ${resource.id}`),
      parentId: resource.parent_id ?? null,
      baseCost: resource.base_cost ?? null,
      defaultForm: resource.default_form || "",
      active: resource.active !== false
    };
  }

  function bookingRows(payload) {
    if (Array.isArray(payload?.bookings)) return payload.bookings;
    if (Array.isArray(payload?.result?.bookings)) return payload.result.bookings;
    if (payload?.result?.bookings && typeof payload.result.bookings === "object") return Object.values(payload.result.bookings);
    if (Array.isArray(payload?.result)) return payload.result;
    if (Array.isArray(payload?.result?.rows)) return payload.result.rows;
    throw new Error("Endpoint-ul rezervărilor a returnat un format necunoscut.");
  }

  function stateFrom(cache, settings, actions, online = false, authPaused = false, source = currentSource) {
    const sourceCache = cache[source] || defaultCache()[source];
    const sourceSettings = settings[source] || defaultSettings()[source];
    const scoped = scopeMobileData(sourceCache.resources, sourceCache.bookings, source);
    return {
      resources: scoped.resources,
      bookings: scoped.bookings,
      commands: actions[source] || [],
      diagnostics: {
        ...emptyDiagnostics(online, authPaused),
        queued: (actions[source] || []).filter((action) => ["queued", "sending"].includes(action.status)).length,
        sending: (actions[source] || []).filter((action) => action.status === "sending").length,
        failed: (actions[source] || []).filter((action) => ["failed", "conflict", "needs_attention"].includes(action.status)).length,
        conflicts: (actions[source] || []).filter((action) => action.status === "conflict").length,
        lastSuccessfulSync: sourceCache.updatedAt || null
      },
      settings: sourceSettings,
      range: currentRange
    };
  }

  async function configuredState(online = false, authPaused = false, source = currentSource) {
    const [settings, cache, actions, password] = await Promise.all([allSettings(), allCache(), allActionHistory(), passwordFor(source)]);
    const result = stateFrom(cache, settings, actions, online, authPaused, source);
    if (source === "marina") {
      const connected = Boolean(marinaAccessToken || await SecureStorage.get(MARINA_REFRESH_TOKEN_KEY));
      const capabilities = MarinaConfig.capabilities(marinaEffectiveScopes);
      result.settings = { ...result.settings, connected, connecting: Boolean(marinaPending), credentialsConfigured: connected, oauthScopes: marinaEffectiveScopes.join(" "), capabilities, connectionStatus: connected ? "connected" : marinaPending ? "connecting" : marinaBuildConfig.configured ? "disconnected" : "disabled" };
      result.diagnostics.authPaused = !connected;
    } else result.settings = { ...result.settings, credentialsConfigured: Boolean(password) };
    return result;
  }

  function emit(state) { for (const callback of callbacks) callback(state); }

  async function fetchBookings(range, source, expectedApiBaseUrl) {
    const all = [];
    const fingerprints = new Set();
    for (let page = 1; page <= 1000; page += 1) {
      const params = new URLSearchParams({ start: range.start, end: range.end, trash: "any", per_page: "100", page: String(page) });
      const { payload } = await request(`/bookings?${params}`, { expectedApiBaseUrl }, null, source);
      const rows = bookingRows(payload);
      const fingerprint = rows.map((row) => String(row.booking_id ?? row.id ?? row.bookingId ?? "")).join(",");
      if (rows.length && fingerprints.has(fingerprint)) throw new Error("Endpoint-ul rezervărilor a repetat o pagină.");
      if (rows.length) fingerprints.add(fingerprint);
      const normalized = rows.map(normalizeBooking);
      if (normalized.some((booking) => !booking.serverId || !booking.dates.length || !booking.resourceId)) throw new Error("Endpoint-ul rezervărilor a returnat înregistrări incomplete.");
      all.push(...normalized);
      if (rows.length < 100) return all;
    }
    throw new Error("Endpoint-ul rezervărilor a depășit limita de paginare.");
  }

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

  function normalizeMarinaBookingRecord(booking, resources) {
    const period = booking.periods?.[0] || booking.booking_periods?.[0] || {};
    const providerResourceId = String(booking.resource_id ?? booking.resourceId ?? booking.resource?.id ?? period.resource_id ?? period.resourceId ?? "");
    const resource = resources.find((item) => item.providerId === providerResourceId);
    const dateOnlyStart = booking.start_date ?? period.start_date;
    const dateOnlyEnd = booking.end_date ?? period.end_date;
    const start = String(dateOnlyStart ?? booking.start_at ?? period.start_at ?? "").slice(0, 10);
    const rawEnd = String(dateOnlyEnd ?? booking.end_at ?? period.end_at ?? start).slice(0, 10);
    const dateRangeBooking = resource?.bookingMode !== "time_slot";
    const hasNestedTimedEnd = Boolean(period.end_at ?? period.endAt ?? period.ends_at ?? period.endsAt);
    const end = dateOnlyEnd || (dateRangeBooking && !hasNestedTimedEnd) ? marinaCheckoutDate(rawEnd) : rawEnd;
    const dates = [];
    for (let cursor = start; /^\d{4}-\d{2}-\d{2}$/.test(cursor) && cursor <= end && dates.length < 366;) {
      dates.push(cursor);
      const next = new Date(`${cursor}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
    }
    const customer = booking.customer || booking.guest || {};
    const guests = booking.guests || {};
    const status = String(booking.status || "pending").toLowerCase();
    return {
      localId: `marina:${booking.id}`,
      serverId: String(booking.id),
      provider: "marina",
      providerId: String(booking.id),
      providerResourceId,
      resourceId: marinaUiId(providerResourceId),
      status: ["approved", "confirmed", "active"].includes(status) ? "approved" : "pending",
      providerStatus: status,
      trashed: ["cancelled", "canceled", "deleted"].includes(status),
      note: marinaNoteText(booking),
      price: booking.price && typeof booking.price === "object" ? { ...booking.price } : null,
      formData: marinaFormData(booking, customer, guests),
      dates,
      syncState: "synced",
      version: booking.version ?? null
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

  function marinaNoteText(booking) {
    const hasInternalNote = Object.prototype.hasOwnProperty.call(booking || {}, "internal_note");
    return (hasInternalNote ? [booking?.internal_note] : [booking?.note, ...marinaNoteBodies(booking)])
      .map((value) => String(value || "").trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .join("\n\n");
  }

  function fetchMarinaNotes(providerId) {
    const key = String(providerId);
    const existing = marinaNoteRequests.get(key);
    if (existing) return existing;
    const request = marinaRequest(`/v1/bookings/${encodeURIComponent(key)}/notes`)
      .then((payload) => marinaNoteBodies(payload))
      .finally(() => {
        if (marinaNoteRequests.get(key) === request) marinaNoteRequests.delete(key);
      });
    marinaNoteRequests.set(key, request);
    return request;
  }

  async function refresh(range) {
    currentRange = range;
    const source = currentSource;
    if (source === "marina") {
      const connected = Boolean(marinaAccessToken || await SecureStorage.get(MARINA_REFRESH_TOKEN_KEY));
      if (!connected) return configuredState(false, true, source); // A pre-login 401 is expected; do not probe protected routes.
      try {
        if (!MarinaConfig.capabilities(marinaEffectiveScopes).resourcesRead) return configuredState(true, false, source);
        const resourcePayload = await marinaRequest("/v1/resources");
        const resourceRows = Array.isArray(resourcePayload?.data) ? resourcePayload.data : Array.isArray(resourcePayload?.resources) ? resourcePayload.resources : Array.isArray(resourcePayload) ? resourcePayload : [];
        const resources = orderMarinaResources(resourceRows.map((resource) => ({ id: marinaUiId(resource.id), provider: "marina", providerId: String(resource.id), title: String(resource.title || resource.name || `Marina ${resource.id}`), capacity: Number(resource.capacity) || null, defaultForm: "marina", bookingMode: String(resource.booking_mode ?? resource.bookingMode ?? "date_range"), active: resource.active !== false })));
        const bookings = [];
        let after = "";
        if (MarinaConfig.capabilities(marinaEffectiveScopes).bookingsRead) do {
          const params = new URLSearchParams({ from: range.start, to: range.end, limit: "200" });
          if (after) params.set("after", after);
          const payload = await marinaRequest(`/v1/bookings?${params}`);
          const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.bookings) ? payload.bookings : Array.isArray(payload) ? payload : [];
          const previousBookings = new Map(((await allCache()).marina.bookings || []).map((booking) => [booking.providerId, booking]));
          for (const booking of rows) {
            const normalized = normalizeMarinaBookingRecord(booking, resources);
            const previous = previousBookings.get(normalized.providerId);
            if (marinaNoteOverrides.has(normalized.providerId)) {
              const override = marinaNoteOverrides.get(normalized.providerId);
              const responseHasNote = Object.prototype.hasOwnProperty.call(booking || {}, "internal_note")
                || Object.prototype.hasOwnProperty.call(booking || {}, "note");
              if (responseHasNote && normalized.note === override) marinaNoteOverrides.delete(normalized.providerId);
              else normalized.note = override;
            } else if (!normalized.note && previous?.note) normalized.note = previous.note;
            bookings.push(normalized);
          }
          await mutateJson(CACHE_KEY, defaultCache, (cache) => {
            cache.marina = { resources, bookings: [...bookings], updatedAt: new Date().toISOString() };
          });
          after = payload?.next_cursor ?? payload?.pagination?.next_cursor ?? payload?.meta?.next_cursor ?? "";
        } while (after);
        await mutateJson(CACHE_KEY, defaultCache, (cache) => { cache.marina = { resources, bookings, updatedAt: new Date().toISOString() }; });
        rememberConnection("marina", true, false);
        const next = await configuredState(true, false, source);
        emit(next);
        return next;
      } catch (error) {
        rememberConnection("marina", Boolean(error.auth), Boolean(error.auth));
        const cached = await configuredState(Boolean(error.auth), Boolean(error.auth), source);
        emit(cached);
        throw error;
      }
    }
    const expectedApiBaseUrl = normalizeBaseUrl((await allSettings())[source]?.apiBaseUrl);
    const operationKey = `${source}:${range.start}:${range.end}:${expectedApiBaseUrl}`;
    const inFlight = refreshOperations.get(operationKey);
    if (inFlight) return inFlight;
    const generation = ++requestGeneration;
    const operation = (async () => {
      try {
        const [{ payload: resourcePayload }, bookings] = await Promise.all([
          request("/resources", { expectedApiBaseUrl }, null, source),
          fetchBookings(range, source, expectedApiBaseUrl)
        ]);
        if (!Array.isArray(resourcePayload?.resources)) throw new Error("Endpoint-ul resurselor a returnat un format necunoscut.");
        if (generation !== requestGeneration) return configuredState(true, false);
        const resources = resourcePayload.resources.map(normalizeResource);
        const resourceIds = new Set(resources.map((resource) => resource.id));
        if (resourceIds.size !== resources.length) throw Object.assign(new Error("Endpoint-ul resurselor a returnat înregistrări duplicate."), { code: "invalid_resource_record", permanent: true, payload: resourcePayload });
        const previous = (await allCache())[source]?.bookings || [];
        const returnedIds = new Set(bookings.map((booking) => Number(booking.serverId)));
        const missing = previous.filter((booking) =>
          booking.serverId
          && !returnedIds.has(Number(booking.serverId))
          && (booking.dates || []).some((date) => date >= range.start && date <= range.end)
        );
        for (const local of missing) {
          try {
            const { payload } = await request(`/bookings/${local.serverId}`, { expectedApiBaseUrl }, null, source);
            const confirmed = normalizeBooking(payload?.booking || payload);
            if (!confirmed.serverId || !confirmed.resourceId || !confirmed.dates.length) {
              throw Object.assign(new Error("Verificarea rezervării a returnat o înregistrare incompletă."), { code: "invalid_booking_record", permanent: true, payload });
            }
            if (confirmed.dates.some((date) => date >= range.start && date <= range.end)) {
              bookings.push(confirmed);
              returnedIds.add(Number(confirmed.serverId));
            }
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        }
        const scoped = scopeMobileData(resources, bookings, source);
        const actions = (await allActionHistory())[source] || [];
        for (const action of actions) {
          if (action.type !== "deposit_update" || !["queued", "sending", "failed", "conflict", "needs_attention"].includes(action.status)) continue;
          const booking = scoped.bookings.find((item) => item.localId === action.bookingLocalId);
          if (booking && action.payload?.new_note) booking.note = action.payload.new_note;
        }
        await mutateJson(CACHE_KEY, defaultCache, (cache) => {
          cache[source] = {
            resources: scoped.resources,
            bookings: scoped.bookings,
            updatedAt: new Date().toISOString()
          };
        });
        rememberConnection(source, true, false);
        const next = await configuredState(true, false);
        emit(next);
        void processPaymentQueue(source);
        return next;
      } catch (error) {
        if (generation !== requestGeneration || source !== currentSource) throw error;
        rememberConnection(source, Boolean(error.auth), Boolean(error.auth));
        const cached = await configuredState(Boolean(error.auth), Boolean(error.auth));
        emit(cached);
        throw error;
      }
    })();
    refreshOperations.set(operationKey, operation);
    try { return await operation; }
    finally { if (refreshOperations.get(operationKey) === operation) refreshOperations.delete(operationKey); }
  }

  async function refreshIfConfigured({ force = false } = {}) {
    if (!currentRange) return;
    const source = currentSource;
    if (source === "marina") return;
    const connection = connectionFor(source);
    if (!force && connection.online && Date.now() - connection.lastSuccessfulAt < MOBILE_REFRESH_INTERVAL_MS) return;
    const settings = (await allSettings())[source];
    if (source !== currentSource || !settings?.apiBaseUrl || !settings?.username || !await passwordFor(source)) return;
    if (source !== currentSource) return;
    try { await refresh(currentRange); } catch {}
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

  function serverId(localId) {
    const value = Number(String(localId || "").replace(/^server:/, ""));
    if (!Number.isInteger(value) || value < 1) throw new Error("Rezervarea nu are încă un ID de server.");
    return value;
  }

  function previousMutationError(previous) {
    const previousCode = previous?.errorCode || previous?.code || "request_failed";
    return Object.assign(new Error("Acțiunea anterioară pentru acest client nu a fost finalizată cu succes. Rezolvă sau elimină eroarea înainte de o altă modificare."), {
      code: "previous_action_failed",
      permanent: true,
      previousActionId: previous?.id || null,
      previousErrorCode: previousCode
    });
  }

  function transitionBackgroundQueue(operation) {
    backgroundQueueTransition = backgroundQueueTransition
      .then(operation, operation);
    return backgroundQueueTransition;
  }

  async function runWithBackgroundQueue(task) {
    if (Capacitor.getPlatform() !== "android") return task();
    backgroundQueueActivities += 1;
    try {
      if (backgroundQueueActivities === 1) {
        await transitionBackgroundQueue(() => BackgroundQueue.start());
      } else {
        await backgroundQueueTransition;
      }
    } catch (cause) {
      backgroundQueueActivities = Math.max(0, backgroundQueueActivities - 1);
      throw Object.assign(new Error("Sincronizarea sigură în fundal nu a putut fi pornită; acțiunea a rămas în coadă."), {
        code: "background_service_unavailable",
        temporary: true,
        cause
      });
    }
    try {
      return await task();
    } finally {
      backgroundQueueActivities = Math.max(0, backgroundQueueActivities - 1);
      if (backgroundQueueActivities === 0) {
        try { await transitionBackgroundQueue(() => backgroundQueueActivities === 0 ? BackgroundQueue.stop() : undefined); }
        catch (error) { console.error("Background queue service stop failed:", error); }
      }
    }
  }

  async function serializeMutation(key, task) {
    const previous = mutationChains.get(key);
    const operation = previous
      ? previous.then(() => runWithBackgroundQueue(task), (error) => { throw previousMutationError(error); })
      : Promise.resolve().then(() => runWithBackgroundQueue(task));
    mutationChains.set(key, operation);
    try { return await operation; }
    finally { if (mutationChains.get(key) === operation) mutationChains.delete(key); }
  }

  async function requireAvailability(source, expectedApiBaseUrl, resourceId, dates, excludeBookingId = null) {
    if (source === "camping" || !dates.length) return;
    const body = { resource_id: Number(resourceId), dates };
    if (excludeBookingId !== null) body.exclude_booking_id = Number(excludeBookingId);
    const { payload } = await request("/availability", {
      method: "POST",
      body,
      expectedApiBaseUrl,
      readOnly: true
    }, null, source);
    if (typeof payload?.available !== "boolean") {
      throw Object.assign(new Error("Endpoint-ul disponibilității a returnat un răspuns incomplet."), { code: "invalid_availability_response", permanent: true, payload });
    }
    if (payload.available === false) {
      throw Object.assign(new Error("Datele solicitate nu mai sunt disponibile."), {
        code: "availability_conflict",
        conflict: true,
        permanent: true,
        payload
      });
    }
  }

  async function cachedBooking(source, bookingId) {
    const cache = await allCache();
    return (cache[source]?.bookings || []).find((booking) => Number(booking.serverId) === Number(bookingId)) || null;
  }

  function sameCanonicalValue(left, right) {
    return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
  }

  function normalizedEditDates(dates) {
    return [...new Set((dates || []).map((date) => String(date).slice(0, 10)))].sort();
  }

  function preparedBookingFormData(booking) {
    if (!booking) return {};
    try { return BookingFields.prepareFormData(booking.formData, booking.resourceId); }
    catch (error) {
      if (error.code === "empty_form_data") return {};
      throw error;
    }
  }

  function captureEditIntent(baseBooking, patch, requestedFormData) {
    const baseFormData = preparedBookingFormData(baseBooking);
    const changedFormData = {};
    const removedFormFields = [];
    const fieldNames = new Set([...Object.keys(baseFormData), ...Object.keys(requestedFormData)]);
    for (const name of fieldNames) {
      const baseHasField = Object.prototype.hasOwnProperty.call(baseFormData, name);
      const requestedHasField = Object.prototype.hasOwnProperty.call(requestedFormData, name);
      if (baseHasField === requestedHasField && sameCanonicalValue(baseFormData[name], requestedFormData[name])) continue;
      if (requestedHasField) changedFormData[name] = requestedFormData[name];
      else removedFormFields.push(name);
    }
    return {
      resourceChanged: !baseBooking || Number(patch.resourceId) !== Number(baseBooking.resourceId),
      datesChanged: !baseBooking || !sameCanonicalValue(normalizedEditDates(patch.dates), normalizedEditDates(baseBooking.dates)),
      noteChanged: patch.note !== undefined && (!baseBooking || String(patch.note) !== String(baseBooking.note || "")),
      changedFormData,
      removedFormFields
    };
  }

  async function rebaseEditPatch(source, latestBooking, patch, intent) {
    if (!latestBooking) throw Object.assign(new Error("Rezervarea nu mai există în datele locale actualizate."), { code: "client_cache_missing", permanent: true });
    const formData = { ...preparedBookingFormData(latestBooking) };
    for (const name of intent.removedFormFields) delete formData[name];
    for (const [name, field] of Object.entries(intent.changedFormData)) formData[name] = field;
    const resourceId = intent.resourceChanged ? Number(patch.resourceId) : Number(latestBooking.resourceId);
    const dates = intent.datesChanged ? normalizedEditDates(patch.dates) : normalizedEditDates(latestBooking.dates);
    const cache = await allCache();
    const resource = (cache[source]?.resources || []).find((item) => Number(item.id) === resourceId);
    const bookingFormType = resource?.defaultForm || (resourceId === Number(patch.resourceId) ? patch.bookingFormType || "" : "");
    const rebased = {
      ...patch,
      resourceId,
      dates,
      formData: BookingFields.prepareFormData(formData, null),
      bookingFormType
    };
    if (patch.note !== undefined) rebased.note = intent.noteChanged ? String(patch.note) : String(latestBooking.note || "");
    return rebased;
  }

  async function mutate(id, path, body, source = currentSource) {
    const bookingId = serverId(id);
    const type = path === "/status" ? "status" : path === "/note" ? "note" : "trash";
    const apiBaseUrl = normalizeBaseUrl((await allSettings())[source]?.apiBaseUrl);
    return trackedMutation({ source, key: `booking:${source}:${bookingId}`, type, bookingLocalId: id, payload: body, apiBaseUrl }, (action) => executeSimpleAction(source, action));
  }

  async function refreshAfterMutation(source, range) {
    if (!range || source !== currentSource) return;
    try { await refresh(range); } catch {}
  }

  async function updateCachedBooking(source, bookingId, patch) {
    const updated = await mutateJson(CACHE_KEY, defaultCache, (cache) => {
      const sourceCache = cache[source] || defaultCache()[source];
      const index = (sourceCache.bookings || []).findIndex((booking) => Number(booking.serverId) === Number(bookingId));
      if (index < 0) return false;
      sourceCache.bookings[index] = { ...sourceCache.bookings[index], ...patch, updatedAt: new Date().toISOString() };
      cache[source] = sourceCache;
      return true;
    });
    if (!updated) return;
    if (source === currentSource) {
      const connection = connectionFor(source);
      emit(await configuredState(connection.online, connection.authPaused));
    }
  }

  async function executeSimpleAction(source, action) {
    const bookingId = serverId(action.bookingLocalId);
    const paths = { status: "/status", note: "/note", trash: "/trash" };
    const path = paths[action.type];
    if (!path) throw Object.assign(new Error("Tipul acțiunii din coadă nu este recunoscut."), { code: "unsupported_queue_action", permanent: true });
    const { payload } = await request(`/bookings/${bookingId}${path}`, {
      method: "POST",
      body: action.payload,
      idempotencyKey: action.idempotencyKey,
      expectedApiBaseUrl: action.apiBaseUrl
    }, null, source);
    const patch = action.type === "status" ? { status: action.payload.status }
      : action.type === "note" ? { note: action.payload.note }
        : { trashed: action.payload.trash };
    await updateCachedBooking(source, bookingId, patch);
    await refreshAfterMutation(source, currentRange);
    return { ...payload, localId: action.bookingLocalId };
  }

  async function executeEditAction(source, action) {
    const bookingId = serverId(action.bookingLocalId);
    if (!action.editIntent) throw Object.assign(new Error("Editarea salvată nu conține informațiile necesare pentru reluare sigură."), { code: "queue_metadata_missing", permanent: true });
    const rebasedPatch = await rebaseEditPatch(source, await cachedBooking(source, bookingId), action.payload, action.editIntent);
    const stayTimes = source === "camping" ? { checkIn: "14:00:01", checkOut: "12:00:02" } : {};
    const apiDates = window.BookingCalendar.toStayDateTimes(rebasedPatch.dates, stayTimes);
    await requireAvailability(source, action.apiBaseUrl, rebasedPatch.resourceId, apiDates, bookingId);
    const editBody = { resource_id: rebasedPatch.resourceId, dates: apiDates, form_data: canonicalValue(rebasedPatch.formData), booking_form_type: rebasedPatch.bookingFormType || "", send_email: Boolean(rebasedPatch.sendEmail) };
    if (rebasedPatch.note !== undefined) editBody.note = String(rebasedPatch.note);
    const { payload } = await request(`/bookings/${bookingId}`, {
      method: "PATCH",
      idempotencyKey: action.idempotencyKey,
      expectedApiBaseUrl: action.apiBaseUrl,
      body: editBody
    }, null, source);
    const cachePatch = {
      resourceId: Number(rebasedPatch.resourceId),
      dates: rebasedPatch.dates,
      startDate: rebasedPatch.dates[0] || "",
      endDate: rebasedPatch.dates.at(-1) || "",
      formData: canonicalValue(rebasedPatch.formData)
    };
    if (payload?.note !== undefined) cachePatch.note = String(payload.note);
    else if (rebasedPatch.note !== undefined) cachePatch.note = String(rebasedPatch.note);
    await updateCachedBooking(source, bookingId, cachePatch);
    await refreshAfterMutation(source, currentRange);
    return { ...payload, localId: action.bookingLocalId, resourceId: Number(rebasedPatch.resourceId) };
  }

  async function executePaymentAction(source, action) {
    const bookingId = serverId(action.bookingLocalId);
    const depositAction = action.type === "deposit_update";
    const path = depositAction ? `/bookings/${bookingId}/deposit` : `/bookings/${bookingId}/payment-request`;
    const body = depositAction ? { deposit: action.payload.deposit, total: action.payload.total, expected_note: action.payload.expected_note } : PaymentRequest.validate(action.payload);
    const { payload } = await request(path, {
      method: depositAction ? "PATCH" : "POST",
      body,
      idempotencyKey: action.idempotencyKey,
      expectedApiBaseUrl: action.apiBaseUrl
    }, null, source);
    if (depositAction) await updateCachedBooking(source, bookingId, { note: payload.note || action.payload.new_note });
    return payload;
  }

  async function enqueuePaymentAction(source, booking, type, payload, dependsOnCommandId = null) {
    const existing = (await allActionHistory())[source] || [];
    const unresolved = existing.find((item) => item.bookingLocalId === booking.localId && ["failed", "conflict", "needs_attention"].includes(item.status));
    if (unresolved) throw previousMutationError(unresolved);
    const timestamp = new Date().toISOString();
    const apiBaseUrl = normalizeBaseUrl((await allSettings())[source]?.apiBaseUrl);
    const id = crypto.randomUUID();
    const action = { id, type, bookingLocalId: booking.localId, resourceId: booking.resourceId, payload: canonicalValue(payload), apiBaseUrl, idempotencyKey: id, dependsOnCommandId, status: "queued", attempts: 0, availableAt: timestamp, result: null, errorCode: null, errorMessage: null, createdAt: timestamp, updatedAt: timestamp, completedAt: null };
    await addAction(source, action);
    await confirmedQueuedAction(source, action.id);
    const confirmed = ((await allActionHistory())[source] || []).find((item) => item.id === action.id);
    return confirmed || action;
  }

  async function confirmedQueuedAction(source, actionId) {
    await processPaymentQueue(source);
    const actions = (await allActionHistory())[source] || [];
    const action = actions.find((item) => item.id === actionId);
    if (!action) throw Object.assign(new Error("Acțiunea nu mai există în istoricul local."), { code: "action_missing", permanent: true });
    if (action.status === "synced") return action.result;
    const dependency = action.dependsOnCommandId ? actions.find((item) => item.id === action.dependsOnCommandId) : null;
    if (dependency && !["queued", "sending", "synced"].includes(dependency.status)) throw previousMutationError(dependency);
    if (["failed", "conflict", "needs_attention", "cancelled"].includes(action.status)) {
      throw Object.assign(new Error(action.errorMessage || "Operația nu a fost confirmată de WordPress."), {
        code: action.errorCode || "request_failed",
        conflict: action.status === "conflict",
        permanent: true,
        actionId: action.id
      });
    }
    throw Object.assign(new Error(action.errorMessage || "Operația nu a fost confirmată de WordPress."), {
      code: action.errorCode || "confirmation_pending",
      temporary: true,
      queued: true,
      actionId: action.id
    });
  }

  function scheduleActionQueue(source, delay = 0) {
    const due = Date.now() + Math.max(0, Number(delay) || 0);
    const existing = actionQueueTimers.get(source);
    if (existing && existing.due <= due) return;
    if (existing) window.clearTimeout(existing.id);
    const id = window.setTimeout(() => {
      actionQueueTimers.delete(source);
      void processPaymentQueue(source);
    }, Math.max(0, due - Date.now()));
    actionQueueTimers.set(source, { id, due });
  }

  function queuedAction(actions, timestamp = Date.now()) {
    return actions.find((candidate, index) => {
      if (locallyOwnedActions.has(candidate.id)) return false;
      if (candidate.status !== "queued" || new Date(candidate.availableAt || candidate.createdAt).getTime() > timestamp) return false;
      if (candidate.dependsOnCommandId && actions.find((item) => item.id === candidate.dependsOnCommandId)?.status !== "synced") return false;
      if (candidate.bookingLocalId && actions.slice(0, index).some((item) => item.id !== candidate.id
        && item.bookingLocalId === candidate.bookingLocalId
        && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status)
      )) return false;
      return true;
    });
  }

  async function recoverActionQueue(source) {
    if (actionQueuesRecovered.has(source)) return;
    actionQueuesRecovered.add(source);
    await updateActionHistory(source, (items) => items.map((item) => item.status === "sending"
      ? (item.apiBaseUrl && item.idempotencyKey
        ? { ...item, status: "queued", availableAt: new Date().toISOString(), errorCode: "restart_recovery", errorMessage: "Operația întreruptă va fi reluată cu aceeași cheie de idempotență.", updatedAt: new Date().toISOString() }
        : { ...item, status: "failed", errorCode: "queue_metadata_missing", errorMessage: "Operația veche nu poate fi reluată sigur deoarece nu are ținta API și cheia de idempotență salvate.", updatedAt: new Date().toISOString() })
      : item));
    await emitCurrentState(source);
  }

  async function processPaymentQueue(source = currentSource) {
    if (paymentQueuePumps.has(source)) return paymentQueuePumps.get(source);
    const operation = (async () => {
      const settings = (await allSettings())[source];
      if (!settings?.apiBaseUrl || !settings?.username || !await passwordFor(source)) return;
      await recoverActionQueue(source);
      while (true) {
        const actions = ((await allActionHistory())[source] || []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const action = queuedAction(actions);
        if (!action) {
          const nextAt = actions.filter((item) => item.status === "queued").map((item) => new Date(item.availableAt || item.createdAt).getTime()).filter((value) => Number.isFinite(value) && value > Date.now()).sort((a, b) => a - b)[0];
          if (nextAt) scheduleActionQueue(source, nextAt - Date.now());
          return;
        }
        let started = false;
        try {
          const mutationKey = action.bookingLocalId ? `booking:${source}:${action.bookingLocalId}` : `create:${source}`;
          await serializeMutation(mutationKey, async () => {
            started = true;
            await updateAction(source, action.id, { status: "sending", attempts: Number(action.attempts || 0) + 1, updatedAt: new Date().toISOString() });
            try {
              const response = await executeQueuedAction(source, action);
              const completedAt = new Date().toISOString();
              await updateAction(source, action.id, { status: "synced", result: canonicalValue(response), errorCode: null, errorMessage: null, completedAt, updatedAt: completedAt });
            } catch (error) {
              const failure = queuedFailure(action, error);
              const delay = retryDelayMs(failure.attempt, error.retryAfter);
              await updateAction(source, action.id, {
                status: failure.status,
                availableAt: failure.retry ? new Date(Date.now() + delay).toISOString() : action.availableAt,
                errorCode: failure.limitReached ? "automatic_retry_limit_reached" : error.code || "request_failed",
                errorMessage: failure.limitReached ? `${error.message || "Acțiunea nu a putut fi finalizată."} Acțiunea a fost oprită după două încercări.` : error.message || "Acțiunea nu a putut fi finalizată.",
                completedAt: failure.retry ? null : new Date().toISOString(),
                updatedAt: new Date().toISOString()
              });
              if (failure.retry) scheduleActionQueue(source, delay);
              throw error;
            }
          });
        } catch (error) {
          if (!started) {
            const completedAt = new Date().toISOString();
            await updateAction(source, action.id, {
              status: "failed",
              errorCode: error.code || "previous_action_failed",
              errorMessage: error.message || "Acțiunea anterioară pentru acest client nu a fost finalizată.",
              completedAt,
              updatedAt: completedAt
            });
          }
          return;
        }
      }
    })();
    paymentQueuePumps.set(source, operation);
    try { return await operation; }
    finally {
      if (paymentQueuePumps.get(source) === operation) paymentQueuePumps.delete(source);
      const actions = ((await allActionHistory())[source] || []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      if (queuedAction(actions)) scheduleActionQueue(source, 0);
    }
  }

  async function cacheCreatedBooking(source, bookingId, input) {
    await mutateJson(CACHE_KEY, defaultCache, (cache) => {
      const sourceCache = cache[source] || defaultCache()[source];
      const bookings = sourceCache.bookings || [];
      if (!bookings.some((booking) => Number(booking.serverId) === Number(bookingId))) {
        const dates = [...new Set(input.dates.map((date) => String(date).slice(0, 10)))].sort();
        bookings.push({
          localId: `server:${bookingId}`,
          serverId: Number(bookingId),
          externalId: input.externalId,
          resourceId: Number(input.resourceId),
          dates,
          startDate: dates[0] || "",
          endDate: dates.at(-1) || "",
          status: input.approved ? "approved" : "pending",
          trashed: false,
          note: String(input.note || ""),
          formData: canonicalValue(input.formData),
          syncState: "synced",
          updatedAt: new Date().toISOString()
        });
      }
      sourceCache.bookings = bookings;
      cache[source] = sourceCache;
    });
    if (source === currentSource) emit(await configuredState(true, false));
  }

  async function pendingCreates() {
    return readJson(PENDING_CREATES_KEY, defaultPendingCreates);
  }

  async function savePendingCreate(source, pending) {
    await mutateJson(PENDING_CREATES_KEY, defaultPendingCreates, (values) => {
      const items = values[source] || [];
      const index = items.findIndex((item) => item.externalId === pending.externalId);
      if (index >= 0) items[index] = pending;
      else items.push(pending);
      values[source] = items;
    });
  }

  async function removePendingCreate(source, externalId) {
    await mutateJson(PENDING_CREATES_KEY, defaultPendingCreates, (values) => {
      values[source] = (values[source] || []).filter((item) => item.externalId !== externalId);
    });
  }

  async function bookingByExternalId(externalId, source, expectedApiBaseUrl) {
    try {
      const { payload } = await request(`/bookings/by-external-id/${encodeURIComponent(externalId)}`, { expectedApiBaseUrl }, null, source);
      return normalizeBooking(payload.booking || payload);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async function executeCreateAction(source, action) {
    const input = action.payload;
    const stayTimes = source === "camping" ? { checkIn: "14:00:01", checkOut: "12:00:02" } : {};
    const dates = window.BookingCalendar.toStayDateTimes(input.dates, stayTimes);
    const signature = action.signature || createOperationSignature({ source, apiBaseUrl: action.apiBaseUrl, ...input, dates });
    const existing = (await pendingCreates())[source]?.find((item) => item.signature === signature || item.externalId === action.idempotencyKey);
    const pending = existing || { signature, externalId: action.idempotencyKey, noteKey: action.noteIdempotencyKey, serverId: null };
    if (!pending.noteKey) throw Object.assign(new Error("Crearea salvată nu conține cheia necesară pentru nota rezervării."), { code: "queue_metadata_missing", permanent: true });
    await savePendingCreate(source, pending);

    let payload = {};
    let booking = pending.serverId ? { serverId: pending.serverId } : null;
    if (!booking) booking = await bookingByExternalId(pending.externalId, source, action.apiBaseUrl);
    if (!booking) {
      try {
        ({ payload } = await request("/bookings", {
          method: "POST",
          idempotencyKey: pending.externalId,
          expectedApiBaseUrl: action.apiBaseUrl,
          retry: false,
          body: { resource_id: input.resourceId, dates, form_data: canonicalValue(input.formData), booking_form_type: input.bookingFormType || "", note: String(input.note || ""), approved: Boolean(input.approved), send_email: Boolean(input.sendEmail), external_id: pending.externalId }
        }, null, source));
      } catch (error) {
        try { booking = await bookingByExternalId(pending.externalId, source, action.apiBaseUrl); } catch {}
        if (!booking) throw error;
      }
    }
    const createdServerId = booking?.serverId || serverIdFromPayload(payload);
    if (!createdServerId) {
      booking = await bookingByExternalId(pending.externalId, source, action.apiBaseUrl);
      if (!booking?.serverId) throw Object.assign(new Error("Crearea a reușit fără un ID de rezervare verificabil."), { code: "invalid_create_response", unknownOutcome: true, temporary: true });
    }
    pending.serverId = booking?.serverId || createdServerId;
    if (payload.note_saved === true) pending.noteSaved = true;
    await savePendingCreate(source, pending);
    if (pending.noteSaved !== true) {
      await request(`/bookings/${pending.serverId}/note`, { method: "POST", body: { note: String(input.note || "") }, idempotencyKey: pending.noteKey, expectedApiBaseUrl: action.apiBaseUrl }, null, source);
    }
    await refreshAfterMutation(source, currentRange);
    await cacheCreatedBooking(source, pending.serverId, { ...input, externalId: pending.externalId });
    await removePendingCreate(source, pending.externalId);
    return {
      localId: `server:${pending.serverId}`,
      serverId: Number(pending.serverId),
      resourceId: Number(input.resourceId),
      dates: [...input.dates],
      startDate: input.dates[0] || "",
      endDate: input.dates.at(-1) || ""
    };
  }

  function executeQueuedAction(source, action) {
    if (!action.apiBaseUrl || !action.idempotencyKey) {
      throw Object.assign(new Error("Acțiunea veche nu conține ținta API și cheia de idempotență necesare pentru reluare sigură."), { code: "queue_metadata_missing", permanent: true });
    }
    if (action.type === "create") return executeCreateAction(source, action);
    if (action.type === "edit") return executeEditAction(source, action);
    if (["status", "note", "trash"].includes(action.type)) return executeSimpleAction(source, action);
    if (["deposit_update", "payment_request"].includes(action.type)) return executePaymentAction(source, action);
    throw Object.assign(new Error("Tipul acțiunii din coadă nu este recunoscut."), { code: "unsupported_queue_action", permanent: true });
  }

  async function marinaCachedBooking(localId) { return (await allCache()).marina.bookings.find((booking) => booking.localId === String(localId)); }
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
      ...(booking.price ? { price: booking.price } : {}),
      version: booking.version
    };
  }
  async function storeMarinaMutationBooking(rawBooking, options = {}) {
    const cache = await allCache();
    const normalized = normalizeMarinaBookingRecord(rawBooking, cache.marina.resources);
    if (Object.prototype.hasOwnProperty.call(options, "noteOverride")) {
      const noteOverride = String(options.noteOverride ?? "");
      marinaNoteOverrides.set(normalized.providerId, noteOverride);
      normalized.note = noteOverride;
    }
    await mutateJson(CACHE_KEY, defaultCache, (nextCache) => {
      const bookings = nextCache.marina.bookings || [];
      const index = bookings.findIndex((booking) => booking.localId === normalized.localId);
      if (index === -1) bookings.push(normalized);
      else bookings[index] = normalized;
      nextCache.marina.bookings = bookings;
      nextCache.marina.updatedAt = new Date().toISOString();
    });
    if (currentSource === "marina") emit(await configuredState(true, false, "marina"));
    return normalized;
  }
  function scheduleMarinaRefresh() {
    if (!currentRange) return;
    const range = { ...currentRange };
    void refresh(range).catch(() => {});
  }
  async function marinaProviderResourceId(resourceId) {
    const resource = (await allCache()).marina.resources.find((item) => Number(item.id) === Number(resourceId));
    if (!resource) throw Object.assign(new Error("Resursa Marina nu mai este disponibilă."), { code: "marina_resource_missing", permanent: true });
    const providerId = Number(resource.providerId);
    if (!Number.isSafeInteger(providerId) || providerId < 1) throw Object.assign(new Error("Identificatorul resursei Marina este invalid."), { code: "marina_resource_id_invalid", permanent: true });
    return providerId;
  }
  async function marinaMutation(path, body, { method = "POST", version } = {}) {
    const headers = { "Idempotency-Key": crypto.randomUUID() };
    if (version !== undefined && version !== null) headers["If-Match"] = String(version);
    const versionedBody = version !== undefined && version !== null && (method === "PATCH" || path.endsWith("/status"))
      ? { ...body, expected_version: Number(version) }
      : body;
    const result = await marinaRequest(path, { method, body: versionedBody, headers });
    return result?.data || result?.booking || result;
  }
  async function marinaQuoteBody(input) {
    const period = marinaStayPeriod(input.dates);
    if (!period) throw Object.assign(new Error("Cotația Marina necesită cel puțin o dată."), { code: "marina_quote_dates_missing", permanent: true });
    return {
      resource_id: await marinaProviderResourceId(input.resourceId),
      periods: [{ ...period, units: 1 }],
      guests: {
        adults: Number(input.formData?.visitors?.value) || 1,
        children: Number(input.formData?.children?.value) || 0
      }
    };
  }
  async function marinaBookingBody(input) {
    const body = await marinaQuoteBody(input);
    body.customer = customerFromFormData(input.formData);
    body.custom_fields = {};
    body.internal_note = String(input.note || "");
    if (input.quoteId) body.quote_id = String(input.quoteId);
    return body;
  }
  function marinaPricingChanged(current, next) {
    const datesEqual = JSON.stringify([...new Set(current.dates || [])].map((value) => String(value).slice(0, 10)).sort()) === JSON.stringify([...new Set(next.dates || [])].map((value) => String(value).slice(0, 10)).sort());
    const adultsEqual = (Number(current.formData?.visitors?.value) || 1) === (Number(next.formData?.visitors?.value) || 1);
    const childrenEqual = (Number(current.formData?.children?.value) || 0) === (Number(next.formData?.children?.value) || 0);
    return Number(current.resourceId) !== Number(next.resourceId) || !datesEqual || !adultsEqual || !childrenEqual;
  }
  async function marinaBookingPatchBody(current, patch) {
    const merged = { ...current, ...patch, formData: patch.formData || current.formData, dates: patch.dates || current.dates };
    const body = {};
    if (marinaPricingChanged(current, merged)) {
      const quote = await marinaQuoteBody(merged);
      body.resource_id = quote.resource_id;
      body.periods = quote.periods;
      body.guests = quote.guests;
      if (patch.quoteId) body.quote_id = String(patch.quoteId);
    }
    const previousCustomer = customerFromFormData(current.formData);
    const nextCustomer = customerFromFormData(merged.formData);
    if (JSON.stringify(previousCustomer) !== JSON.stringify(nextCustomer)) body.customer = nextCustomer;
    if (String(current.note || "") !== String(merged.note || "")) body.internal_note = String(merged.note || "");
    return body;
  }

  window.marina = Object.freeze({
    platform: "android",
    connectMarina,
    disconnectMarina,
    setSource(source) {
      if (!SOURCES.has(source)) throw new TypeError("Sursa rezervărilor este invalidă.");
      currentSource = source;
      requestGeneration += 1;
      scheduleActionQueue(source, 0);
    },
    async bootstrap(range) {
      checkForMobileUpdateOnce();
      currentRange = range;
      await recoverActionQueue(currentSource);
      const connection = connectionFor();
      const state = await configuredState(connection.online, connection.authPaused);
      scheduleActionQueue(currentSource, 0);
      return state;
    },
    refresh,
    async getBooking(id) {
      const source = currentSource;
      const cached = (await allCache())[source]?.bookings?.find((booking) => booking.localId === String(id)) || null;
      if (source !== "marina" || !cached) return cached;
      const bookingPayload = await marinaRequest(`/v1/bookings/${encodeURIComponent(cached.providerId)}`);
      const record = bookingPayload?.data?.booking || bookingPayload?.data || bookingPayload?.booking || bookingPayload;
      const resources = (await allCache()).marina.resources;
      const detailed = normalizeMarinaBookingRecord({ ...record, id: record?.id ?? cached.providerId }, resources);
      const hasInternalNote = Object.prototype.hasOwnProperty.call(record || {}, "internal_note");
      const hasNoteOverride = marinaNoteOverrides.has(cached.providerId);
      const noteOverride = hasNoteOverride ? marinaNoteOverrides.get(cached.providerId) : null;
      if (hasNoteOverride) {
        if (hasInternalNote && detailed.note === noteOverride) marinaNoteOverrides.delete(cached.providerId);
        else detailed.note = noteOverride;
      }
      const notesPromise = hasNoteOverride || hasInternalNote || detailed.note || cached.note
        ? Promise.resolve([])
        : fetchMarinaNotes(cached.providerId).catch(() => []);
      const merge = (noteValues) => ({
        ...cached,
        ...detailed,
        resourceId: detailed.providerResourceId ? detailed.resourceId : cached.resourceId,
        providerResourceId: detailed.providerResourceId || cached.providerResourceId,
        dates: detailed.dates.length ? detailed.dates : cached.dates,
        note: (hasInternalNote ? [detailed.note] : [detailed.note || cached.note, ...(!detailed.note && !cached.note ? noteValues : [])])
          .map((value) => String(value || "").trim())
          .filter((value, index, values) => value && values.indexOf(value) === index)
          .join("\n\n")
      });
      let merged = merge([]);
      await mutateJson(CACHE_KEY, defaultCache, (cache) => {
        cache.marina.bookings = cache.marina.bookings.map((booking) => booking.localId === merged.localId ? merged : booking);
        cache.marina.updatedAt = new Date().toISOString();
      });
      if (currentSource === "marina") emit(await configuredState(true, false, "marina"));
      const fetchedNotes = await notesPromise;
      const withNotes = merge(fetchedNotes);
      if (withNotes.note !== merged.note) {
        merged = withNotes;
        await mutateJson(CACHE_KEY, defaultCache, (cache) => {
          cache.marina.bookings = cache.marina.bookings.map((booking) => booking.localId === merged.localId ? merged : booking);
          cache.marina.updatedAt = new Date().toISOString();
        });
        if (currentSource === "marina") emit(await configuredState(true, false, "marina"));
      }
      return merged;
    },
    async createBooking(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      if (source === "marina") {
        if (!input.quoteId) throw Object.assign(new Error("Rezervarea Marina necesită o cotație confirmată."), { code: "marina_quote_required", permanent: true });
        const quotePayload = await marinaRequest("/v1/quotes", { method: "POST", body: await marinaQuoteBody(input) });
        const finalQuote = normalizeMarinaQuote(quotePayload, { mode: "full" });
        const body = await marinaBookingBody({ ...input, quoteId: finalQuote.quoteId });
        body.status = input.approved ? "approved" : "pending";
        const created = await marinaMutation("/v1/bookings", body);
        const id = created?.id ?? created?.booking_id;
        const createdRecord = { ...body, ...created, id };
        if (!String(createdRecord.note || createdRecord.internal_note || "").trim() && body.internal_note) createdRecord.internal_note = body.internal_note;
        const normalized = await storeMarinaMutationBooking(createdRecord, { noteOverride: body.internal_note });
        scheduleMarinaRefresh();
        return normalized;
      }
      const stayTimes = source === "camping" ? { checkIn: "14:00:01", checkOut: "12:00:02" } : {};
      const dates = window.BookingCalendar.toStayDateTimes(input.dates, stayTimes);
      const inFlightKey = JSON.stringify(canonicalValue({ source, ...input, dates }));
      const inFlight = inFlightCreates.get(inFlightKey);
      if (inFlight) return inFlight;
      const operation = (async () => {
        const apiBaseUrl = normalizeBaseUrl((await allSettings())[source]?.apiBaseUrl);
        const signature = createOperationSignature({ source, apiBaseUrl, ...input, dates });
        const unresolved = ((await allActionHistory())[source] || []).find((item) => item.type === "create" && item.signature === signature && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status));
        if (unresolved) throw previousMutationError(unresolved);
        return trackedMutation({ source, key: `create:${source}`, type: "create", resourceId: input.resourceId, payload: input, apiBaseUrl, signature }, (action) => executeCreateAction(source, action));
      })();
      inFlightCreates.set(inFlightKey, operation);
      try { return await operation; }
      finally { if (inFlightCreates.get(inFlightKey) === operation) inFlightCreates.delete(inFlightKey); }
    },
    async editBooking(id, patch) {
      const source = SOURCES.has(patch?.source) ? patch.source : currentSource;
      assertWritableSource(source);
      if (source === "marina") {
        const booking = await marinaCachedBooking(id);
        if (!booking) throw new Error("Rezervarea Marina nu există în cache.");
        const merged = { ...booking, ...patch, formData: patch.formData || booking.formData, dates: patch.dates || booking.dates };
        const repricing = marinaPricingChanged(booking, merged);
        if (repricing && !patch.quoteId) throw Object.assign(new Error("Modificarea prețului Marina necesită o cotație nouă."), { code: "marina_quote_required", permanent: true });
        const finalPatch = repricing
          ? { ...patch, quoteId: normalizeMarinaQuote(await marinaRequest("/v1/quotes", { method: "POST", body: await marinaQuoteBody(merged) }), { mode: "full" }).quoteId }
          : patch;
        const body = await marinaBookingPatchBody(booking, finalPatch);
        const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, body, { method: "PATCH", version: booking.version });
        const hasNoteMutation = Object.prototype.hasOwnProperty.call(body, "internal_note");
        const noteOverride = hasNoteMutation ? String(body.internal_note ?? "") : undefined;
        const normalized = await storeMarinaMutationBooking({ ...marinaBookingSnapshot(booking), ...body, ...result, ...(hasNoteMutation ? { internal_note: noteOverride } : {}), id: booking.providerId }, hasNoteMutation ? { noteOverride } : {});
        scheduleMarinaRefresh();
        return normalized;
      }
      const bookingId = serverId(id);
      const requestedFormData = BookingFields.prepareFormData(patch.formData, patch.sourceResourceId);
      const editIntent = captureEditIntent(await cachedBooking(source, bookingId), patch, requestedFormData);
      const mutationPatch = { ...patch, formData: requestedFormData };
      const apiBaseUrl = normalizeBaseUrl((await allSettings())[source]?.apiBaseUrl);
      return trackedMutation({ source, key: `booking:${source}:${bookingId}`, type: "edit", bookingLocalId: id, resourceId: patch.resourceId, payload: mutationPatch, apiBaseUrl, editIntent }, (action) => executeEditAction(source, action));
    },
    setStatus: async (id, patch) => { const source = SOURCES.has(patch?.source) ? patch.source : currentSource; assertWritableSource(source); if (source === "marina") { const booking = await marinaCachedBooking(id); const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}/status`, { status: patch.status }, { version: booking.version }); const normalized = await storeMarinaMutationBooking({ ...marinaBookingSnapshot(booking), status: patch.status, ...result, id: booking.providerId }); scheduleMarinaRefresh(); return normalized; } return mutate(id, "/status", { status: patch.status, send_email: Boolean(patch.sendEmail) }, source); },
    setNote: async (id, patch) => { const source = SOURCES.has(patch?.source) ? patch.source : currentSource; assertWritableSource(source); if (source === "marina") { const booking = await marinaCachedBooking(id); const note = String(patch.note ?? ""); const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, { internal_note: note }, { method: "PATCH", version: booking.version }); const normalized = await storeMarinaMutationBooking({ ...marinaBookingSnapshot(booking), ...(String(result?.id) === booking.providerId ? result : {}), internal_note: note, id: booking.providerId }, { noteOverride: note }); scheduleMarinaRefresh(); return normalized; } return mutate(id, "/note", { note: String(patch.note || "") }, source); },
    setTrash: async (id, patch) => { const source = SOURCES.has(patch?.source) ? patch.source : currentSource; assertWritableSource(source); if (source === "marina") { if (!patch.trashed) throw Object.assign(new Error("Rezervarea Marina anulată nu poate fi restaurată din calendar."), { code: "marina_restore_unsupported", permanent: true }); const booking = await marinaCachedBooking(id); const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}/cancel`, {}, { version: booking.version }); const normalized = await storeMarinaMutationBooking({ ...marinaBookingSnapshot(booking), status: "cancelled", ...result, id: booking.providerId }); scheduleMarinaRefresh(); return normalized; } return mutate(id, "/trash", { trash: Boolean(patch.trashed), send_email: Boolean(patch.sendEmail) }, source); },
    async getPayment(id, input = {}) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertReadableSource(source);
      if (source === "marina") {
        const booking = await marinaCachedBooking(id);
        if (!booking) throw Object.assign(new Error("Rezervarea Marina nu există în cache."), { code: "marina_booking_missing", permanent: true });
        const payload = await marinaRequest(`/v1/bookings/${encodeURIComponent(booking.providerId)}`);
        const snapshot = normalizeMarinaPayment(payload, {
          bookingId: booking.providerId,
          fallbackNote: booking.note,
          fallbackEmail: BookingFields.value(booking, "email")
        });
        if (marinaNoteOverrides.has(booking.providerId)) snapshot.note = marinaNoteOverrides.get(booking.providerId);
        return snapshot;
      }
      return request(`/bookings/${serverId(id)}/payment`, {}, null, source).then(({ payload }) => payload);
    },
    async updateDeposit(id, input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      if (source === "marina") {
        const booking = await marinaCachedBooking(id);
        if (!booking) throw Object.assign(new Error("Rezervarea Marina nu există în cache."), { code: "marina_booking_missing", permanent: true });
        const deposit = Number(input.deposit);
        const total = Number(input.total);
        if (!Number.isFinite(deposit) || !Number.isFinite(total) || deposit < 0 || total <= 0 || deposit > total) throw new Error("Avansul trebuie să fie între zero și costul rezervării.");
        const latestPayload = await marinaRequest(`/v1/bookings/${encodeURIComponent(booking.providerId)}`);
        const latestRecord = latestPayload?.data?.booking || latestPayload?.data || latestPayload?.booking || latestPayload || {};
        const customFields = marinaCustomFieldsWithDeposit(latestPayload, { deposit, total });
        const currentNote = String(marinaNoteOverrides.has(booking.providerId)
          ? marinaNoteOverrides.get(booking.providerId)
          : input.note ?? booking.note ?? "");
        const nextNote = PricingNote.update(currentNote, deposit, total).note;
        const body = { custom_fields: customFields, internal_note: nextNote };
        const result = await marinaMutation(`/v1/bookings/${encodeURIComponent(booking.providerId)}`, body, { method: "PATCH", version: latestRecord.version ?? booking.version });
        const returnedCustomFields = {
          ...customFields,
          ...(result?.custom_fields || result?.customFields || {}),
          [MANUAL_DEPOSIT_FIELD]: customFields[MANUAL_DEPOSIT_FIELD]
        };
        const payment = normalizeMarinaPayment({ data: { ...result, custom_fields: returnedCustomFields, note: nextNote, internal_note: nextNote } }, {
          bookingId: booking.providerId,
          fallbackNote: nextNote,
          fallbackEmail: BookingFields.value(booking, "email")
        });
        const updatedNote = nextNote;
        const normalized = await storeMarinaMutationBooking({
          ...marinaBookingSnapshot(booking),
          ...result,
          custom_fields: returnedCustomFields,
          price: result?.price || latestRecord.price || booking.price,
          internal_note: updatedNote,
          id: booking.providerId
        }, { noteOverride: updatedNote });
        scheduleMarinaRefresh();
        return { ...payment, booking_id: payment.booking_id ?? booking.providerId, deposit: payment.deposit ?? deposit, total: payment.total ?? total, note: normalized.note, localId: normalized.localId };
      }
      const booking = await cachedBooking(source, serverId(id));
      if (!booking) throw new Error("Rezervarea nu există în cache.");
      const actions = (await allActionHistory())[source] || [];
      const unresolved = actions.find((item) => item.bookingLocalId === id && ["failed", "conflict", "needs_attention"].includes(item.status));
      if (unresolved) throw previousMutationError(unresolved);
      if (actions.some((item) => item.bookingLocalId === id && ["deposit_update", "payment_request"].includes(item.type) && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status))) throw new Error("Există deja o operație de plată nesincronizată pentru această rezervare.");
      const authoritativeNote = String(input.note ?? booking.note ?? "");
      const pricing = PricingNote.parse(authoritativeNote);
      if (!pricing) throw new Error("Nota rezervării nu conține un Cost valid.");
      const authoritativeTotal = Number(input.total ?? pricing.total);
      if (!Number.isFinite(authoritativeTotal) || Math.abs(authoritativeTotal - pricing.total) > 0.005) throw new Error("Costul verificat nu corespunde notei WordPress.");
      const updated = PricingNote.update(authoritativeNote, Number(input.deposit), authoritativeTotal);
      return enqueuePaymentAction(source, booking, "deposit_update", { deposit: updated.deposit, total: updated.total, expected_note: authoritativeNote, new_note: updated.note });
    },
    async requestPayment(id, input = {}) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      if (source === "marina") throw Object.assign(new Error("API-ul Marina nu expune operațiuni de plată în contractul integrat."), { code: "marina_feature_unsupported", permanent: true });
      const paymentRequest = PaymentRequest.validate(input);
      const booking = await cachedBooking(source, serverId(id));
      if (!booking) throw new Error("Rezervarea nu există în cache.");
      const actions = (await allActionHistory())[source] || [];
      if (actions.some((item) => item.bookingLocalId === id && item.type === "payment_request" && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status))) throw new Error("Există deja un email de plată nesincronizat.");
      const unresolvedDeposit = actions.find((item) => item.bookingLocalId === id && item.type === "deposit_update" && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status));
      if (unresolvedDeposit && ["failed", "conflict", "needs_attention"].includes(unresolvedDeposit.status)) throw new Error("Actualizarea avansului are o problemă. Reîncearcă sau anulează modificarea înainte de trimiterea emailului.");
      const unresolved = actions.find((item) => item.bookingLocalId === id && !["deposit_update", "payment_request"].includes(item.type) && ["failed", "conflict", "needs_attention"].includes(item.status));
      if (unresolved) throw previousMutationError(unresolved);
      const dependency = unresolvedDeposit;
      return enqueuePaymentAction(source, booking, "payment_request", paymentRequest, dependency?.id || null);
    },
    checkAvailability(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      if (source === "marina") return (async () => { const period = marinaAvailabilityPeriod(input.dates); if (!period) throw Object.assign(new Error("Intervalul Marina este invalid."), { code: "marina_invalid_dates", permanent: true }); const body = { resource_id: await marinaProviderResourceId(input.resourceId), periods: [period], units: 1 }; const payload = await marinaRequest("/v1/availability/check", { method: "POST", body }); return payload?.data && typeof payload.data === "object" ? payload.data : payload; })();
      const body = { resource_id: Number(input.resourceId), dates: input.dates };
      if (input.excludeBookingId !== undefined && input.excludeBookingId !== null) body.exclude_booking_id = Number(input.excludeBookingId);
      return request("/availability", { method: "POST", body, readOnly: true }, null, source).then(({ payload }) => {
        if (typeof payload?.available !== "boolean") throw Object.assign(new Error("Endpoint-ul disponibilității a returnat un răspuns incomplet."), { code: "invalid_availability_response", permanent: true, payload });
        return payload;
      });
    },
    async quoteBooking(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      if (source === "marina") {
        const payload = await marinaRequest("/v1/quotes", { method: "POST", body: await marinaQuoteBody(input) });
        return normalizeMarinaQuote(payload, { mode: input.mode || "full" });
      }
      const formData = BookingFields.prepareFormData(input.formData, input.sourceResourceId);
      const key = JSON.stringify(canonicalValue({ source, resourceId: input.resourceId, dates: [...input.dates].sort(), formData, bookingFormType: input.bookingFormType, mode: input.mode }));
      const cached = input.forceFresh ? null : quoteCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const { payload, headers } = await request("/prices/calculate", { method: "POST", body: { resource_id: input.resourceId, dates: [...new Set(input.dates)].sort(), form_data: formData, booking_form_type: input.bookingFormType || "", mode: input.mode || "fast" }, readOnly: true }, null, source);
      const quote = normalizeMobilePriceQuote(payload, headers);
      quoteCache.set(key, { value: quote, expiresAt: Date.now() + (input.mode === "full" ? 15000 : 30000) });
      return quote;
    },
    clearQuoteCache() { quoteCache.clear(); },
    async retryCommand(id) {
      assertWritableSource(currentSource);
      const actions = (await allActionHistory())[currentSource] || [];
      const action = actions.find((item) => item.id === id);
      if (!action || !["create", "edit", "status", "note", "trash", "deposit_update", "payment_request"].includes(action.type)) throw new Error("Această acțiune nu poate fi reîncercată pe telefon.");
      if (!action.apiBaseUrl || !action.idempotencyKey) throw Object.assign(new Error("Acțiunea veche nu conține datele necesare pentru o reîncercare sigură."), { code: "queue_metadata_missing", permanent: true });
      const currentApiBaseUrl = normalizeBaseUrl((await allSettings())[currentSource]?.apiBaseUrl);
      if (currentApiBaseUrl !== action.apiBaseUrl) throw endpointChangedError("POST");
      await updateAction(currentSource, id, { status: "queued", availableAt: new Date().toISOString(), errorCode: null, errorMessage: null, completedAt: null, updatedAt: new Date().toISOString() });
      scheduleActionQueue(currentSource, 0);
    },
    async clearFailedCommands() {
      const source = currentSource;
      assertWritableSource(source);
      const snapshot = (await allActionHistory())[source] || [];
      const failures = snapshot.filter((item) => ["failed", "conflict", "needs_attention"].includes(item.status));
      if (!failures.length) return 0;
      const failedPaymentBookings = [...new Set(failures.filter((item) => ["deposit_update", "payment_request"].includes(item.type)).map((item) => item.bookingLocalId).filter(Boolean))];
      const removedIds = new Set(failures.map((item) => item.id));
      for (const bookingLocalId of failedPaymentBookings) {
        await serializeMutation(`booking:${source}:${bookingLocalId}`, async () => {
          const actions = (await allActionHistory())[source] || [];
          const relevant = actions.filter((item) => item.bookingLocalId === bookingLocalId
            && ["deposit_update", "payment_request"].includes(item.type)
            && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status));
          for (const action of relevant) removedIds.add(action.id);
          const originalNote = relevant.filter((item) => item.type === "deposit_update").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0]?.payload?.expected_note;
          if (originalNote !== undefined) await updateCachedBooking(source, serverId(bookingLocalId), { note: originalNote, syncState: "synced" });
        });
      }
      const failedBookingIds = [...new Set(failures.map((item) => item.bookingLocalId).filter(Boolean))];
      for (const bookingLocalId of failedBookingIds) {
        const actions = (await allActionHistory())[source] || [];
        for (const action of actions) {
          if (action.bookingLocalId === bookingLocalId && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(action.status)) removedIds.add(action.id);
        }
      }
      for (const action of failures.filter((item) => item.type === "create")) {
        if (action.idempotencyKey) await removePendingCreate(source, action.idempotencyKey);
      }
      await updateActionHistory(source, (items) => items.filter((item) => !removedIds.has(item.id)));
      await emitCurrentState(source);
      return failures.length;
    },
    async revertBooking(id) {
      assertWritableSource(currentSource);
      const actions = (await allActionHistory())[currentSource] || [];
      const relevant = actions.filter((item) => item.bookingLocalId === id && ["deposit_update", "payment_request"].includes(item.type) && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status));
      if (!relevant.length) throw new Error("Nu există o operație de plată care poate fi anulată.");
      const originalNote = relevant.find((item) => item.type === "deposit_update")?.payload?.expected_note;
      for (const action of relevant) await updateAction(currentSource, action.id, { status: "cancelled", errorCode: "reverted", errorMessage: "Operația a fost anulată de utilizator.", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (originalNote !== undefined) await updateCachedBooking(currentSource, serverId(id), { note: originalNote, syncState: "synced" });
      if (currentRange && connectionFor(currentSource).online) try { await refresh(currentRange); } catch {}
      return cachedBooking(currentSource, serverId(id));
    },
    async getSettings(requestedSource = currentSource) {
      const source = SOURCES.has(requestedSource) ? requestedSource : currentSource;
      if (source === "marina") return (await configuredState(false, true, source)).settings;
      const settings = (await allSettings())[source];
      return { ...settings, credentialsConfigured: Boolean(await passwordFor(source)) };
    },
    async saveSettings(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      if (source === "marina") throw Object.assign(new Error("Configurația OAuth Marina este inclusă la construirea aplicației."), { code: "marina_settings_managed", permanent: true });
      const settings = await allSettings();
      const existingPassword = await passwordFor(source);
      if (!input.password && !existingPassword) throw new Error("Parola de aplicație este obligatorie la prima salvare.");
      settings[source] = { apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl), username: String(input.username || "").trim(), timezone: String(input.timezone || "Europe/Bucharest") };
      if (!settings[source].username) throw new Error("Utilizatorul API este obligatoriu.");
      await writeJson(SETTINGS_KEY, settings);
      if (input.password) await SecureStorage.set(`${PASSWORD_PREFIX}${source}`, String(input.password));
      const timestamp = new Date().toISOString();
      await updateActionHistory(source, (items) => items.map((item) => ["queued", "sending"].includes(item.status) && item.apiBaseUrl && item.apiBaseUrl !== settings[source].apiBaseUrl
        ? { ...item, status: "needs_attention", errorCode: "endpoint_changed", errorMessage: "Adresa API s-a schimbat; acțiunea a rămas legată de ținta inițială.", updatedAt: timestamp }
        : item));
      quoteCache.clear();
      scheduleActionQueue(source, 0);
      return { ...settings[source], credentialsConfigured: true };
    },
    async testConnection(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      assertWritableSource(source);
      if (source === "marina") { const next = await refresh(currentRange || { start: new Date().toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) }); return { ok: true, resources: next.resources.length }; }
      const override = { ...input, apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl), password: input.password || await passwordFor(source) };
      const { payload } = await request("/resources", {}, override, source);
      if (!Array.isArray(payload?.resources)) throw new Error("Endpoint-ul resurselor a returnat un format necunoscut.");
      return { ok: true, resources: payload.resources.length };
    },
    async clearCredentials(requestedSource = currentSource) {
      const source = SOURCES.has(requestedSource) ? requestedSource : currentSource;
      assertWritableSource(source);
      if (source === "marina") return (await disconnectMarina()).settings;
      const settings = await allSettings();
      settings[source] = defaultSettings()[source];
      await Promise.all([writeJson(SETTINGS_KEY, settings), SecureStorage.remove(`${PASSWORD_PREFIX}${source}`)]);
      const next = await configuredState(false, true, source);
      if (source === currentSource) emit(next);
      return next.settings;
    },
    onStateChanged(callback) { callbacks.add(callback); return () => callbacks.delete(callback); }
  });
  App.addListener("appStateChange", ({ isActive }) => {
    if (!isActive) { stopRefreshTimer(); return; }
    startRefreshTimer();
    void refreshIfConfigured({ force: true });
    scheduleActionQueue(currentSource, 0);
  });
  window.addEventListener("online", () => { void refreshIfConfigured({ force: true }); scheduleActionQueue(currentSource, 0); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { void refreshIfConfigured({ force: true }); scheduleActionQueue(currentSource, 0); }
  });
  startRefreshTimer();
  document.documentElement.classList.add("is-mobile-app");
}
