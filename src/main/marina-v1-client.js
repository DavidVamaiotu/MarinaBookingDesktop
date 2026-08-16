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

function marinaProblemMessage(payload, status) {
  const details = [];
  for (const value of [payload?.detail, payload?.message, payload?.title]) {
    if (typeof value === "string" && value.trim()) details.push(value.trim());
  }
  const errors = payload?.errors;
  if (Array.isArray(errors)) {
    for (const error of errors) {
      const value = error?.detail ?? error?.message ?? error;
      if (typeof value === "string" && value.trim()) details.push(value.trim());
    }
  } else if (errors && typeof errors === "object") {
    for (const [field, value] of Object.entries(errors)) {
      const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
      if (text.trim()) details.push(`${field}: ${text.trim()}`);
    }
  }
  const unique = details.filter((value, index) => details.indexOf(value) === index);
  return unique.length
    ? `Eroare Marina: ${unique.join("; ").slice(0, 450)}`
    : `API-ul Marina a returnat HTTP ${status}.`;
}

function queryString(values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function integerField(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${name} trebuie să fie un număr întreg valid.`);
  return number;
}

function bookingRequestBody(body, { expectedVersion } = {}) {
  const result = { ...(body || {}) };
  if (result.resource_id !== undefined) result.resource_id = integerField(result.resource_id, "resource_id");
  if (result.exclude_booking_id !== undefined) result.exclude_booking_id = integerField(result.exclude_booking_id, "exclude_booking_id");
  if (expectedVersion !== undefined && expectedVersion !== null) result.expected_version = integerField(expectedVersion, "expected_version");
  if (Array.isArray(result.periods)) result.periods = result.periods.map((period) => ({
    ...period,
    ...(period.units === undefined ? {} : { units: integerField(period.units, "periods.units") })
  }));
  if (result.guests) result.guests = {
    ...result.guests,
    ...(result.guests.adults === undefined ? {} : { adults: integerField(result.guests.adults, "guests.adults") }),
    ...(result.guests.children === undefined ? {} : { children: integerField(result.guests.children, "guests.children") })
  };
  return result;
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
          const message = marinaProblemMessage(payload, response.status);
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
  pricing(id, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}/pricing`, options); }
  putPricing(id, body, idempotencyKey, options = {}) { return this.request(`/v1/resources/${encodeURIComponent(id)}/pricing`, { ...options, method: "PUT", body, idempotencyKey }); }
  calendar(id, from, to, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}/calendar?${queryString({ from, to })}`, options); }
  closures(id, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}/closures`, options); }
  availabilityCheck(body, options = {}) { return this.request("/v1/availability/check", { ...options, method: "POST", body: bookingRequestBody(body) }); }
  availabilityResources(from, to, options) { return this.request(`/v1/availability/resources?${queryString({ from, to })}`, options); }
  bookings(query = {}, options) { return this.request(`/v1/bookings?${queryString({ ...query, limit: Math.min(200, Number(query.limit) || 200) })}`, options); }
  quote(body, options = {}) { return this.request("/v1/quotes", { ...options, method: "POST", body: bookingRequestBody(body) }); }
  booking(id, options) { return this.request(`/v1/bookings/${encodeURIComponent(id)}`, options); }
  payment(id, options) { return this.booking(id, options); }
  updateDeposit(id, body, idempotencyKey, expectedVersion, options = {}) { return this.updateBooking(id, body, idempotencyKey, expectedVersion, options); }
  createBooking(body, idempotencyKey, options = {}) { return this.request("/v1/bookings", { ...options, method: "POST", body: bookingRequestBody(body), idempotencyKey }); }
  updateBooking(id, body, idempotencyKey, expectedVersion, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}`, { ...options, method: "PATCH", body: bookingRequestBody(body, { expectedVersion }), idempotencyKey, expectedVersion }); }
  changeBookingStatus(id, body, idempotencyKey, expectedVersion, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/status`, { ...options, method: "POST", body: bookingRequestBody(body, { expectedVersion }), idempotencyKey, expectedVersion }); }
  cancelBooking(id, body, idempotencyKey, expectedVersion, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/cancel`, { ...options, method: "POST", body, idempotencyKey, expectedVersion }); }
  markBookingRead(id, body, idempotencyKey, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/read`, { ...options, method: "POST", body, idempotencyKey }); }
  listNotes(id, options) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/notes`, options); }
  addNote(id, body, idempotencyKey, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/notes`, { ...options, method: "POST", body: { body: body?.body ?? body?.note }, idempotencyKey }); }
  updateNote(id, noteId, body, idempotencyKey, options = {}) { return this.request(`/v1/bookings/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`, { ...options, method: "PATCH", body: { body: body?.body ?? body?.note }, idempotencyKey }); }
}

module.exports = { MarinaApiError, MarinaV1ApiClient, marinaProblemMessage };
