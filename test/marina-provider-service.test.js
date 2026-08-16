"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const MarinaConfig = require("../src/shared/marina-config");
const { MANUAL_DEPOSIT_FIELD, marinaCustomFieldsWithDeposit, normalizeMarinaPayment } = require("../src/shared/marina-payment");
const { MarinaBookingProvider, bookingBody, bookingPatchBody, normalizeBooking, quoteBody } = require("../src/main/marina-provider-service");

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

test("provider converts Parkline checkout dates to inclusive Marina nights and back", () => {
  const resources = [{ id: 7, providerId: "31" }];
  assert.deepEqual(bookingBody({ resourceId: 7, dates: ["2026-09-01", "2026-09-02", "2026-09-03"], formData: {} }, resources).periods, [
    { start_date: "2026-09-01", end_date: "2026-09-02", units: 1 }
  ]);
  const normalized = normalizeBooking({
    id: "booking-1",
    resource_id: 31,
    status: "trash",
    periods: [{ start_date: "2026-09-01", end_date: "2026-09-03" }]
  }, resources);
  assert.deepEqual(normalized.dates, ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  assert.equal(normalized.trashed, true);
});

test("provider restores checkout day when list responses omit migration metadata", () => {
  const normalized = normalizeBooking({
    id: "booking-august",
    resource_id: 4,
    external: { client_id: "wpbooking-rooms", booking_id: "6723" },
    periods: [{ start_date: "2026-08-19", end_date: "2026-08-24" }]
  }, [{ id: 9, providerId: "4" }]);
  assert.equal(normalized.resourceId, 9);
  assert.deepEqual(normalized.dates, [
    "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
    "2026-08-23", "2026-08-24", "2026-08-25"
  ]);
});

test("provider restores checkout day from flattened Marina list dates", () => {
  const normalized = normalizeBooking({
    id: "booking-flat-august",
    resource_id: 4,
    start_date: "2026-08-19",
    end_date: "2026-08-24"
  }, [{ id: 9, providerId: "4" }]);
  assert.equal(normalized.resourceId, 9);
  assert.equal(normalized.dates[0], "2026-08-19");
  assert.equal(normalized.dates.at(-1), "2026-08-25");
});

test("provider restores checkout day from flattened date-range timestamps", () => {
  const normalized = normalizeBooking({
    id: "booking-flat-timestamps",
    resource_id: 4,
    starts_at: "2026-08-19T00:00:00+03:00",
    ends_at: "2026-08-24T23:59:59+03:00"
  }, [{ id: 9, providerId: "4", bookingMode: "date_range" }]);
  assert.equal(normalized.dates[0], "2026-08-19");
  assert.equal(normalized.dates.at(-1), "2026-08-25");
});

test("provider preserves checkout day from nested full-day timestamps", () => {
  const normalized = normalizeBooking({
    id: "booking-nested-timestamps",
    resource_id: 4,
    periods: [{
      starts_at: "2026-08-19T00:00:00+03:00",
      ends_at: "2026-08-24T00:00:00+03:00"
    }]
  }, [{ id: 9, providerId: "4", bookingMode: "full_day" }]);
  assert.equal(normalized.dates[0], "2026-08-19");
  assert.equal(normalized.dates.at(-1), "2026-08-24");
});

test("provider requests Marina quotes with inclusive periods and normalizes integer money", async () => {
  const oauth = new OAuthStub(true);
  let requestBody;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      quote: async (body) => { requestBody = body; return { payload: { data: { quote_id: "quote-7", pricing_version: 3, nights: 2, total_minor: 30000, deposit_percent: 30, deposit_minor: 9000, balance_minor: 21000, expires_at: "2099-01-01T00:00:00Z", nights_breakdown: [{ date: "2026-09-01", total_minor: 15000 }] } } }; }
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  const quote = await provider.quote({ resourceId: 7, dates: ["2026-09-01", "2026-09-02"], formData: { visitors: { value: "2" }, children: { value: "1" } }, mode: "full" });
  assert.deepEqual(requestBody, { resource_id: 31, periods: [{ start_date: "2026-09-01", end_date: "2026-09-01", units: 1 }], guests: { adults: 2, children: 1 } });
  assert.equal(quote.quoteId, "quote-7");
  assert.equal(quote.totalMinor, 30000);
  assert.equal(quote.total, 300);
  assert.equal(quote.deposit, 90);
  assert.equal(quote.balance, 210);
});

test("provider checks Marina availability with room handoff times", async () => {
  const oauth = new OAuthStub(true);
  let requestBody;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: { availabilityCheck: async (body) => { requestBody = body; return { payload: { available: true, resource_id: 31 } }; } }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  const result = await provider.availability(7, ["2026-09-03", "2026-09-01", "2026-09-02"]);
  assert.equal(result.available, true);
  assert.deepEqual(requestBody, { resource_id: 31, periods: [{ start_at: "2026-09-01T15:00:01+03:00", end_at: "2026-09-03T12:00:02+03:00" }], units: 1 });
});

test("provider never sends the unsupported Marina availability exclusion field", async () => {
  const oauth = new OAuthStub(true);
  let requestBody;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: { availabilityCheck: async (body) => { requestBody = body; return { payload: { available: true } }; } }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{ localId: "marina:71", providerId: "71", resourceId: 7 }];

  await provider.availability(7, ["2026-08-27", "2026-08-28"], { excludeBookingId: "marina:71" });

  assert.equal(requestBody.exclude_booking_id, undefined);
});

