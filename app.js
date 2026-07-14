"use strict";

const $ = (selector) => document.querySelector(selector);
const cameraViewport = $("#cameraViewport");
const cameraContent = $("#cameraContent");
const timelineShell = $("#timelineShell");
const timelineScale = $("#timelineScale");
const guestTimeline = $("#guestTimeline");
const bookingMenu = $("#bookingMenu");
const detailsPanel = $("#detailsPanel");
const paymentDialog = $("#paymentDialog");
const createDialog = $("#createDialog");
const settingsDialog = $("#settingsDialog");
const diagnostics = $("#diagnostics");

const TIMELINE_WINDOW_MONTHS = 9;
const TIMELINE_WINDOW_SHIFT_MONTHS = 4;
const DEFAULT_TIMELINE_UNIT_WIDTH = 180;
const TARGET_VISIBLE_DAYS = 31;
const MIN_DAY_WIDTH = 24;
const MAX_DAY_WIDTH = 54;
const MIN_ZOOM_DAY_WIDTH = 18;
const MAX_ZOOM_DAY_WIDTH = 96;
const MIN_CAMERA_SCALE = 1;
const MAX_CAMERA_SCALE = 2;
const PINCH_DIRECTION_THRESHOLD = 8;
const CAMERA_PAN_THRESHOLD = 4;
const ROW_BASE = 44;
const LANE_HEIGHT = 34;
const ROW_GAP = 1;
const VIRTUAL_THRESHOLD = 60;
const OVERSCAN = 10;
const DEFAULT_TIMEZONE = "Europe/Bucharest";

let state = { resources: [], bookings: [], commands: [], diagnostics: {}, settings: {}, range: null };
let activeWorkspace = "rooms";
let workspaceSwitchId = 0;

