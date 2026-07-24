"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const helperSource = appSource.slice(appSource.indexOf("function commandPayload"), appSource.indexOf("function renderCommands"));

function helpers(bookings = [], resources = []) {
  const sandbox = {
    bookingById: (id) => bookings.find((booking) => booking.localId === id),
    resourceById: (id) => resources.find((resource) => Number(resource.id) === Number(id)),
    detailsFieldLabel: (name) => ({ name: "Prenume", secondname: "Nume", phone: "Telefon", details: "Observații client" })[name] || name,
    BookingFields: {
      value(booking, alias) {
        const fieldName = alias === "firstName" ? "name" : "secondname";
        return String(booking?.formData?.[fieldName]?.value || "").trim();
      }
    }
  };
  return vm.runInNewContext(`${helperSource}; ({ commandClientLabel, commandChangeSummary })`, sandbox);
}

test("queue details identify a new client and describe the intended reservation", () => {
  const { commandClientLabel, commandChangeSummary } = helpers([], [{ id: 7, title: "Camera 7" }]);
  const command = {
    type: "create",
    resourceId: 7,
    payload: {
      resource_id: 7,
      dates: ["2026-08-01 15:00:00", "2026-08-03 12:00:00"],
      form_data: { name: { value: "Ana" }, secondname: { value: "Pop" } }
    }
  };
  assert.equal(commandClientLabel(command), "Ana Pop");
  assert.equal(commandChangeSummary(command), "Rezervare nouă · Unitate: Camera 7 · Perioadă: 2026-08-01 – 2026-08-03");
});

test("queue edit details show only values that differ from the confirmed booking", () => {
  const booking = {
    localId: "server:42",
    resourceId: 2,
    dates: ["2026-08-01", "2026-08-03"],
    note: "Veche",
    formData: { name: { value: "Ana" }, phone: { value: "0700" } }
  };
  const { commandClientLabel, commandChangeSummary } = helpers([booking], [{ id: 2, title: "Camera 2" }]);
  const command = {
    type: "edit",
    bookingLocalId: "server:42",
    payload: {
      resource_id: 2,
      dates: ["2026-08-01", "2026-08-03"],
      form_data: { name: { value: "Ana" }, phone: { value: "0711" } },
      note: "Nouă"
    }
  };
  assert.equal(commandClientLabel(command), "Ana");
  assert.equal(commandChangeSummary(command), "Telefon: 0711 · Notă: Nouă");
});

test("queue details cover simple and payment actions, while the renderer labels errors", () => {
  const { commandChangeSummary } = helpers();
  assert.equal(commandChangeSummary({ type: "status", payload: { status: "approved", send_email: true } }), "Status: aprobată · Cu notificare email");
  assert.equal(commandChangeSummary({ type: "trash", payload: { trash: false } }), "Restabilire din gunoi");
  assert.equal(commandChangeSummary({ type: "deposit_update", payload: { deposit: 200, total: 800 } }), "Avans: 200 RON din 800 RON");
  assert.equal(commandChangeSummary({ type: "payment_request", payload: { reason: "ABCDEF", start_date: "2026-08-01", end_date: "2026-08-03" } }), "Trimite emailul de plată (ABCDEF) · Perioadă: 2026-08-01 – 2026-08-03");
  assert.match(appSource, /<strong>Eroare:<\/strong> \$\{escapeHtml\(command\.errorMessage\)\}/);
  assert.match(appSource, /<strong>Client:<\/strong> \$\{escapeHtml\(client\)\}/);
  assert.match(appSource, /<strong>Schimbare:<\/strong> \$\{escapeHtml\(change\)\}/);
});
