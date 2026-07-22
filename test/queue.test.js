"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BookingDatabase } = require("../src/main/database");
const { CommandQueue, backoffDelay } = require("../src/main/command-queue");
const { MarinaApiClient } = require("../src/main/api-client");

function create(db) {
  return db.optimisticCreate({ resourceId: 4, dates: ["2026-07-20"], formData: { name: { value: "Guest", type: "text" } }, approved: true });
}

test("exponential backoff is bounded and jittered", () => {
  assert.equal(backoffDelay(1, () => 0), 750);
  assert.equal(backoffDelay(2, () => 0.5), 2000);
  assert.equal(backoffDelay(20, () => 1), 375000);
});

test("unknown create reconciles by external_id and does not create twice", async () => {
  const db = new BookingDatabase(":memory:");
  create(db);
  let creates = 0;
  let lookups = 0;
  const api = {
    availability: async () => ({ available: true }),
    create: async () => { creates += 1; throw Object.assign(new Error("timeout"), { unknownOutcome: true, code: "timeout_unknown" }); },
    bookingByExternalId: async () => { lookups += 1; return { serverId: 991 }; }
  };
  const queue = new CommandQueue({ database: db, api });
  const command = db.readyCommands()[0];
  await queue.execute(command);
  assert.equal(creates, 1);
  assert.equal(lookups, 1);
  assert.equal(db.commandRows()[0].status, "synced");
  assert.equal(db.bookingRow(command.booking_local_id).serverId, 991);
  db.close();
});

test("availability rejection becomes a visible conflict", async () => {
  const db = new BookingDatabase(":memory:");
  const created = create(db);
  const queue = new CommandQueue({ database: db, api: { availability: async () => ({ available: false }) } });
  await queue.execute(db.readyCommands()[0]);
  assert.equal(db.commandRows()[0].status, "conflict");
  assert.equal(db.commandRows()[0].errorCode, "availability_conflict");
  assert.equal(db.bookingRow(created.booking.localId).syncState, "conflict");
  assert.equal(db.listBookings("2026-07-20", "2026-07-20").length, 0);
  db.close();
});

test("room edit checks the complete new stay and excludes its own server booking", async () => {
  const db = new BookingDatabase(":memory:");
  const booking = db.upsertRemoteBooking({
    serverId: 44,
    resourceId: 4,
    dates: ["2026-07-19", "2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"],
    status: "pending",
    trashed: false,
    note: "",
    formData: { name: { value: "Guest", type: "text" } }
  });
  db.optimisticUpdate(booking.localId, {
    dates: ["2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"]
  }, "edit");
  let availabilityCall;
  let editCalls = 0;
  const api = {
    availability: async (resourceId, dates, options) => {
      availabilityCall = { resourceId, dates, options };
      return { available: true };
    },
    edit: async () => { editCalls += 1; return { payload: { ok: true } }; }
  };
  const queue = new CommandQueue({ database: db, api });
  await queue.execute(db.readyCommands()[0]);
  assert.equal(availabilityCall.resourceId, 4);
  assert.deepEqual(availabilityCall.dates, [
    "2026-07-17 15:00:01",
    "2026-07-18 00:00:00",
    "2026-07-19 00:00:00",
    "2026-07-20 00:00:00",
    "2026-07-21 12:00:02"
  ]);
  assert.equal(availabilityCall.options.excludeBookingId, 44);
  assert.equal(editCalls, 1);
  assert.equal(db.commandRows()[0].status, "synced");
  db.close();
});

