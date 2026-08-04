"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildRange, buildMonth, fromDate, monthSegments } = require("../src/shared/availability-timeline");

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

test("month helper retains leap-year and month-length behavior", () => {
  assert.equal(buildMonth(resources, [], "2026-02-01").dates.length, 28);
  assert.equal(buildMonth(resources, [], "2026-03-01").dates.length, 31);
  assert.equal(buildMonth(resources, [], "2028-02-01").dates.length, 29);
});

test("continuous range crosses month and year boundaries without splitting occupancy", () => {
  const crossYearBookings = [{
    resourceId: 1,
    status: "approved",
    dates: ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]
  }];
  const view = buildRange(resources, crossYearBookings, "2026-12-20", "2027-02-10");
  assert.equal(view.start, "2026-12-20");
  assert.equal(view.end, "2027-02-10");
  assert.equal(view.dates.length, 53);
  assert.deepEqual(monthSegments(view.dates), [
    { key: "2026-12", start: "2026-12-20", end: "2026-12-31", offset: 0, length: 12 },
    { key: "2027-01", start: "2027-01-01", end: "2027-01-31", offset: 12, length: 31 },
    { key: "2027-02", start: "2027-02-01", end: "2027-02-10", offset: 43, length: 10 }
  ]);
  const byDate = Object.fromEntries(view.rows[0].cells.map((cell) => [cell.date, cell]));
  assert.equal(byDate["2026-12-31"].pm, "booked");
  assert.equal(byDate["2027-01-01"].am, "booked");
  assert.equal(byDate["2027-01-01"].pm, "booked");
});

test("range builder rejects reversed ranges", () => {
  assert.throws(() => buildRange(resources, [], "2027-01-02", "2027-01-01"), /nu poate fi înaintea/);
});

test("availability can exclude every date before today without changing the full month", () => {
  const fullView = buildMonth(resources, bookings, "2026-08-01");
  const futureView = fromDate(fullView, "2026-08-12");
  assert.equal(fullView.dates.length, 31);
  assert.equal(futureView.dates[0].date, "2026-08-12");
  assert.equal(futureView.dates.length, 20);
  assert.ok(futureView.rows.every((row) => row.cells.length === 20 && row.cells[0].date === "2026-08-12"));
});

