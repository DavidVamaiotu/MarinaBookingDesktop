"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require("esbuild");
const { webcrypto } = require("node:crypto");

function memoryStorage() {
  const values = new Map();
  const storage = {};
  Object.defineProperties(storage, {
    getItem: { value: (key) => values.has(key) ? values.get(key) : null },
    setItem: { value: (key, value) => { values.set(String(key), String(value)); } },
    removeItem: { value: (key) => { values.delete(String(key)); } },
    key: { value: (index) => [...values.keys()][index] || null },
    length: { get: () => values.size }
  });
  return storage;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

function bridgeHarness(fetchImpl, retainedStorage = null) {
  const bundle = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "mobile", "mobile-bridge.js")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome89"],
    write: false
  }).outputFiles[0].text;
  const localStorage = retainedStorage || memoryStorage();
  const classNames = new Set();
  const windowListeners = new Map();
  const intervals = [];
  const sandbox = {
    URL,
    URLSearchParams,
    TextEncoder,
    Response,
    Headers,
    FormData,
    Blob,
    Event,
    crypto: webcrypto,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    fetch: fetchImpl,
    localStorage,
    setTimeout,
    clearTimeout,
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
    clearInterval() {},
    addEventListener(type, callback) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(callback);
    },
    console,
    document: {
      hidden: false,
      addEventListener() {},
      documentElement: { classList: { add: (name) => classNames.add(name) } }
    },
    BookingCalendar: {
      toStayDateTimes(dates, { checkIn = "15:00:01", checkOut = "12:00:02" } = {}) {
        return dates.map((date, index) => `${date} ${index === 0 ? checkIn : index === dates.length - 1 ? checkOut : "00:00:00"}`);
      }
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(bundle, sandbox, { filename: "mobile-bridge.bundle.js" });
  return {
    marina: sandbox.marina,
    classNames,
    localStorage,
    intervals,
    dispatchWindow(type) { for (const callback of windowListeners.get(type) || []) callback(); }
  };
}

async function configuredBridge(fetchImpl, retainedStorage = null) {
  const harness = bridgeHarness(fetchImpl, retainedStorage);
  await harness.marina.saveSettings({ apiBaseUrl: "https://example.test", username: "api-user", password: "secret", timezone: "Europe/Bucharest" });
  await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  return harness;
}

test("mobile settings stay pinned to the requested workspace", async () => {
  const harness = bridgeHarness(async () => { throw new Error("No network request expected."); });
  await harness.marina.saveSettings({ source: "rooms", apiBaseUrl: "https://rooms.example.test", username: "rooms-user", password: "rooms-secret", timezone: "Europe/Bucharest" });
  harness.marina.setSource("camping");
  await harness.marina.saveSettings({ source: "camping", apiBaseUrl: "https://camping.example.test", username: "camping-user", password: "camping-secret", timezone: "Europe/Bucharest" });
  assert.equal((await harness.marina.getSettings("rooms")).username, "rooms-user");
  assert.equal((await harness.marina.getSettings("camping")).username, "camping-user");
});

