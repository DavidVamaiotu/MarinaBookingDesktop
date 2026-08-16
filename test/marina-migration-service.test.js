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
    async updateBooking(id, body, key, version) { targetCalls.push(["updateBooking", id, body, key, version]); return { payload: {} }; },
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
  let creates = 0;
  service.targetApi.createBooking = async (body, key) => {
    creates += 1;
    if (creates === 1) throw Object.assign(new Error("capacity_exceeded"), { status: 409, conflict: true, code: "availability_conflict" });
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

test("quote-backed conflict retries use matching date periods and fresh idempotency keys", async () => {
  const { service, stored } = harness();
  const calls = [];
  let quoteNumber = 0;
  service.targetApi.quote = async (body) => {
    quoteNumber += 1;
    calls.push(["quote", structuredClone(body), `quote-${quoteNumber}`]);
    return { payload: { data: { quote_id: `quote-${quoteNumber}` } } };
  };
  service.targetApi.createBooking = async (body, key) => {
    calls.push(["createBooking", structuredClone(body), key]);
    if (calls.filter((call) => call[0] === "createBooking").length <= 2) {
      throw Object.assign(new Error("capacity_exceeded"), { status: 409, conflict: true, code: "availability_conflict" });
    }
    return { payload: { data: { id: "quoted-conflict-target" } } };
  };

  await service.run();
  await service.run();

  const creates = calls.filter((call) => call[0] === "createBooking");
  assert.equal(creates.length, 3);
  assert.deepEqual(creates.map((call) => call[1].periods), [
    [{ start_date: "2026-08-11", end_date: "2026-08-11", units: 1 }],
    [{ start_date: "2026-08-11", end_date: "2026-08-11", units: 1 }],
    [{ start_date: "2026-08-11", end_date: "2026-08-11", units: 1 }]
  ]);
  assert.deepEqual(creates.map((call) => call[1].quote_id), ["quote-1", "quote-2", "quote-3"]);
  assert.equal(new Set(creates.map((call) => call[2])).size, 3);
  assert.equal(creates[2][1].status, "completed");
  assert.equal(stored().bookings["91"].targetId, "quoted-conflict-target");
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
    resource_id: 102, periods: [{ start_date: "2026-08-11", end_date: "2026-08-11", units: 1 }],
    customer: { first_name: "Ana", last_name: "Pop", email: "ana@example.test", phone: "0700000000", address: {}, custom_fields: { cost_hint: "500 RON", deposit_hint: "100 RON" } },
    guests: { adults: 2, children: 1 }
  });
  assert.deepEqual(targetCalls.map((call) => call[0]), ["createResource", "createBooking", "updateBooking", "changeBookingStatus"]);
});

test("migration preserves non-standard WordPress client fields in Marina customer custom fields", () => {
  const booking = fixture().bookings[0];
  booking.formData.address6 = { value: "Str. Exemplu 1", type: "text" };
  booking.formData.cerere_client6 = { value: "Cameră liniștită", type: "textarea" };
  const body = require("../src/main/marina-migration-service").bookingBody(booking, 102);
  assert.deepEqual(body.customer.custom_fields, {
    cost_hint: "500 RON",
    deposit_hint: "100 RON",
    address6: "Str. Exemplu 1",
    cerere_client6: "Cameră liniștită"
  });
});

test("migration backfills client fields for bookings already recorded in the journal", async () => {
  const { service, targetCalls, stored } = harness({
    initialJournal: {
      version: 1,
      resources: { 6: { targetId: "102" } },
      bookings: { 91: { targetId: "existing-booking", complete: true, stayPeriodVersion: 1 } }
    }
  });
  const result = await service.run();
  const update = targetCalls.find((call) => call[0] === "updateBooking");
  assert.equal(result.importedBookings, 1);
  assert.equal(targetCalls.filter((call) => call[0] === "createBooking").length, 0);
  assert.equal(update[1], "existing-booking");
  assert.deepEqual(update[2], {
    customer: {
      first_name: "Ana", last_name: "Pop", email: "ana@example.test", phone: "0700000000",
      address: {}, custom_fields: { cost_hint: "500 RON", deposit_hint: "100 RON" }
    }
  });
  assert.equal(stored().bookings["91"].customerDetailsVersion, 1);
});

