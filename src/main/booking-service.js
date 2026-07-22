"use strict";

const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");

const CACHE_MAX_AGE_MS = 15 * 60_000;
const CACHE_CHECK_INTERVAL_MS = 5 * 60_000;
const QUOTE_CACHE_TTL_MS = Object.freeze({ fast: 30_000, full: 15_000 });
const QUOTE_CACHE_MAX_ENTRIES = 50;

function sameRange(first, second) {
  return Boolean(first && second && first.start === second.start && first.end === second.end);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function quotePayload(input) {
  return {
    resource_id: input.resourceId,
    dates: [...new Set(input.dates)].sort(),
    form_data: canonicalValue(input.formData),
    booking_form_type: input.bookingFormType,
    mode: input.mode
  };
}

function quoteCacheKey(input) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(quotePayload(input)))).digest("hex");
}

class BookingService extends EventEmitter {
  constructor({ database, api, queue, vault, now = Date.now, resourceIds = null } = {}) {
    super();
    this.database = database;
    this.api = api;
    this.queue = queue;
    this.vault = vault;
    this.visibleRange = null;
    this.refreshTimer = null;
    this.refreshInFlight = null;
    this.refreshRangeKey = null;
    this.now = now;
    this.resourceIds = resourceIds ? new Set(resourceIds.map(Number)) : null;
    this.quoteCache = new Map();
    this.quoteController = null;
    queue.on("changed", () => this.emitState());
  }

