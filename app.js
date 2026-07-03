"use strict";

const $ = (selector) => document.querySelector(selector);
const timelineShell = $("#timelineShell");
const timelineScale = $("#timelineScale");
const guestTimeline = $("#guestTimeline");
const detailsPanel = $("#detailsPanel");
const createDialog = $("#createDialog");
const settingsDialog = $("#settingsDialog");
const diagnostics = $("#diagnostics");

const DAY_WIDTH = 48;
const RESOURCE_WIDTH = 190;
const ROW_BASE = 52;
const LANE_HEIGHT = 44;
const VIRTUAL_THRESHOLD = 60;
const OVERSCAN = 8;

let state = { resources: [], bookings: [], commands: [], diagnostics: {}, settings: {}, range: null };
let focusMonth = monthStart(new Date());
let windowStart = null;
let windowEnd = null;
let dayCount = 0;
let timelineRows = [];
let rowRenderFrame = null;
let selectedBookingId = null;
let dragState = null;
let availabilityTimer = null;

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
function formatDate(value) { return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(utcDate(value)); }
function formatMonth(value) { return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(utcDate(value)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

function currentRange() {
  windowStart = addMonths(focusMonth, -1);
  windowEnd = monthEnd(addMonths(focusMonth, 1));
  dayCount = daysBetween(windowStart, windowEnd) + 1;
  return { start: iso(windowStart), end: iso(windowEnd) };
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function showError(error) {
  showToast(error?.message || String(error));
}

function bookingById(localId) { return state.bookings.find((booking) => booking.localId === localId); }

function updateSyncUi() {
  const info = state.diagnostics || {};
  const indicator = $("#syncIndicator");
  indicator.className = `sync-indicator ${info.failed ? "attention" : info.online ? "online" : "offline"}`;
  $("#syncText").textContent = info.authPaused ? "Credentials need attention" : info.online ? "Online" : "Offline";
  $("#syncCounts").textContent = `${info.queued || 0} queued · ${info.failed || 0} failed`;
  const banner = $("#banner");
  if (info.authPaused) {
    banner.hidden = false;
    banner.textContent = "Sync is paused. Update the WordPress credentials in Settings.";
  } else if (!info.online) {
    banner.hidden = false;
    banner.textContent = "Offline mode: changes remain durable locally and will sync when the API is reachable.";
  } else if (info.failed) {
    banner.hidden = false;
    banner.textContent = "Some changes need attention. Open sync diagnostics for retry or conflict details.";
  } else banner.hidden = true;
}

function fillResourceSelects() {
  const html = state.resources.map((resource) => `<option value="${resource.id}">${escapeHtml(resource.title)}</option>`).join("");
  for (const select of document.querySelectorAll('select[name="resourceId"]')) {
    const value = select.value;
    select.innerHTML = html || '<option value="">No resources cached</option>';
    if (value) select.value = value;
  }
}

function renderScale() {
  timelineShell.style.setProperty("--timeline-days", dayCount);
  const today = iso(new Date());
  let html = '<span class="timeline-corner">Resource</span>';
  for (let index = 0; index < dayCount; index += 1) {
    const date = addDays(windowStart, index);
    const value = iso(date);
    const classes = [date.getUTCDay() === 0 || date.getUTCDay() === 6 ? "weekend" : "", value === today ? "today" : ""].filter(Boolean).join(" ");
    html += `<span class="${classes}"><strong>${String(date.getUTCDate()).padStart(2, "0")}</strong><small>${new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(date)}</small></span>`;
  }
  timelineScale.innerHTML = html;
  $("#monthLabel").textContent = formatMonth(focusMonth);
}

function assignLanes(items) {
  const laneEnds = [];
  const result = [...items].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)).map((item) => {
    const start = utcDate(item.start);
    const end = addDays(item.end, 1);
    let lane = laneEnds.findIndex((laneEnd) => start >= laneEnd);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(end); }
    else laneEnds[lane] = end;
    return { item, lane: lane + 1 };
  });
  return { items: result, count: Math.max(1, laneEnds.length) };
}

function prepareRows() {
  const lanes = TimelineAdapter.mapState(state.resources, state.bookings);
  let top = 0;
  timelineRows = lanes.map((resource) => {
    const layout = assignLanes(resource.items.filter((item) => item.start <= iso(windowEnd) && item.end >= iso(windowStart)));
    const height = Math.max(ROW_BASE, layout.count * LANE_HEIGHT + 8);
    const row = { resource, layout, top, height };
    top += height + 1;
    return row;
  });
  const virtualized = timelineRows.length > VIRTUAL_THRESHOLD;
  guestTimeline.classList.toggle("is-virtualized", virtualized);
  guestTimeline.style.height = virtualized ? `${top}px` : "auto";
  renderVisibleRows(true);
}

