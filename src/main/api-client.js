"use strict";

const { normalizeFormData } = require("../shared/form-data");

const MAX_BOOKING_PAGES = 1000;

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    Object.assign(this, options);
  }
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
  const message = payload.message || payload?.data?.message || payload.error?.message || (typeof payload.error === "string" ? payload.error : "WordPress a respins operația.");
  const errorCode = code || "api_application_error";
  const auth = status === 401 || status === 403 || /(auth|credential|forbidden|not_logged|cookie|nonce|invalid_username|incorrect_password)/i.test(errorCode);
  const requestInProgress = errorCode === "marina_booking_api_request_in_progress";
  const rateLimited = status === 429 || requestInProgress;
  const temporary = requestInProgress || rateLimited || status >= 500;
  return new ApiError(message, {
    code: errorCode,
    status,
    auth,
    rateLimited,
    retryAfter: payload?.data?.retry_after !== undefined && Number.isFinite(Number(payload.data.retry_after)) ? Number(payload.data.retry_after) : null,
    temporary,
    permanent: !temporary,
    unknownOutcome: method !== "GET" && temporary,
    payload
  });
}

function normalizeBaseUrl(value, { allowHttpLocalhost = true } = {}) {
  const namespace = "/wp-json/marina-booking/v1";
  let url;
  try {
    url = new URL(String(value || "").trim().replace(/\/+$/, ""));
  } catch {
    throw new ApiError("URL-ul API este invalid.", { code: "invalid_url", permanent: true });
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowHttpLocalhost && local)) {
    throw new ApiError("URL-urile API de producție trebuie să folosească HTTPS.", { code: "https_required", permanent: true });
  }
  const sitePath = url.pathname.replace(/\/+$/, "");
  url.pathname = sitePath.endsWith(namespace) ? sitePath : `${sitePath}${namespace}`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function apiBookings(payload) {
  if (Array.isArray(payload?.bookings)) return payload.bookings;
  if (Array.isArray(payload?.result?.bookings)) return payload.result.bookings;
  if (payload?.result?.bookings && typeof payload.result.bookings === "object") return Object.values(payload.result.bookings);
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.result?.rows)) return payload.result.rows;
  throw new ApiError("Endpoint-ul rezervărilor a returnat un format necunoscut; cache-ul local a fost păstrat.", { code: "invalid_bookings_response", permanent: true, payload });
}

function validBookingDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeBooking(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("Endpoint-ul rezervărilor a returnat o înregistrare invalidă.", { code: "invalid_booking_record", permanent: true, payload: raw });
  }
  const serverId = Number(raw.booking_id ?? raw.id ?? raw.bookingId);
  const resourceId = Number(raw.resource_id ?? raw.booking_type ?? raw.type_id);
  const rawDates = Array.isArray(raw.dates) ? raw.dates : [];
  const parsedDates = rawDates.map((entry) => String(entry?.date ?? entry?.booking_date ?? entry).slice(0, 10));
  if (!Number.isInteger(serverId) || serverId <= 0 || !Number.isInteger(resourceId) || resourceId <= 0 || !parsedDates.length || parsedDates.some((date) => !validBookingDate(date))) {
    throw new ApiError("Endpoint-ul rezervărilor a returnat o înregistrare incompletă sau invalidă.", { code: "invalid_booking_record", permanent: true, payload: raw });
  }
  const dates = [...new Set(parsedDates)].sort();
  const normalizedForm = normalizeFormData(raw.form_data || raw.form || raw.parsed_form || {});
  const datesApproved = rawDates.length > 0 && rawDates.every((entry) => Number(entry?.approved) === 1);
  return {
    serverId,
    externalId: raw.external_id ?? raw.externalId ?? null,
    resourceId,
    dates,
    status: raw.status === "approved" || raw.approved === true || Number(raw.approved) === 1 || datesApproved ? "approved" : "pending",
    trashed: raw.trashed === true || raw.trash === true || Number(raw.trash) === 1 || raw.is_trash === true || Number(raw.is_trash) === 1,
    note: String(raw.note ?? raw.remark ?? ""),
    formData: normalizedForm,
    serverUpdatedAt: raw.updated_at ?? raw.modification_date ?? null,
    serverPayload: raw
  };
}

function normalizePriceQuote(payload) {
  const mode = String(payload?.mode || "");
  const total = Number(payload?.total);
  const deposit = Number(payload?.deposit);
  const balance = Number(payload?.balance);
  if (!["fast", "full"].includes(mode) || ![total, deposit, balance].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new ApiError("Endpoint-ul de prețuri a returnat un calcul invalid.", { code: "invalid_price_response", permanent: true, payload });
  }
  return { ...payload, mode, total, deposit, balance, valid: payload.valid !== false };
}