function updateWorkspaceUi() {
  const camping = activeWorkspace === "camping";
  timelineShell.classList.toggle("is-camping-workspace", camping);
  document.querySelectorAll("[data-workspace]").forEach((button) => {
    const active = button.dataset.workspace === activeWorkspace;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#timelineTitle").textContent = camping ? "Calendar camping" : "Calendar camere";
  $("#timelineSubtitle").textContent = camping ? "Corturi și rulote" : "Camere și bungalow-uri";
  $("#openCreate").textContent = camping ? "Rezervare camping" : "Rezervare nouă";
}

async function switchWorkspace(source) {
  if (!new Set(["rooms", "camping"]).has(source) || source === activeWorkspace) return;
  const switchId = ++workspaceSwitchId;
  clearTimeout(availabilityTimer);
  clearTimeout(quoteTimer);
  availabilityRequestId += 1;
  quoteRequestId += 1;
  if (createDialog.open) createDialog.close();
  if (paymentDialog.open) paymentDialog.close();
  if (settingsDialog.open) settingsDialog.close();
  settingsWorkspace = null;
  bookingMenu.hidden = true;
  detailsPanel.hidden = true;
  diagnostics.hidden = true;
  selectedBookingId = null;
  selectedBookingView = "";
  activeWorkspace = source;
  window.marina.setSource(source);
  updateWorkspaceUi();
  const range = currentRange();
  try {
    const next = await window.marina.bootstrap(range);
    if (switchId !== workspaceSwitchId || activeWorkspace !== source) return;
    applyState(next);
    if (state.settings.credentialsConfigured && state.settings.apiBaseUrl) await refreshRange({ force: false, quiet: true });
  } catch (error) {
    if (switchId === workspaceSwitchId && activeWorkspace === source) showError(error);
  }
}
function configuredTimeZone() {
  const candidate = state.settings?.timezone || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function todayIso() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: configuredTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateFormatter(locale, options = {}) {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: configuredTimeZone() });
}

function dateOnlyFormatter(locale, options = {}) {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
}

let focusMonth = monthStart(todayIso());
let windowStart = addMonths(focusMonth, -Math.floor(TIMELINE_WINDOW_MONTHS / 2));
let windowEnd = null;
let dayCount = 0;
let dayWidth = MAX_DAY_WIDTH;
let manualDayWidth = null;
let touchZoomState = null;
let timelineZoomFrame = null;
let pendingTimelineZoom = null;
let cameraScale = 1;
let cameraOffsetX = 0;
let cameraOffsetY = 0;
let pinchStartScale = 1;
let pinchStartOffsetX = 0;
let pinchStartOffsetY = 0;
let pinchFocalPoint = null;
let cameraTransformFrame = null;
let pendingCameraState = null;
let cameraInteractionActive = false;
let cameraPanState = null;
let lastCameraPanEndedAt = 0;
let wheelPinchState = null;
let timelineRows = [];
let rowRenderFrame = null;
let selectedBookingId = null;
let selectedBookingView = "";
const paymentSnapshots = new Map();
const paymentSnapshotErrors = new Map();
const paymentSnapshotLoading = new Set();
let dragState = null;
let availabilityTimer = null;
let availabilityRequestId = 0;
let availabilityState = "idle";
let quoteTimer = null;
let quoteRequestId = 0;
let quoteState = "stale";
let createQuote = null;
let createQuoteKey = "";
let createCalendarMonth = monthStart(todayIso());
let createSelectionStart = "";
let createSelectionEnd = "";
let showTrashed = false;
let lastScrollLeft = 0;
let lastRecenterAt = 0;
let suppressMonthUpdate = false;
let monthNavigationLockedUntil = 0;
let programmaticScrollFrame = null;
let lastDragEndedAt = 0;
let newlyCreatedBookingId = null;
let newlyCreatedHighlightTimer = null;
let createSubmitting = false;
let settingsWorkspace = null;
const pendingActions = new Set();

async function runExclusive(key, controls, action) {
  if (pendingActions.has(key)) return undefined;
  pendingActions.add(key);
  const elements = controls.filter(Boolean);
  const previousDisabled = elements.map((element) => element.disabled);
  elements.forEach((element) => { element.disabled = true; });
  try { return await action(); }
  finally {
    pendingActions.delete(key);
    elements.forEach((element, index) => { element.disabled = previousDisabled[index]; });
  }
}

function workspaceChangedError() {
  return Object.assign(new Error("Acțiunea a fost anulată deoarece ai schimbat calendarul."), { code: "workspace_changed", permanent: true });
}

function utcDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(`${value}T00:00:00Z`);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function iso(date) { return utcDate(date).toISOString().slice(0, 10); }
function addDays(date, count) { const next = utcDate(date); next.setUTCDate(next.getUTCDate() + count); return next; }
function addMonths(date, count) { const next = utcDate(date); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + count); return next; }
function monthStart(date) { const next = utcDate(date); next.setUTCDate(1); return next; }
function monthEnd(date) { return addDays(addMonths(monthStart(date), 1), -1); }
function daysBetween(a, b) { return Math.round((utcDate(b) - utcDate(a)) / 86400000); }
function rangeDates(start, end) {
  const values = [];
  for (let cursor = utcDate(start); cursor <= utcDate(end) && values.length < 367; cursor = addDays(cursor, 1)) values.push(iso(cursor));
  return values;
}
function formatDate(value) { return dateOnlyFormatter("ro-RO", { day: "2-digit", month: "short" }).format(utcDate(value)); }
function formatMonth(value) {
  const label = dateOnlyFormatter("ro-RO", { month: "long", year: "numeric" }).format(utcDate(value));
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

const DISPLAY_STATUS = { approved: "aprobată", pending: "în așteptare", synced: "sincronizat", queued: "în coadă", sending: "se trimite", failed: "eșuată", conflict: "conflict", needs_attention: "necesită atenție", cancelled: "anulată" };
const DISPLAY_COMMAND = { create: "creare", edit: "editare", status: "status", note: "notă", trash: "gunoi", deposit_update: "actualizare avans", payment_request: "email de plată" };
function displayStatus(value) { return DISPLAY_STATUS[value] || value; }
function displayCommand(value) { return DISPLAY_COMMAND[value] || value; }

const CALENDAR_WEEKDAYS = ["LU", "MA", "MI", "JO", "VI", "SÂ", "DU"];

function currentRange() {
  windowEnd = addDays(addMonths(windowStart, TIMELINE_WINDOW_MONTHS), -1);
  dayCount = daysBetween(windowStart, windowEnd) + 1;
  return { start: iso(windowStart), end: iso(windowEnd) };
}

function rangeMatchesWindow(range) {
  return Boolean(range && range.start === iso(windowStart) && range.end === iso(windowEnd));
}

function windowContainsMonth(month) {
  const target = monthStart(month);
  return target >= windowStart && monthEnd(target) <= windowEnd;
}

function ensureWindowContains(month) {
  if (windowContainsMonth(month)) return false;
  windowStart = addMonths(monthStart(month), -Math.floor(TIMELINE_WINDOW_MONTHS / 2));
  currentRange();
  return true;
}

function scrollLeftForDate(date) {
  return Math.max(0, daysBetween(windowStart, date) * dayWidth);
}

function timelineUnitWidth() {
  const width = Number.parseFloat(getComputedStyle(timelineShell).getPropertyValue("--timeline-unit-width"));
  return Number.isFinite(width) ? width : DEFAULT_TIMELINE_UNIT_WIDTH;
}

function updateTimelineNameSize() {
  const baseSize = 12;
  const zoomStart = window.matchMedia("(pointer: coarse)").matches ? MIN_ZOOM_DAY_WIDTH : MAX_DAY_WIDTH;
  const zoomProgress = Math.min(1, Math.max(0, (dayWidth - zoomStart) / (MAX_ZOOM_DAY_WIDTH - zoomStart)));
  timelineShell.style.setProperty("--timeline-name-size", `${(baseSize + zoomProgress * 5).toFixed(1)}px`);
}

function setTimelineBarPastDays(bar, pastDays) {
  const normalized = Math.max(0, Number(pastDays) || 0);
  bar.dataset.pastDays = String(normalized);
  bar.style.setProperty("--timeline-past-width", `calc(${normalized} * var(--timeline-day-width))`);
}

function updateDayWidth() {
  const availableWidth = Math.max(0, timelineShell.clientWidth - timelineUnitWidth() - 12);
  const automatic = Math.floor(Math.min(MAX_DAY_WIDTH, Math.max(MIN_DAY_WIDTH, availableWidth / TARGET_VISIBLE_DAYS)));
  const next = manualDayWidth ?? automatic;
  if (!Number.isFinite(next) || next === dayWidth) return false;
  dayWidth = next;
  timelineShell.style.setProperty("--timeline-day-width", `${dayWidth}px`);
  updateTimelineNameSize();
  return true;
}

function setTimelineZoom(nextWidth, clientX, anchorDay = null) {
  const next = Math.round(Math.min(MAX_ZOOM_DAY_WIDTH, Math.max(MIN_ZOOM_DAY_WIDTH, nextWidth)));
  if (!Number.isFinite(next)) return;
  const rect = timelineShell.getBoundingClientRect();
  const unitWidth = timelineUnitWidth();
  const viewportX = Math.min(rect.width / cameraScale, Math.max(unitWidth, (clientX - rect.left) / cameraScale));
  const dayAtAnchor = anchorDay ?? (timelineScrollLeft() + viewportX - unitWidth) / dayWidth;
  manualDayWidth = next;
  dayWidth = next;
  timelineShell.style.setProperty("--timeline-day-width", `${dayWidth}px`);
  updateTimelineNameSize();
  updateDateGridBackground();
  setTimelineScrollLeft(dayAtAnchor * dayWidth - viewportX + unitWidth);
  lastScrollLeft = timelineShell.scrollLeft;
  updateVisibleMonthFromScroll();
}

function queueTimelineZoom(nextWidth, clientX, anchorDay = null) {
  pendingTimelineZoom = { nextWidth, clientX, anchorDay };
  if (timelineZoomFrame) return;
  timelineZoomFrame = requestAnimationFrame(() => {
    timelineZoomFrame = null;
    const pending = pendingTimelineZoom;
    pendingTimelineZoom = null;
    if (pending) setTimelineZoom(pending.nextWidth, pending.clientX, pending.anchorDay);
  });
}

function finishTimelineZoom() {
  if (timelineZoomFrame) cancelAnimationFrame(timelineZoomFrame);
  timelineZoomFrame = null;
  const pending = pendingTimelineZoom;
  pendingTimelineZoom = null;
  if (pending) setTimelineZoom(pending.nextWidth, pending.clientX, pending.anchorDay);
}

function touchDistance(touches) {
  return Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
}

function touchMidpointX(touches) {
  return (touches[0].clientX + touches[1].clientX) / 2;
}

function touchMidpointY(touches) {
  return (touches[0].clientY + touches[1].clientY) / 2;
}

function touchAxisDistance(touches, axis) {
  return Math.abs(touches[1][axis] - touches[0][axis]);
}

function cameraDimensions() {
  return {
    contentWidth: cameraContent.offsetWidth,
    contentHeight: cameraContent.offsetHeight,
    viewportWidth: cameraViewport.clientWidth,
    viewportHeight: cameraViewport.clientHeight
  };
}

function screenToCameraViewport(clientX, clientY) {
  const rect = cameraViewport.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function screenToCameraContent(clientX, clientY, state = currentCameraState()) {
  const focal = screenToCameraViewport(clientX, clientY);
  return CameraTransform.viewportToContent({
    x: focal.x,
    y: focal.y,
    scale: state.scale,
    offsetX: state.offsetX,
    offsetY: state.offsetY
  });
}

function currentCameraState() {
  return pendingCameraState || { scale: cameraScale, offsetX: cameraOffsetX, offsetY: cameraOffsetY };
}

function clampCameraState(scale, offsetX, offsetY) {
  const dimensions = cameraDimensions();
  if (!dimensions.contentWidth || !dimensions.contentHeight || !dimensions.viewportWidth || !dimensions.viewportHeight) {
    return { scale, offsetX, offsetY };
  }
  return CameraTransform.clampState({ scale, offsetX, offsetY, ...dimensions });
}

function snapToDevicePixel(value) {
  const pixelRatio = Math.max(1, Number(window.devicePixelRatio) || 1);
  return Math.round(value * pixelRatio) / pixelRatio;
}

function renderCameraState() {
  cameraContent.style.willChange = cameraInteractionActive ? "transform" : "auto";
  if (!cameraInteractionActive && cameraScale === 1 && cameraOffsetX === 0 && cameraOffsetY === 0) {
    cameraContent.style.transform = "none";
    return;
  }
  const translate = cameraInteractionActive ? "translate3d" : "translate";
  const suffix = cameraInteractionActive ? ", 0" : "";
  cameraContent.style.transform = `${translate}(${cameraOffsetX}px, ${cameraOffsetY}px${suffix}) scale(${cameraScale})`;
}

function beginCameraInteraction() {
  if (cameraInteractionActive) return;
  cameraInteractionActive = true;
  renderCameraState();
}

function setCameraState(nextState) {
  const nextScale = Math.min(MAX_CAMERA_SCALE, Math.max(MIN_CAMERA_SCALE, Number(nextState.scale)));
  if (!Number.isFinite(nextScale)) return;
  const next = clampCameraState(nextScale, Number(nextState.offsetX) || 0, Number(nextState.offsetY) || 0);
  cameraScale = next.scale;
  cameraOffsetX = next.offsetX;
  cameraOffsetY = next.offsetY;
  renderCameraState();
}

function settleCameraState() {
  const settledScale = Math.abs(cameraScale - 1) < 0.001 ? 1 : Math.round(cameraScale * 1000) / 1000;
  const settled = clampCameraState(settledScale, snapToDevicePixel(cameraOffsetX), snapToDevicePixel(cameraOffsetY));
  cameraScale = settled.scale;
  cameraOffsetX = settled.scale === 1 ? 0 : settled.offsetX;
  cameraOffsetY = settled.scale === 1 ? 0 : settled.offsetY;
  cameraInteractionActive = false;
  renderCameraState();
}

function queueCameraState(nextState) {
  pendingCameraState = nextState;
  if (cameraTransformFrame) return;
  cameraTransformFrame = requestAnimationFrame(() => {
    cameraTransformFrame = null;
    const pending = pendingCameraState;
    pendingCameraState = null;
    if (pending) setCameraState(pending);
  });
}

function finishCameraTransform() {
  if (cameraTransformFrame) cancelAnimationFrame(cameraTransformFrame);
  cameraTransformFrame = null;
  const pending = pendingCameraState;
  pendingCameraState = null;
  if (pending) setCameraState(pending);
  settleCameraState();
}

function cameraStateForContentAtFocal(contentPoint, focalPoint, nextScale) {
  return CameraTransform.placeContentAtFocal({
    contentX: contentPoint.x,
    contentY: contentPoint.y,
    focalX: focalPoint.x,
    focalY: focalPoint.y,
    scale: Math.min(MAX_CAMERA_SCALE, Math.max(MIN_CAMERA_SCALE, nextScale)),
    ...cameraDimensions()
  });
}

function zoomCameraAt(clientX, clientY, nextScale) {
  const focal = screenToCameraViewport(clientX, clientY);
  const current = currentCameraState();
  const contentPoint = screenToCameraContent(clientX, clientY, current);
  return cameraStateForContentAtFocal(contentPoint, focal, nextScale);
}

function beginTouchZoom(event) {
  if (event.touches.length === 1) {
    if (cameraScale <= 1) return;
    cameraPanState = {
      clientX: event.touches[0].clientX,
      clientY: event.touches[0].clientY,
      startOffsetX: cameraOffsetX,
      startOffsetY: cameraOffsetY,
      moved: false
    };
    return;
  }
  if (event.touches.length !== 2) return;
  cancelDrag();
  cameraPanState = null;
  event.preventDefault();
  const midpointX = touchMidpointX(event.touches);
  const midpointY = touchMidpointY(event.touches);
  pinchStartScale = cameraScale;
  pinchStartOffsetX = cameraOffsetX;
  pinchStartOffsetY = cameraOffsetY;
  pinchFocalPoint = screenToCameraViewport(midpointX, midpointY);
  const pinchContentPoint = CameraTransform.viewportToContent({
    x: pinchFocalPoint.x,
    y: pinchFocalPoint.y,
    scale: pinchStartScale,
    offsetX: pinchStartOffsetX,
    offsetY: pinchStartOffsetY
  });
  const rect = timelineShell.getBoundingClientRect();
  const unitWidth = timelineUnitWidth();
  const viewportX = Math.min(rect.width / cameraScale, Math.max(unitWidth, (midpointX - rect.left) / cameraScale));
  touchZoomState = {
    mode: null,
    startDistance: Math.max(1, touchDistance(event.touches)),
    startHorizontalDistance: touchAxisDistance(event.touches, "clientX"),
    startVerticalDistance: touchAxisDistance(event.touches, "clientY"),
    startDayWidth: dayWidth,
    anchorDay: (timelineScrollLeft() + viewportX - unitWidth) / dayWidth,
    pinchContentPoint
  };
}

function moveTouchZoom(event) {
  if (event.touches.length === 1 && cameraPanState) {
    const deltaX = event.touches[0].clientX - cameraPanState.clientX;
    const deltaY = event.touches[0].clientY - cameraPanState.clientY;
    if (!cameraPanState.moved && Math.max(Math.abs(deltaX), Math.abs(deltaY)) < CAMERA_PAN_THRESHOLD) return;
    cameraPanState.moved = true;
    beginCameraInteraction();
    event.preventDefault();
    queueCameraState({
      scale: cameraScale,
      offsetX: cameraPanState.startOffsetX + deltaX,
      offsetY: cameraPanState.startOffsetY + deltaY
    });
    return;
  }
  if (!touchZoomState || event.touches.length < 2) return;
  event.preventDefault();
  if (!touchZoomState.mode) {
    const horizontalChange = Math.abs(touchAxisDistance(event.touches, "clientX") - touchZoomState.startHorizontalDistance);
    const verticalChange = Math.abs(touchAxisDistance(event.touches, "clientY") - touchZoomState.startVerticalDistance);
    if (Math.max(horizontalChange, verticalChange) < PINCH_DIRECTION_THRESHOLD) return;
    const isHorizontal = horizontalChange >= verticalChange;
    touchZoomState.mode = isHorizontal ? "horizontal" : "vertical";
  }
  const scale = touchDistance(event.touches) / touchZoomState.startDistance;
  if (touchZoomState.mode === "horizontal") {
    queueTimelineZoom(touchZoomState.startDayWidth * scale, touchMidpointX(event.touches), touchZoomState.anchorDay);
  } else if (touchZoomState.mode === "vertical") {
    beginCameraInteraction();
    const focal = screenToCameraViewport(touchMidpointX(event.touches), touchMidpointY(event.touches));
    queueCameraState(cameraStateForContentAtFocal(touchZoomState.pinchContentPoint, focal, pinchStartScale * scale));
  }
}

function endTouchZoom(event) {
  if (event.touches.length >= 2) return;
  if (touchZoomState) {
    if (touchZoomState.mode === "horizontal") finishTimelineZoom();
    else if (touchZoomState.mode === "vertical") finishCameraTransform();
    touchZoomState = null;
    pinchFocalPoint = null;
    lastScrollLeft = timelineShell.scrollLeft;
    updateVisibleMonthFromScroll();
  }
  if (cameraPanState && event.touches.length === 0) {
    finishCameraTransform();
    if (cameraPanState.moved) lastCameraPanEndedAt = performance.now();
    cameraPanState = null;
  }
}

function timelineScrollLeft() { return timelineShell.scrollLeft; }
function timelineScrollTop() { return timelineShell.scrollTop; }
function setTimelineScrollLeft(value) { timelineShell.scrollLeft = Math.max(0, value); }
function setTimelineScrollTop(value) { timelineShell.scrollTop = Math.max(0, value); }

const API_ACTION_MESSAGES = Object.freeze({
  createBooking: ["Se creează rezervarea…", "Rezervarea a fost creată."],
  editBooking: ["Se salvează modificările…", "Modificările au fost salvate."],
  setStatus: ["Se actualizează statusul…", "Statusul a fost actualizat."],
  setNote: ["Se salvează nota…", "Nota a fost salvată."],
  setTrash: ["Se actualizează rezervarea…", "Rezervarea a fost actualizată."],
  updateDeposit: ["Se salvează avansul…", "Avansul a fost salvat."],
  requestPayment: ["Se programează emailul de plată…", "Emailul de plată a fost programat."],
  retryCommand: ["Se reîncearcă acțiunea…", "Acțiunea a fost retrimisă."],
  revertBooking: ["Se anulează modificarea locală…", "Modificarea locală a fost anulată."],
  clearFailedCommands: ["Se curăță acțiunile eșuate…", "Acțiunile eșuate au fost curățate."],
  testConnection: ["Se testează conexiunea API…", "Conexiunea API funcționează."]
});
const DESKTOP_QUEUE_MESSAGES = Object.freeze({
  createBooking: "Rezervarea a fost pusă în coada locală.",
  editBooking: "Modificările au fost puse în coada locală.",
  setStatus: "Statusul a fost pus în coada locală.",
  setNote: "Nota a fost pusă în coada locală.",
  setTrash: "Modificarea a fost pusă în coada locală.",
  updateDeposit: "Avansul a fost pus în coada locală.",
  requestPayment: "Emailul de plată a fost pus în coada locală.",
  retryCommand: "Acțiunea a fost retrimisă în coada locală.",
  revertBooking: "Modificarea locală a fost anulată.",
  clearFailedCommands: "Acțiunile eșuate au fost curățate."
});
const apiToastErrors = new WeakSet();
const toastTimers = new WeakMap();
const commandSyncToasts = new Map();
const observedCommandStatuses = new Map();
const observedCommandWorkspaces = new Set();

function shortErrorMessage(error) {
  const message = String(error?.message || error || "Acțiunea nu a putut fi finalizată.")
    .replace(/^Error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return message.length > 150 ? `${message.slice(0, 147)}…` : message;
}

function showToast(message, state = "success", toast = null) {
  const region = $("#toast");
  const item = toast?.isConnected ? toast : document.createElement("div");
  clearTimeout(toastTimers.get(item));
  item.className = `toast-item ${state}`;
  item.setAttribute("role", state === "error" ? "alert" : "status");
  item.replaceChildren();
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = state === "pending" ? "⚙" : state === "error" ? "×" : "✓";
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = String(message);
  item.append(icon, text);
  if (!item.isConnected) region.append(item);
  while (region.children.length > 4) region.firstElementChild.remove();
  if (state !== "pending") {
    const delay = state === "error" ? 5200 : 3200;
    toastTimers.set(item, setTimeout(() => item.remove(), delay));
  }
  return item;
}

function showError(error) {
  if (error && typeof error === "object" && apiToastErrors.has(error)) return;
  showToast(shortErrorMessage(error), "error");
}

async function runApiAction(method, ...args) {
  const [pendingMessage, successMessage] = API_ACTION_MESSAGES[method];
  const toast = showToast(pendingMessage, "pending");
  try {
    const result = await window.marina[method](...args);
    const completedMessage = window.marina.platform === "android" || !DESKTOP_QUEUE_MESSAGES[method]
      ? successMessage
      : DESKTOP_QUEUE_MESSAGES[method];
    showToast(completedMessage, "success", toast);
    return result;
  } catch (error) {
    showToast(shortErrorMessage(error), "error", toast);
    if (error && typeof error === "object") apiToastErrors.add(error);
    throw error;
  }
}

function notifyCommandStateChanges(commands = []) {
  if (window.marina.platform === "android") return;
  const workspace = activeWorkspace;
  const currentKeys = new Set(commands.map((command) => `${workspace}:${command.id}`));
  if (!observedCommandWorkspaces.has(workspace)) {
    commands.forEach((command) => observedCommandStatuses.set(`${workspace}:${command.id}`, command.status));
    observedCommandWorkspaces.add(workspace);
    return;
  }
  commands.forEach((command) => {
    const key = `${workspace}:${command.id}`;
    const previous = observedCommandStatuses.get(key);
    if (previous !== command.status) {
      const label = displayCommand(command.type);
      const existing = commandSyncToasts.get(key);
      if (command.status === "sending") {
        commandSyncToasts.set(key, showToast(`Se sincronizează: ${label}…`, "pending", existing));
      } else if (command.status === "synced") {
        showToast(`Sincronizare reușită: ${label}.`, "success", existing);
        commandSyncToasts.delete(key);
      } else if (["failed", "conflict", "needs_attention"].includes(command.status)) {
        showToast(shortErrorMessage(command.errorMessage || `Sincronizarea a eșuat: ${label}.`), "error", existing);
        commandSyncToasts.delete(key);
      }
      observedCommandStatuses.set(key, command.status);
    }
  });
  for (const [key, toast] of commandSyncToasts) {
    if (key.startsWith(`${workspace}:`) && !currentKeys.has(key)) {
      toast.remove();
      commandSyncToasts.delete(key);
    }
  }
}

function bookingById(localId) { return state.bookings.find((booking) => booking.localId === localId); }
function resourceById(resourceId) { return state.resources.find((resource) => Number(resource.id) === Number(resourceId)); }

function updateSyncUi() {
  const info = state.diagnostics || {};
  const campingSetupRequired = activeWorkspace === "camping" && !state.settings?.credentialsConfigured;
  const endpointChanged = state.commands.some((command) => command.errorCode === "endpoint_changed");
  const indicator = $("#syncIndicator");
  indicator.className = `sync-indicator ${info.failed ? "attention" : info.online ? "online" : "offline"}`;
  $("#syncText").textContent = endpointChanged ? "Verifică adresa API" : info.authPaused ? "Verifică datele de acces" : info.online ? "Conectat" : "Deconectat";
  $("#syncCounts").textContent = `${info.queued || 0} în coadă · ${info.failed || 0} cu probleme`;
  const banner = $("#banner");
  if (campingSetupRequired) {
    banner.hidden = false;
    banner.textContent = "Camping este pregătit local. Instalează Marina Booking API pe camping.marinapark.ro și configurează parola de aplicație în Setări pentru sincronizare.";
  } else if (endpointChanged) {
    banner.hidden = false;
    banner.textContent = "Adresa API s-a schimbat. Verifică ținta înainte de a reîncerca comenzile din coadă.";
  } else if (info.authPaused) {
    banner.hidden = false;
    banner.textContent = "Sincronizarea este oprită. Actualizează datele WordPress în Setări.";
  } else if (!info.online) {
    banner.hidden = false;
    banner.textContent = window.marina.platform === "android"
      ? "Mod offline pe telefon: poți consulta ultimul calendar salvat; modificările necesită conexiune."
      : "Mod offline: modificările sunt păstrate local și se vor sincroniza când API-ul este disponibil.";
  } else if (info.failed) {
    banner.hidden = false;
    banner.textContent = "Unele modificări necesită atenție. Deschide diagnosticul pentru reîncercare sau detalii despre conflict.";
  } else banner.hidden = true;
}

function fillResourceSelects() {
  const options = (resources) => resources.map((resource) => `<option value="${resource.id}"${resource.active === false ? " disabled" : ""}>${escapeHtml(resource.title)}${resource.active === false ? " (inactiv)" : ""}</option>`).join("");
  const createSelect = $("#createForm").elements.resourceId;
  const createValue = createSelect.value;
  createSelect.innerHTML = options(activeWorkspace === "camping" ? timelineResources() : state.resources) || '<option value="">Nu există spații în cache</option>';
  if (createValue) createSelect.value = createValue;
  for (const select of document.querySelectorAll('#detailsForm select[name="resourceId"]')) {
    const value = select.value;
    select.innerHTML = options(state.resources) || '<option value="">Nu există spații în cache</option>';
    if (value) select.value = value;
  }
}

function updateTrashedToggle() {
  const button = $("#toggleTrashed");
  const count = state.bookings.filter((booking) => booking.trashed).length;
  if (!count) showTrashed = false;
  button.disabled = count === 0;
  button.setAttribute("aria-pressed", String(showTrashed));
  button.textContent = showTrashed ? `Ascunde gunoiul (${count})` : `Afișează gunoiul (${count})`;
}

function renderScale() {
  updateDayWidth();
  currentRange();
  timelineShell.style.setProperty("--timeline-days", dayCount);
  const today = todayIso();
  const weekdays = ["Du", "Lu", "Ma", "Mi", "Jo", "Vi", "Sâ"];
  const days = [];
  for (let index = 0; index < dayCount; index += 1) {
    const date = addDays(windowStart, index);
    const value = iso(date);
    const classes = [date.getUTCDate() === 1 ? "is-month-start" : "", date.getUTCDay() === 0 || date.getUTCDay() === 6 ? "is-weekend" : "", value < today ? "is-past" : "", value === today ? "is-today" : ""].filter(Boolean).join(" ");
    days.push(`<span class="timeline-day ${classes}" data-grid-column="${index + 2}"><strong>${weekdays[date.getUTCDay()]}</strong><small>${String(date.getUTCDate()).padStart(2, "0")}</small></span>`);
  }
  const weeks = [];
  let weekStart = 0;
  for (let index = 1; index <= dayCount; index += 1) {
    const date = index < dayCount ? addDays(windowStart, index) : null;
    if (index < dayCount && date.getUTCDay() !== 1) continue;
    const first = addDays(windowStart, weekStart);
    const last = addDays(windowStart, index - 1);
    const firstLabel = dateOnlyFormatter("en-GB", { day: "numeric", ...(first.getUTCMonth() === last.getUTCMonth() ? {} : { month: "short" }) }).format(first);
    const lastLabel = dateOnlyFormatter("en-GB", { day: "numeric", month: "short" }).format(last);
    weeks.push(`<span class="timeline-week" data-grid-start="${weekStart + 2}" data-grid-end="${index + 2}">${firstLabel}–${lastLabel}</span>`);
    weekStart = index;
  }
  timelineScale.innerHTML = `<span class="timeline-corner"><strong>Spațiu</strong><small>rezervări</small></span>${weeks.join("")}${days.join("")}`;
  timelineScale.querySelectorAll(".timeline-week").forEach((week) => {
    week.style.gridColumn = `${week.dataset.gridStart} / ${week.dataset.gridEnd}`;
    week.style.gridRow = "1";
  });
  timelineScale.querySelectorAll(".timeline-day").forEach((day) => {
    day.style.gridColumn = day.dataset.gridColumn;
    day.style.gridRow = "2";
  });
  $("#monthLabel").textContent = formatMonth(focusMonth);
}

function updateDateGridBackground() {
  const rowHeight = LANE_HEIGHT;
  const width = dayCount * dayWidth;
  const today = todayIso();
  const cells = Array.from({ length: dayCount }, (_, index) => {
    const date = addDays(windowStart, index);
    const value = iso(date);
    const x = index * dayWidth;
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    const past = value < today;
    const current = value === today;
    const fill = past ? "#b8bfbb" : weekend ? "#a7443f" : current ? "#2f7045" : "#4b5563";
    const background = current
      ? `<rect x="${x}" y="0" width="${dayWidth}" height="${rowHeight}" fill="#edf8f1"/>`
      : past ? `<rect x="${x}" y="0" width="${dayWidth}" height="${rowHeight}" fill="#fcfcfb"/>`
        : weekend ? `<rect x="${x}" y="0" width="${dayWidth}" height="${rowHeight}" fill="#fffafa"/>` : "";
    return `${background}<text x="${x + dayWidth / 2}" y="${rowHeight / 2 + 3}" text-anchor="middle" fill="${fill}" font-family="Arial,sans-serif" font-size="10" font-weight="600">${String(date.getUTCDate()).padStart(2, "0")}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${rowHeight}" viewBox="0 0 ${width} ${rowHeight}">${cells}</svg>`;
  timelineShell.style.setProperty("--timeline-date-grid", `url("data:image/svg+xml;base64,${window.btoa(svg)}")`);
  timelineShell.style.setProperty("--timeline-date-grid-width", `${width}px`);
}

function assignLanes(items) {
  return TimelineAdapter.assignLanes(items);
}

function resourceParentId(resource) {
  const parentId = Number(resource?.parentId ?? resource?.parent_id);
  return Number.isInteger(parentId) && parentId > 0 ? parentId : null;
}

function resourceLooksCaravan(resource) {
  return /rulot|caravan/i.test(`${resource?.title || ""} ${resource?.defaultForm || resource?.default_form || ""}`);
}

function campingParentResources() {
  const activeResources = state.resources.filter((resource) => resource.active !== false);
  const roots = activeResources.filter((resource) => !resourceParentId(resource));
  const candidates = roots.length ? roots : activeResources;
  const caravan = candidates.find(resourceLooksCaravan)
    || activeResources.find((resource) => Number(resource.id) === 2)
    || candidates[1];
  const tent = candidates.find((resource) => /cort|tent/i.test(`${resource.title || ""} ${resource.defaultForm || resource.default_form || ""}`))
    || activeResources.find((resource) => Number(resource.id) === 1)
    || candidates.find((resource) => Number(resource.id) !== Number(caravan?.id));
  return [
    tent ? { ...tent, title: "Corturi" } : { id: 1, title: "Corturi", capacity: 10, defaultForm: "standard", active: true },
    caravan ? { ...caravan, title: "Rulote" } : { id: 2, title: "Rulote", capacity: 5, defaultForm: "rulota", active: true }
  ];
}

function timelineResources() {
  if (activeWorkspace !== "camping") return state.resources;
  return campingParentResources();
}

function isCaravanResource(resourceId) {
  const [tentParent, caravanParent] = campingParentResources();
  const tentParentId = Number(tentParent?.id);
  const caravanParentId = Number(caravanParent?.id);
  let resource = resourceById(resourceId);
  const visited = new Set();
  while (resource && !visited.has(Number(resource.id))) {
    const currentId = Number(resource.id);
    visited.add(currentId);
    if (currentId === caravanParentId) return true;
    if (currentId === tentParentId) return false;
    const parentId = resourceParentId(resource);
    resource = parentId ? resourceById(parentId) : null;
  }
  return Number(resourceId) === caravanParentId;
}

function timelineBookings() {
  if (activeWorkspace !== "camping") return state.bookings;
  const [, caravan] = timelineResources();
  const [tent] = timelineResources();
  return state.bookings.map((booking) => ({
    ...booking,
    timelineResourceId: isCaravanResource(booking.resourceId) ? caravan.id : tent.id
  }));
}

function prepareRows() {
  const lanes = TimelineAdapter.mapState(timelineResources(), timelineBookings(), { includeTrashed: showTrashed });
  let top = 0;
  timelineRows = lanes.map((resource) => {
    const visibleItems = resource.items.filter((item) => item.start <= iso(windowEnd) && item.end >= iso(windowStart));
    const layout = assignLanes(visibleItems);
    const height = Math.max(ROW_BASE, layout.count * LANE_HEIGHT + 8);
    const row = { resource, layout, top, height };
    top += height + ROW_GAP;
    return row;
  });
  const virtualized = timelineRows.length > VIRTUAL_THRESHOLD;
  guestTimeline.classList.toggle("is-virtualized", virtualized);
  guestTimeline.style.height = virtualized ? `${Math.max(360, top - ROW_GAP)}px` : "";
  if (!timelineRows.length) {
    guestTimeline.innerHTML = '<p class="empty-state">Nu există spații de rezervare în cache.</p>';
    return;
  }
  guestTimeline.querySelector(":scope > .empty-state")?.remove();
  renderVisibleRows(true);
}

function visibleRowBounds() {
  if (timelineRows.length <= VIRTUAL_THRESHOLD) return [0, timelineRows.length];
  const top = Math.max(0, timelineScrollTop() - timelineScale.offsetHeight);
  const bottom = top + timelineShell.clientHeight;
  let start = timelineRows.findIndex((row) => row.top + row.height >= top);
  if (start < 0) start = 0;
  let end = start;
  while (end < timelineRows.length && timelineRows[end].top <= bottom) end += 1;
  return [Math.max(0, start - OVERSCAN), Math.min(timelineRows.length, end + OVERSCAN)];
}

function barSignature(item, lane, predecessorKey = "") {
  return TimelineAdapter.barSignature(item, lane, predecessorKey, iso(windowStart), dayCount);
}

function createBar(item, lane, predecessorKey = "") {
  const start = Math.max(0, daysBetween(windowStart, item.start));
  const end = Math.min(dayCount, daysBetween(windowStart, item.end) + 1);
  const duration = Math.max(1, daysBetween(item.start, item.end) + 1);
  const element = document.createElement("article");
  const compact = duration <= 2 ? "is-compact" : duration <= 4 ? "is-tight" : "";
  const approval = item.status === "approved" ? "is-paid" : "is-unpaid";
  const todayIndex = daysBetween(windowStart, todayIso());
  const pastDays = Math.max(0, Math.min(end - start, todayIndex - start));
  element.className = `timeline-bar ${compact} ${approval} ${item.status} ${item.syncState} ${predecessorKey ? "has-adjacent-start" : ""} ${item.key === newlyCreatedBookingId ? "is-newly-created" : ""}`;
  setTimelineBarPastDays(element, pastDays);
  element.dataset.bookingId = item.key;
  if (predecessorKey) element.dataset.handoffPredecessorKey = predecessorKey;
  element.dataset.signature = barSignature(item, lane, predecessorKey);
  element.style.gridColumn = `${start + 2} / ${end + 2}`;
  element.style.gridRow = lane;
  element.title = `${item.title} · ${formatDate(item.start)}–${formatDate(item.end)} · trage de margine pentru redimensionare`;
  element.innerHTML = `<button class="timeline-handle" data-drag-mode="resize-start" type="button" aria-label="Redimensionează sosirea"></button><div class="timeline-bar-content"><div class="timeline-bar-label"><strong class="timeline-bar-guest">${escapeHtml(item.title)}</strong><span class="timeline-bar-meta">${escapeHtml(formatDate(item.start))}–${escapeHtml(formatDate(item.end))}${item.subtitle ? ` · ${escapeHtml(item.subtitle)}` : ""}</span></div></div><button class="timeline-handle" data-drag-mode="resize-end" type="button" aria-label="Redimensionează plecarea"></button>`;
  return element;
}

function syncRow(element, row, virtualized) {
  element.dataset.resourceId = row.resource.id;
  element.style.setProperty("--timeline-lanes", row.layout.count);
  if (virtualized) {
    element.style.setProperty("--timeline-row-top", `${row.top}px`);
    element.style.setProperty("--timeline-row-height", `${row.height}px`);
  } else {
    element.style.removeProperty("--timeline-row-top");
    element.style.removeProperty("--timeline-row-height");
  }
  const label = element.querySelector(".timeline-unit");
  label.querySelector("strong").textContent = row.resource.title;
  label.title = row.resource.title;
  label.querySelector("span").textContent = row.resource.subtitle;
  const existing = new Map([...element.querySelectorAll(":scope > .timeline-bar")].map((bar) => [bar.dataset.bookingId, bar]));
  for (const { item, lane, predecessorKey } of row.layout.items) {
    const signature = barSignature(item, lane, predecessorKey);
    const current = existing.get(item.key);
    if (!current) element.append(createBar(item, lane, predecessorKey));
    else if (current.dataset.signature !== signature && dragState?.booking.localId !== item.key) current.replaceWith(createBar(item, lane, predecessorKey));
    else current.classList.toggle("is-newly-created", item.key === newlyCreatedBookingId);
    existing.delete(item.key);
  }
  for (const bar of existing.values()) if (bar.dataset.bookingId !== dragState?.booking.localId) bar.remove();
  element.classList.toggle("is-empty", row.layout.items.length === 0);
  updateLabelShifts(element);
}

function updateLabelShifts(row) {
  const bars = [...row.querySelectorAll(":scope > .timeline-bar")];
  const byKey = new Map(bars.map((bar) => [bar.dataset.bookingId, bar]));
  bars.forEach((bar) => bar.style.setProperty("--timeline-label-shift", "0px"));
  const bounds = new Map(bars.map((bar) => [bar.dataset.bookingId, bar.querySelector(".timeline-bar-guest")?.getBoundingClientRect()]));
  for (const bar of bars) {
    const predecessor = byKey.get(bar.dataset.handoffPredecessorKey);
    const previousBounds = bounds.get(bar.dataset.handoffPredecessorKey);
    const currentBounds = bounds.get(bar.dataset.bookingId);
    if (!predecessor || !previousBounds || !currentBounds || predecessor.style.gridRow !== bar.style.gridRow) continue;
    const shift = Math.min(48, Math.max(12, Math.ceil((previousBounds.right - currentBounds.left) / cameraScale + 6)));
    bar.style.setProperty("--timeline-label-shift", `${shift}px`);
  }
}

function renderVisibleRows(force = false) {
  const virtualized = timelineRows.length > VIRTUAL_THRESHOLD;
  const [start, end] = visibleRowBounds();
  const desired = timelineRows.slice(start, end);
  const existing = new Map([...guestTimeline.querySelectorAll(":scope > .timeline-row")].map((row) => [Number(row.dataset.resourceId), row]));
  const elements = desired.map((row) => {
    let element = existing.get(row.resource.id);
    if (!element) {
      element = document.createElement("section");
      element.className = "timeline-row";
      element.innerHTML = '<div class="timeline-unit"><strong></strong><span></span></div>';
    }
    syncRow(element, row, virtualized);
    existing.delete(row.resource.id);
    return element;
  });
  for (const element of existing.values()) element.remove();
  elements.forEach((element, index) => {
    if (force || guestTimeline.children[index] !== element) guestTimeline.insertBefore(element, guestTimeline.children[index] || null);
  });
}

function queueRowRender() {
  if (rowRenderFrame) return;
  rowRenderFrame = requestAnimationFrame(() => { rowRenderFrame = null; renderVisibleRows(); });
}

function renderTimeline({ preserveScroll = true } = {}) {
  const left = timelineShell.scrollLeft;
  const top = timelineShell.scrollTop;
  renderScale();
  updateDateGridBackground();
  prepareRows();
  if (preserveScroll) { timelineShell.scrollLeft = left; timelineShell.scrollTop = top; lastScrollLeft = left; }
}

function renderCommands() {
  const failedCount = state.commands.filter((command) => command.status === "failed").length;
  const commandHtml = (command, compact = false) => {
    const retryable = ["failed", "conflict", "needs_attention"].includes(command.status) && (window.marina.platform !== "android" || ["deposit_update", "payment_request"].includes(command.type));
    const bookingActions = command.bookingLocalId && window.marina.platform !== "android"
      ? `<button class="secondary compact" data-revert-booking="${escapeHtml(command.bookingLocalId)}" type="button">Revino la local</button><button class="secondary compact" data-open-booking="${escapeHtml(command.bookingLocalId)}" type="button">Deschide detaliile</button>`
      : command.bookingLocalId && ["deposit_update", "payment_request"].includes(command.type)
        ? `<button class="secondary compact" data-revert-booking="${escapeHtml(command.bookingLocalId)}" type="button">Anulează și reîncarcă</button>` : "";
    return `<div class="command"><div><strong>${escapeHtml(displayCommand(command.type))}</strong> <span>${escapeHtml(displayStatus(command.status))}</span></div><small>${new Date(command.updatedAt).toLocaleString("ro-RO")}</small>${command.errorMessage ? `<div class="error">${escapeHtml(command.errorMessage)}</div>` : ""}${!compact && retryable ? `<button class="secondary compact" data-retry-command="${command.id}" type="button">Reîncearcă</button>${bookingActions}` : ""}</div>`;
  };
  $("#commandList").innerHTML = state.commands.map((command) => commandHtml(command)).join("") || '<div class="availability">Nu există comenzi.</div>';
  $("#clearQueueIssues").hidden = failedCount === 0;
  const info = state.diagnostics;
  const cache = info.cache?.loadedAt ? `${info.cache.startDate}–${info.cache.endDate}, verificat ${new Date(info.cache.loadedAt).toLocaleString("ro-RO")}` : "nu este încărcat";
  $("#diagnosticSummary").textContent = `Conectare: ${info.online ? "da" : "nu"} · în coadă: ${info.queued || 0} · probleme: ${info.failed || 0} · ultima sincronizare: ${info.lastSuccessfulSync ? new Date(info.lastSuccessfulSync).toLocaleString("ro-RO") : "niciodată"} · cache: ${cache}`;
  if (selectedBookingId && $("#bookingCommands")) $("#bookingCommands").innerHTML = state.commands.filter((command) => command.bookingLocalId === selectedBookingId).map((command) => commandHtml(command, true)).join("") || "Nu există comenzi locale.";
}

function applyState(next) {
  notifyCommandStateChanges(next.commands);
  state = next;
  fillResourceSelects();
  updateTrashedToggle();
  updateSyncUi();
  renderTimeline();
  renderCommands();
  if (createDialog.open) renderCreateCalendar();
  if (selectedBookingId) {
    const booking = bookingById(selectedBookingId);
    if (booking && selectedBookingView === "menu") populateBookingMenu(booking);
    else if (booking && selectedBookingView === "edit") populateDetails(booking, false);
    else if (booking && selectedBookingView === "payment") populatePaymentDialog(booking, false);
    else if (!booking) {
      bookingMenu.hidden = true;
      detailsPanel.hidden = true;
      if (paymentDialog.open) paymentDialog.close();
      selectedBookingId = null;
      selectedBookingView = "";
    }
  }
}

function revealCreatedBooking(created, input, source = activeWorkspace) {
  if (source !== activeWorkspace) return false;
  const serverId = Number(created?.serverId ?? created?.booking_id ?? created?.bookingId ?? created?.booking?.booking_id);
  let booking = created?.localId ? bookingById(created.localId) : null;
  if (!booking && Number.isInteger(serverId) && serverId > 0) booking = state.bookings.find((item) => Number(item.serverId) === serverId);
  const hasCreatedIdentity = Boolean(created?.localId) || (Number.isInteger(serverId) && serverId > 0);
  if (!booking && !hasCreatedIdentity) {
    const expectedStart = input.dates[0];
    const expectedEnd = input.dates[input.dates.length - 1];
    const expectedEmail = String(input.formData?.email?.value || "").trim().toLowerCase();
    booking = [...state.bookings].reverse().find((item) => item.dates?.[0] === expectedStart
      && item.dates?.[item.dates.length - 1] === expectedEnd
      && (!expectedEmail || String(item.formData?.email?.value || "").trim().toLowerCase() === expectedEmail));
  }
  if (!booking) return false;

  clearTimeout(newlyCreatedHighlightTimer);
  newlyCreatedBookingId = booking.localId;
  renderTimeline();

  const row = timelineRows.find((candidate) => candidate.layout.items.some(({ item }) => item.key === booking.localId));
  if (row) setTimelineScrollTop(row.top - Math.max(0, (timelineShell.clientHeight - row.height) / 2));
  renderVisibleRows(true);

  const start = booking.startDate || booking.dates[0];
  const end = booking.endDate || booking.dates[booking.dates.length - 1];
  const center = addDays(start, Math.floor(Math.max(0, daysBetween(start, end)) / 2));
  const maxLeft = Math.max(0, guestTimeline.scrollWidth - timelineShell.clientWidth);
  const visibleTimelineWidth = Math.max(dayWidth, timelineShell.clientWidth - timelineUnitWidth());
  const targetLeft = Math.min(maxLeft, Math.max(0, scrollLeftForDate(center) - visibleTimelineWidth / 2));
  setTimelineScrollLeft(targetLeft);
  lastScrollLeft = timelineShell.scrollLeft;
  focusMonth = monthStart(center);
  $("#monthLabel").textContent = formatMonth(focusMonth);

  newlyCreatedHighlightTimer = setTimeout(() => {
    if (newlyCreatedBookingId !== booking.localId) return;
    newlyCreatedBookingId = null;
    guestTimeline.querySelector(`[data-booking-id="${CSS.escape(booking.localId)}"]`)?.classList.remove("is-newly-created");
  }, 2600);
  return true;
}

async function waitForCreatedBooking(created, input, source = activeWorkspace, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (source !== activeWorkspace) return false;
    if (revealCreatedBooking(created, input, source)) return true;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return revealCreatedBooking(created, input, source);
}

async function refreshRange({ resetScroll = false, force = false, quiet = false, desiredLeft = null } = {}) {
  const range = currentRange();
  const requestWorkspace = activeWorkspace;
  renderScale();
  try {
    const next = await window.marina.refresh(range, { force });
    if (activeWorkspace !== requestWorkspace || !rangeMatchesWindow(range)) return;
    applyState(next);
  } catch (error) {
    if (activeWorkspace !== requestWorkspace || !rangeMatchesWindow(range)) return;
    if (!quiet) showError(error);
    renderTimeline();
  }
  if (activeWorkspace !== requestWorkspace || !rangeMatchesWindow(range)) return;
  const targetLeft = desiredLeft ?? (resetScroll ? Math.max(0, scrollLeftForDate(focusMonth) - dayWidth * 2) : null);
  if (targetLeft !== null) {
    setTimelineScrollLeft(targetLeft);
    lastScrollLeft = timelineShell.scrollLeft;
    renderVisibleRows(true);
  }
}

function calendarMonthLabel(date) {
  const label = dateOnlyFormatter("ro-RO", { month: "long", year: "numeric" }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function calendarDateLabel(value) {
  return dateOnlyFormatter("ro-RO", { day: "numeric", month: "short", year: "numeric" }).format(utcDate(value));
}

function selectedResource() {
  const id = Number($("#createForm").elements.resourceId.value);
  return state.resources.find((resource) => Number(resource.id) === id) || null;
}

function createOccupancy() {
  if (activeWorkspace === "camping") return {};
  return BookingCalendar.occupancyFor(state.bookings, Number($("#createForm").elements.resourceId.value));
}

function setCreateAvailability(message, type = "") {
  const output = $("#createAvailability");
  output.className = `booking-calendar-message ${type}`.trim();
  output.textContent = message;
}

function setCreatePricing(message, type = "") {
  const output = $("#createPricing");
  output.className = `booking-calendar-message ${type}`.trim();
  output.textContent = message;
  const summary = output.closest(".booking-summary");
  const stateLabel = $("#createQuoteState");
  summary.dataset.quoteState = quoteState;
  stateLabel.dataset.state = quoteState;
  stateLabel.textContent = { stale: "neactualizat", calculating: "se calculează", fresh: "actual", error: "eroare" }[quoteState] || quoteState;
}

function pricingFormData(form) {
  const camping = activeWorkspace === "camping";
  const fields = {
    visitors: { value: form.elements.adults.value, type: "selectbox-one" },
    children: { value: form.elements.children.value, type: "selectbox-one" },
    starttime: { value: camping ? "14:00" : "15:00", type: "text" },
    endtime: { value: "12:00", type: "text" }
  };
  if (camping) {
    fields.car_plates = { value: form.elements.vehiclePlate.value, type: "text" };
    if (isCaravanResource(form.elements.resourceId.value) && form.elements.electricity.checked) fields.Energie_electrica = { value: "true", type: "checkbox" };
  } else if (form.elements.extraBed.checked) fields["pat-suplimentar"] = { value: "true", type: "checkbox" };
  return fields;
}

function updateCreateWorkspaceFields() {
  const form = $("#createForm");
  const camping = activeWorkspace === "camping";
  const caravan = camping && isCaravanResource(form.elements.resourceId.value);
  $("#createVehiclePlate").hidden = !camping;
  form.elements.vehiclePlate.required = caravan;
  $("#createElectricity").hidden = !caravan;
  form.elements.electricity.disabled = !caravan;
  if (!caravan) form.elements.electricity.checked = false;
  $("#createExtraBed").hidden = camping;
  if (camping) form.elements.extraBed.checked = false;
  document.querySelectorAll(".booking-legend > span:not(:first-child)").forEach((item) => { item.hidden = camping; });
  $("#createForm > header p").textContent = camping ? "Adăugare client camping" : "Adăugare client";
}

function quoteInput(form = $("#createForm"), { mode = "fast", forceFresh = false } = {}) {
  return {
    resourceId: Number(form.elements.resourceId.value),
    dates: rangeDates(form.elements.start.value, form.elements.end.value),
    formData: pricingFormData(form),
    bookingFormType: selectedResource()?.defaultForm || "",
    mode,
    forceFresh
  };
}

function currentQuoteKey(form = $("#createForm")) {
  if (!form.elements.resourceId.value || !form.elements.start.value || !form.elements.end.value) return "";
  return JSON.stringify([
    Number(form.elements.resourceId.value),
    form.elements.start.value,
    form.elements.end.value,
    form.elements.adults.value,
    form.elements.children.value,
    form.elements.extraBed.checked,
    form.elements.vehiclePlate.value,
    form.elements.electricity.checked,
    activeWorkspace,
    selectedResource()?.defaultForm || ""
  ]);
}

function formatCreateMoney(value, formatted = "") {
  if (String(formatted || "").trim()) return String(formatted).trim();
  return `${new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value) || 0)} lei`;
}

function createPricingNote(quote) {
  if (!quote?.valid) return "";
  return PricingNote.format(quote);
}

function updateCreateSubmitState() {
  const currentKey = currentQuoteKey();
  const currentQuoteAvailable = Boolean(createQuote?.valid && createQuoteKey === currentKey);
  $("#createSubmit").disabled = createSubmitting
    || !createSelectionEnd
    || availabilityState !== "available"
    || !currentQuoteAvailable
    || quoteState === "calculating";
  $("#createQuoteDetails").disabled = !createSelectionEnd || !currentQuoteAvailable || quoteState === "calculating";
}

function invalidateCreateQuote(message = "Se așteaptă calcularea prețului.") {
  clearTimeout(quoteTimer);
  quoteRequestId += 1;
  quoteState = "stale";
  $("#createQuoteBreakdown").hidden = true;
  void window.marina.clearQuoteCache();
  setCreatePricing(message);
  renderCreateSummary();
}

function fillGuestCounts() {
  const form = $("#createForm");
  const capacity = activeWorkspace === "camping" ? (isCaravanResource(form.elements.resourceId.value) ? 5 : 10) : Math.max(1, Number(selectedResource()?.capacity) || 4);
  const currentAdults = Number(form.elements.adults.value) || 1;
  const currentChildren = Number(form.elements.children.value) || 0;
  form.elements.adults.innerHTML = Array.from({ length: Math.max(4, capacity) }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join("");
  form.elements.children.innerHTML = Array.from({ length: 5 }, (_, index) => `<option value="${index}">${index}</option>`).join("");
  form.elements.adults.value = String(Math.min(currentAdults, Math.max(4, capacity)));
  form.elements.children.value = String(Math.min(currentChildren, 4));
}

function renderCreateSummary() {
  const form = $("#createForm");
  const nights = createSelectionEnd ? BookingCalendar.daysBetween(createSelectionStart, createSelectionEnd) : 0;
  if (createSelectionStart && createSelectionEnd) {
    $("#createDateSummary").innerHTML = `Date: <strong>${escapeHtml(calendarDateLabel(createSelectionStart))}</strong> – <strong>${escapeHtml(calendarDateLabel(createSelectionEnd))}</strong> · ${nights} nopți`;
  } else if (createSelectionStart) {
    $("#createDateSummary").innerHTML = `Date: <strong>${escapeHtml(calendarDateLabel(createSelectionStart))}</strong> – <span>selectați plecarea</span>`;
  } else {
    $("#createDateSummary").innerHTML = "Date: <span>…</span> – <span>…</span> nopți";
  }
  $("#createTotalCost").textContent = createQuote ? formatCreateMoney(createQuote.total, createQuote.formatted?.total) : "—";
  $("#createDepositCost").textContent = createQuote ? formatCreateMoney(createQuote.deposit, createQuote.formatted?.deposit) : "—";
  $("#createBalanceCost").textContent = createQuote ? formatCreateMoney(createQuote.balance, createQuote.formatted?.balance) : "—";
  form.elements.start.value = createSelectionStart;
  form.elements.end.value = createSelectionEnd;
  updateCreateSubmitState();
}

function createMonthHtml(month, position, occupancy) {
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  const firstOffset = (month.getUTCDay() + 6) % 7;
  const days = monthEnd(month).getUTCDate();
  const today = todayIso();
  const rangeStart = state.range?.start || "0000-01-01";
  const rangeEnd = state.range?.end || "9999-12-31";
  const minMonth = monthStart(utcDate(today > rangeStart ? today : rangeStart));
  const maxMonth = monthStart(addMonths(utcDate(rangeEnd), -1));
  const canGoBack = createCalendarMonth > minMonth;
  const canGoForward = createCalendarMonth < maxMonth;
  const navigation = position === 0
    ? `<button class="calendar-nav previous" data-calendar-nav="-1" type="button" aria-label="Luna precedentă" ${canGoBack ? "" : "hidden"}>‹</button>`
    : `<button class="calendar-nav next" data-calendar-nav="1" type="button" aria-label="Luna următoare" ${canGoForward ? "" : "hidden"}>›</button>`;
  const cells = Array.from({ length: 42 }, (_, index) => {
    const dayNumber = index - firstOffset + 1;
    if (dayNumber < 1 || dayNumber > days) return '<span class="calendar-blank"></span>';
    const value = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    const outside = value < rangeStart || value > rangeEnd;
    const past = value < today;
    const occupied = occupancy[value] || { am: "available", pm: "available" };
    const stateForDay = past ? { am: "available", pm: "available" } : { ...occupied };
    if (value === today) stateForDay.am = "available";
    const partial = stateForDay.am !== stateForDay.pm;
    const selected = createSelectionStart && value >= createSelectionStart && value <= (createSelectionEnd || createSelectionStart);
    const edge = value === createSelectionStart ? " selection-start" : value === createSelectionEnd ? " selection-end" : "";
    const classes = `calendar-day${partial ? " is-partial" : ""}${past ? " is-past" : ""}${outside ? " is-outside" : ""}${selected ? " is-selected" : ""}${edge}`;
    const status = partial ? "rezervat parțial" : stateForDay.am === "booked" ? "rezervat" : stateForDay.am === "pending" ? "în așteptare" : "disponibil";
    return `<button class="${classes} am-${stateForDay.am} pm-${stateForDay.pm}" data-calendar-date="${value}" type="button" aria-label="${dayNumber} ${escapeHtml(calendarMonthLabel(month))}, ${status}" ${(past || outside) ? "disabled" : ""}><span>${dayNumber}</span></button>`;
  }).join("");
  return `<article class="booking-month"><header>${navigation}<strong>${escapeHtml(calendarMonthLabel(month))}</strong></header><div class="calendar-weekdays">${CALENDAR_WEEKDAYS.map((day) => `<span>${day}</span>`).join("")}</div><div class="calendar-grid">${cells}</div></article>`;
}

function renderCreateCalendar() {
  const occupancy = createOccupancy();
  $("#createCalendar").innerHTML = `${createMonthHtml(createCalendarMonth, 0, occupancy)}${createMonthHtml(addMonths(createCalendarMonth, 1), 1, occupancy)}`;
  renderCreateSummary();
}

function selectCreateDate(value) {
  const occupancy = createOccupancy();
  const day = occupancy[value] || { am: "available", pm: "available" };
  let shouldCheck = false;
  if (!createSelectionStart || createSelectionEnd || value <= createSelectionStart) {
    if (day.pm !== "available") {
      setCreateAvailability("Sosirea nu poate începe în jumătatea rezervată a acestei zile.", "unavailable");
      return;
    }
    createSelectionStart = value;
    createSelectionEnd = "";
    availabilityState = "idle";
    invalidateCreateQuote("Selectați data plecării pentru calcularea prețului.");
    setCreateAvailability("Selectați data plecării.");
  } else {
    const availability = BookingCalendar.rangeAvailability(occupancy, createSelectionStart, value);
    if (!availability.available) {
      setCreateAvailability(`Intervalul se suprapune cu o rezervare în ${calendarDateLabel(availability.date)}.`, "unavailable");
      return;
    }
    createSelectionEnd = value;
    setCreateAvailability("Interval disponibil. Se verifică și pe server…", "available");
    shouldCheck = true;
  }
  renderCreateCalendar();
  if (shouldCheck) {
    scheduleAvailabilityCheck();
    schedulePriceCheck();
  }
}

function openCreate({ resourceId, date } = {}) {
  const form = $("#createForm");
  clearTimeout(availabilityTimer);
  clearTimeout(quoteTimer);
  availabilityRequestId += 1;
  quoteRequestId += 1;
  void window.marina.clearQuoteCache();
  form.reset();
  form.elements.approved.checked = false;
  form.elements.sendEmail.checked = false;
  const requestedResource = state.resources.find((resource) => Number(resource.id) === Number(resourceId) && resource.active !== false);
  form.elements.resourceId.value = requestedResource?.id || state.resources.find((resource) => resource.active !== false)?.id || "";
  updateCreateWorkspaceFields();
  createSelectionStart = "";
  createSelectionEnd = "";
  availabilityState = "idle";
  quoteState = "stale";
  createQuote = null;
  createQuoteKey = "";
  createCalendarMonth = monthStart(date ? utcDate(date) : todayIso());
  fillGuestCounts();
  if (date) {
    const candidateEnd = iso(addDays(date, 1));
    if (BookingCalendar.rangeAvailability(createOccupancy(), date, candidateEnd).available) {
      createSelectionStart = date;
      createSelectionEnd = candidateEnd;
    }
  }
  setCreateAvailability(createSelectionEnd ? "Interval disponibil. Se verifică și pe server…" : "Selectați data sosirii și data plecării.", createSelectionEnd ? "available" : "");
  setCreatePricing(createSelectionEnd ? "Se calculează prețul pe server…" : "Selectați datele pentru calcularea prețului.");
  renderCreateCalendar();
  createDialog.showModal();
  if (createSelectionEnd) {
    scheduleAvailabilityCheck();
    schedulePriceCheck();
  }
}

function formBookingInput(form) {
  return {
    resourceId: Number(form.elements.resourceId.value),
    dates: rangeDates(form.elements.start.value, form.elements.end.value),
    formData: {
      name: { value: form.elements.name.value, type: "text" },
      secondname: { value: form.elements.secondname.value, type: "text" },
      email: { value: form.elements.email.value, type: "email" },
      phone: { value: form.elements.phone.value, type: "text" },
      ...pricingFormData(form)
    },
    bookingFormType: selectedResource()?.defaultForm || "",
    note: createPricingNote(createQuote),
    approved: Boolean(form.elements.approved?.checked),
    sendEmail: Boolean(form.elements.sendEmail.checked)
  };
}

function renderQuoteBreakdown() {
  const output = $("#createQuoteBreakdown");
  if (!createQuote || createQuote.mode !== "full") {
    output.innerHTML = "";
    return;
  }
  const formatted = createQuote.formatted || {};
  const rows = [
    ["Preț inițial", formatCreateMoney(createQuote.original_cost, formatted.original_cost)],
    ["Cost suplimentar", formatCreateMoney(createQuote.additional_cost, formatted.additional_cost)],
    ["Reducere cupon", formatCreateMoney(createQuote.coupon_discount, formatted.coupon_discount)],
    ["Total", formatCreateMoney(createQuote.total, formatted.total)],
    ["Avans", formatCreateMoney(createQuote.deposit, formatted.deposit)],
    ["Rest", formatCreateMoney(createQuote.balance, formatted.balance)],
    ["Zile / nopți", `${Number(createQuote.days) || 0} / ${Number(createQuote.nights) || 0}`]
  ];
  output.innerHTML = rows.map(([label, value]) => `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`).join("");
}

async function fetchCreateQuote(requestId, key, { mode = "fast", forceFresh = false, source = activeWorkspace } = {}) {
  const form = $("#createForm");
  quoteState = "calculating";
  setCreatePricing(mode === "full" ? "Se calculează detaliile prețului…" : "Se calculează…");
  renderCreateSummary();
  try {
    const result = await window.marina.quoteBooking({ ...quoteInput(form, { mode, forceFresh }), source });
    if (source !== activeWorkspace || requestId !== quoteRequestId || key !== currentQuoteKey(form)) return false;
    if (result.valid === false) {
      quoteState = "error";
      setCreatePricing(result.message || "Intervalul nu poate fi tarifat.", "unavailable");
      renderCreateSummary();
      return false;
    }
    quoteState = "fresh";
    createQuote = { ...result, valid: true };
    createQuoteKey = key;
    setCreatePricing(mode === "full" ? "Preț complet confirmat de Booking Calendar." : "Preț calculat de Booking Calendar.", "available");
    renderQuoteBreakdown();
    renderCreateSummary();
    return true;
  } catch (error) {
    if (source !== activeWorkspace || requestId !== quoteRequestId || key !== currentQuoteKey(form)) return false;
    quoteState = "error";
    const unavailable = error?.code === "rest_no_route"
      ? "Actualizați Marina Booking API la versiunea 1.0.4 pentru calcularea prețului."
      : "Prețul nou nu a putut fi calculat. Ultimul preț afișat este vechi.";
    setCreatePricing(unavailable, "unavailable");
    renderCreateSummary();
    return false;
  }
}

function schedulePriceCheck() {
  clearTimeout(quoteTimer);
  const form = $("#createForm");
  const key = currentQuoteKey(form);
  const requestId = ++quoteRequestId;
  void window.marina.clearQuoteCache();
  if (!key) {
    quoteState = "stale";
    setCreatePricing("Selectați datele pentru calcularea prețului.");
    renderCreateSummary();
    return;
  }
  quoteState = "stale";
  $("#createQuoteBreakdown").hidden = true;
  setCreatePricing("Prețul afișat trebuie actualizat…");
  renderCreateSummary();
  const source = activeWorkspace;
  quoteTimer = setTimeout(() => void fetchCreateQuote(requestId, key, { mode: "fast", source }), 300);
}

async function refreshPriceNow({ forceFresh = true } = {}) {
  clearTimeout(quoteTimer);
  const key = currentQuoteKey();
  if (!key) return false;
  const requestId = ++quoteRequestId;
  return fetchCreateQuote(requestId, key, { mode: "full", forceFresh, source: activeWorkspace });
}

function requireValidQuote(result) {
  if (result?.valid === false) throw Object.assign(new Error(result.message || "Booking Calendar a respins acest calcul."), { code: "invalid_price_quote", permanent: true });
  return result;
}

function scheduleAvailabilityCheck() {
  clearTimeout(availabilityTimer);
  const requestId = ++availabilityRequestId;
  if (activeWorkspace === "camping") {
    availabilityState = "available";
    setCreateAvailability("Campingul are capacitate multiplă; alocarea finală este verificată de WordPress.", "available");
    updateCreateSubmitState();
    return;
  }
  availabilityTimer = setTimeout(async () => {
    const form = $("#createForm");
    if (!form.elements.resourceId.value || !form.elements.start.value || !form.elements.end.value || form.elements.start.value > form.elements.end.value) return;
    const resourceId = Number(form.elements.resourceId.value);
    const start = form.elements.start.value;
    const end = form.elements.end.value;
    const source = activeWorkspace;
    availabilityState = "checking";
    setCreateAvailability("Se verifică disponibilitatea…");
    updateCreateSubmitState();
    try {
      const result = await window.marina.checkAvailability({ resourceId, dates: BookingCalendar.toStayDateTimes(rangeDates(start, end)), source });
      if (source !== activeWorkspace || requestId !== availabilityRequestId || Number(form.elements.resourceId.value) !== resourceId || form.elements.start.value !== start || form.elements.end.value !== end) return;
      availabilityState = result.available ? "available" : "unavailable";
      setCreateAvailability(result.available ? "Datele sunt disponibile." : "Datele nu mai sunt disponibile.", result.available ? "available" : "unavailable");
      updateCreateSubmitState();
    } catch {
      if (source !== activeWorkspace || requestId !== availabilityRequestId || Number(form.elements.resourceId.value) !== resourceId || form.elements.start.value !== start || form.elements.end.value !== end) return;
      availabilityState = "error";
      setCreateAvailability("Verificarea online nu este disponibilă. Rezervarea nu poate fi trimisă.", "unavailable");
      updateCreateSubmitState();
    }
  }, 300);
}

function bookingField(booking, ...names) {
  return BookingFields.value(booking, ...names) || "—";
}

const DETAILS_FIELD_LABELS = {
  visitors: "Număr adulți",
  adults: "Număr adulți",
  children: "Număr copii",
  details: "Observații client",
  "pat-suplimentar": "Pat suplimentar (da/nu)",
  car_plates: "Număr de înmatriculare",
  Energie_electrica: "Energie electrică",
  coupon: "Cod promoțional"
};

function editableDetailsField(name, field) {
  if (BookingFields.matchesName(name, "firstName", "lastName", "email", "phone", "adults", "children")) return false;
  if (BookingFields.isDetailsField(name, field)) return true;
  if (name === "pat-suplimentar") return activeWorkspace === "rooms";
  if (isElectricityField(name)) return activeWorkspace === "camping";
  return isVehiclePlateField(name);
}

function isVehiclePlateField(name) {
  return BookingFields.matchesName(name, "car_plates", "carplates", "vehiclePlate", "vehicle_plate", "licensePlate", "license_plate");
}

function isElectricityField(name) {
  return String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/\d+$/, "") === "energieelectrica";
}

function detailsFieldLabel(name, field) {
  if (BookingFields.isDetailsField(name, field)) return DETAILS_FIELD_LABELS.details;
  if (isVehiclePlateField(name)) return DETAILS_FIELD_LABELS.car_plates;
  if (isElectricityField(name)) return DETAILS_FIELD_LABELS.Energie_electrica;
  if (DETAILS_FIELD_LABELS[name]) return DETAILS_FIELD_LABELS[name];
  const label = name.replace(/[-_]+/g, " ").trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Câmp suplimentar";
}

function detailsFieldHtml(name, field) {
  const label = detailsFieldLabel(name, field);
  const attributes = `data-extra-field="${escapeHtml(name)}" data-field-type="${escapeHtml(field.type || "text")}"`;
  const value = escapeHtml(field.value || "");
  if (name === "pat-suplimentar" || isElectricityField(name)) {
    const checked = !["", "0", "false", "no", "off"].includes(String(field.value || "").trim().toLowerCase());
    return `<label class="check extra-checkbox"><input type="checkbox" ${attributes} value="true"${checked ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`;
  }
  if (BookingFields.isDetailsField(name, field)) return `<label class="span-2">${escapeHtml(label)}<textarea ${attributes} rows="3">${value}</textarea></label>`;
  const numeric = ["visitors", "adults", "children"].includes(name) ? ' inputmode="numeric"' : "";
  return `<label>${escapeHtml(label)}<input ${attributes}${numeric} value="${value}"></label>`;
}

function formatMenuDate(value) {
  return dateOnlyFormatter("ro-RO", { day: "numeric", month: "long", year: "numeric" }).format(utcDate(value));
}

function populateBookingMenu(booking) {
  selectedBookingId = booking.localId;
  selectedBookingView = "menu";
  const resource = resourceById(booking.resourceId);
  const firstName = bookingField(booking, "firstName");
  const lastName = bookingField(booking, "lastName");
  const email = bookingField(booking, "email");
  const phone = bookingField(booking, "phone");
  const adults = bookingField(booking, "adults");
  const children = bookingField(booking, "children");
  const details = BookingFields.detailsValue(booking) || "—";
  const extraBed = bookingField(booking, "pat-suplimentar");
  const approved = booking.status === "approved";
  const statusLabel = approved ? "Aprobată" : "În așteptare";
  const note = String(booking.note || "").trim();
  const updated = booking.updatedAt ? new Intl.DateTimeFormat("ro-RO", { dateStyle: "medium", timeStyle: "short", timeZone: configuredTimeZone() }).format(new Date(booking.updatedAt)) : "";
  $("#bookingPaymentMenu").hidden = true;
  $("#bookingPaymentMenuToggle").setAttribute("aria-expanded", "false");
  $("#bookingMenuTitle").textContent = `ID: ${booking.serverId || "local"}`;
  $("#bookingMenuStatus").classList.toggle("is-pending-action", approved);
  $("#bookingMenuStatus").querySelector(".action-label").textContent = approved ? "Pune în așteptare" : "Aprobă";
  $("#bookingMenuStatus").title = approved ? "Pune rezervarea în așteptare" : "Aprobă rezervarea";
  $("#bookingMenuTrash").querySelector(".action-label").textContent = booking.trashed ? "Restabilește" : "Gunoi";
  $("#bookingMenuTrash").title = booking.trashed ? "Restabilește rezervarea" : "Mută rezervarea la gunoi";
  $("#bookingMenuContent").innerHTML = `
    <div class="booking-menu-badges">
      <span class="booking-id-badge">${escapeHtml(String(booking.serverId || "local"))}</span>
      <span class="booking-status-badge ${approved ? "approved" : "pending"}">${statusLabel}</span>
      <span class="booking-resource-badge">${escapeHtml(resource?.title || `Spațiul ${booking.resourceId}`)}</span>
      ${booking.syncState !== "synced" ? `<span class="booking-sync-badge">${escapeHtml(booking.syncState)}</span>` : ""}
    </div>
    <div class="booking-menu-facts">
      <span><strong>Prenume:</strong>${escapeHtml(firstName)}</span>
      <span><strong>Nume:</strong>${escapeHtml(lastName)}</span>
      <span class="wide"><strong>Email:</strong>${escapeHtml(email)}</span>
      <span><strong>Telefon:</strong>${escapeHtml(phone)}</span>
      <span><strong>Adulți:</strong>${escapeHtml(adults)}</span>
      <span><strong>Copii:</strong>${escapeHtml(children)}</span>
      <span><strong>Detalii:</strong>${escapeHtml(details)}</span>
      ${activeWorkspace === "rooms" ? `<span><strong>Pat suplimentar:</strong>${escapeHtml(extraBed)}</span>` : ""}
    </div>
    ${note ? `<div class="booking-menu-note"><strong>Notă:</strong>${escapeHtml(note)}</div>` : ""}
    <div class="booking-menu-dates">
      <span>${escapeHtml(formatMenuDate(booking.dates[0]))} <small>15:00</small></span>
      <b>→</b>
      <span>${escapeHtml(formatMenuDate(booking.dates[booking.dates.length - 1]))} <small>12:00</small></span>
    </div>
    ${updated ? `<p class="booking-menu-updated">Updated: ${escapeHtml(updated)}</p>` : ""}
  `;
}

function prepareBookingMenuPosition() {
  bookingMenu.style.position = "fixed";
  bookingMenu.style.right = "auto";
  bookingMenu.style.bottom = "auto";
}

function positionBookingMenu(anchorRect) {
  prepareBookingMenuPosition();
  const mobile = window.matchMedia("(max-width: 900px)").matches;
  const margin = mobile ? 6 : 10;
  const targetWidth = Math.min(mobile ? 320 : 342, window.innerWidth - margin * 2);
  const targetMaxHeight = Math.min(mobile ? 440 : window.innerHeight - margin * 2, window.innerHeight - margin * 2);
  bookingMenu.style.width = `${targetWidth}px`;
  bookingMenu.style.maxHeight = `${targetMaxHeight}px`;
  const width = bookingMenu.offsetWidth;
  const height = bookingMenu.offsetHeight;
  const left = Math.min(window.innerWidth - width - margin, Math.max(margin, anchorRect.left));
  const below = anchorRect.bottom + 7;
  const above = anchorRect.top - height - 7;
  const top = below + height <= window.innerHeight - margin
    ? below
    : above >= margin
      ? above
      : Math.min(window.innerHeight - height - margin, Math.max(margin, anchorRect.top - height / 3));
  bookingMenu.style.left = `${left}px`;
  bookingMenu.style.top = `${top}px`;
}

function openBookingMenu(booking, anchor) {
  if (!booking) return;
  const anchorRect = anchor.getBoundingClientRect();
  if (selectedBookingId !== booking.localId) void window.marina.clearQuoteCache();
  detailsPanel.hidden = true;
  populateBookingMenu(booking);
  prepareBookingMenuPosition();
  bookingMenu.hidden = false;
  positionBookingMenu(anchorRect);
}

function dismissBookingMenu() {
  if (bookingMenu.hidden) return;
  $("#bookingPaymentMenu").hidden = true;
  $("#bookingPaymentMenuToggle").setAttribute("aria-expanded", "false");
  bookingMenu.hidden = true;
  if (selectedBookingView === "menu") {
    selectedBookingId = null;
    selectedBookingView = "";
  }
}

function closeBookingOverlays() {
  $("#bookingPaymentMenu").hidden = true;
  $("#bookingPaymentMenuToggle").setAttribute("aria-expanded", "false");
  bookingMenu.hidden = true;
  detailsPanel.hidden = true;
  if (paymentDialog.open) paymentDialog.close();
  selectedBookingId = null;
  selectedBookingView = "";
}

function dismissTopLayer() {
  if (settingsDialog.open) { settingsWorkspace = null; settingsDialog.close(); return true; }
  if (createDialog.open) { createDialog.close(); return true; }
  if (paymentDialog.open) { paymentDialog.close(); selectedBookingId = null; selectedBookingView = ""; return true; }
  if (!bookingMenu.hidden) { dismissBookingMenu(); return true; }
  if (!detailsPanel.hidden) {
    detailsPanel.hidden = true;
    selectedBookingId = null;
    selectedBookingView = "";
    return true;
  }
  if (!diagnostics.hidden) { diagnostics.hidden = true; return true; }
  return false;
}

window.addEventListener("marina:back", (event) => {
  if (!dismissTopLayer()) return;
  event.preventDefault();
});

function populateDetails(booking, reset = true) {
  selectedBookingId = booking.localId;
  selectedBookingView = "edit";
  bookingMenu.hidden = true;
  const form = $("#detailsForm");
  const approved = booking.status === "approved";
  $("#detailsStatus").textContent = approved ? "Pune în așteptare" : "Aprobă";
  $("#detailsStatus").title = approved ? "Pune rezervarea în așteptare" : "Aprobă rezervarea";
  $("#detailsTrash").textContent = booking.trashed ? "Restabilește" : "Gunoi";
  $("#detailsTrash").title = booking.trashed ? "Restabilește rezervarea" : "Mută rezervarea la gunoi";
  if (reset) {
    form.reset();
    form.elements.name.value = BookingFields.value(booking, "firstName");
    form.elements.secondname.value = BookingFields.value(booking, "lastName");
    form.elements.email.value = BookingFields.value(booking, "email");
    form.elements.phone.value = BookingFields.value(booking, "phone");
    form.elements.sendEmail.checked = false;
    form.elements.visitors.value = BookingFields.value(booking, "adults") || booking.formData?.visitors_val?.value || "1";
    form.elements.children.value = BookingFields.value(booking, "children") || booking.formData?.children_val?.value || "0";
    const extraFields = Object.entries(booking.formData || {}).filter(([name, field]) => editableDetailsField(name, field));
    const vehicleFields = extraFields.filter(([name]) => isVehiclePlateField(name));
    const vehicleField = vehicleFields.find(([, field]) => String(field?.value || "").trim()) || vehicleFields[0];
    const clientFields = vehicleField ? [vehicleField] : [];
    const optionFields = extraFields.filter(([name, field]) => !isVehiclePlateField(name) && !isElectricityField(name) && !BookingFields.isDetailsField(name, field));
    const electricityFields = extraFields.filter(([name]) => isElectricityField(name));
    if (activeWorkspace === "camping") optionFields.push(electricityFields.find(([, field]) => String(field?.value || "").trim()) || electricityFields[0] || ["Energie_electrica", { value: "no", type: "checkbox" }]);
    const namedObservation = extraFields.find(([name, field]) => BookingFields.matchesName(name, "details") && BookingFields.isDetailsField(name, field));
    const observation = namedObservation || extraFields.find(([name, field]) => !isVehiclePlateField(name) && BookingFields.isDetailsField(name, field));
    const reservationFields = observation ? [...optionFields, observation] : optionFields;
    $("#clientExtraFields").hidden = clientFields.length === 0;
    $("#clientExtraFields").innerHTML = clientFields.map(([name, field]) => detailsFieldHtml(name, field)).join("");
    $("#reservationExtraFields").hidden = reservationFields.length === 0;
    $("#reservationExtraFields").innerHTML = reservationFields.map(([name, field]) => detailsFieldHtml(name, field)).join("");
    form.elements.resourceId.value = booking.resourceId;
    form.elements.start.value = booking.dates[0];
    form.elements.end.value = booking.dates[booking.dates.length - 1];
    form.elements.note.value = booking.note || "";
  }
  const clientName = [BookingFields.value(booking, "firstName"), BookingFields.value(booking, "lastName")].filter(Boolean).join(" ").trim();
  $("#detailsTitle").textContent = clientName || `Rezervarea ${booking.serverId || "locală"}`;
  renderCommands();
  detailsPanel.hidden = false;
}

function populatePaymentDialog(booking, reset = true) {
  selectedBookingId = booking.localId;
  selectedBookingView = "payment";
  bookingMenu.hidden = true;
  detailsPanel.hidden = true;
  const form = $("#paymentForm");
  if (reset) form.reset();
  const clientName = [BookingFields.value(booking, "firstName"), BookingFields.value(booking, "lastName")].filter(Boolean).join(" ").trim();
  $("#paymentDialogTitle").textContent = clientName ? `Avans — ${clientName}` : `Avans rezervare ${booking.serverId || "locală"}`;
  renderPaymentSection(booking, reset);
  if (!paymentDialog.open) paymentDialog.showModal();
  const unresolvedDeposit = unresolvedPaymentCommand(booking, "deposit_update");
  if (reset || (!paymentSnapshots.has(booking.localId) && !paymentSnapshotErrors.has(booking.localId) && !paymentSnapshotLoading.has(booking.localId) && !unresolvedDeposit)) void refreshPaymentSnapshot(booking);
}

async function refreshPaymentSnapshot(booking) {
  const key = booking.localId;
  if (paymentSnapshotLoading.has(key)) return;
  paymentSnapshotLoading.add(key);
  paymentSnapshotErrors.delete(key);
  renderPaymentSection(booking, false);
  try {
    const snapshot = await window.marina.getPayment(booking.localId, { source: activeWorkspace });
    paymentSnapshots.set(key, snapshot);
  } catch (error) {
    paymentSnapshotErrors.set(key, error.message || "Plata nu a putut fi verificată pe server.");
  } finally {
    paymentSnapshotLoading.delete(key);
    const current = bookingById(key);
    if (current && selectedBookingView === "payment" && selectedBookingId === key) renderPaymentSection(current, false);
  }
}

function unresolvedPaymentCommand(booking, type) {
  return state.commands.find((command) => command.bookingLocalId === booking.localId && command.type === type && ["queued", "sending", "failed", "conflict", "needs_attention"].includes(command.status));
}

function paymentAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function renderPaymentSection(booking, reset = false) {
  const form = $("#paymentForm");
  const depositCommand = unresolvedPaymentCommand(booking, "deposit_update");
  const emailCommand = unresolvedPaymentCommand(booking, "payment_request");
  const snapshot = paymentSnapshots.get(booking.localId);
  const snapshotError = paymentSnapshotErrors.get(booking.localId);
  const serverNoteAvailable = typeof snapshot?.note === "string";
  const note = serverNoteAvailable ? snapshot.note : String(booking.note || "");
  const pricing = PricingNote.parse(note);
  const pendingDeposit = depositCommand && ["queued", "sending"].includes(depositCommand.status);
  const databaseDeposit = paymentAmount(snapshot?.deposit);
  const snapshotTotal = paymentAmount(snapshot?.total);
  const total = snapshotTotal ?? paymentAmount(pricing?.total);
  const deposit = paymentAmount(pendingDeposit ? depositCommand.payload?.deposit : databaseDeposit ?? pricing?.deposit);
  const balance = total !== null && deposit !== null ? Math.round((total - deposit) * 100) / 100 : paymentAmount(pricing?.balance);
  const amountsAvailable = [total, deposit, balance].every((value) => value !== null);
  const authoritativePaymentAvailable = Boolean(snapshot && snapshotTotal !== null && databaseDeposit !== null);
  if (reset || document.activeElement !== form.elements.depositAmount) form.elements.depositAmount.value = Number.isFinite(deposit) ? String(deposit) : "";
  $("#paymentFacts").innerHTML = amountsAvailable
    ? `<span><strong>Cost</strong>${escapeHtml(PricingNote.formatAmount(total))} lei</span><span><strong>Avans</strong>${escapeHtml(PricingNote.formatAmount(deposit))} lei</span><span><strong>Rest</strong>${escapeHtml(PricingNote.formatAmount(balance))} lei</span>`
    : '<span class="payment-unavailable">Valorile plății nu au putut fi verificate.</span>';
  $("#paymentNoteLabel").textContent = serverNoteAvailable ? "Notă WordPress" : "Notă locală";
  $("#paymentNoteText").textContent = note || "Nu există notă.";
  $("#paymentDatabaseDeposit").textContent = databaseDeposit === null ? "Se verifică…" : `${PricingNote.formatAmount(databaseDeposit)} lei`;
  $("#saveDeposit").disabled = !authoritativePaymentAvailable || !booking.serverId || Boolean(depositCommand || emailCommand);
  const email = BookingFields.value(booking, "email") || snapshot?.email;
  const verifiedForEmail = pendingDeposit || (authoritativePaymentAvailable && snapshot.email_available !== false);
  $("#sendPaymentRequest").disabled = !booking.serverId || booking.trashed || !email || !verifiedForEmail || Boolean(emailCommand);
  let status = "";
  if (depositCommand && ["failed", "conflict", "needs_attention"].includes(depositCommand.status)) status = `${depositCommand.errorMessage || `Avans: ${displayStatus(depositCommand.status)}.`}${emailCommand ? " Emailul rămâne blocat până la rezolvare." : ""}`;
  else if (emailCommand) status = emailCommand.status === "queued" ? "Email programat; va fi trimis după salvarea avansului." : emailCommand.errorMessage || `Email: ${displayStatus(emailCommand.status)}.`;
  else if (depositCommand) status = depositCommand.status === "queued" ? "Avans salvat în coadă." : depositCommand.errorMessage || `Avans: ${displayStatus(depositCommand.status)}.`;
  else if (paymentSnapshotLoading.has(booking.localId)) status = "Se verifică suma nativă de plată…";
  else if (snapshotError) status = `Suma nativă nu a putut fi verificată: ${snapshotError}`;
  else if (!authoritativePaymentAvailable) status = "WordPress nu a returnat un cost și un avans valide.";
  else if (!email) status = "Rezervarea nu are o adresă de email. Adaugă emailul în Detalii rezervare.";
  else if (snapshot?.email_available === false) status = "Emailurile de plată nu sunt disponibile în configurația WordPress.";
  $("#paymentStatus").textContent = status;
}

function pointerDate(event) {
  const rect = timelineShell.getBoundingClientRect();
  const x = (event.clientX - rect.left) / cameraScale - timelineUnitWidth() + timelineScrollLeft();
  return addDays(windowStart, Math.max(0, Math.min(dayCount - 1, Math.floor(x / dayWidth))));
}

function updateVisibleMonthFromScroll() {
  if (suppressMonthUpdate || performance.now() < monthNavigationLockedUntil) return;
  const visibleDay = Math.max(0, Math.round(timelineScrollLeft() / dayWidth));
  const month = monthStart(addDays(windowStart, visibleDay));
  if (month.getTime() === focusMonth.getTime()) return;
  focusMonth = month;
  $("#monthLabel").textContent = formatMonth(focusMonth);
}

function shiftTimelineWindow(monthDelta) {
  const oldStart = windowStart;
  const oldLeft = timelineScrollLeft();
  windowStart = addMonths(windowStart, monthDelta);
  currentRange();
  const adjustment = daysBetween(oldStart, windowStart) * dayWidth;
  renderTimeline({ preserveScroll: true });
  const nextLeft = Math.max(0, oldLeft - adjustment);
  setTimelineScrollLeft(nextLeft);
  lastScrollLeft = timelineShell.scrollLeft;
  renderVisibleRows(true);
  if (dragState) {
    dragState.scrollLeft -= adjustment;
    dragState.bar = guestTimeline.querySelector(`[data-booking-id="${CSS.escape(dragState.booking.localId)}"]`);
    dragState.bar?.classList.add("is-dragging");
    updateDraggedBar();
  } else {
    void refreshRange({ force: false, quiet: true, desiredLeft: nextLeft });
  }
}

function recenterTimelineWindow(force = false) {
  const maxScroll = Math.max(0, guestTimeline.scrollWidth - timelineShell.clientWidth);
  if (!maxScroll) return false;
  const now = performance.now();
  if (!force && now - lastRecenterAt < 250) return false;
  const edge = Math.min(dayWidth * 28, maxScroll * 0.2);
  const scrollLeft = timelineScrollLeft();
  let direction = 0;
  if (scrollLeft >= maxScroll - edge) direction = TIMELINE_WINDOW_SHIFT_MONTHS;
  else if (scrollLeft <= edge) direction = -TIMELINE_WINDOW_SHIFT_MONTHS;
  if (!direction) return false;
  lastRecenterAt = now;
  shiftTimelineWindow(direction);
  return true;
}

function handleTimelineScroll() {
  dismissBookingMenu();
  const horizontal = Math.abs(timelineShell.scrollLeft - lastScrollLeft) >= 1;
  lastScrollLeft = timelineShell.scrollLeft;
  if (horizontal) recenterTimelineWindow();
  updateVisibleMonthFromScroll();
  queueRowRender();
}

function handleTimelineWheel(event) {
  if (event.ctrlKey) {
    cancelDrag();
    event.preventDefault();
    if (!wheelPinchState) wheelPinchState = { mode: null, x: 0, y: 0, timer: null };
    wheelPinchState.x += event.deltaX;
    wheelPinchState.y += event.deltaY;
    clearTimeout(wheelPinchState.timer);
    wheelPinchState.timer = setTimeout(() => {
      if (wheelPinchState?.mode === "horizontal") finishTimelineZoom();
      else if (wheelPinchState?.mode === "vertical") finishCameraTransform();
      wheelPinchState = null;
    }, 140);
    if (!wheelPinchState.mode) {
      if (Math.max(Math.abs(wheelPinchState.x), Math.abs(wheelPinchState.y)) < PINCH_DIRECTION_THRESHOLD) return;
      const isHorizontal = Math.abs(wheelPinchState.x) > Math.abs(wheelPinchState.y);
      wheelPinchState.mode = isHorizontal ? "horizontal" : "vertical";
    }
    if (wheelPinchState.mode === "horizontal") {
      const baseWidth = pendingTimelineZoom?.nextWidth ?? dayWidth;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      queueTimelineZoom(baseWidth * Math.exp(-delta * 0.01), event.clientX);
    } else if (wheelPinchState.mode === "vertical") {
      beginCameraInteraction();
      const current = currentCameraState();
      queueCameraState(zoomCameraAt(event.clientX, event.clientY, current.scale * Math.exp(-event.deltaY * 0.01)));
    }
    return;
  }
  if (dragState) return;
  const factor = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? timelineShell.clientWidth : 1;
  const x = event.deltaX * factor;
  const y = event.deltaY * factor;
  const horizontal = event.shiftKey ? y : x;
  if ((!event.shiftKey && Math.abs(horizontal) <= Math.abs(y)) || horizontal === 0) return;
  event.preventDefault();
  timelineShell.scrollLeft += horizontal;
  lastScrollLeft = timelineShell.scrollLeft;
  recenterTimelineWindow();
  updateVisibleMonthFromScroll();
  queueRowRender();
}

function autoScrollDuringDrag(event) {
  const rect = timelineShell.getBoundingClientRect();
  const edge = 72 * cameraScale;
  if (event.clientX > rect.right - edge) timelineShell.scrollLeft += dayWidth * 2;
  else if (event.clientX < rect.left + edge) timelineShell.scrollLeft -= dayWidth * 2;
  else return;
  lastScrollLeft = timelineShell.scrollLeft;
  recenterTimelineWindow(true);
}

function beginDrag(event) {
  if (event.pointerType === "touch") return;
  if (event.button !== 0) return;
  const bar = event.target.closest(".timeline-bar");
  if (!bar) return;
  const mode = event.target.closest(".timeline-handle")?.dataset.dragMode;
  if (mode !== "resize-start" && mode !== "resize-end") return;
  const booking = bookingById(bar.dataset.bookingId);
  if (!booking) return;
  event.preventDefault();
  try { bar.setPointerCapture(event.pointerId); } catch {}
  dragState = { pointerId: event.pointerId, bar, booking, mode, clientX: event.clientX, scrollLeft: timelineScrollLeft(), originalDates: [...booking.dates], originalSyncState: booking.syncState, lastDelta: 0, changed: false };
  bar.classList.add("is-dragging");
  bar.closest(".timeline-row")?.classList.add("is-drop-target");
}

function updateDraggedBar() {
  if (!dragState?.bar) return;
  const { bar, booking } = dragState;
  const start = Math.max(0, daysBetween(windowStart, booking.dates[0]));
  const end = Math.min(dayCount, daysBetween(windowStart, booking.dates[booking.dates.length - 1]) + 1);
  const duration = booking.dates.length;
  bar.style.gridColumn = `${start + 2} / ${end + 2}`;
  bar.classList.toggle("is-compact", duration <= 2);
  bar.classList.toggle("is-tight", duration > 2 && duration <= 4);
  const todayIndex = daysBetween(windowStart, todayIso());
  setTimelineBarPastDays(bar, Math.max(0, Math.min(end - start, todayIndex - start)));
  const meta = bar.querySelector(".timeline-bar-meta");
  if (meta) meta.textContent = `${formatDate(booking.dates[0])}–${formatDate(booking.dates[booking.dates.length - 1])}`;
}

function moveDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  autoScrollDuringDrag(event);
  const delta = Math.round(((event.clientX - dragState.clientX) / cameraScale + timelineScrollLeft() - dragState.scrollLeft) / dayWidth);
  if (delta === dragState.lastDelta) return;
  let start = utcDate(dragState.originalDates[0]);
  let end = utcDate(dragState.originalDates[dragState.originalDates.length - 1]);
  const minimumSpan = Math.max(0, daysBetween(start, end) - 1);
  if (dragState.mode === "resize-start") start = addDays(start, Math.min(delta, minimumSpan));
  else end = addDays(end, Math.max(delta, -minimumSpan));
  const nextDates = rangeDates(start, end);
  if (!nextDates.length) return;
  dragState.booking.dates = nextDates;
  dragState.booking.startDate = iso(start);
  dragState.booking.endDate = iso(end);
  dragState.booking.syncState = "queued";
  dragState.lastDelta = delta;
  dragState.changed = nextDates.length !== dragState.originalDates.length || nextDates.some((date, index) => date !== dragState.originalDates[index]);
  updateDraggedBar();
  dragState.bar?.classList.add("is-dragging");
  dragState.bar?.closest(".timeline-row")?.classList.add("is-drop-target");
}

async function endDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const completed = dragState;
  dragState = null;
  completed.bar.classList.remove("is-dragging");
  completed.bar.closest(".timeline-row")?.classList.remove("is-drop-target");
  if (!completed.changed) return;
  lastDragEndedAt = performance.now();
  const source = activeWorkspace;
  try {
    const bookingFormType = resourceById(completed.booking.resourceId)?.defaultForm || "";
    const formData = BookingFields.prepareFormData(completed.booking.formData, completed.booking.resourceId);
    requireValidQuote(await window.marina.quoteBooking({ resourceId: completed.booking.resourceId, sourceResourceId: completed.booking.resourceId, dates: completed.booking.dates, formData, bookingFormType, mode: "full", forceFresh: true, source }));
    if (source !== activeWorkspace) throw workspaceChangedError();
    await runApiAction("editBooking", completed.booking.localId, { dates: completed.booking.dates, resourceId: completed.booking.resourceId, sourceResourceId: completed.booking.resourceId, formData, bookingFormType, source });
    renderTimeline();
    void refreshRange({ force: false, quiet: true });
  } catch (error) {
    completed.booking.dates = completed.originalDates;
    completed.booking.startDate = completed.originalDates[0];
    completed.booking.endDate = completed.originalDates[completed.originalDates.length - 1];
    completed.booking.syncState = completed.originalSyncState;
    showError(error);
    renderTimeline();
  }
}

function cancelDrag() {
  if (!dragState) return;
  const cancelled = dragState;
  dragState = null;
  cancelled.booking.dates = cancelled.originalDates;
  cancelled.booking.startDate = cancelled.originalDates[0];
  cancelled.booking.endDate = cancelled.originalDates[cancelled.originalDates.length - 1];
  cancelled.booking.syncState = cancelled.originalSyncState;
  cancelled.bar?.classList.remove("is-dragging");
  cancelled.bar?.closest(".timeline-row")?.classList.remove("is-drop-target");
  renderTimeline();
}

timelineShell.addEventListener("scroll", handleTimelineScroll, { passive: true });
cameraViewport.addEventListener("wheel", handleTimelineWheel, { passive: false });
cameraViewport.addEventListener("touchstart", beginTouchZoom, { passive: false });
cameraViewport.addEventListener("touchmove", moveTouchZoom, { passive: false });
cameraViewport.addEventListener("touchend", endTouchZoom, { passive: true });
cameraViewport.addEventListener("touchcancel", endTouchZoom, { passive: true });
guestTimeline.addEventListener("pointerdown", beginDrag);
document.addEventListener("pointermove", moveDrag);
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", cancelDrag);
guestTimeline.addEventListener("click", (event) => {
  if (dragState || performance.now() - lastDragEndedAt < 250 || performance.now() - lastCameraPanEndedAt < 250) return;
  const bar = event.target.closest(".timeline-bar");
  if (bar) openBookingMenu(bookingById(bar.dataset.bookingId), bar);
});
guestTimeline.addEventListener("dblclick", (event) => {
  if (event.target.closest(".timeline-bar")) return;
  const row = event.target.closest(".timeline-row");
  if (row) openCreate({ resourceId: Number(row.dataset.resourceId), date: iso(pointerDate(event)) });
});

document.querySelector(".workspace-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-workspace]");
  if (tab) void switchWorkspace(tab.dataset.workspace);
});
$("#openCreate").addEventListener("click", () => openCreate());
createDialog.addEventListener("close", () => {
  clearTimeout(availabilityTimer);
  clearTimeout(quoteTimer);
  availabilityRequestId += 1;
  quoteRequestId += 1;
  void window.marina.clearQuoteCache();
});
$("#closeCreateDialog").addEventListener("click", () => createDialog.close());
$("#cancelCreateDialog").addEventListener("click", () => createDialog.close());
$("#createCalendar").addEventListener("click", (event) => {
  const navigation = event.target.closest("[data-calendar-nav]");
  if (navigation) {
    createCalendarMonth = addMonths(createCalendarMonth, Number(navigation.dataset.calendarNav));
    renderCreateCalendar();
    return;
  }
  const day = event.target.closest("[data-calendar-date]");
  if (day) selectCreateDate(day.dataset.calendarDate);
});
$("#createForm").elements.resourceId.addEventListener("change", () => {
  createSelectionStart = "";
  createSelectionEnd = "";
  availabilityState = "idle";
  updateCreateWorkspaceFields();
  fillGuestCounts();
  setCreateAvailability("Selectați data sosirii și data plecării.");
  invalidateCreateQuote("Selectați datele pentru calcularea prețului.");
  renderCreateCalendar();
});
$("#createForm").elements.adults.addEventListener("change", schedulePriceCheck);
$("#createForm").elements.children.addEventListener("change", schedulePriceCheck);
$("#createForm").elements.extraBed.addEventListener("change", schedulePriceCheck);
$("#createForm").elements.vehiclePlate.addEventListener("input", schedulePriceCheck);
$("#createForm").elements.electricity.addEventListener("change", schedulePriceCheck);
$("#createQuoteDetails").addEventListener("click", async () => {
  const breakdown = $("#createQuoteBreakdown");
  if (!breakdown.hidden) {
    breakdown.hidden = true;
    return;
  }
  breakdown.hidden = false;
  if (!await refreshPriceNow({ forceFresh: false })) breakdown.hidden = true;
});
$("#createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.elements.start.value || !form.elements.end.value) {
    setCreateAvailability("Selectați un interval disponibil.", "unavailable");
    return;
  }
  if (availabilityState !== "available") {
    setCreateAvailability("Disponibilitatea trebuie confirmată online înainte de trimitere.", "unavailable");
    return;
  }
  const source = activeWorkspace;
  await runExclusive(`create:${source}`, [$("#createSubmit")], async () => {
    createSubmitting = true;
    updateCreateSubmitState();
    try {
      if (!await refreshPriceNow({ forceFresh: true })) return;
      if (source !== activeWorkspace || !createDialog.open) throw workspaceChangedError();
      const input = { ...formBookingInput(form), source };
      createDialog.close();
      const created = await runApiAction("createBooking", input);
      await waitForCreatedBooking(created, input, source);
    } catch (error) { showError(error); }
    finally { createSubmitting = false; updateCreateSubmitState(); }
  });
});

$("#detailsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const booking = bookingById(selectedBookingId);
  if (!booking) { showError(new Error("Rezervarea nu a mai fost găsită. Reîncarcă lista și încearcă din nou.")); return; }
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    const invalid = form.querySelector(":invalid");
    invalid?.focus();
    showError(new Error(invalid?.validationMessage || "Completează câmpurile obligatorii înainte de salvare."));
    return;
  }
  const visitors = form.elements.visitors.value;
  const children = form.elements.children.value;
  const formData = { ...booking.formData };
  BookingFields.assign(formData, "name", ["firstName"], form.elements.name.value, "text");
  BookingFields.assign(formData, "secondname", ["lastName"], form.elements.secondname.value, "text");
  BookingFields.assign(formData, "email", ["email"], form.elements.email.value, "email");
  BookingFields.assign(formData, "phone", ["phone"], form.elements.phone.value, "text");
  BookingFields.assign(formData, "visitors", ["adults"], visitors, "selectbox-one");
  BookingFields.assign(formData, "children", ["children"], children, "selectbox-one");
  if (booking.formData?.visitors_val) formData.visitors_val = { ...booking.formData.visitors_val, value: visitors };
  if (booking.formData?.children_val) formData.children_val = { ...booking.formData.children_val, value: children };
  for (const input of form.querySelectorAll("[data-extra-field]")) {
    const value = input.type === "checkbox" ? (input.checked ? "true" : "no") : input.value;
    formData[input.dataset.extraField] = { value, type: input.dataset.fieldType || (input.type === "checkbox" ? "checkbox" : "text") };
  }
  const source = activeWorkspace;
  const saveButton = form.querySelector('[type="submit"]');
  await runExclusive(`booking:${source}:${booking.localId}`, [saveButton], async () => { try {
    const resourceId = Number(form.elements.resourceId.value);
    if (!form.elements.start.value || !form.elements.end.value || form.elements.start.value >= form.elements.end.value) {
      throw Object.assign(new Error("Plecare trebuie să fie după sosire."), { code: "invalid_date_range", permanent: true });
    }
    const dates = rangeDates(form.elements.start.value, form.elements.end.value);
    const bookingFormType = resourceById(resourceId)?.defaultForm || "";
    const outboundFormData = BookingFields.prepareFormData(formData, booking.resourceId);
    requireValidQuote(await window.marina.quoteBooking({ resourceId, sourceResourceId: booking.resourceId, dates, formData: outboundFormData, bookingFormType, mode: "full", forceFresh: true, source }));
    if (source !== activeWorkspace || selectedBookingId !== booking.localId) throw workspaceChangedError();
    closeBookingOverlays();
    await runApiAction("editBooking", booking.localId, { resourceId, sourceResourceId: booking.resourceId, dates, formData: outboundFormData, bookingFormType, note: form.elements.note.value, sendEmail: Boolean(form.elements.sendEmail.checked), source });
  } catch (error) { showError(error); } });
});
$("#detailsForm").addEventListener("input", (event) => {
  if (event.target.matches('[name="resourceId"],[name="start"],[name="end"],[name="visitors"],[name="children"],[data-extra-field]')) void window.marina.clearQuoteCache();
});