function visibleRowBounds() {
  if (timelineRows.length <= VIRTUAL_THRESHOLD) return [0, timelineRows.length];
  const top = Math.max(0, timelineShell.scrollTop - timelineScale.offsetHeight);
  const bottom = top + timelineShell.clientHeight;
  let start = timelineRows.findIndex((row) => row.top + row.height >= top);
  if (start < 0) start = 0;
  let end = start;
  while (end < timelineRows.length && timelineRows[end].top <= bottom) end += 1;
  return [Math.max(0, start - OVERSCAN), Math.min(timelineRows.length, end + OVERSCAN)];
}

function barSignature(item, lane) { return JSON.stringify([item.start, item.end, item.title, item.subtitle, item.status, item.syncState, lane]); }

function createBar(item, lane) {
  const start = Math.max(0, daysBetween(windowStart, item.start));
  const end = Math.min(dayCount, daysBetween(windowStart, item.end) + 1);
  const element = document.createElement("article");
  element.className = `timeline-bar ${item.status} ${item.syncState}`;
  element.dataset.bookingId = item.key;
  element.dataset.signature = barSignature(item, lane);
  element.style.gridColumn = `${start + 2} / ${end + 2}`;
  element.style.gridRow = lane;
  element.innerHTML = `<button class="timeline-handle" data-drag-mode="resize-start" type="button" aria-label="Resize arrival"></button><div class="timeline-bar-content" data-drag-mode="move"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(formatDate(item.start))}–${escapeHtml(formatDate(item.end))}${item.subtitle ? ` · ${escapeHtml(item.subtitle)}` : ""}</span></div><button class="timeline-handle" data-drag-mode="resize-end" type="button" aria-label="Resize departure"></button>`;
  return element;
}

function syncRow(element, row, virtualized) {
  element.dataset.resourceId = row.resource.id;
  element.style.setProperty("--timeline-lanes", row.layout.count);
  if (virtualized) {
    element.style.setProperty("--row-top", `${row.top}px`);
    element.style.setProperty("--row-height", `${row.height}px`);
  }
  const label = element.querySelector(".timeline-unit");
  label.querySelector("strong").textContent = row.resource.title;
  label.querySelector("span").textContent = row.resource.subtitle;
  const existing = new Map([...element.querySelectorAll(":scope > .timeline-bar")].map((bar) => [bar.dataset.bookingId, bar]));
  for (const { item, lane } of row.layout.items) {
    const signature = barSignature(item, lane);
    const current = existing.get(item.key);
    if (!current) element.append(createBar(item, lane));
    else if (current.dataset.signature !== signature && dragState?.booking.localId !== item.key) current.replaceWith(createBar(item, lane));
    existing.delete(item.key);
  }
  for (const bar of existing.values()) if (bar.dataset.bookingId !== dragState?.booking.localId) bar.remove();
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
  prepareRows();
  if (preserveScroll) { timelineShell.scrollLeft = left; timelineShell.scrollTop = top; }
}

function renderCommands() {
  const commandHtml = (command, compact = false) => `<div class="command"><div><strong>${escapeHtml(command.type)}</strong> <span>${escapeHtml(command.status)}</span></div><small>${new Date(command.updatedAt).toLocaleString()}</small>${command.errorMessage ? `<div class="error">${escapeHtml(command.errorMessage)}</div>` : ""}${!compact && ["failed", "conflict", "needs_attention"].includes(command.status) ? `<button class="secondary compact" data-retry-command="${command.id}" type="button">Retry</button>${command.bookingLocalId ? `<button class="secondary compact" data-revert-booking="${escapeHtml(command.bookingLocalId)}" type="button">Revert local</button><button class="secondary compact" data-open-booking="${escapeHtml(command.bookingLocalId)}" type="button">Open details</button>` : ""}` : ""}</div>`;
  $("#commandList").innerHTML = state.commands.map((command) => commandHtml(command)).join("") || '<div class="availability">No commands yet.</div>';
  const info = state.diagnostics;
  $("#diagnosticSummary").textContent = `Online: ${info.online ? "yes" : "no"} · queued: ${info.queued || 0} · failed: ${info.failed || 0} · last sync: ${info.lastSuccessfulSync ? new Date(info.lastSuccessfulSync).toLocaleString() : "never"}`;
  if (selectedBookingId) $("#bookingCommands").innerHTML = state.commands.filter((command) => command.bookingLocalId === selectedBookingId).map((command) => commandHtml(command, true)).join("") || "No local commands.";
}

