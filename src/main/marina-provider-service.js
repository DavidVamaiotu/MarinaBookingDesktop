"use strict";

const { EventEmitter } = require("node:events");
const { createHash, randomUUID } = require("node:crypto");
const MarinaConfig = require("../shared/marina-config");

const REFRESH_INTERVAL_MS = 5 * 60_000;

function collection(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["data", ...keys]) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function entity(payload, keys = []) {
  if (payload?.data && !Array.isArray(payload.data)) return payload.data;
  for (const key of keys) if (payload?.[key] && typeof payload[key] === "object") return payload[key];
  return payload || {};
}

function externalId(value) {
  const id = value?.id ?? value?.booking_id ?? value?.resource_id;
  if (id === undefined || id === null || String(id).trim() === "") throw Object.assign(new Error("Răspunsul Marina nu conține identificatorul necesar."), { code: "marina_invalid_response", permanent: true });
  return String(id);
}

function uiId(providerId) {
  const digest = createHash("sha256").update(`marina:${providerId}`).digest();
  return (digest.readUInt32BE(0) & 0x7fffffff) || 1;
}

const BUCHAREST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Bucharest",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function datePart(value) {
  const source = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return source;
  if (source.includes("T")) {
    const parsed = new Date(source);
    if (Number.isFinite(parsed.getTime())) {
      const parts = Object.fromEntries(BUCHAREST_DATE_FORMATTER.formatToParts(parsed).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  }
  return source.slice(0, 10);
}
function timedEndDatePart(value) {
  if (value === undefined || value === null || String(value) === "") return undefined;
  const date = datePart(value);
  const parsed = new Date(String(value || ""));
  if (!String(value || "").includes("T") || !Number.isFinite(parsed.getTime())) return date;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Bucharest",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(parsed).map((part) => [part.type, part.value]));
  return parts.hour === "00" && parts.minute === "00" && parts.second === "00" ? addDays(date, -1) : date;
}
function addDays(value, count) {
  const date = new Date(`${datePart(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
function dateRange(start, end) {
  const values = [];
  for (let cursor = datePart(start); /^\d{4}-\d{2}-\d{2}$/.test(cursor) && cursor <= datePart(end) && values.length < 366; cursor = addDays(cursor, 1)) values.push(cursor);
  return values;
}

const BUCHAREST_OFFSET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Bucharest",
  timeZoneName: "longOffset"
});

function bucharestRangeBoundary(value, endOfDay = false) {
  const date = datePart(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error("Intervalul calendarului Marina este invalid."), { code: "marina_invalid_range", permanent: true });
  const timeZoneName = BUCHAREST_OFFSET_FORMATTER.formatToParts(new Date(`${date}T12:00:00Z`)).find((part) => part.type === "timeZoneName")?.value || "GMT+02:00";
  const offset = timeZoneName.replace(/^GMT/, "") || "+00:00";
  return `${date}T${endOfDay ? "23:59:59" : "00:00:00"}${offset}`;
}

function field(formData, name) { return String(formData?.[name]?.value ?? "").trim(); }

function normalizeResource(resource) {
  const providerId = externalId(resource);
  return {
    id: uiId(providerId),
    provider: "marina",
    providerId,
    title: String(resource.title || resource.name || resource.label || `Marina ${providerId}`),
    capacity: Number(resource.capacity) || null,
    baseCost: resource.base_cost ?? resource.baseCost ?? null,
    defaultForm: "marina",
    timezone: resource.timezone || "Europe/Bucharest",
    active: resource.active !== false
  };
}

function normalizedFormData(booking) {
  const customer = booking.customer || booking.guest || {};
  const guests = booking.guests || {};
  const source = booking.form_data || booking.formData || {};
  const result = {};
  const add = (name, value, type = "text") => { if (value !== undefined && value !== null && String(value) !== "") result[name] = { value: String(value), type }; };
  for (const [name, value] of Object.entries(source)) add(name, value?.value ?? value, value?.type || "text");
  add("name", customer.first_name ?? customer.firstName ?? booking.first_name ?? booking.name);
  add("secondname", customer.last_name ?? customer.lastName ?? booking.last_name ?? booking.secondname);
  add("email", customer.email ?? booking.email, "email");
  add("phone", customer.phone ?? booking.phone);
  add("visitors", guests.adults ?? booking.adults, "selectbox-one");
  add("children", guests.children ?? booking.children, "selectbox-one");
  return result;
}

function bookingPeriods(booking) {
  for (const value of [booking.periods, booking.booking_periods, booking.bookingPeriods, booking.allocations, booking.segments]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeBooking(booking, resources) {
  const providerId = externalId(booking);
  const periods = bookingPeriods(booking);
  const firstPeriod = periods[0] || {};
  const providerResourceId = String(booking.resource_id ?? booking.resourceId ?? booking.resource?.id ?? firstPeriod.resource_id ?? firstPeriod.resourceId ?? firstPeriod.resource?.id ?? "");
  const resource = resources.find((item) => item.providerId === providerResourceId);
  const periodDates = periods.flatMap((period) => dateRange(
    period.start_date ?? period.startDate ?? period.start_at ?? period.startAt ?? period.starts_at ?? period.startsAt ?? period.from,
    period.end_date ?? period.endDate ?? timedEndDatePart(period.end_at ?? period.endAt ?? period.ends_at ?? period.endsAt ?? period.to) ?? period.start_date ?? period.startDate
  ));
  const start = booking.start_date ?? booking.startDate ?? booking.start_at ?? booking.startAt ?? booking.starts_at ?? booking.startsAt ?? booking.from;
  const end = booking.end_date ?? booking.endDate ?? timedEndDatePart(booking.end_at ?? booking.endAt ?? booking.ends_at ?? booking.endsAt ?? booking.to) ?? start;
  const status = String(booking.status || "pending").toLowerCase();
  return {
    localId: `marina:${providerId}`,
    serverId: providerId,
    externalId: providerId,
    provider: "marina",
    providerId,
    providerResourceId,
    resourceId: resource?.id || uiId(providerResourceId),
    status: ["approved", "confirmed", "active", "completed"].includes(status) ? "approved" : "pending",
    providerStatus: status,
    trashed: ["trash", "cancelled", "canceled", "deleted"].includes(status),
    note: String(booking.note || booking.internal_note || ""),
    formData: normalizedFormData(booking),
    dates: periodDates.length ? [...new Set(periodDates)].sort() : dateRange(start, end),
    syncState: "synced",
    version: booking.version ?? booking.etag ?? null,
    serverUpdatedAt: booking.updated_at ?? booking.updatedAt ?? null
  };
}

function bookingBody(input, resources) {
  const resource = resources.find((item) => Number(item.id) === Number(input.resourceId));
  if (!resource) throw Object.assign(new Error("Resursa Marina selectată nu mai este disponibilă."), { code: "marina_resource_missing", permanent: true });
  const dates = [...input.dates].sort();
  return {
    resource_id: resource.providerId,
    periods: [{ start_date: dates[0], end_date: dates.at(-1), units: 1 }],
    customer: {
      first_name: field(input.formData, "name"),
      last_name: field(input.formData, "secondname"),
      email: field(input.formData, "email"),
      phone: field(input.formData, "phone"),
      address: {},
      custom_fields: {}
    },
    guests: {
      adults: Number(field(input.formData, "visitors")) || 1,
      children: Number(field(input.formData, "children")) || 0,
      details: {}
    },
    custom_fields: {},
    internal_note: String(input.note || "")
  };
}

class MarinaBookingProvider extends EventEmitter {
  constructor({ config, oauth, api, cacheStore = null } = {}) {
    super();
    this.config = config;
    this.oauth = oauth;
    this.api = api;
    this.visibleRange = null;
    this.cacheStore = cacheStore;
    const cached = cacheStore?.load?.() || {};
    this.resources = Array.isArray(cached.resources) ? cached.resources : [];
    this.bookings = Array.isArray(cached.bookings) ? cached.bookings : [];
    this.lastSuccessfulSync = cached.lastSuccessfulSync || null;
    this.online = false;
    this.refreshInFlight = null;
    this.refreshTimer = null;
    oauth.on("changed", () => this.emitState());
  }

  start() {
    this.refreshTimer = setInterval(() => { if (this.visibleRange && this.oauth.status().connected) void this.refresh(this.visibleRange).catch(() => {}); }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
    if (this.oauth.status().connected && typeof this.oauth.refresh === "function") {
      void this.oauth.refresh().then(() => this.emitState()).catch(() => this.emitState());
    }
  }
  stop() { if (this.refreshTimer) clearInterval(this.refreshTimer); }

  settings() {
    const oauth = this.oauth.status();
    const capabilities = MarinaConfig.capabilities(oauth.effectiveScopes);
    return {
      provider: "marina",
      enabled: this.config.enabled,
      configured: this.config.configured,
      credentialsConfigured: oauth.connected,
      connected: oauth.connected,
      connecting: oauth.connecting,
      oauthClientConfigured: Boolean(this.config.clientId),
      oauthScopes: oauth.effectiveScopes.join(" "),
      capabilities,
      apiBaseUrl: this.config.apiBaseUrl,
      configurationError: this.config.configurationError,
      timezone: "Europe/Bucharest",
      connectionStatus: oauth.connected ? "connected" : oauth.connecting ? "connecting" : this.config.configured ? "disconnected" : "disabled"
    };
  }

  state(range = this.visibleRange) {
    const dates = range || { start: new Date().toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) };
    const connected = this.oauth.status().connected;
    return {
      provider: "marina",
      resources: [...this.resources],
      bookings: this.bookings.filter((item) => item.dates.some((date) => date >= dates.start && date <= dates.end)),
      commands: [],
      diagnostics: { provider: "marina", online: this.online, authPaused: !connected, queued: 0, sending: 0, failed: 0, conflicts: 0, lastSuccessfulSync: this.lastSuccessfulSync },
      settings: this.settings(),
      range: dates
    };
  }
  emitState() { this.emit("state", this.state()); }

  async connect() { await this.oauth.connect(); return this.state(); }
  async disconnect() {
    await this.oauth.disconnect();
    this.resources = [];
    this.bookings = [];
    this.online = false;
    this.lastSuccessfulSync = null;
    this.cacheStore?.save?.({ resources: [], bookings: [], lastSuccessfulSync: null });
    return this.state();
  }

  async refresh(range) {
    this.visibleRange = range;
    if (!this.oauth.status().connected) return this.state(range); // Never probe protected endpoints before OAuth.
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        const capabilities = this.settings().capabilities;
        if (!capabilities.resourcesRead) {
          this.resources = [];
          this.bookings = [];
          this.online = true;
          this.emitState();
          return this.state(range);
        }
        const resourcesResponse = await this.api.resources();
        this.resources = collection(resourcesResponse.payload, ["resources"]).map(normalizeResource);
        const loaded = [];
        if (capabilities.bookingsRead) {
          let after = null;
          const from = bucharestRangeBoundary(range.start);
          const to = bucharestRangeBoundary(range.end, true);
          do {
            const response = await this.api.bookings({ from, to, after, limit: 200 });
            loaded.push(...collection(response.payload, ["bookings"]));
            after = response.payload?.next_cursor ?? response.payload?.pagination?.next_cursor ?? response.payload?.meta?.next_cursor ?? null;
          } while (after);
        }
        this.bookings = loaded.map((booking) => normalizeBooking(booking, this.resources));
        this.online = true;
        this.lastSuccessfulSync = new Date().toISOString();
        this.cacheStore?.save?.({ resources: this.resources, bookings: this.bookings, lastSuccessfulSync: this.lastSuccessfulSync });
        const result = this.state(range);
        this.emit("state", result);
        return result;
      } catch (error) {
        this.online = Boolean(error.auth);
        this.emitState();
        throw error;
      } finally { this.refreshInFlight = null; }
    })();
    return this.refreshInFlight;
  }

  findBooking(localId) {
    const booking = this.bookings.find((item) => item.localId === String(localId));
    if (!booking) throw Object.assign(new Error("Rezervarea Marina nu mai există în cache-ul curent."), { code: "marina_booking_missing", permanent: true });
    return booking;
  }

  async details(localId) {
    const current = this.findBooking(localId);
    const [bookingResponse, notesResponse] = await Promise.all([
      this.api.booking(current.providerId),
      this.api.listNotes(current.providerId)
    ]);
    const detailed = normalizeBooking(entity(bookingResponse.payload, ["booking"]), this.resources);
    const noteBodies = collection(notesResponse.payload, ["notes"])
      .map((note) => String(note?.body ?? note?.note ?? "").trim())
      .filter(Boolean);
    const merged = {
      ...current,
      ...detailed,
      resourceId: detailed.providerResourceId ? detailed.resourceId : current.resourceId,
      providerResourceId: detailed.providerResourceId || current.providerResourceId,
      dates: detailed.dates.length ? detailed.dates : current.dates,
      note: [detailed.note, ...noteBodies].map((value) => String(value || "").trim()).filter((value, index, values) => value && values.indexOf(value) === index).join("\n\n")
    };
    this.bookings = this.bookings.map((booking) => booking.localId === merged.localId ? merged : booking);
    this.cacheStore?.save?.({ resources: this.resources, bookings: this.bookings, lastSuccessfulSync: this.lastSuccessfulSync });
    this.emitState();
    return merged;
  }
  async refreshAfterMutation() { return this.visibleRange ? this.refresh(this.visibleRange) : this.state(); }

  async create(input) {
    const response = await this.api.createBooking(bookingBody(input, this.resources), randomUUID());
    const created = entity(response.payload, ["booking"]);
    if (input.note) await this.api.addNote(externalId(created), { note: input.note }, randomUUID());
    await this.refreshAfterMutation();
    return normalizeBooking(created, this.resources);
  }

  async update(localId, patch, type = "edit") {
    const booking = this.findBooking(localId);
    if (type === "status") await this.api.changeBookingStatus(booking.providerId, { status: patch.status }, randomUUID(), booking.version);
    else if (type === "trash") {
      if (!patch.trashed) throw Object.assign(new Error("O rezervare Marina anulată nu poate fi restaurată din acest calendar."), { code: "marina_restore_unsupported", permanent: true });
      await this.api.cancelBooking(booking.providerId, {}, randomUUID(), booking.version);
    } else if (type === "note") await this.api.addNote(booking.providerId, { note: patch.note || "" }, randomUUID());
    else await this.api.updateBooking(booking.providerId, bookingBody({ ...booking, ...patch, formData: patch.formData || booking.formData, dates: patch.dates || booking.dates }, this.resources), randomUUID(), booking.version);
    await this.refreshAfterMutation();
    return this.findBooking(localId);
  }

  async availability(resourceId, dates, { excludeBookingId } = {}) {
    const resource = this.resources.find((item) => Number(item.id) === Number(resourceId));
    const sorted = [...dates].map(datePart).sort();
    const body = { resource_id: resource?.providerId, start_date: sorted[0], end_date: sorted.at(-1) };
    if (excludeBookingId) body.exclude_booking_id = this.findBooking(excludeBookingId).providerId;
    const response = await this.api.availabilityCheck(body);
    return entity(response.payload);
  }

  quote(input) {
    const days = Math.max(1, input.dates.length);
    return Promise.resolve({ valid: true, mode: input.mode || "fast", total: 0, deposit: 0, balance: 0, days, nights: Math.max(0, days - 1), formatted: { total: "Gestionat de Marina", deposit: "—", balance: "—" } });
  }
  clearQuoteCache() {}
  payment() { throw Object.assign(new Error("API-ul Marina nu expune operațiuni de plată în contractul integrat."), { code: "marina_feature_unsupported", permanent: true }); }
  updateDeposit() { return this.payment(); }
  requestPayment() { return this.payment(); }
  retry() { throw Object.assign(new Error("Marina nu folosește coada providerului existent."), { code: "marina_feature_unsupported", permanent: true }); }
  revert() { return this.retry(); }
  clearFailedCommands() { return 0; }
}

module.exports = { MarinaBookingProvider, bookingBody, collection, normalizeBooking, normalizeResource, uiId };
