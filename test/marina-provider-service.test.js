"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const MarinaConfig = require("../src/shared/marina-config");
const { MarinaBookingProvider, bookingBody, normalizeBooking } = require("../src/main/marina-provider-service");

class OAuthStub extends EventEmitter {
  constructor(connected) { super(); this.connected = connected; }
  status() { return { connected: this.connected, connecting: false, effectiveScopes: ["resources:read", "bookings:read", "bookings:write"] }; }
}

test("provider performs no protected probe before OAuth and accepts an empty resource data array", async () => {
  const oauth = new OAuthStub(false);
  let resourceCalls = 0;
  let bookingQuery = null;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      resources: async () => { resourceCalls += 1; return { payload: { data: [] } }; },
      bookings: async (query) => { bookingQuery = query; return { payload: { data: [] } }; }
    }
  });
  const range = { start: "2026-08-01", end: "2026-08-31" };
  assert.equal((await provider.refresh(range)).settings.connected, false);
  assert.equal(resourceCalls, 0);
  oauth.connected = true;
  const state = await provider.refresh(range);
  assert.equal(resourceCalls, 1);
  assert.deepEqual(state.resources, []);
  assert.equal(state.diagnostics.online, true);
  assert.deepEqual(bookingQuery, {
    from: "2026-08-01T00:00:00+03:00",
    to: "2026-08-31T23:59:59+03:00",
    after: null,
    limit: 200
  });
});

test("provider silently refreshes a saved OAuth session when the app starts", async () => {
  const oauth = new OAuthStub(true);
  let refreshCalls = 0;
  oauth.refresh = async () => { refreshCalls += 1; };
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {}
  });
  provider.start();
  await new Promise((resolve) => setImmediate(resolve));
  provider.stop();
  assert.equal(refreshCalls, 1);
});

test("provider writes and reads inclusive date-only booking periods", () => {
  const resources = [{ id: 7, providerId: "31" }];
  assert.deepEqual(bookingBody({ resourceId: 7, dates: ["2026-09-01", "2026-09-02", "2026-09-03"], formData: {} }, resources).periods, [
    { start_date: "2026-09-01", end_date: "2026-09-03", units: 1 }
  ]);
  const normalized = normalizeBooking({
    id: "booking-1",
    resource_id: 31,
    status: "trash",
    periods: [{ start_date: "2026-09-01", end_date: "2026-09-03" }]
  }, resources);
  assert.deepEqual(normalized.dates, ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.equal(normalized.trashed, true);
});

test("provider reads response-side booking period and resource fields", () => {
  const resources = [{ id: 7, providerId: "31" }];
  const normalized = normalizeBooking({
    id: "booking-2",
    status: "approved",
    booking_periods: [{ resource_id: 31, starts_at: "2026-10-24T15:00:00+03:00", ends_at: "2026-10-26T12:00:00+02:00" }]
  }, resources);
  assert.equal(normalized.resourceId, 7);
  assert.equal(normalized.providerResourceId, "31");
  assert.deepEqual(normalized.dates, ["2026-10-24", "2026-10-25", "2026-10-26"]);
});

test("provider interprets UTC period timestamps in the Bucharest resource timezone", () => {
  const resources = [{ id: 7, providerId: "31" }];
  const normalized = normalizeBooking({
    id: "booking-utc",
    resource_id: 31,
    status: "approved",
    booking_periods: [{ starts_at: "2026-07-16T21:00:00Z", ends_at: "2026-07-21T09:00:00Z" }]
  }, resources);
  assert.deepEqual(normalized.dates, ["2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"]);
});

test("provider treats a midnight timed end as an exclusive response boundary", () => {
  const resources = [{ id: 7, providerId: "31" }];
  const normalized = normalizeBooking({
    id: "booking-midnight-end",
    resource_id: 31,
    status: "approved",
    booking_periods: [{ starts_at: "2026-05-29T21:00:00Z", ends_at: "2026-05-31T21:00:00Z" }]
  }, resources);
  assert.deepEqual(normalized.dates, ["2026-05-30", "2026-05-31"]);
});

test("provider loads full booking details and notes only when requested", async () => {
  const oauth = new OAuthStub(true);
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      booking: async () => ({ payload: { data: { id: "booking-3", resource_id: 31, status: "completed", periods: [{ start_date: "2026-08-01", end_date: "2026-08-02" }], internal_note: "Notă importată" } } }),
      listNotes: async () => ({ payload: { data: [{ id: 1, body: "Notă Marina" }] } })
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{ localId: "marina:booking-3", providerId: "booking-3", providerResourceId: "31", resourceId: 7, dates: ["2026-08-01"], note: "", status: "approved" }];
  const detailed = await provider.details("marina:booking-3");
  assert.equal(detailed.status, "approved");
  assert.equal(detailed.note, "Notă importată\n\nNotă Marina");
  assert.deepEqual(detailed.dates, ["2026-08-01", "2026-08-02"]);
});