function applyState(next) {
  state = next;
  fillResourceSelects();
  updateSyncUi();
  renderTimeline();
  renderCommands();
  if (selectedBookingId) {
    const booking = bookingById(selectedBookingId);
    if (booking) populateDetails(booking, false);
  }
}

async function refreshRange({ resetScroll = false } = {}) {
  const range = currentRange();
  renderScale();
  try {
    const next = await window.marina.refresh(range);
    applyState(next);
  } catch (error) {
    showError(error);
    renderTimeline();
  }
  if (resetScroll) timelineShell.scrollLeft = Math.max(0, daysBetween(windowStart, focusMonth) * DAY_WIDTH - DAY_WIDTH * 2);
}

function openCreate({ resourceId, date } = {}) {
  const form = $("#createForm");
  form.reset();
  form.elements.approved.checked = true;
  form.elements.resourceId.value = resourceId || state.resources[0]?.id || "";
  form.elements.start.value = date || iso(new Date());
  form.elements.end.value = date || iso(new Date());
  $("#createAvailability").className = "availability";
  $("#createAvailability").textContent = "Availability will be checked in the background.";
  createDialog.showModal();
  scheduleAvailabilityCheck();
}

function formBookingInput(form) {
  return {
    resourceId: Number(form.elements.resourceId.value),
    dates: rangeDates(form.elements.start.value, form.elements.end.value),
    formData: {
      name: { value: form.elements.name.value, type: "text" },
      email: { value: form.elements.email.value, type: "email" },
      phone: { value: form.elements.phone.value, type: "text" }
    },
    note: form.elements.note.value,
    approved: Boolean(form.elements.approved?.checked),
    sendEmail: Boolean(form.elements.sendEmail.checked)
  };
}

function scheduleAvailabilityCheck() {
  clearTimeout(availabilityTimer);
  availabilityTimer = setTimeout(async () => {
    const form = $("#createForm");
    const output = $("#createAvailability");
    if (!form.elements.resourceId.value || !form.elements.start.value || !form.elements.end.value || form.elements.start.value > form.elements.end.value) return;
    output.className = "availability";
    output.textContent = "Checking availability…";
    try {
      const result = await window.marina.checkAvailability({ resourceId: Number(form.elements.resourceId.value), dates: rangeDates(form.elements.start.value, form.elements.end.value) });
      output.className = `availability ${result.available ? "available" : "unavailable"}`;
      output.textContent = result.available ? "Dates are currently available." : "Dates are unavailable. You can still queue while offline only if the check could not run.";
    } catch {
      output.className = "availability";
      output.textContent = "Availability could not be checked. Saving will remain queued and validated during sync.";
    }
  }, 300);
}

function populateDetails(booking, reset = true) {
  selectedBookingId = booking.localId;
  const form = $("#detailsForm");
  if (reset) form.reset();
  form.elements.name.value = booking.formData?.name?.value || "";
  form.elements.email.value = booking.formData?.email?.value || "";
  form.elements.phone.value = booking.formData?.phone?.value || "";
  const extraFields = Object.entries(booking.formData || {}).filter(([name]) => !["name", "email", "phone"].includes(name));
  $("#extraFieldsSection").hidden = extraFields.length === 0;
  $("#extraFields").innerHTML = extraFields.map(([name, field]) => `<label>${escapeHtml(name)}<input data-extra-field="${escapeHtml(name)}" data-field-type="${escapeHtml(field.type || "text")}" value="${escapeHtml(field.value || "")}"></label>`).join("");
  form.elements.resourceId.value = booking.resourceId;
  form.elements.start.value = booking.dates[0];
  form.elements.end.value = booking.dates[booking.dates.length - 1];
  form.elements.note.value = booking.note || "";
  $("#detailsTitle").textContent = booking.formData?.name?.value || `Booking ${booking.serverId || "local"}`;
  $("#bookingSyncState").textContent = `Sync state: ${booking.syncState}${booking.syncState === "conflict" ? " — choose retry or revert in diagnostics" : ""}`;
  $("#bookingFacts").innerHTML = `<div><dt>Server ID</dt><dd>${booking.serverId || "Waiting for sync"}</dd></div><div><dt>Local ID</dt><dd>${escapeHtml(booking.localId)}</dd></div><div><dt>Status</dt><dd>${booking.status}</dd></div><div><dt>Dates</dt><dd>${booking.dates.length} day(s)</dd></div>`;
  $("#toggleStatus").textContent = booking.status === "approved" ? "Set pending" : "Approve";
  $("#toggleTrash").textContent = booking.trashed ? "Restore from trash" : "Move to trash";
  renderCommands();
  detailsPanel.hidden = false;
}

