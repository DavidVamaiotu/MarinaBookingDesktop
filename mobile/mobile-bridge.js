import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Preferences } from "@capacitor/preferences";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { canonicalValue, createOperationSignature, normalizeMobilePriceQuote, retryDelayMs, scopeMobileData, serverIdFromPayload } from "../src/shared/mobile-api.js";
import { normalizeFormData } from "../src/shared/form-data.js";
import * as BookingFields from "../src/shared/booking-fields.js";
import * as PricingNote from "../src/shared/pricing-note.js";
import * as PaymentRequest from "../src/shared/payment-request.js";

const AutoUpdater = registerPlugin("AutoUpdater");
const BackgroundQueue = registerPlugin("BackgroundQueue");

if (!window.marina) {
  const SOURCES = new Set(["rooms", "camping"]);
  const SETTINGS_KEY = "marina-mobile-settings-v1";
  const CACHE_KEY = "marina-mobile-cache-v1";
  const PENDING_CREATES_KEY = "marina-mobile-pending-creates-v1";
  const ACTION_HISTORY_KEY = "marina-mobile-action-history-v1";
  const ACTION_HISTORY_LIMIT = 500;
  const PASSWORD_PREFIX = "marina-password-";
  const callbacks = new Set();
  const mutationChains = new Map();
  const inFlightCreates = new Map();
  const refreshOperations = new Map();
  const paymentQueuePumps = new Map();
  const paymentQueuesRecovered = new Set();
  const sourceConnections = new Map();
  let actionHistoryWrite = Promise.resolve();
  let backgroundQueueActivities = 0;
  let backgroundQueueTransition = Promise.resolve();
  const MOBILE_REFRESH_INTERVAL_MS = 5 * 60_000;
  const MOBILE_RECONNECT_INTERVAL_MS = 15_000;

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
    }
  });
  const defaultPendingCreates = () => ({ rooms: [], camping: [] });
  const defaultActionHistory = () => ({ rooms: [], camping: [] });

  async function readJson(key, fallback) {
    const { value } = await Preferences.get({ key });
    if (!value) return fallback();
    try { return { ...fallback(), ...JSON.parse(value) }; } catch { return fallback(); }
  }

  async function writeJson(key, value) {
    await Preferences.set({ key, value: JSON.stringify(value) });
  }

  async function allSettings() { return readJson(SETTINGS_KEY, defaultSettings); }
  async function allCache() { return readJson(CACHE_KEY, defaultCache); }
  async function allActionHistory() { return readJson(ACTION_HISTORY_KEY, defaultActionHistory); }
  async function passwordFor(source = currentSource) { return String(await SecureStorage.get(`${PASSWORD_PREFIX}${source}`) || ""); }

  function updateActionHistory(source, update) {
    const operation = actionHistoryWrite.catch(() => {}).then(async () => {
      const history = await allActionHistory();
      const items = [...(history[source] || [])];
      history[source] = update(items)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, ACTION_HISTORY_LIMIT);
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

  async function trackedMutation({ source, key, type, bookingLocalId = null, resourceId = null, payload = {} }, task) {
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
    }
    const timestamp = new Date().toISOString();
    const action = {
      id: crypto.randomUUID(),
      type,
      bookingLocalId,
      resourceId,
      payload: canonicalValue(payload),
      status: "queued",
      attempts: 0,
      result: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    };
    await addAction(source, action);
    let started = false;
    try {
      return await serializeMutation(key, async () => {
        started = true;
        await updateAction(source, action.id, { status: "sending", attempts: 1, updatedAt: new Date().toISOString() });
        try {
          const result = await task();
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
          const completedAt = new Date().toISOString();
          await updateAction(source, action.id, {
            status: "failed",
            errorCode: error.code || "request_failed",
            errorMessage: error.message || "Acțiunea nu a putut fi finalizată.",
            updatedAt: completedAt,
            completedAt
          });
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
    error.rateLimited = status === 429;
    error.temporary = error.rateLimited || status >= 500;
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
    const maxAttempts = retryable ? Math.max(1, Number(options.maxAttempts) || 3) : 1;
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
          error.rateLimited = response.status === 429;
          error.temporary = response.status === 429 || response.status >= 500;
          error.unknownOutcome = method !== "GET" && response.status >= 500;
          const retryAfter = responseHeader(response.headers, "Retry-After");
          error.retryAfter = retryAfter === null ? null : Number(retryAfter);
          error.payload = payload;
        }
      }
      if (!retryable || !error.temporary || attempt >= maxAttempts) throw error;
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
        failed: (actions[source] || []).filter((action) => action.status === "failed").length,
        lastSuccessfulSync: sourceCache.updatedAt || null
      },
      settings: sourceSettings,
      range: currentRange
    };
  }

  async function configuredState(online = false, authPaused = false, source = currentSource) {
    const [settings, cache, actions, password] = await Promise.all([allSettings(), allCache(), allActionHistory(), passwordFor(source)]);
    const result = stateFrom(cache, settings, actions, online, authPaused, source);
    result.settings = { ...result.settings, credentialsConfigured: Boolean(password) };
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

  async function refresh(range) {
    currentRange = range;
    const source = currentSource;
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
        const cache = await allCache();
        if (generation !== requestGeneration) return configuredState(true, false);
        const resources = resourcePayload.resources.map(normalizeResource);
        const resourceIds = new Set(resources.map((resource) => resource.id));
        if (resourceIds.size !== resources.length) throw Object.assign(new Error("Endpoint-ul resurselor a returnat înregistrări duplicate."), { code: "invalid_resource_record", permanent: true, payload: resourcePayload });
        const scoped = scopeMobileData(resources, bookings, source);
        const actions = (await allActionHistory())[source] || [];
        for (const action of actions) {
          if (action.type !== "deposit_update" || !["queued", "sending", "failed", "conflict", "needs_attention"].includes(action.status)) continue;
          const booking = scoped.bookings.find((item) => item.localId === action.bookingLocalId);
          if (booking && action.payload?.new_note) booking.note = action.payload.new_note;
        }
        cache[source] = {
          resources: scoped.resources,
          bookings: scoped.bookings,
          updatedAt: new Date().toISOString()
        };
        await writeJson(CACHE_KEY, cache);
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
      .then(operation, operation)
      .catch((error) => console.error("Background queue service failed:", error));
    return backgroundQueueTransition;
  }

  async function runWithBackgroundQueue(task) {
    if (Capacitor.getPlatform() !== "android") return task();
    backgroundQueueActivities += 1;
    if (backgroundQueueActivities === 1) {
      await transitionBackgroundQueue(() => BackgroundQueue.start());
    } else {
      await backgroundQueueTransition;
    }
    try {
      return await task();
    } finally {
      backgroundQueueActivities = Math.max(0, backgroundQueueActivities - 1);
      if (backgroundQueueActivities === 0) {
        await transitionBackgroundQueue(() => backgroundQueueActivities === 0 ? BackgroundQueue.stop() : undefined);
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
    const range = currentRange;
    const bookingId = serverId(id);
    const type = path === "/status" ? "status" : path === "/note" ? "note" : "trash";
    return trackedMutation({ source, key: `booking:${source}:${bookingId}`, type, bookingLocalId: id, payload: body }, async () => {
      const expectedApiBaseUrl = normalizeBaseUrl((await allSettings())[source]?.apiBaseUrl);
      const key = crypto.randomUUID();
      const { payload } = await request(`/bookings/${bookingId}${path}`, { method: "POST", body, idempotencyKey: key, expectedApiBaseUrl }, null, source);
      const patch = path === "/status" ? { status: body.status }
        : path === "/note" ? { note: body.note }
          : path === "/trash" ? { trashed: body.trash }
            : {};
      await updateCachedBooking(source, bookingId, patch);
      await refreshAfterMutation(source, range);
      return { ...payload, localId: id };
    });
  }

  async function refreshAfterMutation(source, range) {
    if (!range || source !== currentSource) return;
    try { await refresh(range); } catch {}
  }

  async function updateCachedBooking(source, bookingId, patch) {
    const cache = await allCache();
    const sourceCache = cache[source] || defaultCache()[source];
    const index = (sourceCache.bookings || []).findIndex((booking) => Number(booking.serverId) === Number(bookingId));
    if (index < 0) return;
    sourceCache.bookings[index] = { ...sourceCache.bookings[index], ...patch, updatedAt: new Date().toISOString() };
    cache[source] = sourceCache;
    await writeJson(CACHE_KEY, cache);
    if (source === currentSource) {
      const connection = connectionFor(source);
      emit(await configuredState(connection.online, connection.authPaused));
    }
  }

  async function enqueuePaymentAction(source, booking, type, payload, dependsOnCommandId = null) {
    const existing = (await allActionHistory())[source] || [];
    const unresolved = existing.find((item) => item.bookingLocalId === booking.localId && ["failed", "conflict", "needs_attention"].includes(item.status));
    if (unresolved) throw previousMutationError(unresolved);
    const timestamp = new Date().toISOString();
    const action = { id: crypto.randomUUID(), type, bookingLocalId: booking.localId, resourceId: booking.resourceId, payload: canonicalValue(payload), dependsOnCommandId, status: "queued", attempts: 0, result: null, errorCode: null, errorMessage: null, createdAt: timestamp, updatedAt: timestamp, completedAt: null };
    await addAction(source, action);
    void processPaymentQueue(source);
    return action;
  }

  async function processPaymentQueue(source = currentSource) {
    if (paymentQueuePumps.has(source)) return paymentQueuePumps.get(source);
    const operation = (async () => {
      const settings = (await allSettings())[source];
      if (!settings?.apiBaseUrl || !settings?.username || !await passwordFor(source)) return;
      if (!paymentQueuesRecovered.has(source)) {
        await updateActionHistory(source, (items) => items.map((item) => ["deposit_update", "payment_request"].includes(item.type) && item.status === "sending"
          ? { ...item, status: "queued", errorCode: "restart_recovery", errorMessage: "Operația întreruptă va fi reluată cu aceeași cheie de idempotență.", updatedAt: new Date().toISOString() }
          : item));
        paymentQueuesRecovered.add(source);
        await emitCurrentState(source);
      }
      while (true) {
        const actions = ((await allActionHistory())[source] || []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const action = actions.find((candidate) => {
          if (!["deposit_update", "payment_request"].includes(candidate.type) || candidate.status !== "queued") return false;
          if (candidate.dependsOnCommandId && actions.find((item) => item.id === candidate.dependsOnCommandId)?.status !== "synced") return false;
          if (candidate.type === "payment_request" && actions.some((item) => item.type === "deposit_update"
            && item.bookingLocalId === candidate.bookingLocalId
            && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(item.status)
            && String(item.createdAt) <= String(candidate.createdAt))) return false;
          return true;
        });
        if (!action) return;
        let started = false;
        try {
          await serializeMutation(`booking:${source}:${action.bookingLocalId}`, async () => {
            started = true;
            await updateAction(source, action.id, { status: "sending", attempts: Number(action.attempts || 0) + 1, updatedAt: new Date().toISOString() });
            try {
              const bookingId = serverId(action.bookingLocalId);
              const depositAction = action.type === "deposit_update";
              const path = depositAction ? `/bookings/${bookingId}/deposit` : `/bookings/${bookingId}/payment-request`;
              const body = depositAction ? { deposit: action.payload.deposit, total: action.payload.total, expected_note: action.payload.expected_note } : PaymentRequest.validate(action.payload);
              const { payload: response } = await request(path, { method: depositAction ? "PATCH" : "POST", body, idempotencyKey: action.id, expectedApiBaseUrl: normalizeBaseUrl(settings.apiBaseUrl) }, null, source);
              if (depositAction) await updateCachedBooking(source, bookingId, { note: response.note || action.payload.new_note });
              const completedAt = new Date().toISOString();
              await updateAction(source, action.id, { status: "synced", result: canonicalValue(response), errorCode: null, errorMessage: null, completedAt, updatedAt: completedAt });
            } catch (error) {
              const temporary = error.temporary || error.rateLimited || error.unknownOutcome;
              await updateAction(source, action.id, { status: temporary ? "queued" : (error.status === 409 || error.conflict ? "conflict" : "failed"), errorCode: error.code || "request_failed", errorMessage: error.message || "Acțiunea nu a putut fi finalizată.", updatedAt: new Date().toISOString() });
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
    finally { if (paymentQueuePumps.get(source) === operation) paymentQueuePumps.delete(source); }
  }

  async function cacheCreatedBooking(source, bookingId, input) {
    const cache = await allCache();
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
    await writeJson(CACHE_KEY, cache);
    if (source === currentSource) emit(await configuredState(true, false));
  }

  async function pendingCreates() {
    return readJson(PENDING_CREATES_KEY, defaultPendingCreates);
  }

  async function savePendingCreate(source, pending) {
    const values = await pendingCreates();
    const items = values[source] || [];
    const index = items.findIndex((item) => item.externalId === pending.externalId);
    if (index >= 0) items[index] = pending;
    else items.push(pending);
    values[source] = items;
    await writeJson(PENDING_CREATES_KEY, values);
  }

  async function removePendingCreate(source, externalId) {
    const values = await pendingCreates();
    values[source] = (values[source] || []).filter((item) => item.externalId !== externalId);
    await writeJson(PENDING_CREATES_KEY, values);
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

  window.marina = Object.freeze({
    platform: "android",
    setSource(source) {
      if (!SOURCES.has(source)) throw new TypeError("Sursa rezervărilor este invalidă.");
      currentSource = source;
      requestGeneration += 1;
    },
    async bootstrap(range) {
      checkForMobileUpdateOnce();
      currentRange = range;
      const connection = connectionFor();
      return configuredState(connection.online, connection.authPaused);
    },
    refresh,
    async createBooking(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      const range = currentRange;
      const stayTimes = source === "camping" ? { checkIn: "14:00:01", checkOut: "12:00:02" } : {};
      const dates = window.BookingCalendar.toStayDateTimes(input.dates, stayTimes);
      const apiBaseUrl = normalizeBaseUrl((await allSettings())[source]?.apiBaseUrl);
      const signature = createOperationSignature({ source, apiBaseUrl, ...input, dates });
      const inFlight = inFlightCreates.get(signature);
      if (inFlight) return inFlight;
      const operation = trackedMutation({ source, key: `create:${source}`, type: "create", resourceId: input.resourceId, payload: input }, async () => {
        const existing = (await pendingCreates())[source]?.find((item) => item.signature === signature);
        const pending = existing || { signature, externalId: crypto.randomUUID(), noteKey: crypto.randomUUID(), serverId: null };
        await savePendingCreate(source, pending);

        let payload = {};
        let booking = pending.serverId ? { serverId: pending.serverId } : null;
        if (!booking) booking = await bookingByExternalId(pending.externalId, source, apiBaseUrl);
        if (!booking) {
          await requireAvailability(source, apiBaseUrl, input.resourceId, dates);
          try {
            ({ payload } = await request("/bookings", {
              method: "POST",
              idempotencyKey: pending.externalId,
              expectedApiBaseUrl: apiBaseUrl,
              retry: false,
              body: { resource_id: input.resourceId, dates, form_data: canonicalValue(input.formData), booking_form_type: input.bookingFormType || "", approved: Boolean(input.approved), send_email: Boolean(input.sendEmail), external_id: pending.externalId }
            }, null, source));
          } catch (error) {
            try { booking = await bookingByExternalId(pending.externalId, source, apiBaseUrl); } catch {}
            if (!booking) throw error;
          }
        }
        const createdServerId = booking?.serverId || serverIdFromPayload(payload);
        if (!createdServerId) {
          booking = await bookingByExternalId(pending.externalId, source, apiBaseUrl);
          if (!booking?.serverId) throw new Error("Crearea a reușit fără un ID de rezervare verificabil.");
        }
        pending.serverId = booking?.serverId || createdServerId;
        await savePendingCreate(source, pending);
        await request(`/bookings/${pending.serverId}/note`, { method: "POST", body: { note: String(input.note || "") }, idempotencyKey: pending.noteKey, expectedApiBaseUrl: apiBaseUrl }, null, source);
        await cacheCreatedBooking(source, pending.serverId, { ...input, externalId: pending.externalId });
        await removePendingCreate(source, pending.externalId);
        await refreshAfterMutation(source, range);
        return {
          localId: `server:${pending.serverId}`,
          serverId: Number(pending.serverId),
          resourceId: Number(input.resourceId),
          dates: [...input.dates],
          startDate: input.dates[0] || "",
          endDate: input.dates.at(-1) || ""
        };
      });
      inFlightCreates.set(signature, operation);
      try { return await operation; }
      finally { if (inFlightCreates.get(signature) === operation) inFlightCreates.delete(signature); }
    },
    async editBooking(id, patch) {
      const source = SOURCES.has(patch?.source) ? patch.source : currentSource;
      const range = currentRange;
      const bookingId = serverId(id);
      const requestedFormData = BookingFields.prepareFormData(patch.formData, patch.sourceResourceId);
      const editIntent = cachedBooking(source, bookingId).then((baseBooking) => captureEditIntent(baseBooking, patch, requestedFormData));
      const mutationPatch = { ...patch, formData: requestedFormData };
      return trackedMutation({ source, key: `booking:${source}:${bookingId}`, type: "edit", bookingLocalId: id, resourceId: patch.resourceId, payload: mutationPatch }, async () => {
        const rebasedPatch = await rebaseEditPatch(source, await cachedBooking(source, bookingId), patch, await editIntent);
        const expectedApiBaseUrl = normalizeBaseUrl((await allSettings())[source]?.apiBaseUrl);
        const stayTimes = source === "camping" ? { checkIn: "14:00:01", checkOut: "12:00:02" } : {};
        const apiDates = window.BookingCalendar.toStayDateTimes(rebasedPatch.dates, stayTimes);
        await requireAvailability(source, expectedApiBaseUrl, rebasedPatch.resourceId, apiDates, bookingId);
        const editBody = { resource_id: rebasedPatch.resourceId, dates: apiDates, form_data: canonicalValue(rebasedPatch.formData), booking_form_type: rebasedPatch.bookingFormType || "", send_email: Boolean(rebasedPatch.sendEmail) };
        if (rebasedPatch.note !== undefined) editBody.note = String(rebasedPatch.note);
        const { payload } = await request(`/bookings/${bookingId}`, {
          method: "PATCH",
          idempotencyKey: crypto.randomUUID(),
          expectedApiBaseUrl,
          body: editBody
        }, null, source);
        const cachePatch = {
          resourceId: Number(rebasedPatch.resourceId),
          dates: rebasedPatch.dates,
          startDate: rebasedPatch.dates[0] || "",
          endDate: rebasedPatch.dates.at(-1) || "",
          formData: canonicalValue(rebasedPatch.formData)
        };
        if (rebasedPatch.note !== undefined) cachePatch.note = String(rebasedPatch.note);
        await updateCachedBooking(source, bookingId, cachePatch);
        await refreshAfterMutation(source, range);
        return { ...payload, localId: id, resourceId: Number(rebasedPatch.resourceId) };
      });
    },
    setStatus: (id, patch) => mutate(id, "/status", { status: patch.status, send_email: Boolean(patch.sendEmail) }, SOURCES.has(patch?.source) ? patch.source : currentSource),
    setNote: (id, patch) => mutate(id, "/note", { note: String(patch.note || "") }, SOURCES.has(patch?.source) ? patch.source : currentSource),
    setTrash: (id, patch) => mutate(id, "/trash", { trash: Boolean(patch.trashed), send_email: Boolean(patch.sendEmail) }, SOURCES.has(patch?.source) ? patch.source : currentSource),
    async getPayment(id, input = {}) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      return request(`/bookings/${serverId(id)}/payment`, {}, null, source).then(({ payload }) => payload);
    },
    async updateDeposit(id, input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
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
      await updateCachedBooking(source, booking.serverId, { note: updated.note, syncState: "queued" });
      return enqueuePaymentAction(source, booking, "deposit_update", { deposit: updated.deposit, total: updated.total, expected_note: authoritativeNote, new_note: updated.note });
    },
    async requestPayment(id, input = {}) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
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
      return request("/availability", { method: "POST", body: { resource_id: Number(input.resourceId), dates: input.dates }, readOnly: true }, null, source).then(({ payload }) => {
        if (typeof payload?.available !== "boolean") throw Object.assign(new Error("Endpoint-ul disponibilității a returnat un răspuns incomplet."), { code: "invalid_availability_response", permanent: true, payload });
        return payload;
      });
    },
    async quoteBooking(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
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
      const actions = (await allActionHistory())[currentSource] || [];
      const action = actions.find((item) => item.id === id);
      if (!action || !["deposit_update", "payment_request"].includes(action.type)) throw new Error("Această acțiune nu poate fi reîncercată pe telefon.");
      await updateAction(currentSource, id, { status: "queued", errorCode: null, errorMessage: null, updatedAt: new Date().toISOString() });
      void processPaymentQueue(currentSource);
    },
    async clearFailedCommands() {
      const source = currentSource;
      const snapshot = (await allActionHistory())[source] || [];
      const failures = snapshot.filter((item) => item.status === "failed");
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
      await updateActionHistory(source, (items) => items.filter((item) => !removedIds.has(item.id)));
      await emitCurrentState(source);
      return failures.length;
    },
    async revertBooking(id) {
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
      const settings = (await allSettings())[source];
      return { ...settings, credentialsConfigured: Boolean(await passwordFor(source)) };
    },
    async saveSettings(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      const settings = await allSettings();
      const existingPassword = await passwordFor(source);
      if (!input.password && !existingPassword) throw new Error("Parola de aplicație este obligatorie la prima salvare.");
      settings[source] = { apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl), username: String(input.username || "").trim(), timezone: String(input.timezone || "Europe/Bucharest") };
      if (!settings[source].username) throw new Error("Utilizatorul API este obligatoriu.");
      await writeJson(SETTINGS_KEY, settings);
      if (input.password) await SecureStorage.set(`${PASSWORD_PREFIX}${source}`, String(input.password));
      quoteCache.clear();
      return { ...settings[source], credentialsConfigured: true };
    },
    async testConnection(input) {
      const source = SOURCES.has(input?.source) ? input.source : currentSource;
      const override = { ...input, apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl), password: input.password || await passwordFor(source) };
      const { payload } = await request("/resources", {}, override, source);
      if (!Array.isArray(payload?.resources)) throw new Error("Endpoint-ul resurselor a returnat un format necunoscut.");
      return { ok: true, resources: payload.resources.length };
    },
    async clearCredentials(requestedSource = currentSource) {
      const source = SOURCES.has(requestedSource) ? requestedSource : currentSource;
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
    void processPaymentQueue(currentSource);
  });
  window.addEventListener("online", () => { void refreshIfConfigured({ force: true }); void processPaymentQueue(currentSource); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshIfConfigured({ force: true });
  });
  startRefreshTimer();
  document.documentElement.classList.add("is-mobile-app");
}
