"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MarinaRoomsMigrationService, SOURCE_FROM, SOURCE_TO, bookingBody, stableKey } = require("../src/main/marina-migration-service");

function fixture() {
  return {
    resources: [{ id: 6, title: "Camera 1", capacity: 3, parent_id: 2 }],
    bookings: [{
      serverId: 91,
      resourceId: 6,
      dates: ["2026-08-11", "2026-08-12"],
      status: "approved",
      trashed: false,
      note: "Sosire târzie",
      formData: {
        name: { value: "Ana" }, secondname: { value: "Pop" }, email: { value: "ana@example.test" },
        phone: { value: "0700000000" }, visitors: { value: "2" }, children: { value: "1" },
        cost_hint: { value: "500 RON" }, deposit_hint: { value: "100 RON" }
      }
    }]
  };
}

function harness({ failStateOnce = false, initialJournal = {} } = {}) {
  const data = fixture();
  const sourceCalls = [];
  const targetCalls = [];
  let stored = structuredClone(initialJournal);
  let stateFailures = failStateOnce ? 1 : 0;
  const sourceApi = {
    async resources() { sourceCalls.push(["resources"]); return data.resources; },
    async bookings(from, to) { sourceCalls.push(["bookings", from, to]); return data.bookings; },
    async create() { throw new Error("source write called"); },
    async edit() { throw new Error("source write called"); }
  };
  const targetApi = {
    async createResource(body, key) { targetCalls.push(["createResource", body, key]); return { payload: { data: { id: 101 + targetCalls.filter((call) => call[0] === "createResource").length } } }; },
    async deleteResource(id, key) { targetCalls.push(["deleteResource", id, key]); return { payload: {} }; },
    async createBooking(body, key) { targetCalls.push(["createBooking", body, key]); return { payload: { data: { id: "target-booking" } } }; },
    async changeBookingStatus(id, body, key, version) {
      targetCalls.push(["changeBookingStatus", id, body, key, version]);
      if (stateFailures-- > 0) throw new Error("temporary status failure");
      return { payload: {} };
    },
    async cancelBooking(id, body, key, version) { targetCalls.push(["cancelBooking", id, body, key, version]); return { payload: {} }; },
    async addNote(id, body, key) { targetCalls.push(["addNote", id, body, key]); return { payload: {} }; }
  };
  const service = new MarinaRoomsMigrationService({
    sourceApi,
    targetApi,
    journalStore: { load: () => structuredClone(stored), save: (value) => { stored = structuredClone(value); } },
    now: () => "2026-08-11T20:00:00.000Z"
  });
  return { service, sourceCalls, targetCalls, stored: () => stored, data };
}

test("migration journals capacity conflicts and continues importing later bookings", async () => {
  const { service, data, targetCalls, stored } = harness();
  data.bookings.push({ ...structuredClone(data.bookings[0]), serverId: 92 });
  const originalCreate = service.targetApi.createBooking;
  service.targetApi.createBooking = async (body, key) => {
    if (body.external.booking_id === "91") throw Object.assign(new Error("capacity_exceeded"), { status: 409, conflict: true, code: "availability_conflict" });
    return originalCreate(body, key);
  };
  const result = await service.run();
  assert.equal(result.importedBookings, 1);
  assert.equal(result.unresolvedConflicts, 1);
  assert.equal(stored().bookings["91"].conflict, "availability_conflict");
  assert.equal(stored().bookings["92"].complete, true);
  assert.equal(targetCalls.filter((call) => call[0] === "createBooking").length, 1);
});

test("historical conflicts are preserved as completed with their original status metadata", async () => {
  const { service, data, stored } = harness();
  data.bookings[0].dates = ["2023-08-11", "2023-08-12"];
  let calls = 0;
  service.targetApi.createBooking = async (body) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error("capacity_exceeded"), { status: 409, conflict: true, code: "availability_conflict" });
    assert.equal(body.status, "completed");
    assert.equal(body.custom_fields.migration.original_status, "approved");
    return { payload: { data: { id: "historical-target" } } };
  };
  await service.run();
  assert.equal(stored().bookings["91"].complete, false);
  await service.run();
  assert.equal(stored().bookings["91"].targetId, "historical-target");
  assert.equal(stored().bookings["91"].historicalConflictCompleted, true);
  assert.equal(stored().bookings["91"].availabilityConflictImported, true);
});

test("future conflicts are preserved with a nonblocking target status", async () => {
  const { service, stored } = harness();
  let calls = 0;
  service.targetApi.createBooking = async (body) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error("capacity_exceeded"), { status: 409, conflict: true, code: "availability_conflict" });
    assert.equal(body.status, "completed");
    assert.equal(body.custom_fields.migration.original_status, "approved");
    return { payload: { data: { id: "future-conflict-target" } } };
  };
  await service.run();
  await service.run();
  assert.equal(stored().bookings["91"].targetId, "future-conflict-target");
  assert.equal(stored().bookings["91"].availabilityConflictImported, true);
});

