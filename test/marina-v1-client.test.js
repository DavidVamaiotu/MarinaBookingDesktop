"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MarinaApiError, MarinaV1ApiClient } = require("../src/main/marina-v1-client");

function response(status, payload, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async text() { return payload === undefined ? "" : JSON.stringify(payload); }
  };
}

test("Marina API client uses bearer auth and refreshes once after 401", async () => {
  let token = "expired";
  let refreshes = 0;
  const requests = [];
  const client = new MarinaV1ApiClient({
    baseUrl: "https://booking.husi.ro/",
    oauth: {
      getAccessToken: async () => token,
      refresh: async () => { refreshes += 1; token = "fresh"; }
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? response(401, { detail: "expired" })
        : response(200, { resources: [] });
    }
  });

  const result = await client.resources();
  assert.deepEqual(result.payload, { resources: [] });
  assert.equal(refreshes, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://booking.husi.ro/v1/resources");
  assert.equal(requests[0].options.headers.Authorization, "Bearer expired");
  assert.equal(requests[1].options.headers.Authorization, "Bearer fresh");
});

test("Marina API client sends idempotency and version headers for mutations", async () => {
  let request;
  const client = new MarinaV1ApiClient({
    baseUrl: "https://booking.husi.ro",
    oauth: { getAccessToken: async () => "token" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { id: "booking-1", version: 7 });
    }
  });
  const result = await client.updateBooking("booking-1", { resource_id: "31" }, "idem-1", 6);
  assert.equal(result.payload.id, "booking-1");
  assert.equal(request.url, "https://booking.husi.ro/v1/bookings/booking-1");
  assert.equal(request.options.method, "PATCH");
  assert.equal(request.options.headers["Idempotency-Key"], "idem-1");
  assert.equal(request.options.headers["If-Match"], "6");
  assert.deepEqual(JSON.parse(request.options.body), { resource_id: 31, expected_version: 6 });
});

test("Marina API client reads the payment snapshot and sends a versioned deposit update", async () => {
  const requests = [];
  const client = new MarinaV1ApiClient({
    baseUrl: "https://booking.husi.ro",
    oauth: { getAccessToken: async () => "payment-token" },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200, { data: { booking_id: "booking-payment", deposit: 40, total: 100, balance: 60, note: "Cost total: 100 RON, Depozit: 40 RON, Rest: 60 RON" } });
    }
  });

  const snapshot = await client.payment("booking-payment");
  const updated = await client.updateDeposit(
    "booking-payment",
    {
      custom_fields: { existing: "kept", parkline_manual_deposit_minor: 4000 },
      internal_note: "Sosire târzie\nCost total: 100 RON, Depozit: 40 RON, Rest: 60 RON"
    },
    "deposit-key",
    8
  );

  assert.equal(snapshot.payload.data.deposit, 40);
  assert.equal(requests[0].url, "https://booking.husi.ro/v1/bookings/booking-payment");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(updated.payload.data.balance, 60);
  assert.equal(requests[1].url, "https://booking.husi.ro/v1/bookings/booking-payment");
  assert.equal(requests[1].options.method, "PATCH");
  assert.equal(requests[1].options.headers["Idempotency-Key"], "deposit-key");
  assert.equal(requests[1].options.headers["If-Match"], "8");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    custom_fields: { existing: "kept", parkline_manual_deposit_minor: 4000 },
    internal_note: "Sosire târzie\nCost total: 100 RON, Depozit: 40 RON, Rest: 60 RON",
    expected_version: 8
  });
});

test("Marina API client creates resources with bearer auth and an idempotency key", async () => {
  let request;
  const client = new MarinaV1ApiClient({
    baseUrl: "https://booking.husi.ro",
    oauth: { getAccessToken: async () => "access-token" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(201, { data: { id: "resource-1" } });
    }
  });
  await client.createResource({ name: "Camera 1", timezone: "Europe/Bucharest" }, "resource-key");
  assert.equal(request.url, "https://booking.husi.ro/v1/resources");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer access-token");
  assert.equal(request.options.headers["Idempotency-Key"], "resource-key");
});

test("Marina API client reads and publishes pricing and requests quotes", async () => {
  const requests = [];
  const client = new MarinaV1ApiClient({
    baseUrl: "https://booking.husi.ro",
    oauth: { getAccessToken: async () => "pricing-token" },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "GET") return response(200, { data: { version: 4, currency: "RON", pricing_mode: "resource_per_night", resource_nightly_minor: 15000, seasons: [] } });
      if (url.endsWith("/pricing")) return response(200, { data: { version: 5 } });
      return response(200, { data: { quote_id: "quote-1", pricing_version: 4, nights: 2, total_minor: 30000, deposit_percent: 30, deposit_minor: 9000, balance_minor: 21000, expires_at: "2099-01-01T00:00:00Z", nights_breakdown: [] } });
    }
  });
  const current = await client.pricing("resource-1");
  assert.equal(current.payload.data.version, 4);
  await client.putPricing("resource-1", { currency: "RON" }, "pricing-key");
  const quote = await client.quote({ resource_id: "31", periods: [{ start_date: "2026-06-01", end_date: "2026-06-02", units: "1" }], guests: { adults: "2", children: "0" } });
  assert.equal(quote.payload.data.quote_id, "quote-1");
  assert.equal(requests[1].url, "https://booking.husi.ro/v1/resources/resource-1/pricing");
  assert.equal(requests[1].options.headers["Idempotency-Key"], "pricing-key");
  assert.equal(requests[2].url, "https://booking.husi.ro/v1/quotes");
  assert.deepEqual(JSON.parse(requests[2].options.body), { resource_id: 31, periods: [{ start_date: "2026-06-01", end_date: "2026-06-02", units: 1 }], guests: { adults: 2, children: 0 } });
});

test("Marina API client serializes availability IDs as integers", async () => {
  let body;
  const client = new MarinaV1ApiClient({
    oauth: { getAccessToken: async () => "token" },
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response(200, { data: { available: true } }); }
  });
  await client.availabilityCheck({ resource_id: "31", exclude_booking_id: "1592", periods: [], units: 1 });
  assert.equal(body.resource_id, 31);
  assert.equal(body.exclude_booking_id, 1592);
});

test("Marina API client preserves conflicts and retry metadata", async () => {
  const client = new MarinaV1ApiClient({
    oauth: { getAccessToken: async () => "token" },
    fetchImpl: async () => response(409, { type: "booking_conflict", detail: "Conflict" }, { "retry-after": "4" })
  });
  await assert.rejects(() => client.cancelBooking("booking-1", {}, "idem-2", 9), (error) => {
    assert.ok(error instanceof MarinaApiError);
    assert.equal(error.conflict, true);
    assert.equal(error.status, 409);
    assert.equal(error.code, "booking_conflict");
    assert.equal(error.retryAfter, 4);
    assert.equal(error.message, "Eroare Marina: Conflict");
    return true;
  });
});

test("Marina API client exposes structured validation details", async () => {
  const client = new MarinaV1ApiClient({
    oauth: { getAccessToken: async () => "token" },
    fetchImpl: async () => response(422, {
      title: "Validation failed",
      errors: { custom_fields: ["must be an object"] }
    })
  });
  await assert.rejects(() => client.updateDeposit("booking-1", { custom_fields: {} }, "idem-3", 2), (error) => {
    assert.equal(error.message, "Eroare Marina: Validation failed; custom_fields: must be an object");
    return true;
  });
});