test("mobile Camping refresh keeps reservations from every API resource", async () => {
  const harness = bridgeHarness(async (url) => {
    if (url.endsWith("/resources")) return jsonResponse({ resources: [
      { id: 1, title: "Corturi", active: true },
      { id: 2, title: "Rulote", active: true },
      { id: 27, title: "Parcare rulotă", default_form: "rulota", active: true }
    ] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [
      { booking_id: 270, resource_id: 27, dates: [{ date: "2026-07-12" }, { date: "2026-07-13" }], form_data: { secondname: { value: "Ionescu", type: "text" }, car_plates: { value: "B-01-ABC", type: "text" } } }
    ] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  harness.marina.setSource("camping");
  await harness.marina.saveSettings({ apiBaseUrl: "https://camping.example.test", username: "api-user", password: "secret", timezone: "Europe/Bucharest" });
  const state = await harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  assert.ok(state.resources.some((resource) => resource.id === 27));
  assert.equal(state.bookings[0].resourceId, 27);
  assert.equal(state.bookings[0].serverId, 270);
});

test("mobile reconnects immediately when Android reports that internet returned", async () => {
  let available = false;
  let resourceRequests = 0;
  const harness = await configuredBridge(async (url) => {
    if (url.endsWith("/resources")) {
      resourceRequests += 1;
      return available ? jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] }) : jsonResponse({ code: "offline" }, 400);
    }
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await assert.rejects(harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" }));
  const states = [];
  harness.marina.onStateChanged((state) => states.push(state));
  available = true;
  harness.dispatchWindow("online");
  while (!states.some((state) => state.diagnostics.online)) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resourceRequests, 2);
  assert.ok(harness.intervals.some(({ delay }) => delay === 15_000));
  const retained = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  assert.equal(retained.diagnostics.online, true);
});

test("mobile create saves its note and refreshes through the expected API contract", async () => {
  const requests = [];
  let created = false;
  const harness = await configuredBridge(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes("/by-external-id/")) return jsonResponse(created ? { booking: { booking_id: 77, resource_id: 4, dates: [{ date: "2026-07-12" }, { date: "2026-07-13" }] } } : { code: "rest_booking_not_found" }, created ? 200 : 404);
    if (url.endsWith("/availability")) return jsonResponse({ available: true });
    if (url.endsWith("/bookings") && options.method === "POST") { created = true; return jsonResponse({ booking_id: 77 }); }
    if (url.endsWith("/bookings/77/note")) return jsonResponse({ ok: true });
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [{ booking_id: 77, resource_id: 4, dates: [{ date: "2026-07-12" }, { date: "2026-07-13" }], form_data: { name: { value: "Ana", type: "text" } }, note: "Sosire târzie" }] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });

  const input = { resourceId: 4, dates: ["2026-07-12", "2026-07-13"], formData: { name: { value: "Ana", type: "text" } }, bookingFormType: "standard", note: "Sosire târzie", approved: false, sendEmail: false };
  const results = await Promise.all([harness.marina.createBooking(input), harness.marina.createBooking(input)]);
  const create = requests.find((item) => item.url.endsWith("/bookings") && item.options.method === "POST");
  const note = requests.find((item) => item.url.endsWith("/bookings/77/note"));
  assert.ok(create);
  assert.ok(note);
  assert.equal(JSON.parse(note.options.body).note, "Sosire târzie");
  assert.equal(JSON.parse(create.options.body).external_id, create.options.headers["Idempotency-Key"]);
  assert.equal(requests.filter((item) => item.url.endsWith("/bookings") && item.options.method === "POST").length, 1);
  assert.equal(requests.filter((item) => item.url.endsWith("/availability")).length, 1);
  assert.equal(results[0].localId, "server:77");
  assert.equal(results[1].serverId, 77);
  assert.ok(harness.classNames.has("is-mobile-app"));
});

test("mobile create clears Booking Calendar's automatic zero-price remark when no note was entered", async () => {
  const requests = [];
  let created = false;
  const harness = await configuredBridge(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes("/by-external-id/")) return jsonResponse(created ? { booking: { booking_id: 78, resource_id: 4, dates: [{ date: "2026-07-14" }] } } : { code: "rest_booking_not_found" }, created ? 200 : 404);
    if (url.endsWith("/availability")) return jsonResponse({ available: true });
    if (url.endsWith("/bookings") && options.method === "POST") { created = true; return jsonResponse({ booking_id: 78 }); }
    if (url.endsWith("/bookings/78/note")) return jsonResponse({ ok: true });
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [{ booking_id: 78, resource_id: 4, dates: [{ date: "2026-07-14" }], note: "" }] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });

  await harness.marina.createBooking({ resourceId: 4, dates: ["2026-07-14"], formData: { name: { value: "Ana", type: "text" } }, bookingFormType: "standard", note: "" });
  const note = requests.find((item) => item.url.endsWith("/bookings/78/note"));
  assert.ok(note);
  assert.equal(JSON.parse(note.options.body).note, "");
});