$("#detailsStatus").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  const form = $("#detailsForm");
  const source = activeWorkspace;
  await runExclusive(`booking:${source}:${booking.localId}`, [$("#detailsStatus"), $("#detailsTrash"), form.querySelector('[type="submit"]')], async () => { try {
    closeBookingOverlays();
    await runApiAction("setStatus", booking.localId, { status: booking.status === "approved" ? "pending" : "approved", sendEmail: Boolean(form.elements.sendEmail.checked), source });
  } catch (error) { showError(error); } });
});

$("#detailsTrash").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  const action = booking.trashed ? "restabilești rezervarea" : "muți rezervarea la gunoi";
  if (!confirm(`Confirmi că vrei să ${action}? Rezervarea nu va fi ștearsă definitiv.`)) return;
  const form = $("#detailsForm");
  const source = activeWorkspace;
  await runExclusive(`booking:${source}:${booking.localId}`, [$("#detailsStatus"), $("#detailsTrash"), form.querySelector('[type="submit"]')], async () => { try {
    closeBookingOverlays();
    await runApiAction("setTrash", booking.localId, { trashed: !booking.trashed, sendEmail: Boolean(form.elements.sendEmail.checked), source });
  } catch (error) { showError(error); } });
});

$("#saveDeposit").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  const amount = Number($("#paymentForm").elements.depositAmount.value);
  try {
    const snapshot = paymentSnapshots.get(booking.localId);
    const total = paymentAmount(snapshot?.total);
    const note = typeof snapshot?.note === "string" ? snapshot.note : String(booking.note || "");
    if (!snapshot || total === null) throw new Error("Așteaptă verificarea costului din WordPress înainte de salvarea avansului.");
    if (!Number.isFinite(amount) || amount < 0 || amount > total) throw new Error("Avansul trebuie să fie între zero și costul rezervării.");
    paymentSnapshots.delete(booking.localId);
    paymentSnapshotErrors.delete(booking.localId);
    closeBookingOverlays();
    await runApiAction("updateDeposit", booking.localId, { deposit: amount, total, note, source: activeWorkspace });
  } catch (error) { showError(error); }
});

