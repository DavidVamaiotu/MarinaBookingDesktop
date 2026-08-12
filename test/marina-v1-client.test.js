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
  const result = await client.updateBooking("booking-1", { resource_id: "room-1" }, "idem-1", 6);
  assert.equal(result.payload.id, "booking-1");
  assert.equal(request.url, "https://booking.husi.ro/v1/bookings/booking-1");
  assert.equal(request.options.method, "PATCH");
  assert.equal(request.options.headers["Idempotency-Key"], "idem-1");
  assert.equal(request.options.headers["If-Match"], "6");
  assert.deepEqual(JSON.parse(request.options.body), { resource_id: "room-1" });
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
    return true;
  });
});
