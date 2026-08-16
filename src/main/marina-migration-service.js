"use strict";

const { createHash } = require("node:crypto");
const { customerFromFormData, formValue } = require("../shared/marina-customer");
const { buildMarinaPricing, canonicalValue, samePricingConfiguration, verifyPricingConfiguration } = require("./marina-pricing");

const SOURCE_FROM = "2000-01-01";
const SOURCE_TO = "2100-12-31";
const EXCLUDED_SOURCE_RESOURCE_IDS = new Set(["32"]);
const WRITE_PACE_MS = 250;
const STAY_PERIOD_VERSION = 1;

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

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
  if (id === undefined || id === null || String(id).trim() === "") {
    throw Object.assign(new Error("API-ul Marina nu a returnat identificatorul înregistrării importate."), { code: "marina_migration_invalid_response", permanent: true });
  }
  return String(id);
}

function stableKey(kind, sourceId) {
  const bytes = createHash("sha256").update(`parkline:wpbooking:rooms:${kind}:${sourceId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bookingCreateKey(kind, sourceId, quoteId) {
  if (!quoteId) return stableKey(kind, sourceId);
  return stableKey(`${kind}-priced`, `${sourceId}:${quoteId}`);
}

function expectedVersion(payload) {
  const value = entity(payload?.payload ?? payload, ["booking"]);
  return value.version ?? value.booking_version ?? value.bookingVersion ?? value.etag ?? null;
}

function pricingEntity(payload) {
  const root = payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
  if (root?.pricing && typeof root.pricing === "object" && !Array.isArray(root.pricing)) return root.pricing;
  if (root?.config && typeof root.config === "object" && !Array.isArray(root.config)) return root.config;
  return root || {};
}

function pricingVersion(payload) {
  const root = payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload || {};
  const value = pricingEntity(payload);
  return root.version ?? root.pricing_version ?? root.pricingVersion
    ?? value.version ?? value.pricing_version ?? value.pricingVersion ?? null;
}

function isPricingUnconfigured(error) {
  return error?.status === 404 || error?.code === "pricing_not_configured";
}

function quoteIdFromResponse(response) {
  const value = entity(response?.payload ?? response, ["quote"]);
  const quoteId = String(value?.quote_id ?? value?.quoteId ?? "").trim();
  if (!quoteId) throw Object.assign(new Error("API-ul Marina nu a returnat un quote valid pentru import."), { code: "marina_migration_quote_invalid", permanent: true });
  return quoteId;
}

function configHash(config) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(config))).digest("hex");
}

function pricingReport(journal) {
  return Object.entries(journal?.pricing || {}).map(([sourceResourceId, item]) => ({
    sourceResourceId,
    targetResourceId: item.targetId || null,
    category: item.category || null,
    importedDays: Number(item.importedDays) || 0,
    coverage: item.coverage || null,
    baseNightlyMinor: item.baseNightlyMinor ?? null,
    seasons: Array.isArray(item.seasons) ? item.seasons : [],
    configHash: item.configHash || null,
    version: item.version ?? null,
    published: item.published === true,
    skippedWrite: item.skippedWrite === true,
    verified: item.verified === true,
    error: item.error || null
  }));
}

function numeric(value, fallback) {
  const parsed = Number(String(value || "").replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resourceBody(resource) {
  return {
    name: String(resource.title || resource.name || `Resursa ${resource.id}`).trim(),
    external_key: `wpbooking-rooms-${resource.id}`,
    timezone: "Europe/Bucharest",
    booking_mode: "date_range",
    capacity: 1,
    active: true,
    settings: {}
  };
}

function bucharestOffset(date) {
  const name = new Intl.DateTimeFormat("en", { timeZone: "Europe/Bucharest", timeZoneName: "shortOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`)).find((part) => part.type === "timeZoneName")?.value || "GMT+2";
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const hours = String(Number(match?.[2] || 2)).padStart(2, "0");
  return `${match?.[1] || "+"}${hours}:${match?.[3] || "00"}`;
}

function addIsoDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function bookingBody(booking, targetResourceId, { timed = false, status = null, quoteId = null } = {}) {
  const dates = [...new Set(booking.dates || [])].map(String).sort();
  if (!dates.length) throw Object.assign(new Error(`Rezervarea sursă ${booking.serverId} nu are date valide.`), { code: "marina_migration_invalid_source", permanent: true });
  const numericResourceId = Number(targetResourceId);
  if (!Number.isSafeInteger(numericResourceId) || numericResourceId < 1) throw Object.assign(new Error("API-ul Marina a returnat un ID de resursă invalid pentru import."), { code: "marina_migration_invalid_resource_id", permanent: true });
  const timedEndDate = dates.length === 1 ? addIsoDays(dates[0], 1) : dates.at(-1);
  const periods = timed
    ? [{ start_at: `${dates[0]}T15:00:01${bucharestOffset(dates[0])}`, end_at: `${timedEndDate}T12:00:02${bucharestOffset(timedEndDate)}`, units: 1 }]
    : [{ start_date: dates[0], end_date: dates.length > 1 ? dates.at(-2) : dates[0], units: 1 }];
  const body = {
    resource_id: numericResourceId,
    periods,
    customer: customerFromFormData(booking.formData),
    guests: {
      adults: numeric(formValue(booking.formData, "visitors"), 1),
      children: numeric(formValue(booking.formData, "children"), 0),
      details: {}
    },
    status: status || (booking.trashed ? "trash" : booking.status === "approved" ? "approved" : "pending"),
    custom_fields: {},
    internal_note: migrationNote(booking),
    external: { client_id: "wpbooking-rooms", booking_id: String(booking.serverId) }
  };
  if (quoteId) body.quote_id = String(quoteId);
  return body;
}

function migrationNote(booking) {
  const lines = [`Importat din WPBooking Camere. ID sursă: ${booking.serverId}.`];
  if (booking.note) lines.push(String(booking.note));
  const details = formValue(booking.formData, "details");
  if (details && details !== booking.note) lines.push(`Detalii: ${details}`);
  const cost = formValue(booking.formData, "cost_hint");
  const deposit = formValue(booking.formData, "deposit_hint");
  if (cost) lines.push(`Cost sursă: ${cost}`);
  if (deposit) lines.push(`Avans sursă: ${deposit}`);
  return lines.join("\n");
}

function emptyJournal() {
  return { version: 2, resources: {}, bookings: {}, pricing: {}, startedAt: null, completedAt: null };
}

const CUSTOMER_DETAILS_VERSION = 1;

class MarinaRoomsMigrationService {
  constructor({ sourceApi, targetApi, pricingSource = null, journalStore, now = () => new Date().toISOString(), onProgress = () => {} } = {}) {
    if (!sourceApi?.resources || !sourceApi?.bookings) throw new TypeError("Sursa migrării trebuie să permită numai citirea resurselor și rezervărilor.");
    this.sourceApi = Object.freeze({ resources: sourceApi.resources.bind(sourceApi), bookings: sourceApi.bookings.bind(sourceApi) });
    this.targetApi = targetApi;
    this.pricingSource = pricingSource;
    this.journalStore = journalStore;
    this.now = now;
    this.onProgress = onProgress;
    this.running = false;
    this.progress = null;
  }

  loadJournal() {
    try {
      const stored = this.journalStore?.load?.() || {};
      return { ...emptyJournal(), ...stored, resources: stored.resources || {}, bookings: stored.bookings || {}, pricing: stored.pricing || {} };
    }
    catch { return emptyJournal(); }
  }

  saveJournal(journal) { this.journalStore?.save?.(journal); }

  status() {
    const journal = this.loadJournal();
    return {
      running: this.running,
      progress: this.progress,
      importedResources: Object.keys(journal.resources || {}).length,
      importedBookings: Object.values(journal.bookings || {}).filter((item) => item.complete).length,
      importedPricing: Object.values(journal.pricing || {}).filter((item) => item.verified).length,
      pricingFailures: Object.values(journal.pricing || {}).filter((item) => item.error).length,
      startedAt: journal.startedAt,
      completedAt: journal.completedAt
    };
  }

  async readPricing(resources) {
    if (!this.pricingSource?.forResources) return { catalog: null, mapped: [], prepared: [] };
    const candidates = (resources || []).filter((resource) => resource.active !== false && !resource.legacy);
    const extracted = await this.pricingSource.forResources(candidates);
    const prepared = extracted.mapped.map((item) => {
      const generated = buildMarinaPricing(item.days, { depositPercent: 30, timezone: item.timezone });
      return {
        ...item,
        config: generated.config,
        groups: generated.groups,
        coverage: generated.coverage,
        sourceDays: generated.sourceDays,
        configHash: configHash(generated.config)
      };
    });
    return { ...extracted, prepared };
  }