test("availability page is one bounded, lazy, horizontally scrolling timeline", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const mobileBuild = fs.readFileSync(path.join(root, "scripts", "build-mobile-web.js"), "utf8");
  assert.match(html, /id="openAvailability"/);
  assert.match(html, /id="availabilityPage"[^>]*hidden/);
  assert.match(html, /id="closeAvailability"/);
  assert.match(html, /class="availability-legend"[\s\S]*id="closeAvailability"/);
  assert.doesNotMatch(css, /#closeAvailability\{[^}]*margin-right:auto/);
  assert.doesNotMatch(html, /id="availabilityPrev"|id="availabilityNext"|id="availabilityMonthLabel"/);
  assert.match(app, /const AVAILABILITY_WINDOW_DAYS = 84/);
  assert.match(app, /const AVAILABILITY_WINDOW_SHIFT_DAYS = 35/);
  assert.match(app, /AvailabilityTimeline\.buildRange\(state\.resources, state\.bookings, availabilityWindowStart, availabilityWindowEnd\)/);
  assert.match(app, /AvailabilityTimeline\.monthSegments\(view\.dates\)/);
  assert.match(app, /class="availability-month availability-month-days-\$\{segment\.length\}"/);
  assert.match(app, /class="availability-months" role="row"/);
  assert.doesNotMatch(app.slice(app.indexOf("function availabilityMonthHeader"), app.indexOf("function renderAvailabilityTimeline")), /style="/);
  assert.match(app, /requested < earliest \? earliest : requested/);
  assert.match(app, /availabilityGrid\.addEventListener\("scroll", handleAvailabilityScroll, \{ passive: true \}\)/);
  assert.match(app, /if \(availabilityGrid\.scrollLeft >= maxScroll - edge\) shiftAvailabilityWindow\(AVAILABILITY_WINDOW_SHIFT_DAYS\)/);
  assert.match(app, /utcDate\(availabilityWindowStart\) > utcDate\(todayIso\(\)\)/);
  assert.doesNotMatch(app, /setAvailabilityMonth|availabilitySwipeState/);
  assert.match(app, /const weekdayInitials = \["D", "L", "M", "M", "J", "V", "S"\]/);
  assert.match(app, /class="availability-date-number\$\{date\.day === 1 \? " is-month-start" : ""\}"/);
  assert.match(app, /weekdayInitials\[view\.dates\[index\]\.weekday\]/);
  assert.match(html, /id="cameraContent"[\s\S]*id="availabilityPage"/);
  assert.match(app, /timelineShell\.hidden = availabilityViewActive/);
  assert.match(app, /availabilityPage\.hidden = !availabilityViewActive/);
  assert.match(css, /\.availability-grid\{[^}]*--availability-days:84[^}]*overflow:auto[^}]*touch-action:pan-x pan-y/);
  assert.match(css, /\.availability-room\{position:sticky;left:0/);
  assert.match(css, /\.availability-months\{[^}]*grid-column:2\/-1[^}]*grid-template-columns:repeat\(var\(--availability-days\),var\(--availability-day-width\)\)/);
  assert.match(css, /\.availability-month\{[^}]*box-shadow:inset 2px 0 #437581/);
  assert.match(css, /\.availability-month-days-31\{grid-column:span 31\}/);
  assert.match(css, /@media\(max-width:900px\)\{[\s\S]*\.availability-header\{display:grid;grid-template-columns:minmax\(0,1fr\);padding-inline:0\}[\s\S]*\.availability-actions\{width:100%;justify-content:flex-end\}/);
  assert.match(css, /\.is-mobile-app \.availability-cell\[data-am="available"\]\[data-pm="occupied"\]::before\{clip-path:polygon\(100% 0,100% 100%,0 100%\)\}/);
  assert.match(css, /\.is-mobile-app \.availability-cell\[data-am="occupied"\]\[data-pm="available"\]::before\{clip-path:polygon\(0 0,100% 0,0 100%\)\}/);
  assert.match(mobileBuild, /availability-timeline\.js/);
  assert.doesNotMatch(app, /availabilityGrid\.addEventListener\("(?:pointerdown|dblclick)"/);
});

test("synthetic preview enforces the production CSP and uses no inline month positioning", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "test", "fixtures", "availability-timeline-preview.html"), "utf8");
  const preview = fs.readFileSync(path.join(root, "test", "fixtures", "availability-timeline-preview.js"), "utf8");
  assert.match(html, /Content-Security-Policy/);
  assert.match(preview, /class="availability-months"/);
  assert.match(preview, /availability-month-days-\$\{segment\.length\}/);
  assert.doesNotMatch(preview, /style="grid-column/);
  assert.match(preview, /Array\.from\(\{ length: 36 \}/);
});

test("availability rerenders and refreshes preserve the horizontal anchor", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const renderSource = app.slice(app.indexOf("function renderAvailabilityTimeline"), app.indexOf("function setAvailabilityView"));
  assert.match(renderSource, /const previousLeft = desiredLeft \?\? availabilityGrid\.scrollLeft \?\? availabilityScrollLeft/);
  assert.match(renderSource, /availabilityGrid\.scrollLeft = Math\.max\(0, previousLeft\)/);
  assert.match(app, /const nextLeft = Math\.max\(0, oldLeft - actualDelta \* availabilityDayWidth\(\)\)/);
  assert.match(app, /renderAvailabilityTimeline\(\{ desiredLeft: nextLeft \}\)/);
  assert.match(app, /renderAvailabilityTimeline\(\);[\s\S]*renderCommands\(\)/);
});
