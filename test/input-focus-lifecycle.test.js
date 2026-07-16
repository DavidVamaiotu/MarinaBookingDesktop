"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function functionSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const headerEnd = appSource.indexOf("\n", start);
  const bodyStart = appSource.lastIndexOf("{", headerEnd);
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    else if (appSource[index] === "}" && --depth === 0) return appSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source range ${startMarker}`);
  return appSource.slice(start, end);
}

function dragHarness() {
  return vm.runInNewContext(`(() => {
    let dragState = null;
    let renderCount = 0;
    const renderTimeline = () => { renderCount += 1; };
    ${functionSource("releaseDragState")}
    ${functionSource("cancelDrag")}
    ${functionSource("moveDrag")}
    return {
      start(value) { dragState = value; },
      moveDrag,
      cancelDrag,
      state() { return dragState; },
      renderCount() { return renderCount; }
    };
  })()`);
}

function fakeDrag() {
  const removed = [];
  const booking = { dates: ["changed"], startDate: "changed", endDate: "changed", syncState: "queued" };
  const bar = {
    captured: true,
    released: [],
    hasPointerCapture(pointerId) { return this.captured && pointerId === 7; },
    releasePointerCapture(pointerId) { this.released.push(pointerId); this.captured = false; },
    classList: { remove(name) { removed.push(name); } },
    closest() { return { classList: { remove(name) { removed.push(name); } } }; }
  };
  return {
    drag: {
      pointerId: 7,
      bar,
      booking,
      originalDates: ["2026-07-16", "2026-07-17"],
      originalSyncState: "synced"
    },
    bar,
    booking,
    removed
  };
}

test("cancelling a timeline drag releases pointer capture and restores the booking", () => {
  const harness = dragHarness();
  const fixture = fakeDrag();
  harness.start(fixture.drag);

  harness.cancelDrag();

  assert.equal(harness.state(), null);
  assert.deepEqual([...fixture.bar.released], [7]);
  assert.deepEqual([...fixture.booking.dates], ["2026-07-16", "2026-07-17"]);
  assert.equal(fixture.booking.syncState, "synced");
  assert.deepEqual([...fixture.removed], ["is-dragging", "is-drop-target"]);
  assert.equal(harness.renderCount(), 1);
});

test("a missed pointerup self-cancels before the next pointer move can retain capture", () => {
  const harness = dragHarness();
  const fixture = fakeDrag();
  harness.start(fixture.drag);

  harness.moveDrag({ pointerId: 7, buttons: 0 });

  assert.equal(harness.state(), null);
  assert.deepEqual([...fixture.bar.released], [7]);
  assert.equal(harness.renderCount(), 1);
});

test("capture loss and Electron window lifecycle events terminate timeline drag", () => {
  assert.match(appSource, /guestTimeline\.addEventListener\("lostpointercapture", cancelDrag\)/);
  assert.match(appSource, /document\.addEventListener\("pointercancel", cancelDrag\)/);
  assert.match(appSource, /document\.addEventListener\("visibilitychange", \(\) => \{ if \(document\.hidden\) cancelDrag\(\); \}\)/);
  assert.match(appSource, /window\.addEventListener\("pagehide", cancelDrag\)/);
  assert.match(appSource, /window\.addEventListener\("blur", cancelDrag\)/);
});

test("view and editor transitions cancel an active timeline capture before showing fields", () => {
  for (const name of ["switchWorkspace", "setAvailabilityView", "openCreate", "openDuplicate", "populateDetails", "populatePaymentDialog"]) {
    const source = functionSource(name);
    const cancelAt = source.indexOf("cancelDrag();");
    const transitionAt = Math.min(...["showModal()", "hidden =", "activeWorkspace =", "availabilityViewActive ="]
      .map((marker) => source.indexOf(marker))
      .filter((index) => index >= 0));
    assert.ok(cancelAt >= 0 && cancelAt < transitionAt, `${name} must cancel an active drag before changing the view`);
  }
  const settingsOpen = sourceBetween('$("#openSettings").addEventListener("click"', '$("#closeSettingsDialog")');
  assert.match(settingsOpen, /cancelDrag\(\)/);
});