  async existingPricingVersions(prepared, journal) {
    if (typeof this.targetApi?.pricing !== "function") return prepared.map((item) => ({
      sourceResourceId: item.source_resource_id,
      targetResourceId: journal.resources[String(item.source_resource_id)]?.targetId || null,
      category: item.category,
      existingVersion: null,
      existingConfigHash: null,
      publication: journal.resources[String(item.source_resource_id)]?.targetId ? "unread" : "initial"
    }));
    const result = [];
    for (const item of prepared) {
      const sourceResourceId = String(item.source_resource_id);
      const targetResourceId = journal.resources[sourceResourceId]?.targetId || null;
      let existingVersion = null;
      let existingConfigHash = null;
      let publication = targetResourceId ? "initial" : "unmapped";
      if (targetResourceId) {
        try {
          const current = await this.targetApi.pricing(targetResourceId);
          const currentConfig = pricingEntity(current?.payload);
          existingVersion = pricingVersion(current?.payload);
          existingConfigHash = configHash(currentConfig);
          publication = samePricingConfiguration(currentConfig, item.config) ? "unchanged" : "replace";
        } catch (error) {
          if (!isPricingUnconfigured(error)) throw error;
        }
      }
      result.push({ sourceResourceId, targetResourceId, category: item.category, existingVersion, existingConfigHash, publication });
    }
    return result;
  }

  async publishPricing(prepared, journal) {
    if (!prepared.length) return;
    let completed = 0;
    this.emit("pricing-publish", completed, prepared.length);
    for (const item of prepared) {
      const sourceId = String(item.source_resource_id);
      const targetResourceId = journal.resources[sourceId]?.targetId;
      if (!targetResourceId) throw Object.assign(new Error(`Nu există mapare Marina pentru prețul resursei sursă ${sourceId}.`), { code: "marina_pricing_resource_missing", permanent: true });
      const record = journal.pricing[sourceId] || {};
      let current = null;
      try {
        current = await this.targetApi.pricing(targetResourceId);
      } catch (error) {
        if (!isPricingUnconfigured(error)) throw error;
      }
      const currentConfig = current ? pricingEntity(current.payload) : null;
      const currentVersion = current ? pricingVersion(current.payload) : null;
      try {
        const shouldWrite = !currentConfig || !samePricingConfiguration(currentConfig, item.config);
        if (shouldWrite) {
          const body = { ...item.config };
          if (currentVersion !== null && currentVersion !== undefined) body.expected_version = currentVersion;
          await this.targetApi.putPricing(targetResourceId, body, stableKey("pricing-put", sourceId));
          current = await this.targetApi.pricing(targetResourceId);
        }
        const storedConfig = pricingEntity(current?.payload);
        verifyPricingConfiguration(storedConfig, item.sourceDays);
        record.targetId = String(targetResourceId);
        record.source = item.source;
        record.sourceUrl = item.source_url;
        record.sourceFingerprint = item.source_fingerprint;
        record.category = item.category;
        record.coverage = item.coverage;
        record.configHash = item.configHash;
        record.importedDays = item.sourceDays.length;
        record.baseNightlyMinor = item.config.resource_nightly_minor;
        record.seasons = item.config.seasons;
        record.published = shouldWrite;
        record.skippedWrite = !shouldWrite;
        record.version = pricingVersion(current?.payload);
        record.verified = true;
        record.verifiedAt = this.now();
        delete record.error;
        journal.pricing[sourceId] = record;
        this.saveJournal(journal);
      } catch (error) {
        record.targetId = String(targetResourceId);
        record.category = item.category;
        record.coverage = item.coverage;
        record.importedDays = item.sourceDays.length;
        record.baseNightlyMinor = item.config.resource_nightly_minor;
        record.seasons = item.config.seasons;
        record.configHash = item.configHash;
        record.verified = false;
        record.error = error.code || error.message || "pricing_publish_failed";
        journal.pricing[sourceId] = record;
        this.saveJournal(journal);
        throw error;
      }
      completed += 1;
      this.emit("pricing-verify", completed, prepared.length);
    }
  }

  async quoteForBooking(booking, targetResourceId, options = {}) {
    if (typeof this.targetApi?.quote !== "function") return null;
    // Nightly quotes accept inclusive calendar dates even when a conflict
    // fallback later uses a timed booking period.
    const body = bookingBody(booking, targetResourceId, { ...options, timed: false });
    const request = {
      resource_id: body.resource_id,
      periods: body.periods,
      guests: { adults: body.guests.adults, children: body.guests.children }
    };
    const response = await this.targetApi.quote(request);
    return quoteIdFromResponse(response);
  }