test("provider binds a quote to Marina booking creation", () => {
  const body = bookingBody({ resourceId: 7, dates: ["2026-09-01", "2026-09-02"], quoteId: "quote-7", formData: { visitors: { value: "2" }, children: { value: "0" } } }, [{ id: 7, providerId: "31" }]);
  assert.equal(body.quote_id, "quote-7");
  assert.deepEqual(quoteBody({ resourceId: 7, dates: ["2026-09-01", "2026-09-02"], formData: { visitors: { value: "2" }, children: { value: "0" } } }, [{ id: 7, providerId: "31" }]).guests, { adults: 2, children: 0 });
});

test("provider sends only customer and note fields for a non-pricing edit", () => {
  const current = {
    resourceId: 7,
    dates: ["2026-09-01", "2026-09-02"],
    note: "Veche",
    formData: {
      name: { value: "Ana" }, secondname: { value: "Marin" }, email: { value: "ana@example.com" },
      phone: { value: "0700000000" }, visitors: { value: "2" }, children: { value: "0" }
    }
  };
  const formData = { ...current.formData, phone: { value: "0711111111" } };
  const body = bookingPatchBody(current, { formData, note: "Nouă" }, [{ id: 7, providerId: "31" }]);
  assert.equal(body.customer.phone, "0711111111");
  assert.equal(body.internal_note, "Nouă");
  assert.equal(body.resource_id, undefined);
  assert.equal(body.periods, undefined);
  assert.equal(body.guests, undefined);
  assert.equal(body.quote_id, undefined);
});

test("provider sends numeric resource, inclusive periods, guests, and quote for pricing edits", () => {
  const current = { resourceId: 7, dates: ["2026-09-01", "2026-09-02"], note: "", formData: { visitors: { value: "2" }, children: { value: "0" } } };
  const body = bookingPatchBody(current, {
    resourceId: 8,
    dates: ["2026-09-03", "2026-09-04", "2026-09-05"],
    formData: { visitors: { value: "3" }, children: { value: "1" } },
    quoteId: "quote-new"
  }, [{ id: 7, providerId: "31" }, { id: 8, providerId: "32" }]);
  assert.equal(body.resource_id, 32);
  assert.deepEqual(body.periods, [{ start_date: "2026-09-03", end_date: "2026-09-04", units: 1 }]);
  assert.deepEqual(body.guests, { adults: 3, children: 1 });
  assert.equal(body.quote_id, "quote-new");
});

test("provider creates a Marina booking once with its internal note in the booking payload", async () => {
  const oauth = new OAuthStub(true);
  let createBody;
  let finalQuoteBody;
  let noteCalls = 0;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      quote: async (body) => { finalQuoteBody = body; return { payload: { data: { quote_id: "quote-final", nights: 1, total_minor: 18000, deposit_minor: 5400, balance_minor: 12600, expires_at: "2099-01-01T00:00:00Z" } } }; },
      createBooking: async (body) => {
        createBody = body;
        return { payload: { data: { id: 77, resource_id: 31, status: "pending", periods: body.periods, customer: body.customer, guests: body.guests, internal_note: "", version: 1 } } };
      },
      addNote: async () => { noteCalls += 1; }
    }
  });
  provider.resources = [{ id: 7, providerId: "31", bookingMode: "date_range" }];
  provider.refreshAfterMutation = async () => {};
  const created = await provider.create({
    resourceId: 7,
    dates: ["2026-09-01", "2026-09-02"],
    quoteId: "quote-77",
    note: "Sosire târzie",
    formData: { name: { value: "Ana" }, visitors: { value: "2" }, children: { value: "0" } }
  });
  assert.equal(createBody.resource_id, 31);
  assert.equal(createBody.internal_note, "Sosire târzie");
  assert.equal(createBody.quote_id, "quote-final");
  assert.deepEqual(createBody.guests, finalQuoteBody.guests);
  assert.equal(noteCalls, 0);
  assert.equal(created.localId, "marina:77");
  assert.equal(created.note, "Sosire târzie");
});

