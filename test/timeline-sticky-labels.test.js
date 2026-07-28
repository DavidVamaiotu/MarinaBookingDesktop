"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const TimelineStickyLabels = require("../src/shared/timeline-sticky-labels");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const mobileBuildSource = fs.readFileSync(path.join(root, "scripts", "build-mobile-web.js"), "utf8");

test("long reservation labels stay natural until their starting position leaves view", () => {
  assert.equal(TimelineStickyLabels.boundedShift({
    visibleLeft: 180,
    barRight: 700,
    labelLeft: 220,
    labelRight: 320,
    scale: 1
  }), 0);
});

test("long reservation labels pin to the visible left edge and stop at their reservation end", () => {
  assert.equal(TimelineStickyLabels.boundedShift({
    visibleLeft: 300,
    barRight: 700,
    labelLeft: 220,
    labelRight: 320,
    scale: 1
  }), 80);
  assert.equal(TimelineStickyLabels.boundedShift({
    visibleLeft: 680,
    barRight: 700,
    labelLeft: 220,
    labelRight: 320,
    scale: 1
  }), 380);
});

test("sticky label shifts reverse smoothly and remain correct inside camera zoom", () => {
  const shifts = [420, 360, 300, 240].map((visibleLeft) => TimelineStickyLabels.boundedShift({
    visibleLeft,
    barRight: 700,
    labelLeft: 220,
    labelRight: 320,
    scale: 1
  }));
  assert.deepEqual(shifts, [200, 140, 80, 20]);
  assert.equal(TimelineStickyLabels.boundedShift({
    visibleLeft: 600,
    barRight: 1200,
    labelLeft: 400,
    labelRight: 600,
    scale: 2
  }), 100);
});

test("labels do not pin after their reservation has left the visible area", () => {
  assert.equal(TimelineStickyLabels.boundedShift({
    visibleLeft: 720,
    barRight: 700,
    labelLeft: 600,
    labelRight: 680,
    scale: 1
  }), 0);
});

test("the DOM updater pins only long labels and keeps their visible text inside the bar", () => {
  const values = new Map();
  const style = { setProperty: (name, value) => values.set(name, value) };
  const unit = { getBoundingClientRect: () => ({ right: 180 }) };
  const row = { querySelector: () => unit };
  const guest = { getBoundingClientRect: () => ({ left: 120, right: 260 }) };
  const bar = {
    classList: { contains: () => false },
    closest: () => row,
    getBoundingClientRect: () => ({ right: 500 })
  };
  const label = {
    style,
    closest: () => bar,
    querySelector: () => guest
  };
  TimelineStickyLabels.update({
    viewport: { getBoundingClientRect: () => ({ left: 0 }) },
    rows: { querySelectorAll: () => [label] },
    scale: 1,
    gap: 8
  });
  assert.equal(values.get("--timeline-sticky-label-shift"), "68px");
  assert.equal(260 + 68 <= 500, true);
});

test("the renderer wires bounded sticky names without changing reservation geometry", () => {
  assert.match(indexSource, /<script src="src\/shared\/timeline-sticky-labels\.js"><\/script>\s*<script src="app\.js"><\/script>/);
  assert.match(mobileBuildSource, /"timeline-sticky-labels\.js"/);
  assert.match(stylesSource, /\.timeline-bar-label\{position:sticky;left:calc\(var\(--timeline-unit-width\) \+ 8px\)/);
  assert.match(stylesSource, /\.timeline-shell\.has-camera-scale \.timeline-bar-label\{position:relative;left:auto;transform:translateX\(var\(--timeline-sticky-label-shift,0px\)\)/);
  assert.match(stylesSource, /\.timeline-bar\.is-tight \.timeline-bar-label,\.timeline-bar\.is-compact \.timeline-bar-label\{position:static;width:100%;max-width:100%;transform:none\}/);
  assert.match(appSource, /function updateStickyReservationLabels\(\)[\s\S]*cameraScale > 1\.001[\s\S]*TimelineStickyLabels\.reset\(guestTimeline\)[\s\S]*TimelineStickyLabels\.update\(\{[\s\S]*viewport: cameraViewport,[\s\S]*rows: guestTimeline,[\s\S]*scale: cameraScale/);
  assert.match(appSource, /function updateLabelShifts\(row\)[\s\S]*--timeline-sticky-label-shift", "0px"/);
  assert.match(appSource, /function renderCameraState\(\)[\s\S]*updateStickyReservationLabels\(\)/);
  assert.match(appSource, /function renderVisibleRows\(force = false\)[\s\S]*updateStickyReservationLabels\(\)/);
  assert.match(appSource, /function handleTimelineScroll\(\)[\s\S]*if \(cameraScale > 1\.001\) updateStickyReservationLabels\(\)/);
});
