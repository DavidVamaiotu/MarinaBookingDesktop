"use strict";

const { createHash } = require("node:crypto");

const SOURCE_FROM = "2000-01-01";
const SOURCE_TO = "2100-12-31";
const EXCLUDED_SOURCE_RESOURCE_IDS = new Set(["32"]);
const WRITE_PACE_MS = 250;

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

function formValue(formData, ...names) {
  for (const name of names) {
    const direct = formData?.[name]?.value ?? formData?.[name];
    if (direct !== undefined && direct !== null && String(direct).trim() !== "") return String(direct).trim();
    const suffixed = Object.entries(formData || {}).find(([key, field]) => key.startsWith(name) && String(field?.value ?? field ?? "").trim());
    if (suffixed) return String(suffixed[1]?.value ?? suffixed[1]).trim();
  }
  return "";
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

function bookingBody(booking, targetResourceId, { timed = false, status = null } = {}) {
  const dates = [...new Set(booking.dates || [])].map(String).sort();
  if (!dates.length) throw Object.assign(new Error(`Rezervarea sursă ${booking.serverId} nu are date valide.`), { code: "marina_migration_invalid_source", permanent: true });
  const numericResourceId = Number(targetResourceId);
  if (!Number.isSafeInteger(numericResourceId) || numericResourceId < 1) throw Object.assign(new Error("API-ul Marina a returnat un ID de resursă invalid pentru import."), { code: "marina_migration_invalid_resource_id", permanent: true });
  const timedEndDate = dates.length === 1 ? addIsoDays(dates[0], 1) : dates.at(-1);
  const periods = timed
    ? [{ start_at: `${dates[0]}T15:00:01${bucharestOffset(dates[0])}`, end_at: `${timedEndDate}T12:00:02${bucharestOffset(timedEndDate)}`, units: 1 }]
    : [{ start_date: dates[0], end_date: dates.at(-1), units: 1 }];
  return {
    resource_id: numericResourceId,
    periods,
    customer: {
      first_name: formValue(booking.formData, "name"),
      last_name: formValue(booking.formData, "secondname"),
      email: formValue(booking.formData, "email"),
      phone: formValue(booking.formData, "phone"),
      address: {},
      custom_fields: {}
    },
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
  return { version: 1, resources: {}, bookings: {}, startedAt: null, completedAt: null };
}

class MarinaRoomsMigrationService {
  constructor({ sourceApi, targetApi, journalStore, now = () => new Date().toISOString(), onProgress = () => {} } = {}) {
    if (!sourceApi?.resources || !sourceApi?.bookings) throw new TypeError("Sursa migrării trebuie să permită numai citirea resurselor și rezervărilor.");
    this.sourceApi = Object.freeze({ resources: sourceApi.resources.bind(sourceApi), bookings: sourceApi.bookings.bind(sourceApi) });
    this.targetApi = targetApi;
    this.journalStore = journalStore;
    this.now = now;
    this.onProgress = onProgress;
    this.running = false;
    this.progress = null;
  }

  loadJournal() {
    try { return { ...emptyJournal(), ...(this.journalStore?.load?.() || {}) }; }
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
      startedAt: journal.startedAt,
      completedAt: journal.completedAt
    };
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
    return {
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
            let response;
            for (let attempt = 0; ; attempt += 1) {
              try {
                const timed = Boolean(record.conflict);
                response = await this.targetApi.createBooking(
                  bookingBody(booking, targetResourceId, { timed }),
                  stableKey(timed ? "booking-create-timed" : "booking-create", sourceId)
                );
                break;
              } catch (error) {
                if (error?.status !== 429 || attempt >= 5) throw error;
                await delay(Math.max(1000, Math.min(60_000, Number(error.retryAfter || 5) * 1000)));
              }
            }
            record.targetId = externalId(entity(response.payload, ["booking"]));
            journal.bookings[sourceId] = record;
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
          if ((error?.conflict || error?.status === 409) && record.conflict) {
            try {
              const fallbackStatus = booking.trashed ? "trash" : "completed";
              const body = bookingBody(booking, targetResourceId, { timed: true, status: fallbackStatus });
              body.custom_fields = { migration: { original_status: booking.status, availability_conflict: true, imported_nonblocking_status: fallbackStatus } };
              const response = await this.targetApi.createBooking(body, stableKey("booking-create-historical", sourceId));
              record.targetId = externalId(entity(response.payload, ["booking"]));
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
      return { ...this.status(), sourceResources: resources.length, sourceBookings: bookings.length, unresolvedConflicts: unresolved };
    } finally {
      this.running = false;
      this.onProgress(this.status());
    }
  }
}

module.exports = { MarinaRoomsMigrationService, SOURCE_FROM, SOURCE_TO, EXCLUDED_SOURCE_RESOURCE_IDS, WRITE_PACE_MS, addIsoDays, bookingBody, bucharestOffset, migrationNote, resourceBody, stableKey };