async function queuePaymentEmail(booking) {
  const source = activeWorkspace;
  const paymentRequest = PaymentRequest.fromBooking(booking);
  const depositCommand = unresolvedPaymentCommand(booking, "deposit_update");
  const pendingDeposit = depositCommand && ["queued", "sending"].includes(depositCommand.status);
  let snapshot = paymentSnapshots.get(booking.localId);
  if (!pendingDeposit) {
    snapshot = await window.marina.getPayment(booking.localId, { source });
    paymentSnapshots.set(booking.localId, snapshot);
  }
  const email = BookingFields.value(booking, "email") || snapshot?.email;
  const deposit = Number(pendingDeposit ? depositCommand.payload?.deposit : snapshot?.deposit);
  const total = Number(pendingDeposit ? depositCommand.payload?.total : snapshot?.total);
  const note = typeof snapshot?.note === "string" ? snapshot.note : String(booking.note || "");
  if (!email) throw new Error("Rezervarea nu are o adresă de email validă.");
  if (!pendingDeposit && snapshot?.email_available === false) throw new Error("Emailurile de plată nu sunt disponibile în configurația WordPress.");
  if (!Number.isFinite(deposit) || deposit <= 0) throw new Error("Suma nativă de plată nu a putut fi verificată.");
  if (!pendingDeposit && (!Number.isFinite(total) || total <= 0 || !note)) throw new Error("Costul și nota WordPress nu au putut fi verificate.");
  if (!confirm(`Trimiți către ${email} cererea de plată pentru ${PricingNote.formatAmount(deposit)} lei? Dacă aplicația este offline, emailul va rămâne în coadă.`)) return false;
  if (source !== activeWorkspace) throw workspaceChangedError();
  if (!pendingDeposit) {
    await runApiAction("updateDeposit", booking.localId, { deposit, total, note, source });
  }
  await runApiAction("requestPayment", booking.localId, { ...paymentRequest, source });
  return true;
}