function pointerDate(event, row) {
  const rect = row.getBoundingClientRect();
  const x = event.clientX - rect.left - RESOURCE_WIDTH + timelineShell.scrollLeft;
  return addDays(windowStart, Math.max(0, Math.min(dayCount - 1, Math.floor(x / DAY_WIDTH))));
}

function beginDrag(event) {
  if (event.button !== 0) return;
  const bar = event.target.closest(".timeline-bar");
  if (!bar) return;
  const booking = bookingById(bar.dataset.bookingId);
  if (!booking) return;
  event.preventDefault();
  const mode = event.target.closest("[data-drag-mode]")?.dataset.dragMode || "move";
  dragState = { pointerId: event.pointerId, bar, booking, mode, clientX: event.clientX, scrollLeft: timelineShell.scrollLeft, originalDates: [...booking.dates], lastDelta: 0, changed: false };
  bar.classList.add("is-dragging");
  bar.closest(".timeline-row")?.classList.add("is-drop-target");
}

function moveDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const delta = Math.round((event.clientX - dragState.clientX + timelineShell.scrollLeft - dragState.scrollLeft) / DAY_WIDTH);
  if (delta === dragState.lastDelta) return;
  let start = utcDate(dragState.originalDates[0]);
  let end = utcDate(dragState.originalDates[dragState.originalDates.length - 1]);
  if (dragState.mode === "resize-start") start = addDays(start, Math.min(delta, daysBetween(start, end)));
  else if (dragState.mode === "resize-end") end = addDays(end, Math.max(delta, -daysBetween(start, end)));
  else { start = addDays(start, delta); end = addDays(end, delta); }
  dragState.booking.dates = rangeDates(start, end);
  dragState.booking.startDate = iso(start);
  dragState.booking.endDate = iso(end);
  dragState.booking.syncState = "queued";
  dragState.lastDelta = delta;
  dragState.changed = true;
  prepareRows();
}

async function endDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const completed = dragState;
  dragState = null;
  completed.bar.classList.remove("is-dragging");
  completed.bar.closest(".timeline-row")?.classList.remove("is-drop-target");
  if (!completed.changed) return;
  try {
    await window.marina.editBooking(completed.booking.localId, { dates: completed.booking.dates, resourceId: completed.booking.resourceId, formData: completed.booking.formData });
    showToast("Change queued; availability is being validated in the background.");
  } catch (error) {
    completed.booking.dates = completed.originalDates;
    showError(error);
    renderTimeline();
  }
}

timelineShell.addEventListener("scroll", queueRowRender);
guestTimeline.addEventListener("pointerdown", beginDrag);
document.addEventListener("pointermove", moveDrag);
document.addEventListener("pointerup", endDrag);
guestTimeline.addEventListener("click", (event) => {
  if (dragState) return;
  const bar = event.target.closest(".timeline-bar");
  if (bar) populateDetails(bookingById(bar.dataset.bookingId));
});
guestTimeline.addEventListener("dblclick", (event) => {
  if (event.target.closest(".timeline-bar")) return;
  const row = event.target.closest(".timeline-row");
  if (row) openCreate({ resourceId: Number(row.dataset.resourceId), date: iso(pointerDate(event, row)) });
});

$("#openCreate").addEventListener("click", () => openCreate());
$("#createForm").addEventListener("input", scheduleAvailabilityCheck);
$("#createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await window.marina.createBooking(formBookingInput(event.currentTarget));
    createDialog.close();
    showToast("Booking queued locally.");
  } catch (error) { showError(error); }
});

$("#detailsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  const form = event.currentTarget;
  const formData = { ...booking.formData, name: { value: form.elements.name.value, type: "text" }, email: { value: form.elements.email.value, type: "email" }, phone: { value: form.elements.phone.value, type: "text" } };
  for (const input of form.querySelectorAll("[data-extra-field]")) formData[input.dataset.extraField] = { value: input.value, type: input.dataset.fieldType || "text" };
  try {
    await window.marina.editBooking(booking.localId, { resourceId: Number(form.elements.resourceId.value), dates: rangeDates(form.elements.start.value, form.elements.end.value), formData });
    if (form.elements.note.value !== booking.note) await window.marina.setNote(booking.localId, { note: form.elements.note.value });
    showToast("Changes queued locally.");
  } catch (error) { showError(error); }
});