class MarinaApiClient {
  constructor({ getConfig, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.getConfig = getConfig;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = "GET", body, idempotencyKey, timeoutMs = this.timeoutMs, signal, expectedApiBaseUrl } = {}) {
    const config = await this.getConfig();
    const baseUrl = normalizeBaseUrl(config.apiBaseUrl);
    if (expectedApiBaseUrl && baseUrl !== expectedApiBaseUrl) throw new ApiError("Adresa API s-a schimbat înainte de trimiterea comenzii.", { code: "endpoint_changed", permanent: true });
    if (!config.username || !config.password) throw new ApiError("Datele de acces nu sunt configurate.", { code: "credentials_missing", auth: true, permanent: true });
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const headers = {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      const response = await this.fetchImpl(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: "error" });
      const text = String(await response.text() ?? "");
      let payload = {};
      let invalidJson = false;
      try { payload = text.trim() ? JSON.parse(text) : {}; }
      catch { invalidJson = true; payload = { message: text.slice(0, 500) }; }
      if (expectedApiBaseUrl) {
        let latestBaseUrl = "";
        try { latestBaseUrl = normalizeBaseUrl((await this.getConfig()).apiBaseUrl); } catch {}
        if (latestBaseUrl !== expectedApiBaseUrl) {
          throw new ApiError("Adresa API s-a schimbat în timpul trimiterii; rezultatul de pe vechea țintă trebuie verificat înainte de reîncercare.", { code: "endpoint_changed", permanent: true, unknownOutcome: method !== "GET", payload });
        }
      }
      if (!response.ok) {
        const message = payload?.message || payload?.data?.message || `API-ul a returnat HTTP ${response.status}.`;
        const code = payload?.code || `http_${response.status}`;
        const requestInProgress = code === "marina_booking_api_request_in_progress";
        throw new ApiError(message, {
          code,
          status: response.status,
          auth: response.status === 401 || response.status === 403,
          rateLimited: response.status === 429 || requestInProgress,
          retryAfter: response.headers.get("retry-after") !== null && Number.isFinite(Number(response.headers.get("retry-after")))
            ? Number(response.headers.get("retry-after"))
            : (payload?.data?.retry_after !== undefined && Number.isFinite(Number(payload.data.retry_after)) ? Number(payload.data.retry_after) : null),
          temporary: requestInProgress || response.status === 429 || response.status >= 500,
          permanent: !requestInProgress && response.status >= 400 && response.status < 500 && response.status !== 429,
          payload
        });
      }
      if (invalidJson) {
        throw new ApiError("API-ul a returnat un răspuns JSON invalid.", { code: "invalid_json_response", status: response.status, permanent: true, unknownOutcome: method !== "GET", payload });
      }
      if (!text.trim() && response.status !== 204) {
        throw new ApiError("API-ul a returnat un răspuns gol neașteptat.", { code: "empty_api_response", status: response.status, permanent: true, unknownOutcome: method !== "GET", payload });
      }
      const logicalError = applicationError(payload, method);
      if (logicalError) throw logicalError;
      return {
        payload,
        status: response.status,
        idempotencyReplay: response.headers.get("Idempotency-Replayed") === "true",
        idempotencySupported: response.headers.get("Idempotency-Supported") === "true",
        priceMode: response.headers.get("X-Marina-Price-Mode"),
        priceCache: response.headers.get("X-Marina-Price-Cache")
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const aborted = error?.name === "AbortError";
      if (aborted && !timedOut) throw new ApiError("Cererea a fost anulată.", { code: "request_cancelled", cancelled: true, cause: error });
      throw new ApiError(timedOut ? "Cererea a expirat; rezultatul pe server este necunoscut." : "API-ul nu poate fi accesat.", { code: timedOut ? "timeout_unknown" : "network_error", temporary: true, unknownOutcome: timedOut, cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async resources({ expectedApiBaseUrl, timeoutMs } = {}) {
    const { payload } = await this.request("/resources", { expectedApiBaseUrl, timeoutMs });
    if (!Array.isArray(payload?.resources)) {
      throw new ApiError("Endpoint-ul resurselor a returnat un format necunoscut; lista locală a fost păstrată.", { code: "invalid_resources_response", permanent: true, payload });
    }
    const ids = new Set();
    if (payload.resources.some((resource) => {
      const id = Number(resource?.id);
      if (!resource || typeof resource !== "object" || Array.isArray(resource) || !Number.isInteger(id) || id <= 0 || ids.has(id)) return true;
      ids.add(id);
      return false;
    })) {
      throw new ApiError("Endpoint-ul resurselor a returnat înregistrări invalide sau duplicate; lista locală a fost păstrată.", { code: "invalid_resource_record", permanent: true, payload });
    }
    return payload.resources;
  }

  async bookings(start, end, resourceId = null, { expectedApiBaseUrl, timeoutMs, maxAttempts = 1 } = {}) {
    const params = new URLSearchParams({ start, end, trash: "any", per_page: "100" });
    if (resourceId) params.set("resource_id", String(resourceId));
    const all = [];
    const pageFingerprints = new Set();
    for (let page = 1; page <= MAX_BOOKING_PAGES; page += 1) {
      params.set("page", String(page));
      let payload;
      for (let attempt = 1; attempt <= Math.max(1, Number(maxAttempts) || 1); attempt += 1) {
        try {
          ({ payload } = await this.request(`/bookings?${params}`, { expectedApiBaseUrl, timeoutMs }));
          break;
        } catch (error) {
          if (attempt >= maxAttempts || !error.temporary) throw error;
        }
      }
      const rows = apiBookings(payload);
      const fingerprint = rows.map((row) => String(row.booking_id ?? row.id ?? row.bookingId ?? "")).join(",");
      if (rows.length && pageFingerprints.has(fingerprint)) {
        throw new ApiError("Endpoint-ul rezervărilor a repetat o pagină; cache-ul nu a fost marcat ca finalizat.", { code: "pagination_repeated", permanent: true });
      }
      if (rows.length) pageFingerprints.add(fingerprint);
      const normalized = rows.map(normalizeBooking);
      if (normalized.some((booking) => !booking.serverId || !booking.dates.length || !booking.resourceId)) {
        throw new ApiError("Endpoint-ul rezervărilor a returnat înregistrări incomplete; cache-ul local a fost păstrat.", { code: "invalid_booking_record", permanent: true, payload });
      }
      all.push(...normalized);
      if (rows.length < 100) return all;
    }
    throw new ApiError("Endpoint-ul rezervărilor a depășit limita de paginare; cache-ul nu a fost marcat ca finalizat.", { code: "pagination_limit", permanent: true });
  }

  booking(id, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/${id}`, { expectedApiBaseUrl }).then(({ payload }) => normalizeBooking(payload.booking || payload)); }
  bookingByExternalId(externalId, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/by-external-id/${encodeURIComponent(externalId)}`, { expectedApiBaseUrl }).then(({ payload }) => normalizeBooking(payload.booking || payload)); }
  availability(resourceId, dates, { expectedApiBaseUrl, excludeBookingId } = {}) {
    const body = { resource_id: resourceId, dates };
    if (excludeBookingId !== undefined && excludeBookingId !== null) body.exclude_booking_id = Number(excludeBookingId);
    return this.request("/availability", { method: "POST", body, expectedApiBaseUrl }).then(({ payload }) => {
      if (typeof payload?.available !== "boolean") {
        throw new ApiError("Endpoint-ul disponibilității a returnat un răspuns incomplet.", { code: "invalid_availability_response", permanent: true, payload });
      }
      return payload;
    });
  }
  price(payload, { signal } = {}) {
    return this.request("/prices/calculate", { method: "POST", body: payload, signal }).then(({ payload: response, priceMode, priceCache }) => ({
      ...normalizePriceQuote(response),
      diagnostics: { serverMode: priceMode, serverCache: priceCache }
    }));
  }
  create(payload, key, { expectedApiBaseUrl } = {}) { return this.request("/bookings", { method: "POST", body: payload, idempotencyKey: key, expectedApiBaseUrl }); }
  edit(id, payload, key, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/${id}`, { method: "PATCH", body: payload, idempotencyKey: key, expectedApiBaseUrl }); }
  status(id, payload, key, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/${id}/status`, { method: "POST", body: payload, idempotencyKey: key, expectedApiBaseUrl }); }
  note(id, payload, key, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/${id}/note`, { method: "POST", body: payload, idempotencyKey: key, expectedApiBaseUrl }); }
  trash(id, payload, key, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/${id}/trash`, { method: "POST", body: payload, idempotencyKey: key, expectedApiBaseUrl }); }
  payment(id, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/${id}/payment`, { expectedApiBaseUrl }).then(({ payload }) => payload); }
  deposit_update(id, payload, key, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/${id}/deposit`, { method: "PATCH", body: payload, idempotencyKey: key, expectedApiBaseUrl }); }
  payment_request(id, payload, key, { expectedApiBaseUrl } = {}) { return this.request(`/bookings/${id}/payment-request`, { method: "POST", body: payload, idempotencyKey: key, expectedApiBaseUrl }); }
}

module.exports = { ApiError, MarinaApiClient, normalizeBaseUrl, normalizeBooking, normalizePriceQuote, apiBookings };
