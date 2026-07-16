"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildMonth, fromDate } = require("../src/shared/availability-timeline");

const resources = [
  { id: 1, title: "Camera 1" },
  { id: 2, title: "Camera liberă" }
];
const bookings = [
  { resourceId: 1, status: "approved", dates: ["2026-07-31", "2026-08-01", "2026-08-02"] },
  { resourceId: 1, status: "pending", dates: ["2026-08-02", "2026-08-03"] },
  { resourceId: 1, status: "approved", trashed: true, dates: ["2026-08-05", "2026-08-06"] }
];

test("availability month contains exactly one calendar month and every room", () => {
  const view = buildMonth(resources, bookings, "2026-08-19");
  assert.equal(view.start, "2026-08-01");
  assert.equal(view.end, "2026-08-31");
  assert.equal(view.dates.length, 31);
  assert.deepEqual(view.rows.map((row) => row.title), ["Camera 1", "Camera liberă"]);
  assert.ok(view.rows[1].cells.every((cell) => cell.am === "available" && cell.pm === "available"));
});

test("occupancy preserves month boundaries, handoffs, overlaps, and trashed exclusions", () => {
  const row = buildMonth(resources, bookings, "2026-08-01").rows[0];
  const byDate = Object.fromEntries(row.cells.map((cell) => [cell.date, cell]));
  assert.deepEqual(byDate["2026-08-01"], { date: "2026-08-01", am: "booked", pm: "booked" });
  assert.deepEqual(byDate["2026-08-02"], { date: "2026-08-02", am: "booked", pm: "pending" });
  assert.deepEqual(byDate["2026-08-03"], { date: "2026-08-03", am: "pending", pm: "available" });
  assert.deepEqual(byDate["2026-08-05"], { date: "2026-08-05", am: "available", pm: "available" });
});

test("month replacement changes day count instead of appending dates", () => {
  assert.equal(buildMonth(resources, [], "2026-02-01").dates.length, 28);
  assert.equal(buildMonth(resources, [], "2026-03-01").dates.length, 31);
  assert.equal(buildMonth(resources, [], "2028-02-01").dates.length, 29);
});

test("availability can exclude every date before today without changing the full month", () => {
  const fullView = buildMonth(resources, bookings, "2026-08-01");
  const futureView = fromDate(fullView, "2026-08-12");
  assert.equal(fullView.dates.length, 31);
  assert.equal(futureView.dates[0].date, "2026-08-12");
  assert.equal(futureView.dates.length, 20);
  assert.ok(futureView.rows.every((row) => row.cells.length === 20 && row.cells[0].date === "2026-08-12"));
});

test("availability page stays separate from the reservation timeline controls and interactions", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const mobileBuild = fs.readFileSync(path.join(root, "scripts", "build-mobile-web.js"), "utf8");
  assert.match(html, /id="openAvailability"/);
  assert.match(html, /id="availabilityPage"[^>]*hidden/);
  assert.match(html, /id="availabilityPrev"/);
  assert.match(html, /id="availabilityNext"/);
  assert.match(html, /id="closeAvailability"/);
  assert.match(app, /AvailabilityTimeline\.buildMonth\(state\.resources, state\.bookings, availabilityMonth\)/);
  assert.match(app, /const view = AvailabilityTimeline\.fromDate\(fullView, todayIso\(\)\)/);
  assert.match(app, /availabilityMonth = requestedMonth < currentMonth \? currentMonth : requestedMonth/);
  assert.match(app, /const weekdayInitials = \["D", "L", "M", "M", "J", "V", "S"\]/);
  assert.match(app, /class="availability-date-number"[^>]*>\$\{date\.day\}/);
  assert.match(app, /weekdayInitials\[view\.dates\[index\]\.weekday\]/);
  assert.match(html, /id="cameraContent"[\s\S]*id="availabilityPage"/);
  assert.match(app, /timelineShell\.hidden = availabilityViewActive/);
  assert.match(app, /availabilityPage\.hidden = !availabilityViewActive/);
  assert.match(css, /\.availability-grid\{[^}]*overflow-x:hidden/);
  assert.match(css, /\.is-mobile-app \.availability-cell\[data-am="available"\]\[data-pm="occupied"\]::before\{clip-path:polygon\(100% 0,100% 100%,0 100%\)\}/);
  assert.match(css, /\.is-mobile-app \.availability-cell\[data-am="occupied"\]\[data-pm="available"\]::before\{clip-path:polygon\(0 0,100% 0,0 100%\)\}/);
  assert.match(mobileBuild, /availability-timeline\.js/);
  assert.doesNotMatch(app, /availabilityGrid\.addEventListener\("(?:pointerdown|dblclick)"/);
});
