"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BookingDatabase } = require("../src/main/database");
const { BookingService, quoteCacheKey } = require("../src/main/booking-service");
const { CommandQueue } = require("../src/main/command-queue");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function serviceFixture() {
  const database = new BookingDatabase(":memory:");
  const queue = new EventEmitter();
  queue.start = () => {};
  queue.stop = () => {};
  queue.schedule = () => {};
  const calls = { resources: 0, bookings: 0 };
  const api = {
    async resources() { calls.resources += 1; return [{ id: 4, title: "Room 4" }]; },
    async bookings() {
      calls.bookings += 1;
      return [{ serverId: 7, resourceId: 4, dates: ["2026-07-20"], formData: { name: { value: "Fixture", type: "text" } }, status: "approved", note: "" }];
    }
  };
  const vault = { hasPassword: () => true };
  return { database, calls, service: new BookingService({ database, api, queue, vault }) };
}

test("booking service stores a fetched range and reuses it without another API read", async () => {
  const { database, calls, service } = serviceFixture();
  const range = { start: "2026-03-01", end: "2026-11-30" };
  const first = await service.refresh(range);
  const second = await service.refresh(range);
  assert.equal(first.bookings.length, 1);
  assert.equal(second.bookings.length, 1);
  assert.deepEqual(calls, { resources: 1, bookings: 1 });
  assert.equal(database.loadedRange(range.start, range.end).startDate, range.start);
  database.close();
});

test("a forced refresh explicitly verifies the cached range again", async () => {
  const { database, calls, service } = serviceFixture();
  const range = { start: "2026-03-01", end: "2026-11-30" };
  await service.refresh(range);
  await service.refresh(range, { force: true });
  assert.deepEqual(calls, { resources: 2, bookings: 2 });
  database.close();
});

test("an older range refresh cannot emit state for a newer visible range", async () => {
  const database = new BookingDatabase(":memory:");
  const queue = new EventEmitter();
  queue.start = () => {};
  queue.stop = () => {};
  queue.schedule = () => {};
  const api = {
    async resources() { return [{ id: 4, title: "Room 4" }]; },
    async bookings(start) {
      await delay(start === "2026-01-01" ? 30 : 1);
      return [{ serverId: start === "2026-01-01" ? 1 : 2, resourceId: 4, dates: [start], formData: { name: { value: start, type: "text" } }, status: "approved", note: "" }];
    }
  };
  const service = new BookingService({ database, api, queue, vault: { hasPassword: () => true } });
  const events = [];
  service.on("state", (next) => events.push({ range: next.range, bookings: next.bookings.map((booking) => booking.serverId) }));
  const january = { start: "2026-01-01", end: "2026-01-31" };
  const february = { start: "2026-02-01", end: "2026-02-28" };
  const januaryRefresh = service.refresh(january);
  await delay(5);
  const februaryRefresh = service.refresh(february);
  await Promise.all([januaryRefresh, februaryRefresh]);
  assert.deepEqual(events, [{ range: february, bookings: [2] }]);
  database.close();
});

test("a successful authenticated refresh resumes the paused queue and requeues auth failures", async () => {
  const database = new BookingDatabase(":memory:");
  database.saveSettings({ apiBaseUrl: "https://example.com/wp-json/marina-booking/v1", username: "api" });
  const created = database.optimisticCreate({ resourceId: 4, dates: ["2026-07-20", "2026-07-21"], formData: { name: { value: "Fixture", type: "text" } } });
  database.markCommand(created.commandId, "failed", { code: "authentication_failed", message: "Expired credentials" });
  database.setMeta("authPaused", "true");
  const api = {
    async resources() { return [{ id: 4, title: "Room 4" }]; },
    async bookings() { return []; }
  };
  const queue = new CommandQueue({ database, api });
  const service = new BookingService({ database, api, queue, vault: { hasPassword: () => true } });
  await service.refresh({ start: "2026-07-01", end: "2026-07-31" }, { force: true });
  assert.equal(queue.authPaused, false);
  assert.equal(database.diagnostics().authPaused, false);
  assert.equal(database.getCommand(created.commandId).status, "queued");
  database.close();
});

