"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const CameraTransform = require("../src/shared/camera-transform");

const dimensions = {
  contentWidth: 400,
  contentHeight: 700,
  viewportWidth: 400,
  viewportHeight: 700
};

function projectedContentPoint(state, contentPoint) {
  return {
    x: state.offsetX + contentPoint.x * state.scale,
    y: state.offsetY + contentPoint.y * state.scale
  };
}

test("camera zoom preserves the focal content point at the center and corners", () => {
  for (const focal of [{ x: 200, y: 350 }, { x: 20, y: 20 }, { x: 380, y: 20 }, { x: 20, y: 680 }, { x: 380, y: 680 }]) {
    const contentPoint = CameraTransform.viewportToContent({ ...focal, scale: 1, offsetX: 0, offsetY: 0 });
    const state = CameraTransform.zoomAt({ oldScale: 1, newScale: 1.8, offsetX: 0, offsetY: 0, focalX: focal.x, focalY: focal.y, ...dimensions });
    const projected = projectedContentPoint(state, contentPoint);
    assert.ok(Math.abs(projected.x - focal.x) < 0.0001);
    assert.ok(Math.abs(projected.y - focal.y) < 0.0001);
  }
});

test("camera pan is clamped so the content always covers a zoomed viewport", () => {
  assert.deepEqual(
    CameraTransform.clampState({ scale: 2, offsetX: 500, offsetY: 500, ...dimensions }),
    { scale: 2, offsetX: 0, offsetY: 0 }
  );
  assert.deepEqual(
    CameraTransform.clampState({ scale: 2, offsetX: -1000, offsetY: -2000, ...dimensions }),
    { scale: 2, offsetX: -400, offsetY: -700 }
  );
});

test("scale one always resets camera translation without changing dimensions", () => {
  assert.deepEqual(
    CameraTransform.clampState({ scale: 1, offsetX: -123, offsetY: -456, ...dimensions }),
    { scale: 1, offsetX: 0, offsetY: 0 }
  );
});

test("resizing reclamps offsets without recreating the camera state", () => {
  const resized = CameraTransform.clampState({
    scale: 1.8,
    offsetX: -250,
    offsetY: -400,
    contentWidth: 320,
    contentHeight: 500,
    viewportWidth: 500,
    viewportHeight: 320
  });
  assert.deepEqual(resized, { scale: 1.8, offsetX: -76, offsetY: -400 });
});