test("migration reads only source resources and bookings and writes all data to Marina", async () => {
  const { service, sourceCalls, targetCalls } = harness();
  const preview = await service.preview();
  assert.deepEqual(preview, {
    resources: 1, bookings: 1, fetchedBookingRows: 1, excludedBookings: 0, deferredCancelledBookings: 0, pendingResources: 1, pendingBookings: 1,
    approved: 1, pending: 0, cancelled: 0, from: "2026-08-11", to: "2026-08-12"
  });
  const result = await service.run();
  assert.equal(result.importedResources, 1);
  assert.equal(result.importedBookings, 1);
  assert.deepEqual(sourceCalls, [
    ["resources"], ["bookings", SOURCE_FROM, SOURCE_TO],
    ["resources"], ["bookings", SOURCE_FROM, SOURCE_TO]
  ]);
  assert.equal(targetCalls[0][0], "createResource");
  assert.deepEqual(targetCalls[0][1], {
    name: "Camera 1", external_key: "wpbooking-rooms-6", timezone: "Europe/Bucharest",
    booking_mode: "date_range", capacity: 1, active: true, settings: {}
  });
  assert.equal(targetCalls[1][0], "createBooking");
  assert.deepEqual(targetCalls[1][1], {
    resource_id: 102, periods: [{ start_date: "2026-08-11", end_date: "2026-08-12", units: 1 }],
    customer: { first_name: "Ana", last_name: "Pop", email: "ana@example.test", phone: "0700000000", address: {}, custom_fields: {} },
    guests: { adults: 2, children: 1, details: {} },
    status: "approved", custom_fields: {},
    internal_note: "Importat din WPBooking Camere. ID sursă: 91.\nSosire târzie\nCost sursă: 500 RON\nAvans sursă: 100 RON",
    external: { client_id: "wpbooking-rooms", booking_id: "91" }
  });
  assert.deepEqual(targetCalls.map((call) => call[0]), ["createResource", "createBooking"]);
});

test("migration reruns without recreating completed target records", async () => {
  const { service, targetCalls, stored } = harness();
  await service.run();
  await service.run();
  assert.equal(targetCalls.filter((call) => call[0] === "createResource").length, 1);
  assert.equal(targetCalls.filter((call) => call[0] === "createBooking").length, 1);
  assert.equal(stored().bookings["91"].stateApplied, true);
  assert.equal(stored().bookings["91"].noteApplied, true);
  assert.equal(stored().bookings["91"].complete, true);
});

test("stable migration keys are deterministic UUIDs and differ by operation", () => {
  assert.equal(stableKey("booking-create", 91), stableKey("booking-create", 91));
  assert.notEqual(stableKey("booking-create", 91), stableKey("booking-note", 91));
  assert.match(stableKey("booking-create", 91), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("conflict retries use timed Bucharest periods for same-day room turnover", () => {
  const body = bookingBody(fixture().bookings[0], 9, { timed: true });
  assert.deepEqual(body.periods, [{
    start_at: "2026-08-11T15:00:01+03:00",
    end_at: "2026-08-12T12:00:02+03:00",
    units: 1
  }]);
});

test("one-day conflict retries check out the following day", () => {
  const booking = { ...fixture().bookings[0], dates: ["2026-08-11"] };
  assert.deepEqual(bookingBody(booking, 9, { timed: true }).periods, [{
    start_at: "2026-08-11T15:00:01+03:00",
    end_at: "2026-08-12T12:00:02+03:00",
    units: 1
  }]);
});

test("migration deduplicates paginated source rows by WordPress booking ID", async () => {
  const { service, data, targetCalls } = harness();
  data.bookings.push(structuredClone(data.bookings[0]));
  const preview = await service.preview();
  assert.equal(preview.fetchedBookingRows, 2);
  assert.equal(preview.bookings, 1);
  await service.run();
  assert.equal(targetCalls.filter((call) => call[0] === "createBooking").length, 1);
});

test("migration excludes void resource 32 bookings and leaves its unsupported target resource unused", async () => {
  const { service, data, targetCalls, stored } = harness({
    initialJournal: { version: 1, resources: { 32: { targetId: "target-32", title: "32" } }, bookings: {} }
  });
  data.bookings.push({
    serverId: 92,
    resourceId: 32,
    dates: ["2026-07-01"],
    status: "pending",
    trashed: true,
    note: "",
    formData: { resource: { value: "Camera istorică" }, name: { value: "Ion" } }
  });
  const preview = await service.preview();
  assert.equal(preview.resources, 1);
  assert.equal(preview.bookings, 1);
  assert.equal(preview.excludedBookings, 1);
  assert.equal(preview.deferredCancelledBookings, 0);
  await service.run();
  assert.equal(targetCalls.filter((call) => call[0] === "createResource").length, 1);
  assert.equal(targetCalls.filter((call) => call[0] === "deleteResource").length, 0);
  assert.equal(stored().resources[32].targetId, "target-32");
});

test("migration creates cancelled bookings with their final non-blocking status", async () => {
  const { service, data, targetCalls } = harness();
  data.bookings.push({
    serverId: 93,
    resourceId: 6,
    dates: ["2026-08-11", "2026-08-12"],
    status: "pending",
    trashed: true,
    formData: {}
  });
  const preview = await service.preview();
  assert.equal(preview.bookings, 2);
  assert.equal(preview.cancelled, 1);
  assert.equal(preview.deferredCancelledBookings, 0);
  await service.run();
  assert.equal(targetCalls.filter((call) => call[0] === "createBooking").length, 2);
  assert.equal(targetCalls.filter((call) => call[0] === "createBooking").find((call) => call[1].external.booking_id === "93")[1].status, "trash");
  assert.equal(targetCalls.filter((call) => call[0] === "changeBookingStatus").find((call) => call[1] === "target-booking")[2].status, "trash");
  assert.equal(targetCalls.filter((call) => call[0] === "cancelBooking").length, 0);
});
