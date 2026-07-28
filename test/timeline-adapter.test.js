"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assignLanes, barSignature, mapState, toItem } = require("../src/shared/timeline-adapter");

test("timeline adapter maps resources to lanes and bookings to bars", () => {
  const resources = [{ id: 4, title: "Room 4", capacity: 2 }, { id: 5, title: "Room 5" }];
  const bookings = [{ localId: "server:10", serverId: 10, resourceId: 4, dates: ["2026-07-20", "2026-07-21"], startDate: "2026-07-20", endDate: "2026-07-21", formData: { name: { value: "John" } }, status: "approved", syncState: "queued", trashed: false }];
  const lanes = mapState(resources, bookings);
  assert.equal(lanes.length, 2);
  assert.equal(lanes[0].subtitle, "");
  assert.equal(lanes[1].subtitle, "");
  assert.equal(lanes[0].items.length, 1);
  assert.equal(lanes[1].items.length, 0);
  assert.equal(toItem(bookings[0]).key, "server:10");
  assert.equal(lanes[0].items[0].title, "John");
  assert.equal(lanes[0].items[0].syncState, "queued");
});

test("timeline reservation labels show only the WordPress last name", () => {
  const item = toItem({ localId: "server:11", serverId: 11, resourceId: 4, dates: ["2026-07-20"], startDate: "2026-07-20", endDate: "2026-07-20", formData: { name: { value: "Ana" }, secondname: { value: "Popescu" } }, status: "pending", syncState: "synced" });
  assert.equal(item.title, "Popescu");
});

test("timeline display rows can differ from the original API resource", () => {
  const booking = { localId: "server:12", serverId: 12, resourceId: 27, timelineResourceId: 2, dates: ["2026-07-20"], formData: {}, status: "pending" };
  const item = toItem(booking);
  assert.equal(item.resourceId, 2);
  assert.equal(item.booking.resourceId, 27);
});

test("trashed reservations stay hidden unless the timeline explicitly includes them", () => {
  const resources = [{ id: 4, title: "Room 4" }];
  const bookings = [
    { localId: "server:1", serverId: 1, resourceId: 4, dates: ["2026-07-20"], formData: {}, status: "approved", trashed: false },
    { localId: "server:2", serverId: 2, resourceId: 4, dates: ["2026-07-21"], formData: {}, status: "pending", trashed: true }
  ];
  assert.deepEqual(mapState(resources, bookings)[0].items.map((item) => item.key), ["server:1"]);
  assert.deepEqual(mapState(resources, bookings, { includeTrashed: true })[0].items.map((item) => item.key), ["server:1", "server:2"]);
});

test("reservations sharing an end and start date form one handoff lane", () => {
  const layout = assignLanes([
    { key: "first", start: "2026-07-01", end: "2026-07-05" },
    { key: "second", start: "2026-07-05", end: "2026-07-09" },
    { key: "overlap", start: "2026-07-04", end: "2026-07-06" }
  ]);
  const first = layout.items.find(({ item }) => item.key === "first");
  const second = layout.items.find(({ item }) => item.key === "second");
  const overlap = layout.items.find(({ item }) => item.key === "overlap");
  assert.equal(first.lane, 1);
  assert.equal(second.lane, 1);
  assert.equal(second.predecessorKey, "first");
  assert.equal(overlap.lane, 2);
});

test("booking bar signatures change when the timeline window moves", () => {
  const item = { key: "server:1", start: "2026-07-10", end: "2026-07-14", title: "Guest", subtitle: "", status: "approved", syncState: "synced" };
  const julyWindow = barSignature(item, 1, "", "2026-03-01", 275);
  const februaryWindow = barSignature(item, 1, "", "2025-10-01", 273);
  assert.notEqual(julyWindow, februaryWindow);
});
