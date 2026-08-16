"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BookingDatabase } = require("../src/main/database");
const { BookingService } = require("../src/main/booking-service");
const { CommandQueue } = require("../src/main/command-queue");

function queueStub() {
  const queue = new EventEmitter();
  queue.start = () => {};
  queue.stop = () => {};
  queue.schedule = () => {};
  return queue;
}

test("room and camping caches can contain identical WordPress IDs without collisions", () => {
  const rooms = new BookingDatabase(":memory:");
  const camping = new BookingDatabase(":memory:", { checkIn: "14:00:01", checkOut: "12:00:02" });
  try {
    rooms.writeBooking({ localId: "server:1", serverId: 1, resourceId: 1, dates: ["2026-07-10", "2026-07-11"], formData: { name: { value: "Cameră", type: "text" } } });
    camping.writeBooking({ localId: "server:1", serverId: 1, resourceId: 1, dates: ["2026-08-10", "2026-08-11"], formData: { name: { value: "Cort", type: "text" } } });
    assert.equal(rooms.bookingRow("server:1").formData.name.value, "Cameră");
    assert.equal(camping.bookingRow("server:1").formData.name.value, "Cort");
  } finally {
    rooms.close();
    camping.close();
  }
});

test("camping commands use the site's 14:00 check-in time", () => {
  const database = new BookingDatabase(":memory:", { checkIn: "14:00:01", checkOut: "12:00:02" });
  try {
    const result = database.optimisticCreate({ resourceId: 2, dates: ["2026-07-20", "2026-07-21", "2026-07-22"], formData: { visitors: { value: "2", type: "selectbox-one" } }, bookingFormType: "rulota" });
    assert.deepEqual(database.getCommand(result.commandId).payload.dates, ["2026-07-20 14:00:01", "2026-07-21 00:00:00", "2026-07-22 12:00:02"]);
  } finally {
    database.close();
  }
});

test("camping service does not discard reservations on additional API resources", () => {
  const database = new BookingDatabase(":memory:");
  try {
    database.replaceResources([
      { id: 1, title: "Corturi", default_form: "standard" },
      { id: 2, title: "Rulote", default_form: "rulota" },
      { id: 3, title: "Parcare rulotă", default_form: "standard" }
    ]);
    database.writeBooking({ localId: "server:3", serverId: 3, resourceId: 3, dates: ["2026-07-10"], formData: { car_plates: { value: "B-01-ABC", type: "text" } } });
    const service = new BookingService({ database, api: {}, queue: queueStub(), vault: { hasPassword: () => false } });
    const result = service.state({ start: "2026-07-01", end: "2026-07-31" });
    assert.deepEqual(result.resources.map((resource) => resource.id), [1, 2, 3]);
    assert.deepEqual(result.bookings.map((booking) => booking.serverId), [3]);
  } finally {
    database.close();
  }
});

test("renderer and preload expose separate Camere and Camping workspaces", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "electron-main.js"), "utf8");
  assert.match(indexSource, /data-workspace="rooms"[^>]*>Camere</);
  assert.match(indexSource, /data-workspace="camping"[^>]*>Camping</);
  assert.match(preloadSource, /let currentSource = "rooms"/);
  assert.match(preloadSource, /invoke\("state:bootstrap", currentSource, range\)/);
  assert.match(mainSource, /"marina-booking-camping\.sqlite"/);
  assert.doesNotMatch(mainSource, /resourceIds: \[1, 2\]/);
});

test("desktop emergency queue controls pause both WordPress workspaces", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "electron-main.js"), "utf8");
  assert.match(mainSource, /for \(const queueSource of \["rooms", "camping"\]\) contextFor\(queueSource\)\.service\.pauseQueue\(\)/);
  assert.match(mainSource, /for \(const queueSource of \["rooms", "camping"\]\) contextFor\(queueSource\)\.service\.resumeQueue\(\)/);
});