test("provider exposes a created Marina booking before the background range refresh finishes", async () => {
  const oauth = new OAuthStub(true);
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      quote: async () => ({ payload: { data: { quote_id: "quote-final", nights: 1, total_minor: 18000, deposit_minor: 5400, balance_minor: 12600, expires_at: "2099-01-01T00:00:00Z" } } }),
      createBooking: async (body) => ({ payload: { data: { id: 78, version: 3, ...body } } })
    }
  });
  provider.resources = [{ id: 7, providerId: "31", bookingMode: "date_range" }];
  provider.visibleRange = { start: "2026-09-01", end: "2026-09-30" };
  provider.refreshAfterMutation = () => new Promise(() => {});
  let emittedBooking;
  provider.on("state", (state) => { emittedBooking = state.bookings.find((booking) => booking.localId === "marina:78"); });

  const created = await Promise.race([
    provider.create({ resourceId: 7, dates: ["2026-09-01", "2026-09-02"], quoteId: "quote-ui", formData: { visitors: { value: "2" } } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("create waited for background refresh")), 100))
  ]);

  assert.equal(created.version, 3);
  assert.equal(provider.findBooking("marina:78").version, 3);
  assert.equal(emittedBooking?.localId, "marina:78");
});

test("provider keeps a created note when Marina list responses omit note fields", async () => {
  const oauth = new OAuthStub(true);
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      resources: async () => ({ payload: { data: [{ id: 31, title: "Camera 31", booking_mode: "date_range" }] } }),
      bookings: async () => ({ payload: { data: [{ id: 79, resource_id: 31, status: "pending", periods: [{ start_date: "2026-09-01", end_date: "2026-09-01" }], internal_note: "", version: 2 }] } })
    }
  });
  provider.resources = [{ id: 7, providerId: "31", bookingMode: "date_range" }];
  provider.bookings = [{
    localId: "marina:79", providerId: "79", providerResourceId: "31", resourceId: 7,
    dates: ["2026-09-01", "2026-09-02"], note: "Cost total: 180 RON, Depozit: 54 RON, Rest: 126 RON", version: 1,
    formData: {}
  }];

  await provider.refresh({ start: "2026-09-01", end: "2026-09-30" });

  assert.equal(provider.findBooking("marina:79").note, "Cost total: 180 RON, Depozit: 54 RON, Rest: 126 RON");
});

test("provider edits contact details without resending pricing fields", async () => {
  const oauth = new OAuthStub(true);
  let updateCall;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: { updateBooking: async (...args) => { updateCall = args; return { payload: { data: { id: 77 } } }; } }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{
    localId: "marina:77", providerId: "77", providerResourceId: "31", resourceId: 7,
    dates: ["2026-09-01", "2026-09-02"], note: "", version: 4,
    formData: { name: { value: "Ana" }, phone: { value: "0700000000" }, visitors: { value: "2" }, children: { value: "0" } }
  }];
  provider.refreshAfterMutation = async () => {};
  await provider.update("marina:77", { formData: { ...provider.bookings[0].formData, phone: { value: "0711111111" } } });
  assert.equal(updateCall[0], "77");
  assert.equal(updateCall[1].customer.phone, "0711111111");
  assert.equal(updateCall[1].resource_id, undefined);
  assert.equal(updateCall[1].periods, undefined);
  assert.equal(updateCall[3], 4);
});