test("mobile persists deposit and payment-email commands in dependency order", async () => {
  const requests = [];
  const booking = { booking_id: 88, resource_id: 4, dates: [{ date: "2026-07-20" }, { date: "2026-07-21" }], form_data: { email: { value: "client@example.com", type: "email" } }, remark: "Avans: 30, Cost: 100, Rest: 70" };
  const harness = await configuredBridge(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [booking] });
    if (url.endsWith("/bookings/88/deposit")) return jsonResponse({ booking_id: 88, note: "Cost total: 100 RON, Depozit: 40 RON, Rest: 60 RON" });
    if (url.endsWith("/bookings/88/payment-request")) return jsonResponse({ booking_id: 88, sent: true });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  const deposit = await harness.marina.updateDeposit("server:88", { deposit: 40 });
  const payment = { reason: "aBcDeF", nights: 1, start_date: "2026-07-20", end_date: "2026-07-21" };
  const email = await harness.marina.requestPayment("server:88", payment);
  assert.equal(email.dependsOnCommandId, deposit.id);
  while (!requests.some((item) => item.url.endsWith("/bookings/88/payment-request"))) await new Promise((resolve) => setTimeout(resolve, 0));
  const mutations = requests.filter((item) => item.url.includes("/bookings/88/") && !item.url.endsWith("/payment"));
  assert.deepEqual(mutations.map((item) => item.url.split("/").at(-1)), ["deposit", "payment-request"]);
  assert.equal(mutations[0].options.headers["Idempotency-Key"], deposit.id);
  assert.equal(mutations[1].options.headers["Idempotency-Key"], email.id);
  assert.deepEqual(JSON.parse(mutations[1].options.body), payment);
  const state = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  assert.equal(state.bookings[0].note, "Cost total: 100 RON, Depozit: 40 RON, Rest: 60 RON");
});

test("mobile persists a zero deposit in WordPress and keeps the full balance", async () => {
  const requests = [];
  const booking = { booking_id: 90, resource_id: 4, dates: [{ date: "2026-07-20" }, { date: "2026-07-21" }], form_data: {}, remark: "Avans: 30, Cost: 100, Rest: 70" };
  const harness = await configuredBridge(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [booking] });
    if (url.endsWith("/bookings/90/deposit")) return jsonResponse({ booking_id: 90, deposit: 0, total: 100, balance: 100, note: "Cost total: 100 RON, Depozit: 0 RON, Rest: 100 RON" });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  await harness.marina.updateDeposit("server:90", { deposit: 0 });
  while (!requests.some((item) => item.url.endsWith("/bookings/90/deposit"))) await new Promise((resolve) => setTimeout(resolve, 0));
  const request = requests.find((item) => item.url.endsWith("/bookings/90/deposit"));
  assert.deepEqual(JSON.parse(request.options.body), {
    deposit: 0,
    total: 100,
    expected_note: "Avans: 30, Cost: 100, Rest: 70"
  });
  let state;
  do {
    await new Promise((resolve) => setTimeout(resolve, 0));
    state = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  } while (state.commands.some((command) => command.type === "deposit_update" && command.status !== "synced"));
  assert.equal(state.bookings[0].note, "Cost total: 100 RON, Depozit: 0 RON, Rest: 100 RON");
});

test("mobile blocks payment email after a failed deposit and clear restores the server note", async () => {
  let paymentRequests = 0;
  const booking = { booking_id: 188, resource_id: 4, dates: [{ date: "2026-07-20" }, { date: "2026-07-21" }], form_data: { email: { value: "client@example.com", type: "email" } }, remark: "Avans: 30, Cost: 100, Rest: 70" };
  const harness = await configuredBridge(async (url) => {
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [booking] });
    if (url.endsWith("/bookings/188/deposit")) return jsonResponse({ code: "deposit_rejected", message: "Avans respins." }, 422);
    if (url.endsWith("/bookings/188/payment-request")) { paymentRequests += 1; return jsonResponse({ booking_id: 188, sent: true }); }
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  await harness.marina.updateDeposit("server:188", { deposit: 40 });
  let state;
  do {
    await new Promise((resolve) => setTimeout(resolve, 0));
    state = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  } while (!state.commands.some((command) => command.type === "deposit_update" && command.status === "failed"));
  assert.equal(state.bookings[0].note, "Cost total: 100 RON, Depozit: 40 RON, Rest: 60 RON");
  await assert.rejects(harness.marina.requestPayment("server:188", { reason: "aBcDeF", nights: 1, start_date: "2026-07-20", end_date: "2026-07-21" }), /Actualizarea avansului are o problemă/);
  assert.equal(paymentRequests, 0);
  assert.equal(await harness.marina.clearFailedCommands(), 1);
  state = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  assert.equal(state.bookings[0].note, booking.remark);
  assert.equal(state.bookings[0].syncState, "synced");
  assert.equal(state.commands.length, 0);
});