test("retrying endpoint-quarantined work cannot retarget it to the new site", async () => {
  const database = new BookingDatabase(":memory:");
  database.saveSettings({ apiBaseUrl: "https://site-a.example/wp-json/marina-booking/v1", username: "a" });
  const created = database.optimisticCreate({ resourceId: 4, dates: ["2026-07-20"], formData: { name: { value: "Fixture", type: "text" } } });
  database.saveSettings({ apiBaseUrl: "https://site-b.example/wp-json/marina-booking/v1", username: "b" });
  database.quarantineQueuedCommands();
  const queue = new EventEmitter();
  queue.schedule = () => {};
  queue.resumeAfterCredentials = () => {};
  const service = new BookingService({ database, api: {}, queue, vault: { hasPassword: () => true } });
  await assert.rejects(service.retry(created.commandId), (error) => error.code === "endpoint_changed");
  assert.equal(database.getCommand(created.commandId).status, "needs_attention");
  assert.equal(database.getCommand(created.commandId).api_base_url, "https://site-a.example/wp-json/marina-booking/v1");
  database.close();
});

test("resources removed by WordPress stay absent even when a cached booking references them", () => {
  const database = new BookingDatabase(":memory:");
  database.replaceResources([{ id: 4, title: "Active" }, { id: 5, title: "Removed" }]);
  database.replaceResources([{ id: 4, title: "Active" }]);
  database.writeBooking({ serverId: 9, resourceId: 5, dates: ["2026-07-20", "2026-07-21"], formData: { name: { value: "Historical", type: "text" } }, syncState: "synced" });
  const queue = new EventEmitter();
  queue.start = () => {};
  queue.stop = () => {};
  const service = new BookingService({ database, api: {}, queue, vault: { hasPassword: () => true } });
  const resources = service.state({ start: "2026-07-01", end: "2026-07-31" }).resources;
  assert.deepEqual(resources.map((resource) => [resource.id, resource.active]), [[4, true]]);
  database.close();
});

test("desktop mutations wait for WordPress before changing the local booking", async () => {
  const database = new BookingDatabase(":memory:");
  const booking = database.upsertRemoteBooking({ serverId: 91, resourceId: 4, dates: ["2026-07-20"], formData: {}, status: "pending", note: "Old" });
  let confirmRequest;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const confirmed = new Promise((resolve) => { confirmRequest = resolve; });
  const api = {
    note: async () => {
      requestStarted();
      await confirmed;
      return { payload: { updated: true } };
    }
  };
  const queue = new CommandQueue({ database, api, skipAvailabilityChecks: true });
  const service = new BookingService({ database, api, queue, vault: { hasPassword: () => true } });
  queue.start();
  const saving = service.update(booking.localId, { note: "New" }, "note");
  await queue.pump();
  await started;
  assert.equal(database.bookingRow(booking.localId).note, "Old");
  confirmRequest();
  assert.equal((await saving).note, "New");
  queue.stop();
  database.close();
});

test("booking service maps renderer quote fields to the native price API contract", async () => {
  const database = new BookingDatabase(":memory:");
  const queue = new EventEmitter();
  queue.start = () => {};
  queue.stop = () => {};
  queue.schedule = () => {};
  let payload;
  const api = {
    async price(input) { payload = input; return { mode: input.mode, total: 810, deposit: 243, balance: 567 }; }
  };
  const service = new BookingService({ database, api, queue, vault: { hasPassword: () => true } });
  const result = await service.quote({
    resourceId: 14,
    dates: ["2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25"],
    formData: { visitors: { value: "1", type: "selectbox-one" } },
    bookingFormType: "standard",
    mode: "fast",
    forceFresh: false
  });
  assert.deepEqual(payload, {
    resource_id: 14,
    dates: ["2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25"],
    form_data: { visitors: { value: "1", type: "selectbox-one" } },
    booking_form_type: "standard",
    mode: "fast"
  });
  assert.deepEqual(result, { mode: "fast", total: 810, deposit: 243, balance: 567, diagnostics: { clientCache: "MISS" } });
  database.close();
});