test("payment snapshots require read access while deposit updates remain write-protected", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const mobileSource = fs.readFileSync(path.join(__dirname, "..", "mobile", "mobile-bridge.js"), "utf8");
  assert.match(mainSource, /ipcMain\.handle\("booking:payment", \(_event, source, localId\) => \{ assertReadableSource\(source\)/);
  assert.match(mainSource, /ipcMain\.handle\("booking:deposit", \(_event, source, localId, input\) => \{ assertWritableSource\(source\)/);
  assert.match(mobileSource, /async getPayment\(id, input = \{\}\)[\s\S]*?assertReadableSource\(source\)[\s\S]*?if \(source === "marina"\)/);
  assert.match(mobileSource, /async updateDeposit\(id, input\)[\s\S]*?assertWritableSource\(source\)[\s\S]*?if \(source === "marina"\)/);
});

test("camping timeline keeps one category row for corturi and one for rulote", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(appSource, /function timelineResources\(\)/);
  assert.match(appSource, /function campingParentResources\(\)/);
  assert.match(appSource, /tent \? \{ \.\.\.tent, title: "Corturi" \}/);
  assert.match(appSource, /caravan \? \{ \.\.\.caravan, title: "Rulote" \}/);
  assert.match(appSource, /timelineResourceId: isCaravanResource\(booking\.resourceId\) \? caravan\.id : tent\.id/);
  assert.match(appSource, /if \(currentId === caravanParentId\) return true/);
  assert.match(appSource, /if \(currentId === tentParentId\) return false/);
  assert.doesNotMatch(appSource, /if \(plate \|\| \["1", "true", "yes", "on"\]\.includes\(electricity\)\) return true/);
  assert.match(appSource, /TimelineAdapter\.mapState\(timelineResources\(\), timelineBookings\(\)/);
  assert.match(appSource, /const layout = assignLanes\(visibleItems\)/);
  assert.doesNotMatch(appSource, /assignSingleLane/);
  assert.match(appSource, /timelineShell\.classList\.toggle\("is-camping-workspace", camping\)/);
  assert.match(appSource, /activeWorkspace === "camping" \? timelineResources\(\) : state\.resources/);
});

test("late workspace and refresh responses cannot overwrite the active source", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(appSource, /let workspaceSwitchId = 0/);
  assert.match(appSource, /const switchId = \+\+workspaceSwitchId/);
  assert.match(appSource, /switchId !== workspaceSwitchId \|\| activeWorkspace !== source/);
  assert.match(appSource, /const requestWorkspace = activeWorkspace/);
  assert.match(appSource, /activeWorkspace !== requestWorkspace \|\| !rangeMatchesWindow\(range\)/);
  assert.match(appSource, /source !== activeWorkspace \|\| selectedBookingId !== booking\.localId/);
  assert.match(appSource, /waitForCreatedBooking\(created, input, source\)/);
  assert.match(appSource, /window\.marina\.getSettings\(source\)/);
  assert.match(appSource, /const payload = \{ apiBaseUrl:[^\n]+source \}/);
});

test("camping creation includes vehicle plate and caravan electricity fields", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(indexSource, /input name="vehiclePlate"/);
  assert.match(indexSource, /input name="electricity" type="checkbox"/);
  assert.match(appSource, /fields\.car_plates = \{ value: form\.elements\.vehiclePlate\.value, type: "text" \}/);
  assert.match(appSource, /fields\.Energie_electrica = \{ value: "true", type: "checkbox" \}/);
});

test("camping calendar delegates parent capacity allocation and never offers an extra bed", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(appSource, /function createOccupancy\(form = calendarForm\(\)\) \{\s*if \(activeWorkspace === "camping"\) return \{\}/);
  assert.match(appSource, /Campingul are capacitate multiplă; alocarea finală este verificată de WordPress/);
  assert.match(appSource, /window\.marina\.checkAvailability\(\{ resourceId, dates:[^\n]+excludeBookingId, source \}/);
  assert.match(appSource, /else if \(form\.elements\.extraBed\.checked\) fields\["pat-suplimentar"\]/);
  assert.match(appSource, /\$\("#createExtraBed"\)\.hidden = camping/);
});

test("camping queue delegates parent-resource capacity to WordPress creation", async () => {
  const database = new BookingDatabase(":memory:", { checkIn: "14:00:01", checkOut: "12:00:02" });
  try {
    const created = database.optimisticCreate({ resourceId: 1, dates: ["2026-08-01", "2026-08-02"], formData: { visitors: { value: "2", type: "selectbox-one" } }, bookingFormType: "standard" });
    let availabilityCalls = 0;
    let createCalls = 0;
    const api = {
      availability: async () => { availabilityCalls += 1; return { available: false }; },
      create: async () => { createCalls += 1; return { payload: { booking_id: 91 } }; }
    };
    const queue = new CommandQueue({ database, api, skipAvailabilityChecks: true });
    await queue.execute(database.getCommand(created.commandId));
    assert.equal(availabilityCalls, 0);
    assert.equal(createCalls, 1);
    assert.equal(database.getCommand(created.commandId).status, "synced");
  } finally {
    database.close();
  }
});