test("mobile recovers an interrupted sending deposit with its original idempotency key", async () => {
  const booking = { booking_id: 89, resource_id: 4, dates: [{ date: "2026-07-20" }, { date: "2026-07-21" }], form_data: { email: { value: "client@example.com", type: "email" } }, remark: "Avans: 30, Cost: 100, Rest: 70" };
  let releaseRequest;
  const interrupted = new Promise((resolve) => { releaseRequest = resolve; });
  const first = await configuredBridge(async (url) => {
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [booking] });
    if (url.endsWith("/bookings/89/deposit")) return interrupted;
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await first.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  const states = [];
  first.marina.onStateChanged((state) => states.push(state));
  void first.marina.updateDeposit("server:89", { deposit: 40 });
  while (!states.some((state) => state.commands.some((command) => command.type === "deposit_update" && command.status === "sending"))) await new Promise((resolve) => setTimeout(resolve, 0));
  const original = states.at(-1).commands.find((command) => command.type === "deposit_update");

  const retried = [];
  const second = bridgeHarness(async (url, options = {}) => {
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [booking] });
    if (url.endsWith("/bookings/89/deposit")) { retried.push(options.headers["Idempotency-Key"]); return jsonResponse({ booking_id: 89, note: "Cost total: 100 RON, Depozit: 40 RON, Rest: 60 RON" }); }
    throw new Error(`Unexpected synthetic request: ${url}`);
  }, first.localStorage);
  await second.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  second.dispatchWindow("online");
  while (!retried.length) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(retried[0], original.id);
  releaseRequest(jsonResponse({ booking_id: 89, note: "Cost total: 100 RON, Depozit: 40 RON, Rest: 60 RON" }));
});

test("mobile Camping create delegates capacity allocation to WordPress", async () => {
  const requests = [];
  let created = false;
  const harness = bridgeHarness(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes("/by-external-id/")) return jsonResponse(created ? { booking: { booking_id: 88, resource_id: 1, dates: [{ date: "2026-07-20" }, { date: "2026-07-21" }] } } : { code: "rest_booking_not_found" }, created ? 200 : 404);
    if (url.endsWith("/bookings") && options.method === "POST") { created = true; return jsonResponse({ booking_id: 88 }); }
    if (url.endsWith("/bookings/88/note")) return jsonResponse({ ok: true });
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 1, title: "Corturi", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [{ booking_id: 88, resource_id: 1, dates: [{ date: "2026-07-20" }, { date: "2026-07-21" }], form_data: { name: { value: "Test", type: "text" } } }] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  harness.marina.setSource("camping");
  await harness.marina.saveSettings({ apiBaseUrl: "https://camping.example.test", username: "api-user", password: "secret", timezone: "Europe/Bucharest" });
  await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  await harness.marina.createBooking({ resourceId: 1, dates: ["2026-07-20", "2026-07-21"], formData: { name: { value: "Test", type: "text" } }, bookingFormType: "standard" });
  assert.equal(requests.filter((item) => item.url.endsWith("/availability")).length, 0);
  assert.equal(requests.filter((item) => item.url.endsWith("/bookings") && item.options.method === "POST").length, 1);
});

test("mobile create reconciles an unknown network outcome without posting twice", async () => {
  const requests = [];
  let created = false;
  const harness = await configuredBridge(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes("/by-external-id/")) return jsonResponse(created ? { booking: { booking_id: 91, resource_id: 4, dates: [{ date: "2026-07-14" }, { date: "2026-07-15" }] } } : { code: "rest_booking_not_found" }, created ? 200 : 404);
    if (url.endsWith("/availability")) return jsonResponse({ available: true });
    if (url.endsWith("/bookings") && options.method === "POST") { created = true; throw new TypeError("Synthetic connection loss after commit"); }
    if (url.endsWith("/bookings/91/note")) return jsonResponse({ ok: true });
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [{ booking_id: 91, resource_id: 4, dates: [{ date: "2026-07-14" }, { date: "2026-07-15" }], form_data: { name: { value: "Ion", type: "text" } } }] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });

  await harness.marina.createBooking({ resourceId: 4, dates: ["2026-07-14", "2026-07-15"], formData: { name: { value: "Ion", type: "text" } }, bookingFormType: "standard" });
  assert.equal(requests.filter((item) => item.url.endsWith("/bookings") && item.options.method === "POST").length, 1);
  assert.equal(requests.filter((item) => item.url.includes("/by-external-id/")).length, 2);
});