test("provider exposes Marina edits before the background range refresh finishes", async () => {
  const oauth = new OAuthStub(true);
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      updateBooking: async (_id, body) => ({ payload: { data: { id: 77, version: 5, ...body } } })
    }
  });
  provider.resources = [{ id: 7, providerId: "31", bookingMode: "date_range" }];
  provider.bookings = [{
    localId: "marina:77", providerId: "77", providerResourceId: "31", resourceId: 7,
    dates: ["2026-09-01", "2026-09-02"], note: "", status: "approved", providerStatus: "approved", version: 4,
    formData: { name: { value: "Ana" }, phone: { value: "0700000000" }, visitors: { value: "2" }, children: { value: "0" } }
  }];
  provider.refreshAfterMutation = () => new Promise(() => {});
  const formData = { ...provider.bookings[0].formData, phone: { value: "0711111111" } };

  const updated = await Promise.race([
    provider.update("marina:77", { formData }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("edit waited for background refresh")), 100))
  ]);

  assert.equal(updated.formData.phone.value, "0711111111");
  assert.equal(updated.version, 5);
  assert.equal(provider.findBooking("marina:77").version, 5);
});

test("provider restores Marina customer custom fields into calendar form data", () => {
  const normalized = normalizeBooking({
    id: "booking-custom-fields",
    resource_id: 31,
    customer: {
      first_name: "Ana",
      custom_fields: { address6: "Str. Exemplu 1", cerere_client6: "Cameră liniștită" }
    },
    guests: { adults: 2, children: 1 },
    periods: [{ start_date: "2026-09-01", end_date: "2026-09-03" }]
  }, [{ id: 7, providerId: "31" }]);
  assert.equal(normalized.formData.address6.value, "Str. Exemplu 1");
  assert.equal(normalized.formData.cerere_client6.value, "Cameră liniștită");
  assert.equal(normalized.formData.name.value, "Ana");
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

test("provider reloads Marina state after a stale booking version", async () => {
  const oauth = new OAuthStub(true);
  let bookingReads = 0;
  let pricingReads = 0;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      quote: async () => ({ payload: { data: { quote_id: "quote-refreshed", nights: 2, total_minor: 36000, deposit_minor: 10800, balance_minor: 25200, expires_at: "2099-01-01T00:00:00Z" } } }),
      updateBooking: async () => { throw Object.assign(new Error("stale"), { status: 412 }); },
      booking: async () => { bookingReads += 1; return { payload: { data: { id: "booking-stale", resource_id: 31, version: 5, periods: [{ start_date: "2026-09-01", end_date: "2026-09-03" }] } } }; },
      listNotes: async () => ({ payload: { data: [] } }),
      pricing: async () => { pricingReads += 1; return { payload: { data: { version: 8 } } }; }
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{ localId: "marina:booking-stale", providerId: "booking-stale", providerResourceId: "31", resourceId: 7, dates: ["2026-09-01", "2026-09-02"], formData: { visitors: { value: "2" }, children: { value: "0" } }, note: "", version: 4 }];
  await assert.rejects(() => provider.update("marina:booking-stale", { dates: ["2026-09-01", "2026-09-03"], quoteId: "quote-new" }), (error) => error.code === "marina_stale_version" && error.status === 412);
  assert.equal(bookingReads, 1);
  assert.equal(pricingReads, 1);
  assert.equal(provider.findBooking("marina:booking-stale").version, 5);
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

test("provider loads full booking details and keeps internal_note as the editable note", async () => {
  const oauth = new OAuthStub(true);
  let noteReads = 0;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      booking: async () => ({ payload: { data: { id: "booking-3", resource_id: 31, status: "completed", periods: [{ start_date: "2026-08-01", end_date: "2026-08-02" }], internal_note: "Notă importată" } } }),
      listNotes: async () => { noteReads += 1; return { payload: { data: [{ id: 1, body: "Notă Marina" }] } }; }
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{ localId: "marina:booking-3", providerId: "booking-3", providerResourceId: "31", resourceId: 7, dates: ["2026-08-01"], note: "", status: "approved" }];
  const detailed = await provider.details("marina:booking-3");
  assert.equal(detailed.status, "approved");
  assert.equal(detailed.note, "Notă importată");
  assert.equal(noteReads, 0);
  assert.deepEqual(detailed.dates, ["2026-08-01", "2026-08-02", "2026-08-03"]);
});

test("provider hydrates the separate notes collection only when internal_note is absent", async () => {
  const oauth = new OAuthStub(true);
  let releaseNotes;
  const notesGate = new Promise((resolve) => { releaseNotes = resolve; });
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      booking: async () => ({ payload: { data: { id: "booking-separate-note", resource_id: 31, periods: [{ start_date: "2026-08-01", end_date: "2026-08-02" }] } } }),
      listNotes: async () => notesGate
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{ localId: "marina:booking-separate-note", providerId: "booking-separate-note", providerResourceId: "31", resourceId: 7, dates: ["2026-08-01"], note: "", status: "approved" }];
  const detailsPromise = provider.details("marina:booking-separate-note");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.findBooking("marina:booking-separate-note").note, "");
  releaseNotes({ payload: { data: [{ id: 2, body: "Notă suplimentară" }] } });
  const detailed = await detailsPromise;
  assert.equal(detailed.note, "Notă suplimentară");
});

