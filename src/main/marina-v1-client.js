"use strict";

const { normalizeBaseUrl } = require("../shared/marina-config");

class MarinaApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MarinaApiError";
    Object.assign(this, options);
  }
}

function jsonPayload(text) {
  if (!String(text || "").trim()) return {};
  try { return JSON.parse(text); }
  catch { return { detail: String(text).slice(0, 500) }; }
}

function retryableStatus(status) {
  return status === 429 || status >= 500;
}

function queryString(values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

class MarinaV1ApiClient {
  constructor({ baseUrl, oauth, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.oauth = oauth;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  url(path) {
    const normalized = String(path || "").startsWith("/") ? String(path) : `/${path}`;
    return `${this.baseUrl}${normalized}`;
  }

  async request(path, { method = "GET", body, headers = {}, idempotencyKey, expectedVersion, signal, retryOnUnauthorized = true } = {}) {
    if (!this.oauth?.getAccessToken) throw new MarinaApiError("Conexiunea Marina nu este configurată.", { code: "marina_not_connected", auth: true, permanent: true });
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let refreshed = false;
    try {
      while (true) {
        const accessToken = await this.oauth.getAccessToken();
        const requestHeaders = { Accept: "application/json", ...headers, Authorization: `Bearer ${accessToken}` };
        if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
        if (idempotencyKey) requestHeaders["Idempotency-Key"] = String(idempotencyKey);
        if (expectedVersion !== undefined && expectedVersion !== null) requestHeaders["If-Match"] = String(expectedVersion);
        let response;
        try {
          response = await this.fetchImpl(this.url(path), {
            method,
            headers: requestHeaders,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
            redirect: "error"
          });
        } catch (cause) {
          if (cause?.name === "AbortError" && !timedOut) throw new MarinaApiError("Cererea Marina a fost anulată.", { code: "marina_request_cancelled", cancelled: true, cause });
          throw new MarinaApiError(timedOut ? "Cererea Marina a expirat." : "API-ul Marina nu poate fi accesat momentan.", { code: timedOut ? "marina_timeout" : "marina_network_error", temporary: true, unknownOutcome: method !== "GET", cause });
        }
        const payload = jsonPayload(await response.text());
        if (response.status === 401 && retryOnUnauthorized && !refreshed) {
          refreshed = true;
          try { await this.oauth.refresh(); }
          catch (cause) { throw new MarinaApiError("Reconectarea Marina este necesară.", { code: "marina_reconnect_required", auth: true, permanent: true, cause }); }
          continue;
        }
        if (!response.ok) {
          const message = payload.detail || payload.message || payload.title || `API-ul Marina a returnat HTTP ${response.status}.`;
          throw new MarinaApiError(message, {
            code: payload.code || payload.type || `marina_http_${response.status}`,
            status: response.status,
            auth: response.status === 401 || response.status === 403,
            conflict: response.status === 409,
            temporary: retryableStatus(response.status),
            permanent: !retryableStatus(response.status),
            retryAfter: Number(response.headers?.get?.("retry-after")) || null,
            payload
          });
        }
        return { payload, status: response.status, headers: response.headers };
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  resources(options) { return this.request("/v1/resources", options); }
  createResource(body, idempotencyKey, options = {}) { return this.request("/v1/resources", { ...options, method: "POST", body, idempotencyKey }); }
  resource(id, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}`, options); }
  calendar(id, from, to, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}/calendar?${queryString({ from, to })}`, options); }
  closures(id, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}/closures`, options); }
  availabilityCheck(body, options = {}) { return this.request("/v1/availability/check", { ...options, method: "POST", body }); }
  availabilityResources(from, to, options) { return this.request(`/v1/availability/resources?${queryString({ from, to })}`, options); }
  bookings(query = {}, options) { return this.request(`/v1/bookings?${queryString({ ...query, limit: Math.min(200, Number(query.limit) || 200) })}`, options); }
  booking(id, options) { return this.request(`/v1/bookings/${encodeURIComponent(id)}`, options); }
  createBooking(body, idempotencyKey, options = {}) { return this.request("/v1/bookings", { ...options, method: "POST", body, idempotencyKey }); }
  updateBooking(id, body, idempotencyKey, expectedVersion, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}`, { ...options, method: "PATCH", body, idempotencyKey, expectedVersion }); }
  changeBookingStatus(id, body, idempotencyKey, expectedVersion, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/status`, { ...options, method: "POST", body, idempotencyKey, expectedVersion }); }
  cancelBooking(id, body, idempotencyKey, expectedVersion, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/cancel`, { ...options, method: "POST", body, idempotencyKey, expectedVersion }); }
  markBookingRead(id, body, idempotencyKey, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/read`, { ...options, method: "POST", body, idempotencyKey }); }
  listNotes(id, options) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/notes`, options); }
  addNote(id, body, idempotencyKey, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/notes`, { ...options, method: "POST", body: { body: body?.body ?? body?.note }, idempotencyKey }); }
  updateNote(id, noteId, body, idempotencyKey, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`, { ...options, method: "PATCH", body: { body: body?.body ?? body?.note }, idempotencyKey }); }
}

module.exports = { MarinaApiError, MarinaV1ApiClient };
