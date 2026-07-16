"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const mobileBridgeSource = fs.readFileSync(path.join(__dirname, "..", "mobile", "mobile-bridge.js"), "utf8");

test("Android Back closes an open booking menu before exiting the app", () => {
  assert.match(mobileBridgeSource, /App\.addListener\("backButton"/);
  assert.match(mobileBridgeSource, /new Event\("marina:back", \{ cancelable: true \}\)/);
  assert.match(mobileBridgeSource, /if \(!window\.dispatchEvent\(event\)\) return;/);
  assert.match(appSource, /function dismissTopLayer\(\)/);
  assert.match(appSource, /if \(!bookingMenu\.hidden\) \{ dismissBookingMenu\(\); return true; \}/);
  assert.match(appSource, /window\.addEventListener\("marina:back", \(event\) => \{\s*if \(!dismissTopLayer\(\)\) return;\s*event\.preventDefault\(\);/);
});

test("touch input cannot start a reservation resize", () => {
  assert.match(appSource, /function beginDrag\(event\) \{\s*if \(event\.pointerType === "touch"\) return;/);
  assert.match(stylesSource, /\.timeline-handle\{cursor:ew-resize;touch-action:pan-x pan-y\}/);
});

test("cancelled pointers restore the original booking instead of syncing a resize", () => {
  assert.match(appSource, /document\.addEventListener\("pointercancel", cancelDrag\)/);
  assert.match(appSource, /cancelled\.booking\.dates = cancelled\.originalDates/);
  assert.doesNotMatch(appSource, /document\.addEventListener\("pointercancel", endDrag\)/);
});

test("horizontal pinch keeps the original timeline zoom inside the isolated camera", () => {
  assert.match(indexSource, /<div class="timeline-camera-viewport" id="cameraViewport">\s*<div class="timeline-camera-content" id="cameraContent">\s*<div class="timeline-shell" id="timelineShell"[^>]*>\s*<div class="timeline-scale" id="timelineScale"><\/div>\s*<div class="guest-timeline" id="guestTimeline"><\/div>/);
  assert.match(stylesSource, /\.timeline-scale \.timeline-corner,\.timeline-unit\{position:sticky;left:0;/);
  assert.doesNotMatch(indexSource, /timeline-header-pane|timeline-row-pane/);
  assert.match(appSource, /function setTimelineZoom\(nextWidth, clientX, anchorDay = null/);
  assert.match(appSource, /cameraViewport\.addEventListener\("touchstart", beginTouchZoom, \{ passive: false \}\)/);
  assert.match(appSource, /queueTimelineZoom\(touchZoomState\.startDayWidth \* scale, touchMidpointX\(event\.touches\), touchZoomState\.anchorDay\)/);
  const wheelSource = appSource.slice(appSource.indexOf("function handleTimelineWheel"), appSource.indexOf("function autoScrollDuringDrag"));
  assert.match(wheelSource, /wheelPinchState\.mode === "horizontal"[\s\S]*queueTimelineZoom\(baseWidth \* Math\.exp\(-delta \* 0\.01\), event\.clientX\)/);
});

test("horizontal pinch batches work and renders date numbers at every rounded frame", () => {
  assert.match(appSource, /function queueTimelineZoom\(nextWidth, clientX, anchorDay = null\)[\s\S]*requestAnimationFrame/);
  const liveZoomSource = appSource.slice(appSource.indexOf("function setTimelineZoom"), appSource.indexOf("function queueTimelineZoom"));
  assert.doesNotMatch(liveZoomSource, /querySelectorAll|queueRowRender/);
  assert.match(liveZoomSource, /updateDateGridBackground\(\)/);
  assert.match(appSource, /const next = Math\.round\(Math\.min\(MAX_ZOOM_DAY_WIDTH/);
  assert.doesNotMatch(appSource, /is-horizontal-pinching/);
  assert.doesNotMatch(stylesSource, /is-horizontal-pinching/);
  assert.doesNotMatch(stylesSource, /\.timeline-(?:scale|day|row|unit)[^{]*\{[^}]*visibility:hidden/);
});

test("vertical pinch locks direction and transforms only the camera content", () => {
  assert.match(appSource, /const MIN_CAMERA_SCALE = 1/);
  assert.match(appSource, /const MAX_CAMERA_SCALE = 2/);
  assert.match(appSource, /const PINCH_DIRECTION_THRESHOLD = 8/);
  assert.match(appSource, /let cameraScale = 1;\s*let cameraOffsetX = 0;\s*let cameraOffsetY = 0;/);
  assert.match(appSource, /let pinchStartScale = 1;\s*let pinchStartOffsetX = 0;\s*let pinchStartOffsetY = 0;\s*let pinchFocalPoint = null;/);
  assert.match(appSource, /const isHorizontal = horizontalChange >= verticalChange/);
  assert.match(appSource, /touchZoomState\.mode = isHorizontal \? "horizontal" : "vertical"/);
  assert.doesNotMatch(stylesSource, /:root\{[^}]*transform:/);
  assert.match(stylesSource, /\.app-shell\{position:relative\}/);
  assert.match(stylesSource, /\.timeline-camera-viewport\{[^}]*overflow:hidden/);
  assert.match(stylesSource, /\.timeline-camera-content\{[^}]*transform:none[^}]*transform-origin:0 0[^}]*will-change:auto[^}]*contain:paint/);
  assert.doesNotMatch(stylesSource, /\.app-shell\{[^}]*transform:/);
  const cameraSource = appSource.slice(appSource.indexOf("function snapToDevicePixel"), appSource.indexOf("function queueCameraState"));
  assert.match(cameraSource, /cameraContent\.style\.willChange = cameraInteractionActive \? "transform" : "auto"/);
  assert.match(cameraSource, /cameraContent\.style\.transform = "none"/);
  assert.match(cameraSource, /const translate = cameraInteractionActive \? "translate3d" : "translate"/);
  assert.match(cameraSource, /Math\.round\(value \* pixelRatio\) \/ pixelRatio/);
  assert.match(cameraSource, /Math\.round\(cameraScale \* 1000\) \/ 1000/);
  assert.doesNotMatch(cameraSource, /window\.scroll|dayWidth|font|margin|padding/);
  assert.doesNotMatch(appSource, /window\.scrollTo|displayMagnification|--display-magnification/);
});

test("screen coordinates are explicitly converted through the inverse camera transform", () => {
  assert.match(appSource, /function screenToCameraViewport\(clientX, clientY\)[\s\S]*clientX - rect\.left[\s\S]*clientY - rect\.top/);
  assert.match(appSource, /function screenToCameraContent\(clientX, clientY, state = currentCameraState\(\)\)[\s\S]*CameraTransform\.viewportToContent/);
  assert.match(appSource, /const x = \(event\.clientX - rect\.left\) \/ cameraScale - timelineUnitWidth\(\) \+ timelineScrollLeft\(\)/);
  assert.match(appSource, /\(event\.clientX - dragState\.clientX\) \/ cameraScale/);
  assert.match(appSource, /previousBounds\.right - currentBounds\.left\) \/ cameraScale/);
});

test("high resolution horizontal scrolling preserves the full trackpad delta", () => {
  const wheelSource = appSource.slice(appSource.indexOf("function handleTimelineWheel"), appSource.indexOf("function autoScrollDuringDrag"));
  assert.match(wheelSource, /timelineShell\.scrollLeft \+= horizontal/);
  assert.doesNotMatch(wheelSource, /Math\.min\(Math\.max\(horizontal/);
});

test("availability timeline swipes switch one month without blocking vertical scrolling", () => {
  const swipeSource = appSource.slice(appSource.indexOf("function beginAvailabilitySwipe"), appSource.indexOf("function renderCommands"));
  assert.match(appSource, /const AVAILABILITY_SWIPE_THRESHOLD = 50/);
  assert.match(swipeSource, /Math\.abs\(deltaX\) > Math\.abs\(deltaY\) \? "horizontal" : "vertical"/);
  assert.match(swipeSource, /if \(availabilitySwipeState\.mode === "horizontal"\) event\.preventDefault\(\)/);
  assert.match(swipeSource, /setAvailabilityMonth\(addMonths\(availabilityMonth, deltaX < 0 \? 1 : -1\)\)/);
  assert.match(swipeSource, /function beginAvailabilitySwipe\(event\) \{\s*if \(!availabilityViewActive \|\| event\.touches\.length !== 1\)[\s\S]*?return;\s*}\s*event\.stopPropagation\(\)/);
  assert.match(swipeSource, /function moveAvailabilitySwipe\(event\) \{\s*if \(!availabilitySwipeState \|\| event\.touches\.length !== 1\)[\s\S]*?return;\s*}\s*event\.stopPropagation\(\)/);
  assert.match(swipeSource, /const swipe = availabilitySwipeState;\s*availabilitySwipeState = null;\s*if \(!swipe\) return;\s*event\.stopPropagation\(\)/);
  assert.match(appSource, /availabilityGrid\.addEventListener\("touchstart", beginAvailabilitySwipe, \{ passive: true \}\)/);
  assert.match(appSource, /availabilityGrid\.addEventListener\("touchmove", moveAvailabilitySwipe, \{ passive: false \}\)/);
  assert.match(appSource, /availabilityGrid\.addEventListener\("touchcancel", cancelAvailabilitySwipe, \{ passive: true \}\)/);
  assert.match(stylesSource, /\.availability-grid\{[^}]*touch-action:pan-y/);
});

test("each stacked reservation lane receives its own compact date strip", () => {
  const dateGridSource = appSource.slice(appSource.indexOf("function updateDateGridBackground"), appSource.indexOf("function assignLanes"));
  assert.match(dateGridSource, /const rowHeight = LANE_HEIGHT/);
  assert.match(dateGridSource, /\$\{cells\}\$\{monthLines\.join\(""\)\}/);
  assert.match(appSource, /const DATE_GRID_CHUNK_DAYS = 28/);
  assert.match(dateGridSource, /start \+ DATE_GRID_CHUNK_DAYS/);
  assert.match(dateGridSource, /--timeline-date-grid-position/);
  assert.match(dateGridSource, /--timeline-date-grid-size/);
  assert.match(stylesSource, /\.timeline-row::before\{[^}]*inset:0 0 -1px var\(--timeline-unit-width\)[^}]*background-repeat:repeat-y[^}]*background-position:var\(--timeline-date-grid-position\)[^}]*background-size:var\(--timeline-date-grid-size\)/);
  assert.match(stylesSource, /\.guest-timeline\{display:grid;align-content:start/);
});

test("phone and Fold timelines keep enough width for complete room identifiers", () => {
  assert.match(stylesSource, /@media\(max-width:900px\)[\s\S]*--timeline-unit-width:150px/);
  assert.match(stylesSource, /\.timeline-unit strong\{overflow:visible;font-size:10px;text-overflow:clip;white-space:normal;overflow-wrap:anywhere\}/);
  assert.match(stylesSource, /@media\(min-width:600px\) and \(max-width:1100px\)[\s\S]*--timeline-unit-width:180px/);
  assert.match(appSource, /label\.title = row\.resource\.title/);
});

test("the new reservation dialog is centered on mobile without changing other dialogs", () => {
  assert.match(stylesSource, /@media\(max-width:900px\)[\s\S]*#createDialog\{inset:50% auto auto 50%;width:calc\(100vw - 24px\);height:auto;max-height:calc\(100dvh - 24px\);margin:0;border:1px solid var\(--line\);border-radius:10px;transform:translate\(-50%,-50%\)\}/);
});

test("desktop and mobile shells fit the physical viewport without page scrollbars", () => {
  assert.match(stylesSource, /html,body\{width:100%;height:100%;overflow:hidden\}/);
  assert.match(stylesSource, /\.app-shell\{display:grid;grid-template-rows:auto minmax\(0,1fr\);height:100dvh;min-height:0;overflow:hidden/);
  assert.match(stylesSource, /\.timeline-panel\{min-height:0;overflow:hidden;display:grid;grid-template-rows:auto auto minmax\(0,1fr\)/);
  assert.match(stylesSource, /\.timeline-camera-viewport\{grid-row:3;[^}]*height:auto;min-height:0;max-height:none;overflow:hidden/);
});

test("camping alone uses a compact timeline category column", () => {
  assert.match(stylesSource, /\.timeline-shell\.is-camping-workspace\{--timeline-unit-width:112px\}/);
  assert.match(appSource, /function timelineUnitWidth\(\)[\s\S]*getComputedStyle\(timelineShell\)[\s\S]*--timeline-unit-width/);
  assert.doesNotMatch(appSource, /\bRESOURCE_WIDTH\b/);
});

test("past timeline days and only the past segment of reservations are faded", () => {
  assert.match(appSource, /value < today \? "is-past"/);
  assert.match(appSource, /const pastDays = Math\.max\(0, Math\.min\(end - start, todayIndex - start\)\)/);
  assert.match(appSource, /bar\.dataset\.pastDays = String\(normalized\)/);
  assert.match(appSource, /--timeline-past-width", `calc\(\$\{normalized\} \* var\(--timeline-day-width\)\)`/);
  assert.doesNotMatch(appSource, /function updateRenderedPastWidths/);
  assert.match(stylesSource, /--timeline-booking-bg:#ffeead/);
  assert.match(stylesSource, /--timeline-booking-bg:#6aa352/);
  assert.match(stylesSource, /--timeline-booking-bg-past:#adcda0/);
  assert.match(stylesSource, /linear-gradient\(to right,var\(--timeline-booking-bg-past\) 0 var\(--timeline-past-width\),var\(--timeline-booking-bg\) var\(--timeline-past-width\) 100%\)/);
  assert.match(stylesSource, /\.timeline-scale \.timeline-day\.is-past/);
});

test("client popup uses viewport-safe positioning on phone and Fold widths", () => {
  const positionSource = appSource.slice(appSource.indexOf("function positionBookingMenu"), appSource.indexOf("function openBookingMenu"));
  assert.match(positionSource, /matchMedia\("\(max-width: 900px\)"\)/);
  assert.match(appSource, /function prepareBookingMenuPosition\(\) \{[\s\S]*bookingMenu\.style\.position = "fixed"/);
  assert.match(positionSource, /Math\.min\(mobile \? 360 : 342, window\.innerWidth - margin \* 2\)/);
  assert.match(positionSource, /bookingMenu\.style\.width = `\$\{targetWidth\}px`/);
  assert.match(positionSource, /bookingMenu\.style\.maxHeight = `\$\{targetMaxHeight\}px`/);
  assert.match(positionSource, /anchorRect\.bottom \+ 7/);
  assert.match(positionSource, /bookingMenu\.style\.left = `\$\{left\}px`/);
  assert.match(positionSource, /bookingMenu\.style\.top = `\$\{top\}px`/);
  assert.match(stylesSource, /\.booking-menu\{[^}]*overflow-anchor:none/);
  assert.doesNotMatch(stylesSource.match(/\.booking-menu\{[^}]*\}/)?.[0] || "", /transform:/);
  assert.match(stylesSource, /\.booking-menu\{inset:auto 6px max\(6px,env\(safe-area-inset-bottom\)\);width:auto;max-height:min\(520px,calc\(100dvh/);
});

test("opening a client popup cannot read or mutate camera state", () => {
  const openSource = appSource.slice(appSource.indexOf("function openBookingMenu"), appSource.indexOf("function dismissBookingMenu"));
  assert.match(openSource, /const anchorRect = anchor\.getBoundingClientRect\(\)/);
  assert.match(openSource, /prepareBookingMenuPosition\(\);\s*bookingMenu\.hidden = false/);
  assert.match(openSource, /positionBookingMenu\(anchorRect\)/);
  assert.doesNotMatch(openSource, /window\.scroll|scrollX|scrollY|cameraScale|cameraOffset|setCamera|requestAnimationFrame/);
  assert.match(indexSource, /<\/main>\s*<div class="overlay-layer" id="overlayLayer">\s*<aside class="booking-menu"/);
});

test("menus, side panels, dialogs, diagnostics, and toasts stay in the unscaled overlay layer", () => {
  assert.match(stylesSource, /\.overlay-layer\{position:fixed;inset:0;z-index:50;pointer-events:none\}/);
  assert.match(indexSource, /<div class="overlay-layer" id="overlayLayer">[\s\S]*id="bookingMenu"[\s\S]*id="detailsPanel"[\s\S]*<dialog id="paymentDialog"[\s\S]*<dialog id="createDialog"[\s\S]*<dialog id="settingsDialog"[\s\S]*id="diagnostics"[\s\S]*id="toast"/);
  assert.doesNotMatch(appSource, /bookingMenu\.addEventListener\("touch|bookingMenu\.addEventListener\("wheel/);
  assert.doesNotMatch(appSource, /setBookingMenuTransformOrigin|beginBookingMenuZoom|handleBookingMenuWheel/);
});