  async finalizeImportedBooking(booking, record, sourceId, remote) {
    const metadata = { migration: { source: "wpbooking-rooms", source_booking_id: sourceId, stay_period_version: STAY_PERIOD_VERSION } };
    const note = migrationNote(booking);
    const current = () => entity(remote?.payload ?? remote, ["booking"]);
    const currentMigration = current()?.custom_fields?.migration || {};
    if (String(current()?.internal_note || "") !== note
      || String(currentMigration.source_booking_id || "") !== sourceId
      || Number(currentMigration.stay_period_version || 0) !== STAY_PERIOD_VERSION) {
      remote = await this.targetApi.updateBooking(
        record.targetId,
        { internal_note: note, custom_fields: metadata },
        stableKey("booking-import-metadata", sourceId),
        expectedVersion(remote)
      );
    }
    const status = booking.trashed ? "trash" : booking.status === "approved" ? "approved" : "pending";
    if (String(current()?.status || "pending").toLowerCase() !== status) {
      remote = await this.targetApi.changeBookingStatus(
        record.targetId,
        { status },
        stableKey("booking-import-status", sourceId),
        expectedVersion(remote)
      );
    }
    record.customerDetailsVersion = CUSTOMER_DETAILS_VERSION;
    record.stayPeriodVersion = STAY_PERIOD_VERSION;
    record.stateApplied = true;
    record.noteApplied = true;
    record.complete = true;
    delete record.conflict;
    return { remote, status };
  }

  async readSource() {
    const resources = [...await this.sourceApi.resources()];
    const fetchedBookings = await this.sourceApi.bookings(SOURCE_FROM, SOURCE_TO);
    const bySourceId = new Map();
    for (const booking of fetchedBookings) bySourceId.set(String(booking.serverId), booking);
    const allBookings = [...bySourceId.values()];
    const excludedBookings = allBookings.filter((booking) => EXCLUDED_SOURCE_RESOURCE_IDS.has(String(booking.resourceId)));
    const bookings = allBookings.filter((booking) => !EXCLUDED_SOURCE_RESOURCE_IDS.has(String(booking.resourceId))).sort((left, right) => {
      if (Boolean(left.trashed) !== Boolean(right.trashed)) return left.trashed ? -1 : 1;
      return String(left.dates?.[0] || "").localeCompare(String(right.dates?.[0] || "")) || Number(left.serverId) - Number(right.serverId);
    });
    const includedResources = resources.filter((item) => !EXCLUDED_SOURCE_RESOURCE_IDS.has(String(item.id)));
    const resourceIds = new Set(includedResources.map((item) => String(item.id)));
    for (const booking of bookings) {
      const resourceId = String(booking.resourceId);
      if (resourceIds.has(resourceId)) continue;
      const sourceTitle = formValue(booking.formData, "resource");
      if (EXCLUDED_SOURCE_RESOURCE_IDS.has(resourceId)) continue;
      includedResources.push({
        id: booking.resourceId,
        title: sourceTitle || `Resursa arhivată ${resourceId}`,
        legacy: true,
        active: false
      });
      resourceIds.add(resourceId);
    }
    return {
      resources: includedResources,
      bookings,
      fetchedBookingRows: fetchedBookings.length,
      excludedBookings: excludedBookings.length,
      deferredCancelledBookings: 0
    };
  }

  async preview() {
    const source = await this.readSource();
    const journal = this.loadJournal();
    const dates = source.bookings.flatMap((item) => item.dates || []).sort();
    const pricing = await this.readPricing(source.resources);
    const existingPricing = await this.existingPricingVersions(pricing.prepared, journal);
    const result = {
      resources: source.resources.length,
      bookings: source.bookings.length,
      fetchedBookingRows: source.fetchedBookingRows,
      excludedBookings: source.excludedBookings,
      deferredCancelledBookings: source.deferredCancelledBookings,
      pendingResources: source.resources.filter((item) => !journal.resources?.[String(item.id)]).length,
      pendingBookings: source.bookings.filter((item) => !journal.bookings?.[String(item.serverId)]?.complete).length,
      approved: source.bookings.filter((item) => item.status === "approved" && !item.trashed).length,
      pending: source.bookings.filter((item) => item.status !== "approved" && !item.trashed).length,
      cancelled: source.bookings.filter((item) => item.trashed).length,
      from: dates[0] || null,
      to: dates.at(-1) || null
    };
    if (!this.pricingSource) return result;
    return {
      ...result,
      pricingSource: pricing.catalog?.source || null,
      pricingSourceUrl: pricing.catalog?.source_url || null,
      pricingCoverage: pricing.catalog?.coverage || null,
      pricingResources: pricing.prepared.length,
      pricingWarnings: pricing.catalog?.warnings || [],
      pricingVersions: pricing.prepared.map((item) => ({
        ...existingPricing.find((value) => value.sourceResourceId === String(item.source_resource_id)),
        configHash: item.configHash,
        from: item.coverage.from,
        to: item.coverage.to
      }))
    };
  }

