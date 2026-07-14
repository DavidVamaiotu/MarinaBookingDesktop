"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BookingDatabase } = require("../src/main/database");
const BookingFields = require("../src/shared/booking-fields");
const { normalizeFormData } = require("../src/shared/form-data");

function input(name = "Guest") {
  return { resourceId: 4, dates: ["2026-07-20", "2026-07-21"], formData: { name: { value: name, type: "text" } }, bookingFormType: "standard", approved: false };
}

test("create commands preserve the Booking Calendar form used for native pricing", () => {
  const db = new BookingDatabase(":memory:");
  db.optimisticCreate(input());
  assert.equal(db.readyCommands()[0].payload.booking_form_type, "standard");
  db.close();
});

test("resource edits carry the booking note in the same API command", () => {
  const db = new BookingDatabase(":memory:");
  db.writeBooking({ serverId: 702, resourceId: 31, dates: ["2026-07-20", "2026-07-21"], formData: input().formData, note: "Cost total: 900 RON", status: "approved" });
  db.optimisticUpdate("server:702", { resourceId: 32, note: "Cost total: 900 RON" }, "edit");
  const command = db.readyCommands()[0];
  assert.equal(command.payload.resource_id, 32);
  assert.equal(command.payload.note, "Cost total: 900 RON");
  db.close();
});

test("customer details survive API normalization and the normalized SQLite field table", () => {
  const db = new BookingDatabase(":memory:");
  const formData = normalizeFormData({ cerere_client7: { field_value: "Cameră liniștită", field_type: "textarea" } });
  db.writeBooking({ serverId: 700, resourceId: 4, dates: ["2026-07-20"], formData, status: "pending" });
  const booking = db.bookingRow("server:700");
  assert.deepEqual(booking.formData.cerere_client7, { value: "Cameră liniștită", type: "textarea" });
  assert.equal(BookingFields.detailsValue(booking), "Cameră liniștită");
  db.close();
});

