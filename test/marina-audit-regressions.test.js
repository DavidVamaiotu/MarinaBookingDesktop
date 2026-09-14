"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const MarinaConfig = require("../src/shared/marina-config");
const MarinaOperationRegistry = require("../src/shared/marina-operation-registry");
const MarinaSyncResponse = require("../src/shared/marina-sync-response");
const MarinaConflictRecovery = require("../src/shared/marina-conflict-recovery");
const { MarinaBookingProvider } = require("../src/main/marina-provider-service");

class OAuthStub extends EventEmitter {
  constructor() { super(); this.connected = true; this.value = 0; }
  status() { return { connected: this.connected, connecting: false, effectiveScopes: ["resources:read", "bookings:read", "bookings:write"] }; }
  generation() { return this.value; }
}

const config = (workspaceSlug = "rooms") => ({
  ...MarinaConfig.createConfig({ MARINA_INTEGRATION_ENABLED: "true", MARINA_OAUTH_CLIENT_ID: "public-client", MARINA_ROOMS_WORKSPACE_ID: "2" }),
  workspaceId: 2,
  workspaceSlug
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, reject, resolve };
};
const resource = (id = 31) => ({ id, name: `Camera ${id}`, booking_mode: "date_range" });
const booking = (id, resourceId = 31, date = "2026-09-01") => ({ id, resource_id: resourceId, periods: [{ start_date: date, end_date: date }], status: "pending", version: 1 });
const fullQuote = (quoteId) => ({ payload: { data: { quote_id: quoteId, nights: 1, total_minor: 10000, deposit_minor: 3000, balance_minor: 7000, expires_at: "2099-01-01T00:00:00Z" } } });

test("shared session operation registry coalesces work, preserves uncertain requests, and never evicts them", async () => {
  let keyNumber = 0;
  const registry = MarinaOperationRegistry.createOperationRegistry({ limit: 1, createKey: () => `key-${++keyNumber}` });
  const gate = deferred();
  let executions = 0;
  const first = registry.run("same", () => ({ exact: true }), async (body, key) => { executions += 1; await gate.promise; throw Object.assign(new Error("timeout"), { status: 504, body, key }); });
  const concurrent = registry.run("same", () => ({ exact: false }), () => { throw new Error("must coalesce"); });
  await assert.rejects(() => registry.run("different", () => ({}), async () => ({})), { code: "marina_retry_capacity" });
  gate.resolve();
  const [firstError, concurrentError] = await Promise.all([first.catch((error) => error), concurrent.catch((error) => error)]);
  assert.equal(executions, 1);
  assert.equal(firstError, concurrentError);
  const retried = await registry.run("same", () => ({ exact: false }), async (body, key) => ({ body, key }));
  assert.deepEqual(retried, { body: { exact: true }, key: "key-1" });
  const newAttempt = await registry.run("same", () => ({ exact: "new" }), async (body, key) => ({ body, key }));
  assert.deepEqual(newAttempt, { body: { exact: "new" }, key: "key-2" });
  await assert.rejects(registry.run("rejected", () => ({}), async () => { throw Object.assign(new Error("bad request"), { status: 400 }); }), /bad request/);
  const afterRejection = await registry.run("rejected", () => ({}), async (_body, key) => key);
  assert.equal(afterRejection, "key-4");
});

test("desktop create retries reuse the exact final quote body and key", async () => {
  let quoteCalls = 0;
  const attempts = [];
  const provider = new MarinaBookingProvider({
    config: config(), oauth: new OAuthStub(),
    api: {
      quote: async () => fullQuote(`final-${++quoteCalls}`),
      createBooking: async (body, key) => {
        attempts.push({ body: structuredClone(body), key });
        if (attempts.length === 1) throw Object.assign(new Error("timeout"), { status: 504 });
        return { payload: { data: { ...body, id: 77, version: 1 } } };
      }
    }
  });
  provider.resources = [{ id: 7, providerId: "31", bookingMode: "date_range" }];
  provider.refreshAfterMutation = () => {};
  const input = { resourceId: 7, dates: ["2026-09-01", "2026-09-02"], quoteId: "ui-1", note: "Test", formData: {} };
  await assert.rejects(provider.create(input), /timeout/);
  await provider.create({ ...input, quoteId: "ui-2" });
  assert.equal(quoteCalls, 1);
  assert.equal(attempts[0].key, attempts[1].key);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(attempts[1].body.quote_id, "final-1");
});

test("repricing retries reuse the exact quoted patch and idempotency key", async () => {
  let quoteCalls = 0;
  const attempts = [];
  const provider = new MarinaBookingProvider({
    config: config(), oauth: new OAuthStub(),
    api: {
      quote: async () => fullQuote(`reprice-${++quoteCalls}`),
      updateBooking: async (_id, body, key) => {
        attempts.push({ body: structuredClone(body), key });
        if (attempts.length === 1) throw Object.assign(new Error("gateway"), { status: 503 });
        return { payload: { data: { id: "5", resource_id: body.resource_id, periods: body.periods, guests: body.guests, version: 2 } } };
      }
    }
  });
  provider.resources = [{ id: 7, providerId: "31", bookingMode: "date_range" }];
  provider.bookings = [{ localId: "marina:5", providerId: "5", providerResourceId: "31", resourceId: 7, dates: ["2026-09-01", "2026-09-02"], facilityIds: [], formData: {}, note: "", version: 1 }];
  provider.refreshAfterMutation = () => {};
  const patch = { dates: ["2026-09-02", "2026-09-03"], quoteId: "ui-1" };
  await assert.rejects(provider.update("marina:5", patch), /gateway/);
  await provider.update("marina:5", { ...patch, quoteId: "ui-2" });
  assert.equal(quoteCalls, 1);
  assert.equal(attempts[0].key, attempts[1].key);
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(attempts[1].body.quote_id, "reprice-1");
});

