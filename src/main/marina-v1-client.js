"use strict";

const { normalizeBaseUrl, normalizeWorkspaceId } = require("../shared/marina-config");
const { TERMINAL_REFRESH_ERRORS } = require("./marina-oauth-controller");

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

function pageLimit(value = 200) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new TypeError("limit trebuie să fie un număr întreg între 1 și 200.");
  }
  return limit;
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
  if (result.facility_ids !== undefined) {
    if (!Array.isArray(result.facility_ids)) throw new TypeError("facility_ids trebuie să fie o listă.");
    result.facility_ids = result.facility_ids.map((value) => {
      const id = integerField(value, "facility_ids");
      if (id < 1) throw new TypeError("facility_ids trebuie să conțină doar identificatori pozitivi.");
      return id;
    });
    if (result.facility_ids.length > 64 || new Set(result.facility_ids).size !== result.facility_ids.length) {
      throw new TypeError("facility_ids conține prea multe valori sau valori duplicate.");
    }
  }
  return result;
}

class MarinaV1ApiClient {
  constructor({ baseUrl, oauth, workspaceId = null, workspaceSlug = "", fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.oauth = oauth;
    this.workspaceId = normalizeWorkspaceId(workspaceId);
    this.workspaceSlug = String(workspaceSlug || "").trim().toLowerCase();
    this.workspaceResolution = null;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  url(path) {
    const normalized = String(path || "").startsWith("/") ? String(path) : `/${path}`;
    return `${this.baseUrl}${normalized}`;
  }

  async resolveWorkspaceId() {
    if (this.workspaceId !== null) return this.workspaceId;
    if (!this.workspaceSlug) return null;
    if (!this.workspaceResolution) this.workspaceResolution = (async () => {
      const response = await this.request("/v1/workspaces", { workspaceScoped: false });
      const rows = Array.isArray(response.payload?.data)
        ? response.payload.data
        : Array.isArray(response.payload?.workspaces) ? response.payload.workspaces : [];
      const active = rows.filter((workspace) => workspace?.active !== false);
      let selected = active.find((workspace) => String(workspace?.slug || "").trim().toLowerCase() === this.workspaceSlug);
      if (!selected && this.workspaceSlug === "rooms") {
        selected = active.find((workspace) => ["camere", "default"].includes(String(workspace?.slug || "").trim().toLowerCase()))
          || active.find((workspace) => workspace?.is_default === true);
      }
      const id = normalizeWorkspaceId(selected?.id);
      if (id === null) {
        throw Object.assign(new Error(`Workspace-ul Marina „${this.workspaceSlug}” nu este accesibil.`), {
          code: "marina_workspace_missing",
          permanent: true
        });
      }
      this.workspaceId = id;
      return id;
    })().catch((error) => {
      this.workspaceResolution = null;
      throw error;
    });
    return this.workspaceResolution;
  }

  async request(path, { method = "GET", body, headers = {}, idempotencyKey, expectedVersion, signal, retryOnUnauthorized = true, workspaceScoped = true } = {}) {
    if (!this.oauth?.getAccessToken) throw new MarinaApiError("Conexiunea Marina nu este configurată.", { code: "marina_not_connected", auth: true, permanent: true });
    const workspaceId = workspaceScoped ? await this.resolveWorkspaceId() : null;
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
        if (workspaceId !== null) requestHeaders["X-Workspace-ID"] = String(workspaceId);
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
          catch (cause) {
            // Only a definitive OAuth rejection (bad grant/client) means the saved
            // login is gone; a temporary refresh failure must stay retryable.
            if (TERMINAL_REFRESH_ERRORS.has(cause?.code) || cause?.status === 401) {
              throw new MarinaApiError("Reconectarea Marina este necesară.", { code: "marina_reconnect_required", auth: true, permanent: true, cause });
            }
            throw new MarinaApiError("Autentificarea Marina nu a putut fi reînnoită momentan. Încercați din nou.", { code: "marina_refresh_unavailable", auth: true, temporary: true, cause });
          }
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

  workspaces(options = {}) { return this.request("/v1/workspaces", { ...options, workspaceScoped: false }); }
  resources(options) { return this.request("/v1/resources", options); }
  facilities(query = {}, options) {
    const queryValue = queryString(query);
    return this.request(`/v1/facilities${queryValue ? `?${queryValue}` : ""}`, options);
  }
  createResource(body, idempotencyKey, options = {}) { return this.request("/v1/resources", { ...options, method: "POST", body, idempotencyKey }); }
  resource(id, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}`, options); }
  pricing(id, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}/pricing`, options); }
  putPricing(id, body, idempotencyKey, options = {}) { return this.request(`/v1/resources/${encodeURIComponent(id)}/pricing`, { ...options, method: "PUT", body, idempotencyKey }); }
  calendar(id, from, to, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}/calendar?${queryString({ from, to })}`, options); }
  closures(id, options) { return this.request(`/v1/resources/${encodeURIComponent(id)}/closures`, options); }
  availabilityCheck(body, options = {}) { return this.request("/v1/availability/check", { ...options, method: "POST", body: bookingRequestBody(body) }); }
  availabilityResources(from, to, options) { return this.request(`/v1/availability/resources?${queryString({ from, to })}`, options); }
  bookings(query = {}, options) { return this.request(`/v1/bookings?${queryString({ ...query, limit: pageLimit(query.limit) })}`, options); }
  quote(body, options = {}) { return this.request("/v1/quotes", { ...options, method: "POST", body: bookingRequestBody(body) }); }
  booking(id, options) { return this.request(`/v1/bookings/${encodeURIComponent(id)}`, options); }
  payment(id, options) { return this.booking(id, options); }
  requestPayment(id, body, idempotencyKey, options = {}) {
    return this.request(`/v1/admin/bookings/${encodeURIComponent(id)}/payment-request`, {
      ...options,
      method: "POST",
      body,
      idempotencyKey
    });
  }
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