test("startup recovers fields omitted by older normalizers from the stored server payload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "marina-form-recovery-"));
  const filename = path.join(directory, "cache.sqlite");
  let db = new BookingDatabase(filename);
  db.writeBooking({
    serverId: 701,
    resourceId: 4,
    dates: ["2026-07-20"],
    formData: { name: { value: "Ana", type: "text" } },
    status: "pending",
    syncState: "synced",
    serverPayload: { form_data: { cerere_client7: { field_value: "Cameră liniștită", field_type: "textarea" } } }
  });
  db.close();
  db = new BookingDatabase(filename);
  assert.equal(BookingFields.detailsValue(db.bookingRow("server:701")), "Cameră liniștită");
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("changing API endpoints quarantines queued work until explicitly rebound", () => {
  const db = new BookingDatabase(":memory:");
  db.saveSettings({ apiBaseUrl: "https://site-a.example/wp-json/marina-booking/v1", username: "a" });
  const created = db.optimisticCreate(input());
  assert.equal(db.getCommand(created.commandId).api_base_url, "https://site-a.example/wp-json/marina-booking/v1");
  db.saveSettings({ apiBaseUrl: "https://site-b.example/wp-json/marina-booking/v1", username: "b" });
  assert.equal(db.quarantineQueuedCommands(), 1);
  assert.equal(db.getCommand(created.commandId).status, "needs_attention");
  assert.equal(db.getCommand(created.commandId).error_code, "endpoint_changed");
  db.retryCommand(created.commandId);
  assert.equal(db.getCommand(created.commandId).api_base_url, "https://site-b.example/wp-json/marina-booking/v1");
  db.close();
});

test("resource refresh deactivates resources omitted by the authoritative response", () => {
  const db = new BookingDatabase(":memory:");
  db.replaceResources([{ id: 1, title: "Active" }, { id: 2, title: "Removed" }]);
  db.replaceResources([{ id: 1, title: "Active" }]);
  assert.deepEqual(db.listResources().map((resource) => resource.id), [1]);
  assert.deepEqual(db.listResources({ includeInactive: true }).map((resource) => [resource.id, resource.active]), [[1, true], [2, false]]);
  db.close();
});

test("remote refresh by external id reuses an optimistic create row", () => {
  const db = new BookingDatabase(":memory:");
  db.saveSettings({ apiBaseUrl: "https://site-a.example/wp-json/marina-booking/v1", username: "a" });
  const created = db.optimisticCreate(input());
  const command = db.getCommand(created.commandId);
  db.upsertRemoteBooking({ serverId: 778, externalId: created.booking.externalId, resourceId: 4, dates: input().dates, formData: input().formData, status: "approved", note: "" });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM bookings").get().count, 1);
  db.markCreateSynced(command, 778, { booking_id: 778 });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM bookings").get().count, 1);
  assert.equal(db.bookingRow(created.booking.localId).serverId, 778);
  db.close();
});

test("queue and optimistic booking survive restart and sending commands recover", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marina-queue-"));
  const filename = path.join(dir, "queue.sqlite");
  const first = new BookingDatabase(filename);
  const created = first.optimisticCreate(input());
  const command = first.readyCommands()[0];
  first.markSending(command.id);
  first.close();

  const second = new BookingDatabase(filename);
  assert.equal(second.bookingRow(created.booking.localId).syncState, "queued");
  assert.equal(second.readyCommands().length, 1);
  assert.equal(second.commandRows()[0].errorCode, "restart_recovery");
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("commands remain ordered per booking and resource", () => {
  const db = new BookingDatabase(":memory:");
  const created = db.optimisticCreate(input());
  db.optimisticUpdate(created.booking.localId, { note: "one" }, "note");
  const first = db.readyCommands();
  assert.equal(first.length, 1);
  assert.equal(first[0].type, "create");
  db.markCommand(first[0].id, "synced");
  assert.equal(db.readyCommands()[0].type, "note");
  db.close();
});

test("safe queued edits and notes coalesce but creates never coalesce", () => {
  const db = new BookingDatabase(":memory:");
  const first = db.optimisticCreate(input("One"));
  db.optimisticCreate(input("Two"));
  db.optimisticUpdate(first.booking.localId, { note: "draft" }, "note");
  db.optimisticUpdate(first.booking.localId, { note: "final" }, "note");
  db.optimisticUpdate(first.booking.localId, { dates: ["2026-07-22"] }, "edit");
  db.optimisticUpdate(first.booking.localId, { dates: ["2026-07-23"], sendEmail: true }, "edit");
  const commands = db.commandRows();
  assert.equal(commands.filter((item) => item.type === "create").length, 2);
  assert.equal(commands.filter((item) => item.type === "note").length, 1);
  assert.equal(commands.find((item) => item.type === "note").payload.note, "final");
  assert.equal(commands.filter((item) => item.type === "edit").length, 1);
  assert.deepEqual(commands.find((item) => item.type === "edit").payload.dates, ["2026-07-23 00:00:00"]);
  assert.equal(commands.find((item) => item.type === "edit").payload.send_email, true);
  db.close();
});

test("optimistic status, note, trash and edit update local state immediately", () => {
  const db = new BookingDatabase(":memory:");
  const { booking } = db.optimisticCreate(input());
  db.optimisticUpdate(booking.localId, { status: "approved" }, "status");
  db.optimisticUpdate(booking.localId, { note: "Late arrival" }, "note");
  db.optimisticUpdate(booking.localId, { trashed: true }, "trash");
  db.optimisticUpdate(booking.localId, { dates: ["2026-07-23", "2026-07-24"] }, "edit");
  const current = db.bookingRow(booking.localId);
  assert.equal(current.status, "approved");
  assert.equal(current.note, "Late arrival");
  assert.equal(current.trashed, true);
  assert.deepEqual(current.dates, ["2026-07-23", "2026-07-24"]);
  assert.equal(current.syncState, "queued");
  db.close();
});

test("remote refresh does not overwrite an optimistic overlay", () => {
  const db = new BookingDatabase(":memory:");
  db.upsertRemoteBooking({ serverId: 12, resourceId: 4, dates: ["2026-07-20"], formData: { name: { value: "Remote", type: "text" } }, status: "pending", note: "" });
  db.optimisticUpdate("server:12", { note: "Local note" }, "note");
  db.upsertRemoteBooking({ serverId: 12, resourceId: 4, dates: ["2026-07-20"], formData: { name: { value: "Remote", type: "text" } }, status: "approved", note: "Old note" });
  assert.equal(db.bookingRow("server:12").note, "Local note");
  db.close();
});

test("loaded booking ranges are reused until their freshness window expires", () => {
  const db = new BookingDatabase(":memory:");
  const loadedAt = "2026-07-04T09:00:00.000Z";
  db.markRangeLoaded("2026-03-01", "2026-11-30", 0, loadedAt);
  assert.equal(db.rangeIsFresh("2026-04-01", "2026-10-31", 15 * 60_000, 0, Date.parse("2026-07-04T09:14:59.000Z")), true);
  assert.equal(db.rangeIsFresh("2026-04-01", "2026-10-31", 15 * 60_000, 0, Date.parse("2026-07-04T09:15:01.000Z")), false);
  assert.equal(db.rangeIsFresh("2026-02-01", "2026-10-31", 15 * 60_000, 0, Date.parse("2026-07-04T09:01:00.000Z")), false);
  db.close();
});

test("range reconciliation removes missing synced cache rows but preserves local work", () => {
  const db = new BookingDatabase(":memory:");
  db.upsertRemoteBooking({ serverId: 12, resourceId: 4, dates: ["2026-07-20"], formData: { name: { value: "Old", type: "text" } }, status: "pending", note: "" });
  db.upsertRemoteBooking({ serverId: 13, resourceId: 4, dates: ["2026-07-21"], formData: { name: { value: "Keep", type: "text" } }, status: "pending", note: "" });
  db.optimisticUpdate("server:12", { note: "Local edit" }, "note");
  const removed = db.reconcileRemoteRange("2026-07-01", "2026-07-31", new Set());
  assert.equal(removed, 1);
  assert.equal(db.bookingRow("server:12").note, "Local edit");
  assert.equal(db.bookingRow("server:13"), null);
  db.close();
});

test("reverting local work cancels its commands without blocking the resource", () => {
  const db = new BookingDatabase(":memory:");
  const first = db.optimisticCreate(input("Reverted"));
  db.revertBooking(first.booking.localId);
  const second = db.optimisticCreate(input("Next"));
  const commands = db.commandRows();
  assert.equal(commands.find((command) => command.bookingLocalId === first.booking.localId).status, "cancelled");
  assert.equal(db.readyCommands().length, 1);
  assert.equal(db.readyCommands()[0].booking_local_id, second.booking.localId);
  assert.equal(db.diagnostics().failed, 0);
  db.close();
});

test("discarding failed work reverts its booking and cancels dependent commands", () => {
  const db = new BookingDatabase(":memory:");
  const failed = db.optimisticCreate(input("Failed"));
  const dependent = db.optimisticUpdate(failed.booking.localId, { note: "Must not be sent" }, "note");
  const conflict = db.optimisticCreate(input("Conflict"));
  db.markCommand(failed.commandId, "failed", { code: "request_failed", message: "Failed log" });
  db.markCommand(conflict.commandId, "conflict", { code: "conflict", message: "Conflict log" });
  assert.equal(db.diagnostics().failed, 2);
  assert.equal(db.dismissFailedCommands(), 1);
  assert.deepEqual(db.commandRows().map((command) => command.id), [conflict.commandId]);
  assert.equal(db.diagnostics().failed, 1);
  assert.equal(db.bookingRow(failed.booking.localId), null);
  assert.equal(db.getCommand(failed.commandId).status, "cancelled");
  assert.equal(db.getCommand(dependent.commandId).status, "cancelled");
  assert.ok(db.db.prepare("SELECT dismissed_at FROM commands WHERE id=?").get(failed.commandId).dismissed_at);
  assert.ok(db.db.prepare("SELECT dismissed_at FROM commands WHERE id=?").get(dependent.commandId).dismissed_at);
  db.revertBooking(conflict.booking.localId);
  const next = db.optimisticCreate(input("Next"));
  assert.deepEqual(db.readyCommands().map((command) => command.id), [next.commandId]);
  db.close();
});