test("confirmed writes become visible only after the WordPress response", async () => {
  const db = new BookingDatabase(":memory:");
  const pendingCreate = create(db);
  assert.equal(db.listBookings("2026-07-20", "2026-07-20").length, 0);
  const createQueue = new CommandQueue({
    database: db,
    api: {
      availability: async () => ({ available: true }),
      create: async () => ({ payload: { booking_id: 81 } })
    }
  });
  await createQueue.execute(db.getCommand(pendingCreate.commandId));
  assert.equal(db.listBookings("2026-07-20", "2026-07-20")[0].serverId, 81);

  const queuedEdit = db.optimisticUpdate(pendingCreate.booking.localId, { note: "Confirmată" }, "note");
  assert.equal(db.bookingRow(pendingCreate.booking.localId).note, "");
  const editQueue = new CommandQueue({ database: db, api: { note: async () => ({ payload: { updated: true } }) } });
  await editQueue.execute(db.getCommand(queuedEdit.commandId));
  assert.equal(db.bookingRow(pendingCreate.booking.localId).note, "Confirmată");
  db.close();
});

test("availability API serializes the edited booking exclusion in the WordPress request", async () => {
  let requestBody;
  const api = new MarinaApiClient({
    getConfig: async () => ({ apiBaseUrl: "https://example.test/wp-json/marina-booking/v1", username: "api", password: "secret" }),
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, status: 200, headers: new Headers(), text: async () => '{"available":true}' };
    }
  });
  await api.availability(4, ["2026-07-17 00:00:00"], { excludeBookingId: 44 });
  assert.deepEqual(requestBody, { resource_id: 4, dates: ["2026-07-17 00:00:00"], exclude_booking_id: 44 });
});

test("unknown create with reliable external-id miss retries the same command key", async () => {
  const db = new BookingDatabase(":memory:");
  create(db);
  const api = {
    availability: async () => ({ available: true }),
    create: async () => { throw Object.assign(new Error("timeout"), { unknownOutcome: true, code: "timeout_unknown" }); },
    bookingByExternalId: async () => { throw Object.assign(new Error("not found"), { status: 404, code: "marina_booking_api_external_id_not_found" }); }
  };
  const queue = new CommandQueue({ database: db, api, random: () => 0 });
  const command = db.readyCommands()[0];
  await queue.execute(command);
  const stored = db.commandRows()[0];
  assert.equal(stored.status, "queued");
  assert.equal(stored.id, command.id);
  assert.equal(db.getCommand(command.id).idempotency_key, command.idempotency_key);
  db.close();
});

test("unknown outcomes for ordinary idempotent writes retry the same command key", async () => {
  const db = new BookingDatabase(":memory:");
  const booking = db.upsertRemoteBooking({ serverId: 46, resourceId: 4, dates: ["2026-07-20"], status: "pending", note: "", formData: {} });
  db.optimisticUpdate(booking.localId, { note: "Retry safely" }, "note");
  const command = db.readyCommands()[0];
  const api = { note: async () => { throw Object.assign(new Error("timeout"), { code: "timeout_unknown", unknownOutcome: true }); } };
  const queue = new CommandQueue({ database: db, api, random: () => 0, skipAvailabilityChecks: true });
  await queue.execute(command);
  const stored = db.getCommand(command.id);
  assert.equal(stored.status, "queued");
  assert.equal(stored.idempotency_key, command.idempotency_key);
  assert.equal(stored.error_code, "timeout_unknown");
  db.close();
});

test("an idempotency reservation still in progress remains queued instead of becoming a conflict", async () => {
  const db = new BookingDatabase(":memory:");
  const booking = db.upsertRemoteBooking({ serverId: 47, resourceId: 4, dates: ["2026-07-20"], status: "pending", note: "", formData: {} });
  db.optimisticUpdate(booking.localId, { note: "Wait for prior request" }, "note");
  const command = db.readyCommands()[0];
  const api = { note: async () => { throw Object.assign(new Error("În curs"), { code: "marina_booking_api_request_in_progress", status: 409, temporary: true, retryAfter: 2 }); } };
  const queue = new CommandQueue({ database: db, api, skipAvailabilityChecks: true });
  await queue.execute(command);
  const stored = db.getCommand(command.id);
  assert.equal(stored.status, "queued");
  assert.equal(stored.error_code, "marina_booking_api_request_in_progress");
  db.close();
});

