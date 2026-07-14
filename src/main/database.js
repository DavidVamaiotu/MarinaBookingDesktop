"use strict";

const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const { toStayDateTimes } = require("../shared/booking-calendar");
const { normalizeFormData } = require("../shared/form-data");
const PricingNote = require("../shared/pricing-note");
const PaymentRequest = require("../shared/payment-request");

const ACTIVE_COMMAND_STATES = ["queued", "sending", "failed", "conflict", "needs_attention"];

function now() {
  return new Date().toISOString();
}

function json(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function datesFromRange(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && dates.length <= 366) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

class BookingDatabase {
  constructor(filename = ":memory:", stayTimes = {}) {
    this.stayTimes = stayTimes;
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.recoverInterruptedCommands();
  }

  bookingDateTimes(dates) {
    return toStayDateTimes(dates, this.stayTimes);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secrets (
        key TEXT PRIMARY KEY,
        encrypted_value BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resources (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        parent_id INTEGER,
        capacity INTEGER,
        base_cost REAL,
        default_form TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings (
        local_id TEXT PRIMARY KEY,
        server_id INTEGER UNIQUE,
        external_id TEXT UNIQUE,
        resource_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        trashed INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        form_data_json TEXT NOT NULL DEFAULT '{}',
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'synced',
        server_updated_at TEXT,
        server_payload_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_range ON bookings(start_date, end_date, resource_id);
      CREATE TABLE IF NOT EXISTS booking_dates (
        booking_local_id TEXT NOT NULL REFERENCES bookings(local_id) ON DELETE CASCADE,
        booking_date TEXT NOT NULL,
        PRIMARY KEY (booking_local_id, booking_date)
      );
      CREATE INDEX IF NOT EXISTS idx_booking_dates_date ON booking_dates(booking_date);
      CREATE TABLE IF NOT EXISTS booking_form_data (
        booking_local_id TEXT NOT NULL REFERENCES bookings(local_id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        field_type TEXT NOT NULL,
        field_value TEXT NOT NULL,
        PRIMARY KEY (booking_local_id, field_name)
      );
      CREATE TABLE IF NOT EXISTS booking_notes (
        booking_local_id TEXT PRIMARY KEY REFERENCES bookings(local_id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS optimistic_overlays (
        booking_local_id TEXT PRIMARY KEY REFERENCES bookings(local_id) ON DELETE CASCADE,
        base_json TEXT,
        overlay_json TEXT NOT NULL,
        remote_shadow_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        booking_local_id TEXT,
        resource_id INTEGER,
        api_base_url TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        depends_on_command_id TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        dismissed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_commands_ready ON commands(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_commands_booking ON commands(booking_local_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_commands_resource ON commands(resource_id, created_at);
      CREATE TABLE IF NOT EXISTS sync_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT,
        booking_local_id TEXT,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS loaded_ranges (
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        resource_id INTEGER NOT NULL DEFAULT 0,
        loaded_at TEXT NOT NULL,
        PRIMARY KEY (start_date, end_date, resource_id)
      );
    `);
    const commandColumns = this.db.prepare("PRAGMA table_info(commands)").all().map((column) => column.name);
    if (!commandColumns.includes("api_base_url")) this.db.exec("ALTER TABLE commands ADD COLUMN api_base_url TEXT");
    if (!commandColumns.includes("depends_on_command_id")) this.db.exec("ALTER TABLE commands ADD COLUMN depends_on_command_id TEXT");
    if (!commandColumns.includes("dismissed_at")) this.db.exec("ALTER TABLE commands ADD COLUMN dismissed_at TEXT");
    const resourceColumns = this.db.prepare("PRAGMA table_info(resources)").all().map((column) => column.name);
    if (!resourceColumns.includes("active")) this.db.exec("ALTER TABLE resources ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
    this.recoverStoredFormFields();
  }

  recoverStoredFormFields() {
    const rows = this.db.prepare("SELECT local_id,form_data_json,server_payload_json FROM bookings WHERE sync_state='synced' AND server_payload_json IS NOT NULL").all();
    if (!rows.length) return 0;
    const updateBooking = this.db.prepare("UPDATE bookings SET form_data_json=? WHERE local_id=?");
    const insertField = this.db.prepare("INSERT OR IGNORE INTO booking_form_data(booking_local_id,field_name,field_type,field_value) VALUES(?,?,?,?)");
    let recoveredCount = 0;
    this.transaction(() => {
      for (const row of rows) {
        const payload = json(row.server_payload_json, {});
        const recovered = normalizeFormData(payload.form_data || payload.form || payload.parsed_form || {});
        const current = json(row.form_data_json, {});
        let changed = false;
        for (const [name, field] of Object.entries(recovered)) {
          if (Object.prototype.hasOwnProperty.call(current, name)) continue;
          current[name] = field;
          insertField.run(row.local_id, name, String(field.type || "text"), String(field.value ?? ""));
          recoveredCount += 1;
          changed = true;
        }
        if (changed) updateBooking.run(JSON.stringify(current), row.local_id);
      }
    });
    return recoveredCount;
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverInterruptedCommands() {
    const timestamp = now();
    this.db.prepare(`UPDATE commands SET status='queued', available_at=?, updated_at=?, error_code='restart_recovery', error_message='Comanda a fost recuperată după repornirea aplicației.' WHERE status='sending'`).run(timestamp, timestamp);
  }

  getSettings() {
    const rows = this.db.prepare("SELECT key, value FROM settings").all();
    const result = { apiBaseUrl: "", username: "", timezone: "Europe/Bucharest" };
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  saveSettings(settings) {
    const statement = this.db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    const timestamp = now();
    this.transaction(() => {
      for (const key of ["apiBaseUrl", "username", "timezone"]) {
        if (settings[key] !== undefined) statement.run(key, String(settings[key]), timestamp);
      }
    });
  }

  setSecret(key, encryptedValue) {
    this.db.prepare("INSERT INTO secrets(key,encrypted_value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_at=excluded.updated_at").run(key, encryptedValue, now());
  }

  getSecret(key) {
    return this.db.prepare("SELECT encrypted_value FROM secrets WHERE key=?").get(key)?.encrypted_value || null;
  }

  deleteSecret(key) {
    this.db.prepare("DELETE FROM secrets WHERE key=?").run(key);
  }

  replaceResources(resources) {
    const statement = this.db.prepare(`INSERT INTO resources(id,title,parent_id,capacity,base_cost,default_form,active,payload_json,updated_at)
      VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,parent_id=excluded.parent_id,capacity=excluded.capacity,base_cost=excluded.base_cost,default_form=excluded.default_form,active=1,payload_json=excluded.payload_json,updated_at=excluded.updated_at`);
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare("UPDATE resources SET active=0,updated_at=?").run(timestamp);
      for (const resource of resources) {
        statement.run(Number(resource.id), String(resource.title || `Resource ${resource.id}`), resource.parent_id ?? null, resource.capacity ?? null, resource.base_cost ?? null, resource.default_form || "", JSON.stringify(resource), timestamp);
      }
    });
  }

  listResources({ includeInactive = false } = {}) {
    return this.db.prepare(`SELECT id,title,parent_id AS parentId,capacity,base_cost AS baseCost,default_form AS defaultForm,active
      FROM resources
      WHERE active=1 OR ?=1
      ORDER BY COALESCE(parent_id,0), id`).all(includeInactive ? 1 : 0).map((resource) => ({ ...resource, active: Boolean(resource.active) }));
  }

  bookingRow(localId) {
    const row = this.db.prepare("SELECT * FROM bookings WHERE local_id=?").get(localId);
    return row ? this.hydrateBooking(row) : null;
  }

  hydrateBooking(row) {
    const dates = this.db.prepare("SELECT booking_date FROM booking_dates WHERE booking_local_id=? ORDER BY booking_date").all(row.local_id).map((item) => item.booking_date);
    const formData = {};
    for (const field of this.db.prepare("SELECT field_name,field_type,field_value FROM booking_form_data WHERE booking_local_id=? ORDER BY field_name").all(row.local_id)) {
      formData[field.field_name] = { type: field.field_type, value: field.field_value };
    }
    return {
      localId: row.local_id,
      serverId: row.server_id,
      externalId: row.external_id,
      resourceId: row.resource_id,
      status: row.status,
      trashed: Boolean(row.trashed),
      note: row.note,
      formData,
      dates,
      startDate: row.start_date,
      endDate: row.end_date,
      syncState: row.sync_state,
      updatedAt: row.updated_at
    };
  }

  listBookings(start, end) {
    return this.db.prepare("SELECT DISTINCT b.* FROM bookings b JOIN booking_dates d ON d.booking_local_id=b.local_id WHERE d.booking_date BETWEEN ? AND ? ORDER BY b.resource_id,b.start_date,b.server_id").all(start, end).map((row) => this.hydrateBooking(row));
  }

  loadedRange(start, end, resourceId = 0) {
    return this.db.prepare(`SELECT start_date AS startDate,end_date AS endDate,loaded_at AS loadedAt
      FROM loaded_ranges
      WHERE resource_id=? AND start_date<=? AND end_date>=?
      ORDER BY loaded_at DESC LIMIT 1`).get(Number(resourceId), start, end) || null;
  }

  rangeIsFresh(start, end, maxAgeMs, resourceId = 0, timestamp = Date.now()) {
    const range = this.loadedRange(start, end, resourceId);
    if (!range) return false;
    const loadedAt = Date.parse(range.loadedAt);
    return Number.isFinite(loadedAt) && loadedAt >= timestamp - maxAgeMs;
  }

  markRangeLoaded(start, end, resourceId = 0, loadedAt = now()) {
    this.db.prepare(`INSERT INTO loaded_ranges(start_date,end_date,resource_id,loaded_at)
      VALUES(?,?,?,?)
      ON CONFLICT(start_date,end_date,resource_id) DO UPDATE SET loaded_at=excluded.loaded_at`).run(start, end, Number(resourceId), loadedAt);
    this.db.prepare(`DELETE FROM loaded_ranges WHERE rowid NOT IN (
      SELECT rowid FROM loaded_ranges ORDER BY loaded_at DESC LIMIT 24
    )`).run();
  }

  invalidateLoadedRanges() {
    this.db.prepare("DELETE FROM loaded_ranges").run();
  }

  reconcileRemoteRange(start, end, returnedServerIds) {
    const returned = new Set([...returnedServerIds].map(Number));
    const cached = this.db.prepare(`SELECT DISTINCT b.local_id AS localId,b.server_id AS serverId
      FROM bookings b
      JOIN booking_dates d ON d.booking_local_id=b.local_id
      WHERE d.booking_date BETWEEN ? AND ?
        AND b.server_id IS NOT NULL
        AND b.sync_state='synced'`).all(start, end);
    const remove = cached.filter((booking) => !returned.has(Number(booking.serverId)));
    if (!remove.length) return 0;
    const statement = this.db.prepare("DELETE FROM bookings WHERE local_id=? AND sync_state='synced'");
    this.transaction(() => remove.forEach((booking) => statement.run(booking.localId)));
    return remove.length;
  }

  writeBooking(booking, { preserveOverlay = false } = {}) {
    const localId = String(booking.localId || (booking.serverId ? `server:${booking.serverId}` : `local:${randomUUID()}`));
    const dates = [...new Set(booking.dates || [])].sort();
    if (!dates.length) throw new Error("Datele rezervării sunt obligatorii.");
    const formData = booking.formData || {};
    const timestamp = now();
    this.db.prepare(`INSERT INTO bookings(local_id,server_id,external_id,resource_id,status,trashed,note,form_data_json,start_date,end_date,sync_state,server_updated_at,server_payload_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_id) DO UPDATE SET server_id=excluded.server_id,external_id=COALESCE(excluded.external_id,bookings.external_id),resource_id=excluded.resource_id,status=excluded.status,trashed=excluded.trashed,note=excluded.note,form_data_json=excluded.form_data_json,start_date=excluded.start_date,end_date=excluded.end_date,sync_state=excluded.sync_state,server_updated_at=excluded.server_updated_at,server_payload_json=excluded.server_payload_json,updated_at=excluded.updated_at`).run(
        localId, booking.serverId ?? null, booking.externalId || null, Number(booking.resourceId), booking.status || "pending", booking.trashed ? 1 : 0, String(booking.note || ""), JSON.stringify(formData), dates[0], dates[dates.length - 1], booking.syncState || "synced", booking.serverUpdatedAt || null, booking.serverPayload ? JSON.stringify(booking.serverPayload) : null, timestamp
      );
    this.db.prepare("DELETE FROM booking_dates WHERE booking_local_id=?").run(localId);
    const dateStatement = this.db.prepare("INSERT INTO booking_dates(booking_local_id,booking_date) VALUES(?,?)");
    for (const date of dates) dateStatement.run(localId, date);
    this.db.prepare("DELETE FROM booking_form_data WHERE booking_local_id=?").run(localId);
    const fieldStatement = this.db.prepare("INSERT INTO booking_form_data(booking_local_id,field_name,field_type,field_value) VALUES(?,?,?,?)");
    for (const [name, field] of Object.entries(formData)) fieldStatement.run(localId, name, String(field.type || "text"), String(field.value ?? ""));
    this.db.prepare("INSERT INTO booking_notes(booking_local_id,note,updated_at) VALUES(?,?,?) ON CONFLICT(booking_local_id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at").run(localId, String(booking.note || ""), timestamp);
    if (!preserveOverlay && booking.syncState === "synced") this.db.prepare("DELETE FROM optimistic_overlays WHERE booking_local_id=?").run(localId);
    return this.bookingRow(localId);
  }

  upsertRemoteBooking(booking) {
    const serverId = Number(booking.serverId);
    const existing = booking.externalId
      ? this.db.prepare("SELECT local_id,sync_state FROM bookings WHERE server_id=? OR external_id=? ORDER BY CASE WHEN server_id=? THEN 0 ELSE 1 END LIMIT 1").get(serverId, booking.externalId, serverId)
      : this.db.prepare("SELECT local_id,sync_state FROM bookings WHERE server_id=?").get(serverId);
    if (existing && existing.sync_state !== "synced") {
      const overlay = this.db.prepare("SELECT base_json FROM optimistic_overlays WHERE booking_local_id=?").get(existing.local_id);
      const base = json(overlay?.base_json);
      this.db.prepare("UPDATE optimistic_overlays SET remote_shadow_json=?,updated_at=? WHERE booking_local_id=?").run(JSON.stringify(booking), now(), existing.local_id);
      const comparable = (value) => value ? JSON.stringify({ resourceId: Number(value.resourceId), dates: value.dates || [], status: value.status || "pending", trashed: Boolean(value.trashed), note: value.note || "", formData: value.formData || {} }) : "";
      if (base && comparable(base) !== comparable(booking)) this.markBookingConflict(existing.local_id, "remote_changed", "Rezervarea de pe server s-a schimbat în timp ce existau modificări locale în așteptare.", booking);
      return this.bookingRow(existing.local_id);
    }
    return this.transaction(() => this.writeBooking({ ...booking, localId: existing?.local_id || `server:${serverId}`, syncState: "synced" }));
  }

  setOverlay(localId, base, overlay) {
    this.db.prepare("INSERT INTO optimistic_overlays(booking_local_id,base_json,overlay_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(booking_local_id) DO UPDATE SET overlay_json=excluded.overlay_json,updated_at=excluded.updated_at").run(localId, base ? JSON.stringify(base) : null, JSON.stringify(overlay), now());
  }

  enqueue(type, bookingLocalId, resourceId, payload, options = {}) {
    const coalescible = new Set(["edit", "note"]);
    const timestamp = now();
    if (coalescible.has(type) && !options.noCoalesce) {
      const existing = this.db.prepare("SELECT id FROM commands WHERE type=? AND booking_local_id=? AND status='queued' ORDER BY created_at DESC LIMIT 1").get(type, bookingLocalId);
      if (existing) {
        this.db.prepare("UPDATE commands SET payload_json=?,resource_id=?,updated_at=?,available_at=?,error_code=NULL,error_message=NULL WHERE id=?").run(JSON.stringify(payload), resourceId ?? null, timestamp, timestamp, existing.id);
        return existing.id;
      }
    }
    const id = options.commandId || randomUUID();
    const apiBaseUrl = this.db.prepare("SELECT value FROM settings WHERE key='apiBaseUrl'").get()?.value || "";
    this.db.prepare("INSERT INTO commands(id,type,booking_local_id,resource_id,api_base_url,payload_json,status,available_at,idempotency_key,depends_on_command_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?)").run(id, type, bookingLocalId || null, resourceId ?? null, apiBaseUrl, JSON.stringify(payload), timestamp, options.idempotencyKey || id, options.dependsOnCommandId || null, timestamp, timestamp);
    return id;
  }

  optimisticCreate(input) {
    const externalId = randomUUID();
    const localId = `local:${externalId}`;
    return this.transaction(() => {
      const booking = this.writeBooking({ ...input, localId, externalId, status: input.approved ? "approved" : "pending", trashed: false, syncState: "queued" });
      this.setOverlay(localId, null, booking);
      const commandId = this.enqueue("create", localId, input.resourceId, { resource_id: input.resourceId, dates: input.apiDates || this.bookingDateTimes(input.dates), form_data: input.formData, booking_form_type: input.bookingFormType || "", approved: Boolean(input.approved), send_email: Boolean(input.sendEmail), external_id: externalId }, { noCoalesce: true, idempotencyKey: externalId, commandId: externalId });
      return { booking, commandId };
    });
  }

  optimisticUpdate(localId, patch, type = "edit") {
    return this.transaction(() => {
      const current = this.bookingRow(localId);
      if (!current) throw new Error("Rezervarea nu a fost găsită.");
      const next = { ...current, ...patch, formData: patch.formData || current.formData, dates: patch.dates || current.dates, syncState: "queued" };
      const booking = this.writeBooking(next, { preserveOverlay: true });
      this.setOverlay(localId, current, booking);
      let payload;
      if (type === "status") payload = { status: booking.status, send_email: Boolean(patch.sendEmail) };
      else if (type === "note") payload = { note: booking.note };
      else if (type === "trash") payload = { trash: booking.trashed, send_email: Boolean(patch.sendEmail) };
      else {
        const apiDates = this.bookingDateTimes(booking.dates);
        payload = {
          resource_id: booking.resourceId,
          dates: apiDates,
          form_data: booking.formData,
          booking_form_type: patch.bookingFormType || "",
          note: booking.note,
          send_email: Boolean(patch.sendEmail),
          availability_dates: apiDates
        };
      }
      const commandId = this.enqueue(type, localId, booking.resourceId, payload);
      return { booking, commandId };
    });
  }

  queueDepositUpdate(localId, payment) {
    return this.transaction(() => {
      const current = this.bookingRow(localId);
      if (!current) throw new Error("Rezervarea nu a fost găsită.");
      if (!current.serverId) throw new Error("Rezervarea trebuie sincronizată înainte de schimbarea avansului.");
      const pending = this.db.prepare("SELECT id FROM commands WHERE booking_local_id=? AND type IN ('deposit_update','payment_request') AND status IN ('queued','sending','failed','conflict','needs_attention') LIMIT 1").get(localId);
      if (pending) throw new Error("Există deja o operație de plată nesincronizată pentru această rezervare.");
      const input = payment && typeof payment === "object" ? payment : { deposit: payment };
      const authoritativeNote = String(input.note ?? current.note ?? "");
      const pricing = PricingNote.parse(authoritativeNote);
      if (!pricing) throw new Error("Nota rezervării nu conține un Cost valid.");
      const authoritativeTotal = Number(input.total ?? pricing.total);
      if (!Number.isFinite(authoritativeTotal) || Math.abs(authoritativeTotal - pricing.total) > 0.005) throw new Error("Costul verificat nu corespunde notei WordPress.");
      const updated = PricingNote.update(authoritativeNote, Number(input.deposit), authoritativeTotal);
      const booking = this.writeBooking({ ...current, note: updated.note, syncState: "queued" }, { preserveOverlay: true });
      this.setOverlay(localId, current, booking);
      const commandId = this.enqueue("deposit_update", localId, null, {
        deposit: updated.deposit,
        total: updated.total,
        expected_note: authoritativeNote
      }, { noCoalesce: true });
      return { booking, commandId, pricing: updated };
    });
  }

  queuePaymentRequest(localId, paymentRequest) {
    return this.transaction(() => {
      paymentRequest = PaymentRequest.validate(paymentRequest);
      const booking = this.bookingRow(localId);
      if (!booking?.serverId) throw new Error("Rezervarea trebuie sincronizată înainte de trimiterea emailului.");
      const existing = this.db.prepare("SELECT id FROM commands WHERE booking_local_id=? AND type='payment_request' AND status IN ('queued','sending','failed','conflict','needs_attention') LIMIT 1").get(localId);
      if (existing) throw new Error("Există deja un email de plată nesincronizat pentru această rezervare.");
      const blockedDeposit = this.db.prepare("SELECT id FROM commands WHERE booking_local_id=? AND type='deposit_update' AND status IN ('failed','conflict','needs_attention') LIMIT 1").get(localId);
      if (blockedDeposit) throw new Error("Actualizarea avansului are o problemă. Reîncearcă sau anulează modificarea înainte de trimiterea emailului.");
      const dependency = this.db.prepare("SELECT id FROM commands WHERE booking_local_id=? AND type='deposit_update' AND status IN ('queued','sending') ORDER BY created_at DESC LIMIT 1").get(localId);
      const commandId = this.enqueue("payment_request", localId, null, paymentRequest, { noCoalesce: true, dependsOnCommandId: dependency?.id });
      this.refreshBookingSyncState(localId);
      return { booking: this.bookingRow(localId), commandId, dependsOnCommandId: dependency?.id || null };
    });
  }

  commandRows(limit = 500) {
    return this.db.prepare("SELECT * FROM commands WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT ?").all(limit).map((row) => ({
      id: row.id, type: row.type, bookingLocalId: row.booking_local_id, resourceId: row.resource_id, payload: json(row.payload_json, {}), status: row.status, attempts: row.attempts, availableAt: row.available_at, dependsOnCommandId: row.depends_on_command_id, result: json(row.result_json), errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  getCommand(id) {
    const row = this.db.prepare("SELECT * FROM commands WHERE id=?").get(id);
    return row ? { ...row, payload: json(row.payload_json, {}) } : null;
  }

  readyCommands(timestamp = now()) {
    const rows = this.db.prepare("SELECT rowid AS queue_order,* FROM commands WHERE status='queued' AND available_at<=? ORDER BY created_at,queue_order").all(timestamp).map((row) => ({ ...row, payload: json(row.payload_json, {}) }));
    return rows.filter((candidate) => {
      if (candidate.depends_on_command_id) {
        const dependency = this.db.prepare("SELECT status FROM commands WHERE id=?").get(candidate.depends_on_command_id);
        if (dependency?.status !== "synced") return false;
      }
      return !this.db.prepare(`SELECT 1 FROM commands WHERE rowid<>? AND (created_at<? OR (created_at=? AND rowid<?)) AND status IN (${ACTIVE_COMMAND_STATES.map(() => "?").join(",")}) AND ((booking_local_id IS NOT NULL AND booking_local_id=?) OR (resource_id IS NOT NULL AND resource_id=?)) LIMIT 1`).get(candidate.queue_order, candidate.created_at, candidate.created_at, candidate.queue_order, ...ACTIVE_COMMAND_STATES, candidate.booking_local_id, candidate.resource_id);
    });
  }

  markSending(id) {
    this.db.prepare("UPDATE commands SET status='sending',attempts=attempts+1,updated_at=?,error_code=NULL,error_message=NULL WHERE id=?").run(now(), id);
  }

  markCommand(id, status, { result = null, code = null, message = null, availableAt = null } = {}) {
    const timestamp = now();
    this.db.prepare("UPDATE commands SET status=?,result_json=?,error_code=?,error_message=?,available_at=COALESCE(?,available_at),updated_at=?,completed_at=CASE WHEN ?='synced' THEN ? ELSE completed_at END WHERE id=?").run(status, result ? JSON.stringify(result) : null, code, message, availableAt, timestamp, status, timestamp, id);
    const command = this.getCommand(id);
    if (status !== "synced" && code) this.db.prepare("INSERT INTO sync_errors(command_id,booking_local_id,code,message,details_json,created_at) VALUES(?,?,?,?,?,?)").run(id, command?.booking_local_id || null, code, message || code, result ? JSON.stringify(result) : null, timestamp);
    if (command?.booking_local_id) this.refreshBookingSyncState(command.booking_local_id);
  }

  markCreateSynced(command, serverId, result) {
    this.transaction(() => {
      const duplicate = this.db.prepare("SELECT local_id FROM bookings WHERE server_id=? AND local_id<>?").get(Number(serverId), command.booking_local_id);
      if (duplicate) this.db.prepare("DELETE FROM bookings WHERE local_id=? AND sync_state='synced'").run(duplicate.local_id);
      this.db.prepare("UPDATE bookings SET server_id=?,sync_state='synced',updated_at=? WHERE local_id=?").run(Number(serverId), now(), command.booking_local_id);
      this.markCommand(command.id, "synced", { result });
      this.refreshBookingSyncState(command.booking_local_id);
    });
  }

  refreshBookingSyncState(localId) {
    const active = this.db.prepare(`SELECT status FROM commands WHERE booking_local_id=? AND status IN (${ACTIVE_COMMAND_STATES.map(() => "?").join(",")}) ORDER BY created_at LIMIT 1`).get(localId, ...ACTIVE_COMMAND_STATES);
    const state = active?.status || "synced";
    this.db.prepare("UPDATE bookings SET sync_state=?,updated_at=? WHERE local_id=?").run(state, now(), localId);
    if (!active) this.db.prepare("DELETE FROM optimistic_overlays WHERE booking_local_id=?").run(localId);
  }

  retryCommand(id) {
    const timestamp = now();
    this.db.prepare("UPDATE commands SET status='queued',api_base_url=COALESCE((SELECT value FROM settings WHERE key='apiBaseUrl'),api_base_url),available_at=?,error_code=NULL,error_message=NULL,dismissed_at=NULL,updated_at=? WHERE id=? AND status IN ('failed','conflict','needs_attention')").run(timestamp, timestamp, id);
  }

  dismissFailedCommands() {
    return this.transaction(() => {
      const failures = this.db.prepare("SELECT id,booking_local_id FROM commands WHERE status='failed' AND dismissed_at IS NULL ORDER BY created_at,id").all();
      if (!failures.length) return 0;
      const bookingIds = [...new Set(failures.map((row) => row.booking_local_id).filter(Boolean))];
      const affectedCommandIds = new Set(failures.map((row) => row.id));
      for (const localId of bookingIds) {
        const active = this.db.prepare(`SELECT id FROM commands WHERE booking_local_id=? AND status IN (${ACTIVE_COMMAND_STATES.map(() => "?").join(",")})`).all(localId, ...ACTIVE_COMMAND_STATES);
        for (const command of active) affectedCommandIds.add(command.id);
        this.revertBookingState(localId);
      }
      const timestamp = now();
      for (const commandId of affectedCommandIds) {
        this.db.prepare("UPDATE commands SET status='cancelled',error_code='discarded_failed_operation',error_message='Operația eșuată și modificările locale dependente au fost anulate',dismissed_at=?,updated_at=?,completed_at=COALESCE(completed_at,?) WHERE id=?").run(timestamp, timestamp, timestamp, commandId);
        this.db.prepare("UPDATE sync_errors SET resolved_at=? WHERE resolved_at IS NULL AND command_id=?").run(timestamp, commandId);
      }
      return failures.length;
    });
  }

  retryAuthenticationCommands() {
    const timestamp = now();
    return this.db.prepare(`UPDATE commands
      SET status='queued',available_at=?,error_code=NULL,error_message=NULL,dismissed_at=NULL,updated_at=?
      WHERE status='failed' AND error_code IN ('authentication_failed','http_401','http_403')`).run(timestamp, timestamp).changes;
  }

  quarantineQueuedCommands(message = "Adresa API s-a schimbat; verifică ținta înainte de a reîncerca această comandă.") {
    const rows = this.db.prepare("SELECT id,booking_local_id FROM commands WHERE status='queued'").all();
    if (!rows.length) return 0;
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare("UPDATE commands SET status='needs_attention',error_code='endpoint_changed',error_message=?,updated_at=? WHERE status='queued'").run(message, timestamp);
      for (const row of rows) if (row.booking_local_id) this.refreshBookingSyncState(row.booking_local_id);
    });
    return rows.length;
  }

  markBookingConflict(localId, code, message, details = null) {
    const command = this.db.prepare("SELECT id FROM commands WHERE booking_local_id=? AND status='queued' ORDER BY created_at,id LIMIT 1").get(localId);
    if (command) this.markCommand(command.id, "conflict", { code, message, result: details });
    else this.db.prepare("UPDATE bookings SET sync_state='conflict',updated_at=? WHERE local_id=?").run(now(), localId);
  }

  revertBookingState(localId) {
    const timestamp = now();
    this.db.prepare("UPDATE commands SET status='cancelled',error_code='reverted',error_message='Modificarea a fost anulată de utilizator',updated_at=?,completed_at=? WHERE booking_local_id=? AND status IN ('queued','failed','conflict','needs_attention')").run(timestamp, timestamp, localId);
    const overlay = this.db.prepare("SELECT base_json FROM optimistic_overlays WHERE booking_local_id=?").get(localId);
    if (!overlay) {
      this.refreshBookingSyncState(localId);
      return this.bookingRow(localId);
    }
    const base = json(overlay.base_json);
    if (!base) {
      this.db.prepare("DELETE FROM bookings WHERE local_id=?").run(localId);
      return null;
    }
    const booking = this.writeBooking({ ...base, syncState: "synced" });
    this.db.prepare("DELETE FROM optimistic_overlays WHERE booking_local_id=?").run(localId);
    return booking;
  }

  revertBooking(localId) {
    return this.transaction(() => this.revertBookingState(localId));
  }

  diagnostics() {
    const counts = Object.fromEntries(this.db.prepare("SELECT status,COUNT(*) count FROM commands WHERE dismissed_at IS NULL GROUP BY status").all().map((row) => [row.status, row.count]));
    const meta = Object.fromEntries(this.db.prepare("SELECT key,value FROM sync_meta").all().map((row) => [row.key, row.value]));
    const cache = this.db.prepare("SELECT start_date AS startDate,end_date AS endDate,loaded_at AS loadedAt FROM loaded_ranges WHERE resource_id=0 ORDER BY loaded_at DESC LIMIT 1").get() || null;
    return { queued: (counts.queued || 0) + (counts.sending || 0), failed: (counts.failed || 0) + (counts.conflict || 0) + (counts.needs_attention || 0), counts, lastSuccessfulSync: meta.lastSuccessfulSync || null, authPaused: meta.authPaused === "true", cache };
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO sync_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, String(value), now());
  }
}

module.exports = { BookingDatabase, datesFromRange };