$("#sendPaymentRequest").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  try {
    await queuePaymentEmail(booking);
  } catch (error) { showError(error); }
});

$("#bookingMenuEdit").addEventListener("click", () => {
  const booking = bookingById(selectedBookingId);
  if (booking) populateDetails(booking);
});

$("#bookingPaymentMenuToggle").addEventListener("click", () => {
  const menu = $("#bookingPaymentMenu");
  menu.hidden = !menu.hidden;
  $("#bookingPaymentMenuToggle").setAttribute("aria-expanded", String(!menu.hidden));
});

$("#bookingMenuChangeDeposit").addEventListener("click", () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  populatePaymentDialog(booking);
  requestAnimationFrame(() => {
    const input = $("#paymentForm").elements.depositAmount;
    input.focus();
    input.select();
  });
});

$("#closePaymentDialog").addEventListener("click", () => {
  paymentDialog.close();
  selectedBookingId = null;
  selectedBookingView = "";
});
paymentDialog.addEventListener("close", () => {
  if (selectedBookingView !== "payment") return;
  selectedBookingId = null;
  selectedBookingView = "";
});

$("#bookingMenuSendPayment").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  $("#bookingPaymentMenu").hidden = true;
  $("#bookingPaymentMenuToggle").setAttribute("aria-expanded", "false");
  try { await queuePaymentEmail(booking); }
  catch (error) { showError(error); }
});