$("#toggleStatus").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  try { await window.marina.setStatus(booking.localId, { status: booking.status === "approved" ? "pending" : "approved", sendEmail: $("#detailsForm").elements.sendEmail.checked }); }
  catch (error) { showError(error); }
});

$("#toggleTrash").addEventListener("click", async () => {
  const booking = bookingById(selectedBookingId);
  if (!booking) return;
  const action = booking.trashed ? "restore" : "move this booking to trash";
  if (!confirm(`Confirm: ${action}? There is no permanent delete in this app.`)) return;
  try { await window.marina.setTrash(booking.localId, { trashed: !booking.trashed, sendEmail: $("#detailsForm").elements.sendEmail.checked }); }
  catch (error) { showError(error); }
});

$("#syncIndicator").addEventListener("click", () => { diagnostics.hidden = false; });
document.addEventListener("click", async (event) => {
  const close = event.target.closest("[data-close]");
  if (close) document.getElementById(close.dataset.close).hidden = true;
  const retry = event.target.closest("[data-retry-command]");
  if (retry) { try { await window.marina.retryCommand(retry.dataset.retryCommand); } catch (error) { showError(error); } }
  const revert = event.target.closest("[data-revert-booking]");
  if (revert && confirm("Revert the unsynced local change to the last known server state?")) { try { await window.marina.revertBooking(revert.dataset.revertBooking); } catch (error) { showError(error); } }
  const open = event.target.closest("[data-open-booking]");
  if (open) {
    const booking = bookingById(open.dataset.openBooking);
    if (booking) { diagnostics.hidden = true; populateDetails(booking); }
  }
});

$("#openSettings").addEventListener("click", async () => {
  const settings = await window.marina.getSettings();
  const form = $("#settingsForm");
  form.elements.apiBaseUrl.value = settings.apiBaseUrl || "";
  form.elements.username.value = settings.username || "";
  form.elements.password.value = "";
  form.elements.timezone.value = settings.timezone || "Europe/Bucharest";
  $("#settingsStatus").textContent = settings.credentialsConfigured ? "A credential is stored in the OS-protected credential store." : "No Application Password is stored.";
  settingsDialog.showModal();
});

$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = { apiBaseUrl: form.elements.apiBaseUrl.value, username: form.elements.username.value, timezone: form.elements.timezone.value };
  if (form.elements.password.value) payload.password = form.elements.password.value;
  try {
    const settings = await window.marina.saveSettings(payload);
    form.elements.password.value = "";
    $("#settingsStatus").textContent = settings.credentialsConfigured ? "Settings saved securely." : "Settings saved; credential missing.";
    await refreshRange();
  } catch (error) { form.elements.password.value = ""; showError(error); }
});

$("#testConnection").addEventListener("click", async () => {
  const output = $("#settingsStatus");
  output.textContent = "Testing…";
  try { const result = await window.marina.testConnection(); output.textContent = `Connected. ${result.resources} resources returned.`; }
  catch (error) { output.textContent = error.message || String(error); }
});

$("#clearCredentials").addEventListener("click", async () => {
  if (!confirm("Clear the locally stored API URL, username, and Application Password?")) return;
  try { await window.marina.clearCredentials(); $("#settingsForm").reset(); $("#settingsStatus").textContent = "Local credentials cleared."; }
  catch (error) { showError(error); }
});

$("#prevMonth").addEventListener("click", () => { focusMonth = addMonths(focusMonth, -1); void refreshRange({ resetScroll: true }); });
$("#nextMonth").addEventListener("click", () => { focusMonth = addMonths(focusMonth, 1); void refreshRange({ resetScroll: true }); });
$("#today").addEventListener("click", () => { focusMonth = monthStart(new Date()); void refreshRange({ resetScroll: true }); });
$("#refresh").addEventListener("click", () => { void refreshRange(); });

window.marina.onStateChanged(applyState);

(async function boot() {
  const range = currentRange();
  try {
    applyState(await window.marina.bootstrap(range));
    timelineShell.scrollLeft = Math.max(0, daysBetween(windowStart, focusMonth) * DAY_WIDTH - DAY_WIDTH * 2);
    if (state.settings.credentialsConfigured && state.settings.apiBaseUrl) await refreshRange();
    else $("#openSettings").click();
  } catch (error) { showError(error); }
})();