test("quote cache keys normalize date and form-field order", () => {
  const first = { resourceId: 14, dates: ["2026-07-23", "2026-07-22"], formData: { visitors: { type: "selectbox-one", value: "2" }, children: { value: "0", type: "selectbox-one" } }, bookingFormType: "standard", mode: "fast" };
  const second = { resourceId: 14, dates: ["2026-07-22", "2026-07-23"], formData: { children: { type: "selectbox-one", value: "0" }, visitors: { value: "2", type: "selectbox-one" } }, bookingFormType: "standard", mode: "fast" };
  assert.equal(quoteCacheKey(first), quoteCacheKey(second));
  assert.notEqual(quoteCacheKey(first), quoteCacheKey({ ...second, mode: "full" }));
});

test("quote cache hits avoid network calls and expired entries refetch", async () => {
  const database = new BookingDatabase(":memory:");
  const queue = new EventEmitter();
  queue.start = () => {};
  queue.stop = () => {};
  queue.schedule = () => {};
  let now = 1_000;
  let calls = 0;
  const api = { async price(input) { calls += 1; return { mode: input.mode, total: calls, deposit: 0, balance: calls }; } };
  const service = new BookingService({ database, api, queue, vault: { hasPassword: () => true }, now: () => now });
  const input = { resourceId: 14, dates: ["2026-07-22", "2026-07-23"], formData: { visitors: { value: "1", type: "selectbox-one" } }, bookingFormType: "standard", mode: "fast", forceFresh: false };
  assert.equal((await service.quote(input)).diagnostics.clientCache, "MISS");
  assert.equal((await service.quote(input)).diagnostics.clientCache, "HIT");
  assert.equal(calls, 1);
  now += 30_001;
  assert.equal((await service.quote(input)).total, 2);
  assert.equal(calls, 2);
  database.close();
});

test("full quote cache expires after fifteen seconds", async () => {
  const database = new BookingDatabase(":memory:");
  const queue = new EventEmitter();
  queue.start = () => {};
  queue.stop = () => {};
  queue.schedule = () => {};
  let now = 5_000;
  let calls = 0;
  const api = { async price() { calls += 1; return { mode: "full", total: 810, deposit: 243, balance: 567 }; } };
  const service = new BookingService({ database, api, queue, vault: { hasPassword: () => true }, now: () => now });
  const input = { resourceId: 14, dates: ["2026-07-22", "2026-07-23"], formData: { visitors: { value: "1", type: "selectbox-one" } }, bookingFormType: "standard", mode: "full", forceFresh: false };
  await service.quote(input);
  now += 15_000;
  await service.quote(input);
  assert.equal(calls, 2);
  database.close();
});

test("fresh full quotes bypass cache and replacement requests abort older work", async () => {
  const database = new BookingDatabase(":memory:");
  const queue = new EventEmitter();
  queue.start = () => {};
  queue.stop = () => {};
  queue.schedule = () => {};
  let calls = 0;
  let firstAborted = false;
  const api = {
    async price(input, { signal }) {
      calls += 1;
      if (calls === 1) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { firstAborted = true; reject(Object.assign(new Error("cancelled"), { cancelled: true })); }, { once: true }));
      return { mode: input.mode, total: 900 + calls, deposit: 270, balance: 632 };
    }
  };
  const service = new BookingService({ database, api, queue, vault: { hasPassword: () => true } });
  const base = { resourceId: 14, dates: ["2026-07-22", "2026-07-23"], formData: { visitors: { value: "1", type: "selectbox-one" } }, bookingFormType: "standard", mode: "full", forceFresh: true };
  const first = service.quote(base);
  const second = service.quote({ ...base, dates: ["2026-07-23", "2026-07-24"] });
  await assert.rejects(first);
  assert.equal((await second).mode, "full");
  assert.equal(firstAborted, true);
  assert.equal(calls, 2);
  await service.quote(base);
  assert.equal(calls, 3);
  database.close();
});