$("#bookingMenuStatus").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  const source = activeWorkspace;
  await runExclusive(`booking:${source}:${booking.localId}`, [$("#bookingMenuStatus"), $("#bookingMenuTrash")], async () => { try {
    closeBookingOverlays();
    await runApiAction("setStatus", booking.localId, { status: booking.status === "approved" ? "pending" : "approved", sendEmail: false, source });
  } catch (error) { showError(error); } });
});

$("#bookingMenuTrash").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  const action = booking.trashed ? "restabilești rezervarea" : "muți rezervarea la gunoi";
  if (!confirm(`Confirmi că vrei să ${action}? Rezervarea nu va fi ștearsă definitiv.`)) return;
  const source = activeWorkspace;
  await runExclusive(`booking:${source}:${booking.localId}`, [$("#bookingMenuStatus"), $("#bookingMenuTrash")], async () => { try {
    await runApiAction("setTrash", booking.localId, { trashed: !booking.trashed, sendEmail: false, source });
    dismissBookingMenu();
  } catch (error) { showError(error); } });
});

$("#syncIndicator").addEventListener("click", () => { diagnostics.hidden = false; });
$("#clearQueueIssues").addEventListener("click", async () => {
  if (!confirm("Anulezi modificările locale eșuate și comenzile care depind de ele? Rezervările vor reveni la ultima stare cunoscută de pe server.")) return;
  const button = $("#clearQueueIssues");
  await runExclusive(`clear-failed:${activeWorkspace}`, [button], async () => { try {
    await runApiAction("clearFailedCommands");
  } catch (error) { showError(error); } });
});
document.addEventListener("click", async (event) => {
  if (!event.target.closest(".booking-payment-menu")) {
    $("#bookingPaymentMenu").hidden = true;
    $("#bookingPaymentMenuToggle").setAttribute("aria-expanded", "false");
  }
  if (!bookingMenu.hidden && !event.target.closest("#bookingMenu") && !event.target.closest(".timeline-bar")) {
    dismissBookingMenu();
  }
  const close = event.target.closest("[data-close]");
  if (close) {
    document.getElementById(close.dataset.close).hidden = true;
    if (["bookingMenu", "detailsPanel"].includes(close.dataset.close)) {
      selectedBookingId = null;
      selectedBookingView = "";
    }
  }
  const retry = event.target.closest("[data-retry-command]");
  if (retry) { try { await runApiAction("retryCommand", retry.dataset.retryCommand); } catch (error) { showError(error); } }
  const revert = event.target.closest("[data-revert-booking]");
  if (revert && confirm("Revii de la modificarea locală nesincronizată la ultima stare cunoscută de pe server?")) { try { await runApiAction("revertBooking", revert.dataset.revertBooking); } catch (error) { showError(error); } }
  const open = event.target.closest("[data-open-booking]");
  if (open) {
    const booking = bookingById(open.dataset.openBooking);
    if (booking) { diagnostics.hidden = true; populateDetails(booking); }
  }
});