test("mobile create does not POST when its duplicate-preflight lookup cannot be trusted", async () => {
  let createCalls = 0;
  const harness = await configuredBridge(async (url, options = {}) => {
    if (url.includes("/by-external-id/")) return jsonResponse({ code: "rest_not_logged_in", message: "Autentificare expirată.", data: { status: 401 } });
    if (url.endsWith("/bookings") && options.method === "POST") { createCalls += 1; return jsonResponse({ booking_id: 99 }); }
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await assert.rejects(
    harness.marina.createBooking({ resourceId: 4, dates: ["2026-07-14"], formData: { name: { value: "Ion", type: "text" } }, bookingFormType: "standard" }),
    (error) => error.code === "rest_not_logged_in" && error.auth === true
  );
  assert.equal(createCalls, 0);
});

test("confirmed mobile mutations remain visible when their follow-up refresh fails", async () => {
  let failRefresh = false;
  const harness = await configuredBridge(async (url, options = {}) => {
    if (url.endsWith("/bookings/55/status")) return jsonResponse({ ok: true });
    if (url.endsWith("/resources")) {
      if (failRefresh) return jsonResponse({ code: "synthetic_refresh_outage" }, 400);
      return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    }
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [{ booking_id: 55, resource_id: 4, approved: 0, dates: [{ date: "2026-07-16" }, { date: "2026-07-17" }], form_data: { name: { value: "Maria", type: "text" } } }] });
    throw new Error(`Unexpected synthetic request: ${url} ${options.method || "GET"}`);
  });
  await harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  const states = [];
  harness.marina.onStateChanged((state) => states.push(state));
  failRefresh = true;
  await harness.marina.setStatus("server:55", { status: "approved", sendEmail: false });
  assert.equal(states.at(-1).bookings[0].status, "approved");
  assert.equal(states.at(-1).diagnostics.online, false);
});

test("mobile action history persists every successful mutation and its lifecycle", async () => {
  const harness = await configuredBridge(async (url, options = {}) => {
    if (url.endsWith("/bookings/55/status") && options.method === "POST") return jsonResponse({ ok: true });
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [] });
    throw new Error(`Unexpected synthetic request: ${url} ${options.method || "GET"}`);
  });
  const states = [];
  harness.marina.onStateChanged((state) => states.push(state));

  await harness.marina.setStatus("server:55", { status: "approved", sendEmail: false });

  assert.ok(states.some((state) => state.commands[0]?.status === "queued"));
  assert.ok(states.some((state) => state.commands[0]?.status === "sending"));
  assert.equal(states.at(-1).commands[0].type, "status");
  assert.equal(states.at(-1).commands[0].bookingLocalId, "server:55");
  assert.equal(states.at(-1).commands[0].status, "synced");
  assert.equal(states.at(-1).diagnostics.queued, 0);
  assert.equal(states.at(-1).diagnostics.failed, 0);

  const restored = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  assert.equal(restored.commands.length, 1);
  assert.equal(restored.commands[0].status, "synced");
});

test("mobile action history keeps failed mutations with their error", async () => {
  const harness = await configuredBridge(async (url, options = {}) => {
    if (url.endsWith("/bookings/55/note") && options.method === "POST") return jsonResponse({ code: "note_rejected", message: "Nota a fost respinsă." }, 400);
    throw new Error(`Unexpected synthetic request: ${url} ${options.method || "GET"}`);
  });

  await assert.rejects(
    harness.marina.setNote("server:55", { note: "Test" }),
    /Nota a fost respinsă/
  );

  const restored = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  assert.equal(restored.commands.length, 1);
  assert.equal(restored.commands[0].type, "note");
  assert.equal(restored.commands[0].status, "failed");
  assert.equal(restored.commands[0].errorCode, "note_rejected");
  assert.equal(restored.commands[0].errorMessage, "Nota a fost respinsă.");
  assert.equal(restored.diagnostics.failed, 1);
  assert.equal(await harness.marina.clearFailedCommands(), 1);
  const cleared = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  assert.equal(cleared.commands.length, 0);
  assert.equal(cleared.diagnostics.failed, 0);
});

test("mobile rejects HTTP 200 WordPress errors instead of updating its local cache", async () => {
  let noteCalls = 0;
  const harness = await configuredBridge(async (url, options = {}) => {
    if (url.endsWith("/bookings/55/note") && options.method === "POST") {
      noteCalls += 1;
      return jsonResponse({ code: "rest_cookie_invalid_nonce", message: "Nonce expirat.", data: { status: 403 } });
    }
    throw new Error(`Unexpected synthetic request: ${url} ${options.method || "GET"}`);
  });

  await assert.rejects(
    harness.marina.setNote("server:55", { note: "Nu trebuie salvat local" }),
    (error) => error.code === "rest_cookie_invalid_nonce" && error.status === 403 && error.auth === true
  );
  assert.equal(noteCalls, 1);
  const restored = await harness.marina.bootstrap({ start: "2026-07-01", end: "2026-07-31" });
  assert.equal(restored.commands[0].status, "failed");
  assert.equal(restored.commands[0].errorCode, "rest_cookie_invalid_nonce");
});