test("migration corrects checkout-inclusive periods already stored in Marina", async () => {
  const { service, targetCalls, stored } = harness({
    initialJournal: {
      version: 1,
      resources: { 6: { targetId: "102" } },
      bookings: { 91: { targetId: "existing-booking", complete: true, customerDetailsVersion: 1 } }
    }
  });
  service.targetApi.quote = async (body) => {
    targetCalls.push(["quote", body]);
    return { payload: { data: { quote_id: "period-quote" } } };
  };
  service.targetApi.booking = async (id) => {
    targetCalls.push(["booking", id]);
    return { payload: { data: { id, version: 7, custom_fields: { migration: { original_status: "approved" }, retained: "yes" } } } };
  };

  await service.run();

  const update = targetCalls.find((call) => call[0] === "updateBooking");
  assert.equal(update[1], "existing-booking");
  assert.deepEqual(update[2], {
    periods: [{ start_date: "2026-08-11", end_date: "2026-08-11", units: 1 }],
    custom_fields: {
      retained: "yes",
      migration: {
        original_status: "approved",
        source: "wpbooking-rooms",
        source_booking_id: "91",
        stay_period_version: 1
      }
    },
    quote_id: "period-quote"
  });
  assert.equal(update[4], 7);
  assert.equal(stored().bookings["91"].stayPeriodVersion, 1);
  assert.equal(targetCalls.filter((call) => call[0] === "createBooking").length, 0);
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
  assert.equal(targetCalls.filter((call) => call[0] === "changeBookingStatus").some((call) => call[2].status === "trash"), true);
  assert.equal(targetCalls.filter((call) => call[0] === "changeBookingStatus").find((call) => call[1] === "target-booking")[2].status, "trash");
  assert.equal(targetCalls.filter((call) => call[0] === "cancelBooking").length, 0);
});

test("pricing validation happens before Marina writes and publishes the public-page mapping", async () => {
  const data = fixture();
  const targetCalls = [];
  let pricingDocument = null;
  let pricingReads = 0;
  const sourceApi = {
    async resources() { return data.resources; },
    async bookings() { return data.bookings; }
  };
  const targetApi = {
    async createResource(body, key) { targetCalls.push(["createResource", body, key]); return { payload: { data: { id: 106 } } }; },
    async pricing() {
      pricingReads += 1;
      if (!pricingDocument) throw Object.assign(new Error("not configured"), { status: 422, code: "pricing_not_configured" });
      return { payload: { data: { ...pricingDocument, version: 1 } } };
    },
    async putPricing(id, body, key) { targetCalls.push(["putPricing", id, body, key]); pricingDocument = body; return { payload: { data: { version: 1 } } }; },
    async createBooking(body, key) { targetCalls.push(["createBooking", body, key]); return { payload: { data: { id: "marina-booking-91" } } }; },
    async updateBooking(id, body, key, version) { targetCalls.push(["updateBooking", id, body, key, version]); return { payload: {} }; },
    async changeBookingStatus(id, body, key, version) { targetCalls.push(["changeBookingStatus", id, body, key, version]); return { payload: {} }; }
  };
  const pricingSource = {
    async forResources(resources) {
      assert.equal(resources.length, 1);
      return {
        catalog: { source: "marina-public-prices", source_url: "https://www.marinapark.ro/preturi-cazare-camping/", coverage: { from: "2026-06-01", to: "2026-06-02" }, warnings: [] },
        mapped: [{ source: "marina-public-prices", source_url: "https://www.marinapark.ro/preturi-cazare-camping/", source_fingerprint: "fingerprint", source_resource_id: "6", resource_name: "Camera 1", category: "double", currency: "RON", timezone: "Europe/Bucharest", days: [{ date: "2026-06-01", price_minor: 15000 }, { date: "2026-06-02", price_minor: 18000 }] }]
      };
    }
  };
  const stored = {};
  const service = new MarinaRoomsMigrationService({ sourceApi, targetApi, pricingSource, journalStore: { load: () => structuredClone(stored), save: (value) => Object.assign(stored, structuredClone(value)) }, now: () => "2026-08-11T20:00:00.000Z" });
  const result = await service.run();
  assert.equal(result.importedPricing, 1);
  assert.equal(pricingReads, 2);
  assert.deepEqual(targetCalls.map((call) => call[0]), ["createResource", "putPricing", "createBooking", "updateBooking", "changeBookingStatus"]);
  assert.equal(stored.pricing["6"].verified, true);
  assert.equal(stored.pricing["6"].version, 1);

  const invalidCalls = [];
  const invalidService = new MarinaRoomsMigrationService({
    sourceApi,
    targetApi: { async createResource() { invalidCalls.push("createResource"); } },
    pricingSource: { async forResources() { throw Object.assign(new Error("missing price"), { code: "marina_pricing_missing_date", permanent: true }); } },
    journalStore: { load: () => ({}), save: () => {} }
  });
  await assert.rejects(() => invalidService.run(), (error) => error.code === "marina_pricing_missing_date");
  assert.deepEqual(invalidCalls, []);
});