test("provider replaces and clears a Marina internal note through booking PATCH", async () => {
  const oauth = new OAuthStub(true);
  const updates = [];
  let appendedNotes = 0;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      updateBooking: async (id, body, key, version) => {
        updates.push({ id, body, key, version });
        return { payload: { data: { id, resource_id: 31, status: "pending", periods: [{ start_date: "2026-08-01", end_date: "2026-08-02" }], internal_note: "Nota veche", version: Number(version) + 1 } } };
      },
      addNote: async () => { appendedNotes += 1; }
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{ localId: "marina:booking-note", providerId: "booking-note", providerResourceId: "31", resourceId: 7, dates: ["2026-08-01", "2026-08-02", "2026-08-03"], note: "Nota veche", status: "pending", formData: {}, version: 4 }];
  provider.refreshAfterMutation = async () => {};

  const replaced = await provider.update("marina:booking-note", { note: "Nota nouă" }, "note");
  provider.bookings = provider.normalizeBookings([{ id: "booking-note", resource_id: 31, status: "pending", periods: [{ start_date: "2026-08-01", end_date: "2026-08-02" }], internal_note: "Nota veche", version: 5 }]);
  const afterStaleReplaceRefresh = provider.findBooking("marina:booking-note");
  const cleared = await provider.update("marina:booking-note", { note: "" }, "note");
  provider.bookings = provider.normalizeBookings([{ id: "booking-note", resource_id: 31, status: "pending", periods: [{ start_date: "2026-08-01", end_date: "2026-08-02" }], internal_note: "Nota veche", version: 6 }]);
  const afterStaleClearRefresh = provider.findBooking("marina:booking-note");

  assert.equal(updates.length, 2);
  assert.equal(updates[0].body.internal_note, "Nota nouă");
  assert.equal(updates[1].body.internal_note, "");
  assert.equal(updates[0].version, 4);
  assert.equal(updates[1].version, 5);
  assert.equal(replaced.note, "Nota nouă");
  assert.equal(afterStaleReplaceRefresh.note, "Nota nouă");
  assert.equal(cleared.note, "");
  assert.equal(afterStaleClearRefresh.note, "");
  assert.equal(appendedNotes, 0);
});

test("provider supplies the Marina payment snapshot to the shared Avans popup", async () => {
  const oauth = new OAuthStub(true);
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      payment: async (id) => {
        assert.equal(id, "booking-payment");
        return { payload: { data: { booking_id: id, total_minor: 30000, deposit_minor: 9000, balance_minor: 21000, note: "Cost total: 300 RON, Depozit: 90 RON, Rest: 210 RON" } } };
      }
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{
    localId: "marina:booking-payment", providerId: "booking-payment", providerResourceId: "31", resourceId: 7,
    dates: ["2026-09-01", "2026-09-02"], note: "Sosire târzie", formData: { email: { value: "ana@example.com" } }, version: 4
  }];

  const snapshot = await provider.payment("marina:booking-payment");

  assert.equal(snapshot.booking_id, "booking-payment");
  assert.equal(snapshot.total, 300);
  assert.equal(snapshot.deposit, 90);
  assert.equal(snapshot.balance, 210);
  assert.equal(snapshot.email_available, false);
  assert.equal(snapshot.email, "ana@example.com");
});

test("Marina payment normalization accepts nested pricing and legacy deposit fields", () => {
  const snapshot = normalizeMarinaPayment({
    data: {
      booking: {
        id: "booking-legacy-payment",
        cost: 180,
        pricing: { total_minor: 70000 },
        internal_note: "Cost total: 700 RON, Depozit: 180 RON, Rest: 420 RON"
      }
    }
  });

  assert.equal(snapshot.booking_id, "booking-legacy-payment");
  assert.equal(snapshot.total, 700);
  assert.equal(snapshot.deposit, 180);
  assert.equal(snapshot.balance, 520);
  assert.equal(snapshot.note, "Cost total: 700 RON, Depozit: 180 RON, Rest: 420 RON");
});

