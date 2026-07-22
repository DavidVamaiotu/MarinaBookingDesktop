"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BookingFields = require("../src/shared/booking-fields");
const { BookingDatabase } = require("../src/main/database");

const root = path.resolve(__dirname, "..");

test("duplicate input copies booking data without mutating the original and remaps resource fields", () => {
  const booking = {
    resourceId: 7,
    dates: ["2026-08-10", "2026-08-11", "2026-08-12"],
    status: "approved",
    note: "Cost 900 / avans 300",
    formData: {
      name7: { value: "Ana", type: "text" },
      secondname7: { value: "Pop", type: "text" },
      email7: { value: "ana@example.test", type: "email" },
      phone7: { value: "0700000000", type: "text" },
      visitors7: { value: "2", type: "selectbox-one" },
      details7: { value: "Păstrează toate detaliile", type: "textarea" },
      custom7: { value: "valoare", type: "text" },
      custom: { value: "valoare exactă", type: "text" }
    }
  };
  const before = structuredClone(booking);
  const input = BookingFields.duplicateBookingInput(booking, { id: 12, active: true, defaultForm: "room-12" });

  assert.deepEqual(booking, before);
  assert.equal(input.resourceId, 12);
  assert.deepEqual(input.dates, booking.dates);
  assert.notStrictEqual(input.dates, booking.dates);
  assert.equal(input.formData.name.value, "Ana");
  assert.equal(input.formData.details.value, "Păstrează toate detaliile");
  assert.equal(input.formData.custom.value, "valoare exactă");
  assert.equal(Object.keys(input.formData).filter((name) => name === "custom").length, 1);
  assert.equal(Object.keys(input.formData).some((name) => name.endsWith("7")), false);
  assert.equal(input.bookingFormType, "room-12");
  assert.equal(input.note, booking.note);
  assert.equal(input.approved, true);
  assert.equal(input.sendEmail, false);
});

test("duplicate input rejects the original or an inactive resource", () => {
  const booking = { resourceId: 7, dates: ["2026-08-10"], formData: { name7: { value: "Ana", type: "text" } } };
  assert.throws(() => BookingFields.duplicateBookingInput(booking, { id: 7, active: true }), { code: "duplicate_same_resource" });
  assert.throws(() => BookingFields.duplicateBookingInput(booking, { id: 8, active: false }), { code: "invalid_target_resource" });
});

test("desktop duplicate persistence keeps the draft hidden and leaves the source row unchanged", () => {
  const database = new BookingDatabase(":memory:");
  database.writeBooking({
    serverId: 701,
    resourceId: 7,
    dates: ["2026-08-10", "2026-08-11"],
    status: "approved",
    note: "Notă originală",
    formData: { name7: { value: "Ana", type: "text" }, details7: { value: "Detalii", type: "textarea" } }
  });
  const sourceBefore = database.bookingRow("server:701");
  const input = BookingFields.duplicateBookingInput(sourceBefore, { id: 12, active: true, defaultForm: "room-12" });
  const pending = database.optimisticCreate(input);
  database.optimisticUpdate(pending.booking.localId, { note: input.note }, "note");
  const created = database.bookingRow(pending.booking.localId);
  const sourceAfter = database.bookingRow("server:701");

  assert.deepEqual(sourceAfter, sourceBefore);
  assert.notEqual(created.localId, sourceAfter.localId);
  assert.equal(created.serverId, null);
  assert.equal(created.resourceId, 12);
  assert.equal(created.formData.name.value, "Ana");
  assert.equal(created.formData.details.value, "Detalii");
  assert.equal(created.note, "");
  assert.equal(created.status, "approved");
  assert.equal(database.listBookings("2026-08-10", "2026-08-11").length, 1);
  assert.equal(database.readyCommands().filter((command) => command.type === "create").length, 1);
  assert.equal(database.commandRows().find((command) => command.type === "note").payload.note, "Notă originală");
  database.close();
});

test("duplicate UI uses the existing create path and excludes the source resource", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(html, /id="bookingMenuDuplicate"/);
  assert.match(html, /id="bookingMenuTrash"[\s\S]*id="bookingMenuDuplicate"[\s\S]*id="bookingPaymentMenuToggle"/);
  assert.match(html, /<dialog id="duplicateDialog"/);
  assert.match(app, /resource\.active !== false && Number\(resource\.id\) !== Number\(booking\.resourceId\)/);
  assert.match(app, /BookingFields\.duplicateBookingInput\(booking, resource\)/);
  assert.match(app, /runApiAction\("createBooking", input\)/);
  assert.doesNotMatch(app, /runApiAction\("editBooking",[^\n]*duplicate/);
});