$("#openSettings").addEventListener("click", async () => {
  const source = activeWorkspace;
  const settings = await window.marina.getSettings(source);
  if (source !== activeWorkspace) return;
  settingsWorkspace = source;
  const form = $("#settingsForm");
  const camping = source === "camping";
  $("#settingsSourceLabel").textContent = camping ? "Conexiune camping" : "Conexiune camere";
  $("#settingsTitle").textContent = camping ? "Setări Camping" : "Setări Camere";
  form.elements.apiBaseUrl.value = settings.apiBaseUrl || "";
  form.elements.username.value = settings.username || "";
  form.elements.password.value = "";
  form.elements.timezone.value = settings.timezone || "Europe/Bucharest";
  $("#settingsStatus").textContent = settings.credentialsConfigured ? "Datele de acces sunt stocate în magazinul protejat al sistemului." : "Nu este stocată nicio parolă de aplicație.";
  settingsDialog.showModal();
});
$("#closeSettingsDialog").addEventListener("click", () => { settingsWorkspace = null; settingsDialog.close(); });

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const source = settingsWorkspace;
  if (!source || source !== activeWorkspace) { showError(workspaceChangedError()); return; }
  const payload = { apiBaseUrl: form.elements.apiBaseUrl.value, username: form.elements.username.value, timezone: form.elements.timezone.value, source };
  if (form.elements.password.value) payload.password = form.elements.password.value;
  try {
    const settings = await window.marina.saveSettings(payload);
    if (source !== activeWorkspace) return;
    form.elements.password.value = "";
    $("#settingsStatus").textContent = settings.credentialsConfigured ? "Setările au fost salvate în siguranță." : "Setările au fost salvate; lipsește parola.";
    settingsWorkspace = null;
    settingsDialog.close();
    await refreshRange();
  } catch (error) { form.elements.password.value = ""; showError(error); }
});