test("authentication failure pauses the queue and credential recovery requeues it", async () => {
  const db = new BookingDatabase(":memory:");
  create(db);
  const api = { availability: async () => { throw Object.assign(new Error("Forbidden"), { auth: true, code: "forbidden" }); } };
  const queue = new CommandQueue({ database: db, api });
  await queue.execute(db.readyCommands()[0]);
  assert.equal(queue.authPaused, true);
  assert.equal(db.diagnostics().authPaused, true);
  assert.equal(db.commandRows()[0].errorCode, "authentication_failed");
  queue.resumeAfterCredentials();
  assert.equal(queue.authPaused, false);
  assert.equal(db.diagnostics().authPaused, false);
  assert.equal(db.commandRows()[0].status, "queued");
  assert.equal(db.readyCommands().length, 1);
  db.close();
});

test("queue refuses a command captured for a different API endpoint", async () => {
  const db = new BookingDatabase(":memory:");
  db.saveSettings({ apiBaseUrl: "https://site-a.example/wp-json/marina-booking/v1", username: "a" });
  create(db);
  const command = db.readyCommands()[0];
  db.saveSettings({ apiBaseUrl: "https://site-b.example/wp-json/marina-booking/v1", username: "b" });
  let networkCalls = 0;
  const queue = new CommandQueue({ database: db, api: { availability: async () => { networkCalls += 1; return { available: true }; } } });
  await queue.execute(command);
  assert.equal(networkCalls, 0);
  assert.equal(db.getCommand(command.id).status, "needs_attention");
  assert.equal(db.getCommand(command.id).error_code, "endpoint_changed");
  db.close();
});

function remoteBooking(db) {
  return db.upsertRemoteBooking({ serverId: 44, externalId: null, resourceId: 4, dates: ["2026-07-20", "2026-07-21"], status: "pending", trashed: false, note: "Avans: 30, Cost: 100, Rest: 70", formData: { email: { value: "client@example.com", type: "email" } } });
}

test("deposit queue uses the authoritative WordPress note without publishing it before confirmation", () => {
  const db = new BookingDatabase(":memory:");
  const booking = db.upsertRemoteBooking({ serverId: 45, externalId: null, resourceId: 4, dates: ["2026-07-20", "2026-07-21"], status: "pending", trashed: false, note: "Notă locală veche", formData: {} });
  const serverNote = "Sosire târzie\nAvans: 30, Cost: 1000, Rest: 970\nPăstrează locul aproape de recepție";
  db.queueDepositUpdate(booking.localId, { deposit: 40, total: 1000, note: serverNote });
  const command = db.commandRows().find((item) => item.type === "deposit_update");
  assert.equal(command.payload.expected_note, serverNote);
  assert.equal(db.bookingRow(booking.localId).note, "Notă locală veche");
  db.close();
});

test("zero deposit remains pending until WordPress confirms it", () => {
  const db = new BookingDatabase(":memory:");
  const booking = remoteBooking(db);
  db.queueDepositUpdate(booking.localId, { deposit: 0, total: 100, note: booking.note });
  const command = db.commandRows().find((item) => item.type === "deposit_update");
  assert.equal(command.payload.deposit, 0);
  assert.equal(command.payload.total, 100);
  assert.equal(db.bookingRow(booking.localId).note, "Avans: 30, Cost: 100, Rest: 70");
  db.close();
});