  emit(phase, completed, total) {
    this.progress = { phase, completed, total };
    this.onProgress(this.status());
  }

  async run() {
    if (this.running) throw Object.assign(new Error("Importul Camere este deja în curs."), { code: "marina_migration_running", permanent: true });
    this.running = true;
    const journal = this.loadJournal();
    journal.startedAt ||= this.now();
    journal.completedAt = null;
    this.saveJournal(journal);
    try {
      const { resources, bookings } = await this.readSource();
      if (this.pricingSource) this.emit("pricing-extract", 0, 1);
      const pricing = await this.readPricing(resources);
      if (this.pricingSource) this.emit("pricing-extract", 1, 1);
      if (pricing.prepared.length) this.emit("pricing-validation", pricing.prepared.length, pricing.prepared.length);
      let completed = 0;
      this.emit("resources", completed, resources.length);
      for (const resource of resources) {
        const sourceId = String(resource.id);
        if (!journal.resources[sourceId]) {
          const response = await this.targetApi.createResource(resourceBody(resource), stableKey("resource-create", sourceId));
          journal.resources[sourceId] = { targetId: externalId(entity(response.payload, ["resource"])), title: String(resource.title || resource.name || "") };
          this.saveJournal(journal);
        }
        completed += 1;
        this.emit("resources", completed, resources.length);
      }

      await this.publishPricing(pricing.prepared, journal);

      completed = 0;
      this.emit("bookings", completed, bookings.length);
      for (const booking of bookings) {
        const sourceId = String(booking.serverId);
        const targetResourceId = journal.resources[String(booking.resourceId)]?.targetId;
        if (!targetResourceId) throw Object.assign(new Error(`Nu există mapare Marina pentru resursa sursă ${booking.resourceId}.`), { code: "marina_migration_resource_missing", permanent: true });
        const record = journal.bookings[sourceId] || {};
        let attemptedWrite = false;
        try {
          if (!record.targetId) {
            attemptedWrite = true;
            const quoteId = await this.quoteForBooking(booking, targetResourceId);
            const desired = bookingBody(booking, targetResourceId, { quoteId });
            const createBody = {
              resource_id: desired.resource_id,
              periods: desired.periods,
              customer: desired.customer,
              guests: { adults: desired.guests.adults, children: desired.guests.children }
            };
            if (quoteId) createBody.quote_id = quoteId;
            let response;
            for (let attempt = 0; ; attempt += 1) {
              try {
                response = await this.targetApi.createBooking(
                  createBody,
                  bookingCreateKey("booking-create", sourceId, quoteId)
                );
                break;
              } catch (error) {
                if (error?.status !== 429 || attempt >= 5) throw error;
                await delay(Math.max(1000, Math.min(60_000, Number(error.retryAfter || 5) * 1000)));
              }
            }
            record.targetId = externalId(entity(response.payload, ["booking"]));
            await this.finalizeImportedBooking(booking, record, sourceId, response);
            if (booking.trashed) record.trashApplied = true;
            journal.bookings[sourceId] = record;
            this.saveJournal(journal);
          }
          if (Number(record.stayPeriodVersion || 0) < STAY_PERIOD_VERSION) {
            attemptedWrite = true;
            const quoteId = await this.quoteForBooking(booking, targetResourceId);
            const desired = bookingBody(booking, targetResourceId, { quoteId });
            const currentResponse = typeof this.targetApi.booking === "function"
              ? await this.targetApi.booking(record.targetId)
              : null;
            const currentBooking = entity(currentResponse?.payload ?? currentResponse, ["booking"]);
            const customFields = currentBooking.custom_fields && typeof currentBooking.custom_fields === "object"
              ? currentBooking.custom_fields
              : {};
            const migration = customFields.migration && typeof customFields.migration === "object"
              ? customFields.migration
              : {};
            const patch = {
              periods: desired.periods,
              custom_fields: {
                ...customFields,
                migration: {
                  ...migration,
                  source: "wpbooking-rooms",
                  source_booking_id: sourceId,
                  stay_period_version: STAY_PERIOD_VERSION
                }
              }
            };
            if (quoteId) patch.quote_id = quoteId;
            await this.targetApi.updateBooking(
              record.targetId,
              patch,
              bookingCreateKey("booking-period-backfill", sourceId, quoteId),
              expectedVersion(currentResponse)
            );
            record.stayPeriodVersion = STAY_PERIOD_VERSION;
            this.saveJournal(journal);
          }
          if (record.customerDetailsVersion !== CUSTOMER_DETAILS_VERSION) {
            attemptedWrite = true;
            await this.targetApi.updateBooking(
              record.targetId,
              { customer: customerFromFormData(booking.formData) },
              stableKey("booking-customer-details", sourceId),
              null
            );
            record.customerDetailsVersion = CUSTOMER_DETAILS_VERSION;
            this.saveJournal(journal);
          }
          if (booking.trashed && !record.trashApplied) {
            attemptedWrite = true;
            await this.targetApi.changeBookingStatus(record.targetId, { status: "trash" }, stableKey("booking-trash", sourceId), null);
            record.trashApplied = true;
            this.saveJournal(journal);
          }
          record.stateApplied = true;
          record.noteApplied = true;
          record.complete = true;
          delete record.conflict;
          this.saveJournal(journal);
        } catch (error) {
          const lastDate = [...new Set(booking.dates || [])].map(String).sort().at(-1) || "";
          if (!record.targetId && (error?.conflict || error?.status === 409) && record.conflict) {
            try {
              const fallbackStatus = booking.trashed ? "trash" : "completed";
              const fallbackQuoteId = await this.quoteForBooking(booking, targetResourceId, { status: fallbackStatus });
              const body = bookingBody(booking, targetResourceId, { status: fallbackStatus, quoteId: fallbackQuoteId });
              body.custom_fields = { migration: { original_status: booking.status, availability_conflict: true, imported_nonblocking_status: fallbackStatus } };
              const response = await this.targetApi.createBooking(
                body,
                bookingCreateKey("booking-create-historical", sourceId, fallbackQuoteId)
              );
              record.targetId = externalId(entity(response.payload, ["booking"]));
              record.customerDetailsVersion = CUSTOMER_DETAILS_VERSION;
              record.stayPeriodVersion = STAY_PERIOD_VERSION;
              record.stateApplied = true;
              record.noteApplied = true;
              record.complete = true;
              record.availabilityConflictImported = true;
              if (lastDate < new Date().toISOString().slice(0, 10)) record.historicalConflictCompleted = true;
              delete record.conflict;
              this.saveJournal(journal);
            } catch (fallbackError) {
              error = fallbackError;
            }
          }
          if (record.complete) {
            completed += 1;
            this.emit("bookings", completed, bookings.length);
            if (attemptedWrite) await delay(WRITE_PACE_MS);
            continue;
          }
          if (!error?.conflict && error?.status !== 409) throw error;
          record.conflict = error.code || "availability_conflict";
          record.complete = false;
          journal.bookings[sourceId] = record;
          this.saveJournal(journal);
        }
        completed += 1;
        this.emit("bookings", completed, bookings.length);
        if (attemptedWrite) await delay(WRITE_PACE_MS);
      }
      const unresolved = Object.values(journal.bookings).filter((item) => item.conflict && !item.complete).length;
      journal.completedAt = unresolved ? null : this.now();
      this.saveJournal(journal);
      this.emit("complete", bookings.length, bookings.length);
      return {
        ...this.status(),
        sourceResources: resources.length,
        sourceBookings: bookings.length,
        importedPricing: pricing.prepared.length,
        pricingWarnings: pricing.catalog?.warnings || [],
        pricingReport: pricingReport(journal),
        unresolvedConflicts: unresolved
      };
    } finally {
      this.running = false;
      this.onProgress(this.status());
    }
  }
}

module.exports = { MarinaRoomsMigrationService, SOURCE_FROM, SOURCE_TO, EXCLUDED_SOURCE_RESOURCE_IDS, WRITE_PACE_MS, addIsoDays, bookingBody, bucharestOffset, configHash, customerFromFormData, migrationNote, pricingEntity, pricingReport, resourceBody, stableKey };