$("#testConnection").addEventListener("click", async () => {
  const output = $("#settingsStatus");
  const form = $("#settingsForm");
  const source = settingsWorkspace;
  if (!source || source !== activeWorkspace) { showError(workspaceChangedError()); return; }
  output.textContent = "Se testează…";
  try {
    const result = await runApiAction("testConnection", { apiBaseUrl: form.elements.apiBaseUrl.value, username: form.elements.username.value, password: form.elements.password.value || undefined, timezone: form.elements.timezone.value, source });
    output.textContent = `Conectat. Au fost găsite ${result.resources} spații.`;
  }
  catch (error) { output.textContent = error.message || String(error); }
});

$("#clearCredentials").addEventListener("click", async () => {
  if (!confirm("Ștergi URL-ul API, utilizatorul și parola de aplicație stocate local?")) return;
  const source = settingsWorkspace;
  if (!source || source !== activeWorkspace) { showError(workspaceChangedError()); return; }
  try { await window.marina.clearCredentials(source); $("#settingsForm").reset(); $("#settingsStatus").textContent = "Datele de acces locale au fost șterse."; }
  catch (error) { showError(error); }
});

function setVisibleMonth(month) {
  const target = monthStart(month);
  const shifted = ensureWindowContains(target);
  focusMonth = target;
  suppressMonthUpdate = true;
  monthNavigationLockedUntil = performance.now() + 900;
  renderTimeline({ preserveScroll: true });
  const targetLeft = scrollLeftForDate(target);
  setTimelineScrollLeft(targetLeft);
  lastScrollLeft = timelineShell.scrollLeft;
  if (programmaticScrollFrame) cancelAnimationFrame(programmaticScrollFrame);
  programmaticScrollFrame = requestAnimationFrame(() => {
    programmaticScrollFrame = null;
    setTimelineScrollLeft(targetLeft);
    lastScrollLeft = timelineShell.scrollLeft;
    renderVisibleRows(true);
    requestAnimationFrame(() => { suppressMonthUpdate = false; $("#monthLabel").textContent = formatMonth(focusMonth); });
  });
  if (shifted) void refreshRange({ force: false, quiet: true, desiredLeft: targetLeft });
}

$("#prevMonth").addEventListener("click", () => setVisibleMonth(addMonths(focusMonth, -1)));
$("#nextMonth").addEventListener("click", () => setVisibleMonth(addMonths(focusMonth, 1)));
$("#today").addEventListener("click", () => setVisibleMonth(monthStart(todayIso())));
$("#refresh").addEventListener("click", () => { void refreshRange({ force: true }); });
$("#toggleTrashed").addEventListener("click", () => {
  showTrashed = !showTrashed;
  updateTrashedToggle();
  renderTimeline();
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const anchor = addDays(windowStart, Math.round(timelineScrollLeft() / dayWidth));
    renderTimeline({ preserveScroll: false });
    setTimelineScrollLeft(scrollLeftForDate(anchor));
    lastScrollLeft = timelineShell.scrollLeft;
    finishCameraTransform();
    setCameraState({ scale: cameraScale, offsetX: cameraOffsetX, offsetY: cameraOffsetY });
  }, 120);
});

window.marina.onStateChanged(applyState);

(async function boot() {
  const range = currentRange();
  try {
    window.marina.setSource("rooms");
    updateWorkspaceUi();
    applyState(await window.marina.bootstrap(range));
    setTimelineScrollLeft(Math.max(0, scrollLeftForDate(focusMonth) - dayWidth * 2));
    lastScrollLeft = timelineShell.scrollLeft;
    if (state.settings.credentialsConfigured && state.settings.apiBaseUrl) await refreshRange({ force: false });
    else $("#openSettings").click();
  } catch (error) { showError(error); }
})();