  start() {
    this.queue.start();
    this.refreshTimer = setInterval(() => {
      if (this.visibleRange) void this.refresh(this.visibleRange, { force: false }).catch(() => {});
    }, CACHE_CHECK_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  stop() {
    this.queue.stop();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.clearQuoteCache();
  }

  settings() {
    return { ...this.database.getSettings(), credentialsConfigured: this.vault.hasPassword() };
  }

  state(range = this.visibleRange) {
    const dates = range || { start: new Date().toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) };
    const diagnostics = this.database.diagnostics();
    const bookings = this.database.listBookings(dates.start, dates.end).filter((booking) => !this.resourceIds || this.resourceIds.has(Number(booking.resourceId)));
    const resources = this.database.listResources().filter((resource) => !this.resourceIds || this.resourceIds.has(Number(resource.id)));
    return {
      resources,
      bookings,
      commands: this.database.commandRows(),
      diagnostics: { ...diagnostics, online: this.database.db.prepare("SELECT value FROM sync_meta WHERE key='online'").get()?.value !== "false" },
      settings: this.settings(),
      range: dates
    };
  }

  emitState(range = this.visibleRange) {
    this.emit("state", this.state(range));
  }

  async refresh(range, { force = false } = {}) {
    this.visibleRange = range;
    const rangeKey = `${range.start}:${range.end}`;
    if (!force && this.database.rangeIsFresh(range.start, range.end, CACHE_MAX_AGE_MS)) {
      return this.state(range);
    }
    if (this.refreshInFlight) {
      if (this.refreshRangeKey === rangeKey) return this.refreshInFlight;
      try { await this.refreshInFlight; } catch {}
      if (!force && this.database.rangeIsFresh(range.start, range.end, CACHE_MAX_AGE_MS)) {
        return this.state(range);
      }
    }
    this.refreshRangeKey = rangeKey;
    this.refreshInFlight = (async () => {
      try {
        const expectedApiBaseUrl = this.database.getSettings().apiBaseUrl;
        const [allResources, allBookings] = await Promise.all([
          this.api.resources({ expectedApiBaseUrl }),
          this.api.bookings(range.start, range.end, null, { expectedApiBaseUrl })
        ]);
        const resources = allResources.filter((resource) => !this.resourceIds || this.resourceIds.has(Number(resource.id)));
        const bookings = allBookings.filter((booking) => !this.resourceIds || this.resourceIds.has(Number(booking.resourceId)));
        this.database.replaceResources(resources);
        for (const booking of bookings) this.database.upsertRemoteBooking(booking);
        const returnedIds = new Set(bookings.map((booking) => booking.serverId));
        this.database.reconcileRemoteRange(range.start, range.end, returnedIds);
        const pending = this.database.listBookings(range.start, range.end).filter((booking) => booking.serverId && booking.syncState !== "synced" && !returnedIds.has(booking.serverId));
        for (const local of pending) {
          try {
            this.database.upsertRemoteBooking(await this.api.booking(local.serverId, { expectedApiBaseUrl }));
          } catch (error) {
            if (error.status === 404) this.database.markBookingConflict(local.localId, "remote_missing", "Rezervarea a fost eliminată sau nu mai este vizibilă pe server.");
            else throw error;
          }
        }
        this.database.markRangeLoaded(range.start, range.end);
        this.database.setMeta("lastSuccessfulSync", new Date().toISOString());
        this.database.setMeta("online", "true");
        if (this.queue.authPaused || this.database.diagnostics().authPaused) this.queue.resumeAfterCredentials({ retryFailed: true });
        else this.database.setMeta("authPaused", "false");
        const nextState = this.state(range);
        if (sameRange(this.visibleRange, range)) this.emit("state", nextState);
        return nextState;
      } catch (error) {
        if (error.auth) this.queue.pauseForAuthentication();
        this.database.setMeta("online", error.auth ? "true" : "false");
        if (sameRange(this.visibleRange, range)) this.emitState(range);
        throw error;
      } finally {
        this.refreshInFlight = null;
        this.refreshRangeKey = null;
      }
    })();
    return this.refreshInFlight;
  }

  async create(input) {
    const result = this.database.optimisticCreate(input);
    const note = input.note ? this.database.optimisticUpdate(result.booking.localId, { note: input.note }, "note") : null;
    this.emitState();
    await this.queue.waitForAttempt(result.commandId);
    if (note) await this.queue.waitForAttempt(note.commandId);
    this.emitState();
    return this.database.bookingRow(result.booking.localId);
  }

  async update(localId, patch, type = "edit") {
    const result = this.database.optimisticUpdate(localId, patch, type);
    this.emitState();
    await this.queue.waitForAttempt(result.commandId);
    this.emitState();
    return this.database.bookingRow(localId);
  }

  payment(localId) {
    const booking = this.database.bookingRow(localId);
    if (!booking?.serverId) throw new Error("Rezervarea trebuie sincronizată înainte de citirea plății.");
    return this.api.payment(booking.serverId);
  }

  async updateDeposit(localId, payment) {
    const result = this.database.queueDepositUpdate(localId, payment);
    this.emitState();
    await this.queue.waitForAttempt(result.commandId);
    this.emitState();
    return { ...result, booking: this.database.bookingRow(localId) };
  }

  async requestPayment(localId, paymentRequest) {
    const result = this.database.queuePaymentRequest(localId, paymentRequest);
    this.emitState();
    await this.queue.waitForAttempt(result.commandId);
    this.emitState();
    return result;
  }

  availability(resourceId, dates) {
    return this.api.availability(resourceId, dates);
  }

  async quote(input) {
    this.quoteController?.abort();
    this.quoteController = null;
    const payload = quotePayload(input);
    const key = quoteCacheKey(input);
    const timestamp = this.now();
    for (const [cacheKey, entry] of this.quoteCache) {
      if (entry.expiresAt <= timestamp) this.quoteCache.delete(cacheKey);
    }
    const cached = input.forceFresh ? null : this.quoteCache.get(key);
    if (cached && cached.expiresAt > timestamp) {
      this.quoteCache.delete(key);
      this.quoteCache.set(key, cached);
      return { ...cached.quote, diagnostics: { ...cached.quote.diagnostics, clientCache: "HIT" } };
    }

    const controller = new AbortController();
    this.quoteController = controller;
    try {
      const quote = await this.api.price(payload, { signal: controller.signal });
      if (controller.signal.aborted) throw Object.assign(new Error("Cererea a fost anulată."), { code: "request_cancelled", cancelled: true });
      this.quoteCache.set(key, { quote, expiresAt: this.now() + QUOTE_CACHE_TTL_MS[input.mode] });
      while (this.quoteCache.size > QUOTE_CACHE_MAX_ENTRIES) this.quoteCache.delete(this.quoteCache.keys().next().value);
      return { ...quote, diagnostics: { ...quote.diagnostics, clientCache: "MISS" } };
    } finally {
      if (this.quoteController === controller) this.quoteController = null;
    }
  }

  clearQuoteCache() {
    this.quoteController?.abort();
    this.quoteController = null;
    this.quoteCache.clear();
  }

  async retry(commandId) {
    const command = this.database.getCommand(commandId);
    if (command?.error_code === "endpoint_changed" && command.api_base_url !== this.database.getSettings().apiBaseUrl) {
      throw Object.assign(new Error("Comanda aparține vechii adrese API. Revino la acea adresă pentru reîncercare sau anulează modificarea locală."), { code: "endpoint_changed", permanent: true });
    }
    this.database.retryCommand(commandId);
    if (command?.error_code === "endpoint_changed") this.queue.resumeAfterCredentials({ retryFailed: false });
    this.emitState();
    await this.queue.waitForAttempt(commandId);
    this.emitState();
  }

  clearFailedCommands() {
    const cleared = this.database.dismissFailedCommands();
    this.emitState();
    return cleared;
  }

  revert(localId) {
    const result = this.database.revertBooking(localId);
    this.emitState();
    return result;
  }
}

module.exports = { BookingService, CACHE_MAX_AGE_MS, CACHE_CHECK_INTERVAL_MS, QUOTE_CACHE_TTL_MS, canonicalValue, quoteCacheKey, quotePayload };