test("mobile edits check the full room stay while excluding the edited booking", async () => {
  const requests = [];
  const booking = { booking_id: 66, resource_id: 4, approved: 0, dates: [{ date: "2026-07-16" }, { date: "2026-07-17" }], form_data: { name: { value: "Elena", type: "text" } } };
  const harness = await configuredBridge(async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/availability")) return jsonResponse({ available: true });
    if (url.endsWith("/bookings/66") && options.method === "PATCH") return jsonResponse({ ok: true });
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [booking] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  await harness.marina.editBooking("server:66", { resourceId: 4, dates: ["2026-07-16", "2026-07-17", "2026-07-18"], formData: booking.form_data, bookingFormType: "standard", note: "Cost total: 900 RON", sendEmail: true });
  const availability = requests.find((item) => item.url.endsWith("/availability"));
  const edit = requests.find((item) => item.url.endsWith("/bookings/66") && item.options.method === "PATCH");
  assert.deepEqual(JSON.parse(availability.options.body), {
    resource_id: 4,
    dates: ["2026-07-16 15:00:01", "2026-07-17 00:00:00", "2026-07-18 12:00:02"],
    exclude_booking_id: 66
  });
  assert.equal(JSON.parse(edit.options.body).send_email, true);
  assert.equal(JSON.parse(edit.options.body).note, "Cost total: 900 RON");
});

test("mobile never edits a reservation after an incomplete availability response", async () => {
  let patchCalls = 0;
  const booking = { booking_id: 67, resource_id: 4, dates: [{ date: "2026-07-16" }], form_data: { name: { value: "Elena", type: "text" } } };
  const harness = await configuredBridge(async (url, options = {}) => {
    if (url.endsWith("/availability")) return jsonResponse({ checked: true });
    if (url.endsWith("/bookings/67") && options.method === "PATCH") { patchCalls += 1; return jsonResponse({ ok: true }); }
    if (url.endsWith("/resources")) return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [booking] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  await assert.rejects(
    harness.marina.editBooking("server:67", { resourceId: 4, dates: ["2026-07-16", "2026-07-17"], formData: booking.form_data, bookingFormType: "standard" }),
    (error) => error.code === "invalid_availability_response"
  );
  assert.equal(patchCalls, 0);
});

test("mobile reads retry temporary API failures with bounded policy", async () => {
  let resourceAttempts = 0;
  const harness = await configuredBridge(async (url) => {
    if (url.endsWith("/resources")) {
      resourceAttempts += 1;
      if (resourceAttempts === 1) return jsonResponse({ code: "temporary" }, 503, { "Retry-After": "0" });
      return jsonResponse({ resources: [{ id: 4, title: "Camera 4", active: true }] });
    }
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  await harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  assert.equal(resourceAttempts, 2);
});

test("mobile ignores responses when the configured endpoint changes in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const harness = await configuredBridge(async (url) => {
    started += 1;
    await gate;
    if (url.endsWith("/resources")) return jsonResponse({ resources: [] });
    if (url.includes("/bookings?")) return jsonResponse({ bookings: [] });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  const refreshing = harness.marina.refresh({ start: "2026-07-01", end: "2026-07-31" });
  while (started < 2) await Promise.resolve();
  await harness.marina.saveSettings({ apiBaseUrl: "https://changed.example.test", username: "api-user", timezone: "Europe/Bucharest" });
  release();
  await assert.rejects(refreshing, (error) => error.code === "endpoint_changed");
});

test("mobile deduplicates periodic and manual refreshes for the same range", async () => {
  let resourceRequests = 0;
  let bookingRequests = 0;
  const harness = await configuredBridge(async (url) => {
    if (url.endsWith("/resources")) { resourceRequests += 1; return jsonResponse({ resources: [] }); }
    if (url.includes("/bookings?")) { bookingRequests += 1; return jsonResponse({ bookings: [] }); }
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  const range = { start: "2026-07-01", end: "2026-07-31" };
  await Promise.all([harness.marina.refresh(range), harness.marina.refresh(range)]);
  assert.equal(resourceRequests, 1);
  assert.equal(bookingRequests, 1);
});
