(function cameraTransformModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CameraTransform = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createCameraTransform() {
  "use strict";

  const EPSILON = 0.0001;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function viewportToContent({ x, y, scale, offsetX, offsetY }) {
    return {
      x: (x - offsetX) / scale,
      y: (y - offsetY) / scale
    };
  }

  function clampAxis(offset, scale, contentSize, viewportSize) {
    const scaledSize = contentSize * scale;
    if (scaledSize <= viewportSize) return (viewportSize - scaledSize) / 2;
    return clamp(offset, viewportSize - scaledSize, 0);
  }

  function clampState({ scale, offsetX, offsetY, contentWidth, contentHeight, viewportWidth, viewportHeight }) {
    if (Math.abs(scale - 1) < EPSILON) return { scale: 1, offsetX: 0, offsetY: 0 };
    return {
      scale,
      offsetX: clampAxis(offsetX, scale, contentWidth, viewportWidth),
      offsetY: clampAxis(offsetY, scale, contentHeight, viewportHeight)
    };
  }

  function placeContentAtFocal({
    contentX,
    contentY,
    focalX,
    focalY,
    scale,
    contentWidth,
    contentHeight,
    viewportWidth,
    viewportHeight
  }) {
    return clampState({
      scale,
      offsetX: focalX - contentX * scale,
      offsetY: focalY - contentY * scale,
      contentWidth,
      contentHeight,
      viewportWidth,
      viewportHeight
    });
  }

  function zoomAt({
    oldScale,
    newScale,
    offsetX,
    offsetY,
    focalX,
    focalY,
    contentWidth,
    contentHeight,
    viewportWidth,
    viewportHeight
  }) {
    const contentPoint = viewportToContent({ x: focalX, y: focalY, scale: oldScale, offsetX, offsetY });
    return placeContentAtFocal({
      contentX: contentPoint.x,
      contentY: contentPoint.y,
      focalX,
      focalY,
      scale: newScale,
      contentWidth,
      contentHeight,
      viewportWidth,
      viewportHeight
    });
  }

  return { clamp, clampState, placeContentAtFocal, viewportToContent, zoomAt };
});