test("Marina manual deposit is namespaced and preserves existing custom fields", () => {
  const customFields = marinaCustomFieldsWithDeposit({ data: {
    id: "booking-no-price",
    custom_fields: { existing: "kept" },
    price: { total_minor: 10000, deposit_minor: 3000, balance_minor: 7000 }
  } }, { total: 100, deposit: 40 });
  assert.deepEqual(customFields, { existing: "kept", [MANUAL_DEPOSIT_FIELD]: 4000 });

  const payment = normalizeMarinaPayment({ data: {
    custom_fields: customFields,
    price: { total_minor: 10000, deposit_minor: 3000, balance_minor: 7000 }
  } });
  assert.equal(payment.deposit, 40);
  assert.equal(payment.balance, 60);
});

test("provider changes Marina Avans through namespaced booking custom fields", async () => {
  const oauth = new OAuthStub(true);
  let updateCall;
  const provider = new MarinaBookingProvider({
    config: MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client" }),
    oauth,
    api: {
      payment: async () => ({ payload: { data: { id: "booking-deposit", resource_id: 31, periods: [{ start_date: "2026-09-01", end_date: "2026-09-01" }], internal_note: "Sosire târzie\n\nCost total: 100 RON, Depozit: 30 RON, Rest: 70 RON\n\nAtenție la parcare", version: 4, custom_fields: { existing: "kept" }, price: { currency: "RON", base_minor: 10000, discount_minor: 0, tax_minor: 0, total_minor: 10000, deposit_minor: 3000, balance_minor: 7000, payment_status: "unpaid", source: "quote", breakdown: { nights: 1 } } } } }),
      updateDeposit: async (...args) => {
        updateCall = args;
        return { payload: { data: { id: "booking-deposit", resource_id: 31, periods: [{ start_date: "2026-09-01", end_date: "2026-09-01" }], internal_note: "Cost total: 100 RON, Depozit: 30 RON, Rest: 70 RON", version: 5 } } };
      }
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{
    localId: "marina:booking-deposit", providerId: "booking-deposit", providerResourceId: "31", resourceId: 7,
    dates: ["2026-09-01", "2026-09-02"], note: "Sosire târzie\n\nCost total: 100 RON, Depozit: 30 RON, Rest: 70 RON\n\nAtenție la parcare", formData: {}, version: 4
  }];
  provider.refreshAfterMutation = () => {};

  const updated = await provider.updateDeposit("marina:booking-deposit", {
    deposit: 40,
    total: 100,
    note: "Sosire târzie\n\nCost total: 100 RON, Depozit: 30 RON, Rest: 70 RON\n\nAtenție la parcare"
  });

  assert.equal(updateCall[0], "booking-deposit");
  assert.deepEqual(updateCall[1], {
    custom_fields: { existing: "kept", [MANUAL_DEPOSIT_FIELD]: 4000 },
    internal_note: "Sosire târzie\n\nCost total: 100 RON, Depozit: 40 RON, Rest: 60 RON\n\nAtenție la parcare"
  });
  assert.match(updateCall[2], /^[0-9a-f-]{36}$/);
  assert.equal(updateCall[3], 4);
  assert.equal(updated.deposit, 40);
  assert.equal(updated.total, 100);
  assert.equal(updated.note, "Sosire târzie\n\nCost total: 100 RON, Depozit: 40 RON, Rest: 60 RON\n\nAtenție la parcare");
  assert.equal(provider.findBooking("marina:booking-deposit").version, 5);
  assert.equal(provider.findBooking("marina:booking-deposit").formData[MANUAL_DEPOSIT_FIELD], undefined);
  const reopenedPayment = await provider.payment("marina:booking-deposit");
  assert.equal(reopenedPayment.note, "Sosire târzie\n\nCost total: 100 RON, Depozit: 40 RON, Rest: 60 RON\n\nAtenție la parcare");
  provider.bookings = provider.normalizeBookings([{
    id: "booking-deposit", resource_id: 31, periods: [{ start_date: "2026-09-01", end_date: "2026-09-01" }],
    internal_note: "Sosire târzie\n\nCost total: 100 RON, Depozit: 30 RON, Rest: 70 RON\n\nAtenție la parcare", version: 5
  }]);
  assert.equal(provider.findBooking("marina:booking-deposit").note, "Sosire târzie\n\nCost total: 100 RON, Depozit: 40 RON, Rest: 60 RON\n\nAtenție la parcare");
});
