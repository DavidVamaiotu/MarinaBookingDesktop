"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("timeline bars no longer capture pointer events for drag-resizing", () => {
  assert.doesNotMatch(appSource, /setPointerCapture|releasePointerCapture|lostpointercapture/);
  assert.doesNotMatch(appSource, /\b(?:beginDrag|moveDrag|endDrag|cancelDrag|releaseDragState|dragState)\b/);
  assert.doesNotMatch(appSource, /guestTimeline\.addEventListener\("pointerdown"/);
});