test("payment email waits for its deposit update and uses stable command keys", async () => {
  const db = new BookingDatabase(":memory:");
  const booking = remoteBooking(db);
  const deposit = db.queueDepositUpdate(booking.localId, 40);
  const payment = { reason: "aBcDeF", nights: 1, start_date: "2026-07-20", end_date: "2026-07-21" };
  const email = db.queuePaymentRequest(booking.localId, payment);
  assert.equal(email.dependsOnCommandId, deposit.commandId);
  assert.deepEqual(db.readyCommands().map((command) => command.type), ["deposit_update"]);
  const calls = [];
  const api = {
    deposit_update: async (_id, payload, key) => { calls.push({ type: "deposit", payload, key }); return { payload: { note: "Cost total: 100 RON, Depozit: 40 RON, Rest: 60 RON" } }; },
    payment_request: async (_id, payload, key) => { calls.push({ type: "email", payload, key }); return { payload: { sent: true } }; }
  };
  const queue = new CommandQueue({ database: db, api });
  await queue.execute(db.readyCommands()[0]);
  assert.deepEqual(db.readyCommands().map((command) => command.type), ["payment_request"]);
  await queue.execute(db.readyCommands()[0]);
  assert.deepEqual(calls.map((call) => call.type), ["deposit", "email"]);
  assert.equal(calls[0].key, deposit.commandId);
  assert.equal(calls[1].key, email.commandId);
  assert.deepEqual(calls[1].payload, payment);
  db.close();
});

test("deposit conflict blocks its dependent payment email", async () => {
  const db = new BookingDatabase(":memory:");
  const booking = remoteBooking(db);
  const deposit = db.queueDepositUpdate(booking.localId, 40);
  const payment = db.queuePaymentRequest(booking.localId, { reason: "aBcDeF", nights: 1, start_date: "2026-07-20", end_date: "2026-07-21" });
  const queue = new CommandQueue({ database: db, api: { deposit_update: async () => { throw Object.assign(new Error("Nota s-a schimbat"), { status: 409, code: "note_conflict" }); } } });
  const waiting = queue.waitForAttempt(payment.commandId);
  await queue.execute(db.readyCommands()[0]);
  await assert.rejects(waiting, (error) => error.code === "dependency_failed" && error.previousActionId === deposit.commandId);
  assert.equal(db.commandRows().find((command) => command.type === "deposit_update").status, "conflict");
  assert.equal(db.readyCommands().length, 0);
  assert.equal(db.commandRows().find((command) => command.type === "payment_request").status, "queued");
  db.close();
});

test("payment email cannot bypass an already failed deposit refresh", () => {
  const db = new BookingDatabase(":memory:");
  const booking = remoteBooking(db);
  const deposit = db.queueDepositUpdate(booking.localId, 40);
  db.markCommand(deposit.commandId, "failed", { code: "refresh_failed", message: "Refresh failed" });
  assert.throws(() => db.queuePaymentRequest(booking.localId, { reason: "aBcDeF", nights: 1, start_date: "2026-07-20", end_date: "2026-07-21" }), /Actualizarea avansului are o problemă/);
  db.close();
});

test("an old endpoint response cannot be committed after settings change mid-request", async () => {
  const db = new BookingDatabase(":memory:");
  db.saveSettings({ apiBaseUrl: "https://site-a.example/wp-json/marina-booking/v1", username: "api" });
  const created = create(db);
  let releaseResponse;
  let markStarted;
  const responseReleased = new Promise((resolve) => { releaseResponse = resolve; });
  const requestStarted = new Promise((resolve) => { markStarted = resolve; });
  const api = new MarinaApiClient({
    getConfig: async () => ({ ...db.getSettings(), password: "secret" }),
    fetchImpl: async () => {
      markStarted();
      await responseReleased;
      return { ok: true, status: 201, headers: new Headers(), text: async () => '{"booking_id":88}' };
    }
  });
  const queue = new CommandQueue({ database: db, api, skipAvailabilityChecks: true });
  const execution = queue.execute(db.getCommand(created.commandId));
  await requestStarted;
  db.saveSettings({ apiBaseUrl: "https://site-b.example/wp-json/marina-booking/v1", username: "api" });
  queue.pauseForEndpointChange();
  releaseResponse();
  await execution;
  assert.equal(db.getCommand(created.commandId).status, "needs_attention");
  assert.equal(db.getCommand(created.commandId).error_code, "endpoint_changed");
  assert.equal(db.bookingRow(created.booking.localId).serverId, null);
  db.close();
});