test("strict sync parsing accepts supported empty envelopes and rejects unknown shapes", () => {
  for (const payload of [[], { data: [] }, { resources: [] }, { data: { resources: [] } }]) {
    assert.deepEqual(MarinaSyncResponse.collection(payload, ["resources"], "resurse"), []);
  }
  assert.throws(() => MarinaSyncResponse.collection({ data: { unexpected: [] } }, ["resources"], "resurse"), { code: "marina_invalid_response" });
  assert.throws(() => MarinaSyncResponse.validateRecord({ providerId: "1", providerResourceId: "", dates: [] }, "rezervări"), { code: "marina_invalid_response" });
});

test("newer range refresh wins and the superseded request never persists", async () => {
  const firstResources = deferred();
  let resourceCalls = 0;
  const saved = [];
  const provider = new MarinaBookingProvider({
    config: config(), oauth: new OAuthStub(),
    api: {
      resources: async () => ++resourceCalls === 1 ? firstResources.promise : { payload: { data: [resource(32)] } },
      facilities: async () => ({ payload: { data: [] } }),
      bookings: async ({ from }) => ({ payload: { data: [booking(from.includes("10-01") ? 2 : 1, from.includes("10-01") ? 32 : 31, from.slice(0, 10))], has_more: false, next_cursor: "" } })
    },
    cacheStore: { load: () => ({}), save: (value) => saved.push(structuredClone(value)) }
  });
  const older = provider.refresh({ start: "2026-09-01", end: "2026-09-30" });
  const newer = await provider.refresh({ start: "2026-10-01", end: "2026-10-31" });
  firstResources.resolve({ payload: { data: [resource(31)] } });
  await assert.rejects(older, { code: "marina_refresh_superseded" });
  assert.equal(newer.source, "rooms");
  assert.deepEqual(newer.range, { start: "2026-10-01", end: "2026-10-31" });
  assert.equal(provider.resources[0].providerId, "32");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].resources[0].providerId, "32");
});

test("malformed later booking pages preserve the previous complete cache and sync timestamp", async () => {
  const oldBooking = { localId: "marina:old", providerId: "old", providerResourceId: "31", resourceId: 7, dates: ["2026-08-01"], formData: {} };
  let saved = 0;
  const provider = new MarinaBookingProvider({
    config: config(), oauth: new OAuthStub(),
    api: {
      resources: async () => ({ payload: { data: [resource()] } }),
      facilities: async () => ({ payload: { data: [] } }),
      bookings: async ({ cursor }) => cursor ? { payload: { unexpected: [], has_more: false, next_cursor: "" } } : { payload: { data: [booking("new")], has_more: true, next_cursor: "next" } }
    }, cacheStore: { load: () => ({}), save: () => { saved += 1; } }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [oldBooking];
  provider.lastSuccessfulSync = "2026-08-01T00:00:00.000Z";
  await assert.rejects(provider.refresh({ start: "2026-09-01", end: "2026-09-30" }), { code: "marina_invalid_response" });
  assert.deepEqual(provider.bookings, [oldBooking]);
  assert.equal(provider.lastSuccessfulSync, "2026-08-01T00:00:00.000Z");
  assert.equal(saved, 0);
});

test("deposit updates use the fresh authoritative note and stop when an omitted note cannot be retrieved", async () => {
  const updateBodies = [];
  let latest = { id: "9", resource_id: 31, periods: [{ start_date: "2026-09-01", end_date: "2026-09-01" }], internal_note: "", version: 4 };
  const provider = new MarinaBookingProvider({
    config: config(), oauth: new OAuthStub(),
    api: {
      payment: async () => ({ payload: { data: latest } }),
      listNotes: async () => { throw new Error("notes unavailable"); },
      updateDeposit: async (_id, body) => { updateBodies.push(body); return { payload: { data: { ...latest, ...body, version: 5 } } }; }
    }
  });
  provider.resources = [{ id: 7, providerId: "31" }];
  provider.bookings = [{ localId: "marina:9", providerId: "9", providerResourceId: "31", resourceId: 7, dates: ["2026-09-01", "2026-09-02"], formData: {}, note: "NOTĂ VECHE", version: 3 }];
  provider.refreshAfterMutation = () => {};
  await provider.updateDeposit("marina:9", { deposit: 40, total: 100, note: "NOTĂ VECHE" });
  assert.equal(updateBodies[0].internal_note, "Cost total: 100 RON, Depozit: 40 RON, Rest: 60 RON");
  latest = { id: "9", resource_id: 31, periods: latest.periods, version: 5 };
  await assert.rejects(provider.updateDeposit("marina:9", { deposit: 50, total: 100 }), /notes unavailable/);
  assert.equal(updateBodies.length, 1);
});

test("Android conflict recovery stores the raw fresh record and reports storage failure", async () => {
  const raw = { id: "17", resource_id: 31, periods: [{ start_date: "2026-09-01", end_date: "2026-09-01" }], version: 8 };
  let stored;
  assert.equal(await MarinaConflictRecovery.recoverBooking({ bookingId: "17", fetchBooking: async () => ({ data: { booking: raw } }), storeBooking: async (value) => { stored = value; } }), true);
  assert.deepEqual(stored, raw);
  assert.equal(await MarinaConflictRecovery.recoverBooking({ bookingId: "17", fetchBooking: async () => ({ data: { booking: raw } }), storeBooking: async () => { throw new Error("disk full"); } }), false);
});
