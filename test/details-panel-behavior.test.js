"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const PricingNote = require("../src/shared/pricing-note");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(appSource);
  assert.ok(match, `missing function ${name}`);
  const start = match.index;
  const headerEnd = appSource.indexOf("\n", start);
  const bodyStart = appSource.lastIndexOf("{", headerEnd);
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    else if (appSource[index] === "}" && --depth === 0) return appSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function evaluate(names, expression, sandbox = {}) {
  const source = names.map(functionSource).join("\n");
  return vm.runInNewContext(`${source}\n${expression}`, sandbox, { filename: "app.behavior.js" });
}

function dateRangeHarness() {
  return evaluate(
    ["utcDate", "iso", "validIsoDate", "normalizedBookingDateRange"],
    "({ normalizedBookingDateRange })"
  );
}

test("missing and malformed reservation dates normalize to an empty, editable range", () => {
  const { normalizedBookingDateRange } = dateRangeHarness();

  assert.equal(JSON.stringify(normalizedBookingDateRange({})), JSON.stringify({ start: "", end: "", valid: false }));
  assert.equal(JSON.stringify(normalizedBookingDateRange({ dates: ["invalid"] })), JSON.stringify({ start: "", end: "", valid: false }));
  assert.equal(JSON.stringify(normalizedBookingDateRange({ dates: ["2026-08-04"] })), JSON.stringify({ start: "2026-08-04", end: "", valid: false }));
  assert.equal(
    JSON.stringify(normalizedBookingDateRange({ dates: ["2026-08-06", "bad", "2026-08-04"] })),
    JSON.stringify({ start: "2026-08-04", end: "2026-08-06", valid: true })
  );
});

test("a recalculated note uses the authoritative deposit without deleting unrelated note content", async () => {
  const calls = [];
  const paymentSnapshots = new Map();
  const { recalculatedBookingNote } = evaluate(
    ["recalculatedBookingNote"],
    "({ recalculatedBookingNote })",
    {
      PricingNote,
      paymentSnapshots,
      window: {
        marina: {
          async getPayment(localId, options) {
            calls.push({ localId, options });
            return { deposit: 75 };
          }
        }
      },
      calls
    }
  );

  const note = await recalculatedBookingNote(
    { localId: "booking-1" },
    { total: 225 },
    "camping",
    "Sosește după ora 18.\nCost total: 200 RON, Depozit: 50 RON, Rest: 150 RON\nLocul 12"
  );

  assert.equal(note, "Sosește după ora 18.\nCost total: 225 RON, Depozit: 75 RON, Rest: 150 RON\nLocul 12");
  assert.equal(JSON.stringify(calls), JSON.stringify([{ localId: "booking-1", options: { source: "camping" } }]));
  assert.equal(paymentSnapshots.get("booking-1").deposit, 75);

  const rejecting = evaluate(
    ["recalculatedBookingNote"],
    "recalculatedBookingNote",
    {
      PricingNote,
      paymentSnapshots: new Map(),
      window: { marina: { async getPayment() { return { deposit: 250 }; } } }
    }
  );
  await assert.rejects(() => rejecting({ localId: "booking-2" }, { total: 225 }, "rooms"), /depășește noul cost total/);
});

test("a recalculated pricing line is appended when the internal note has no saved price", async () => {
  const recalculatedBookingNote = evaluate(
    ["recalculatedBookingNote"],
    "recalculatedBookingNote",
    {
      PricingNote,
      paymentSnapshots: new Map(),
      window: { marina: { async getPayment() { return { deposit: 25 }; } } }
    }
  );

  const note = await recalculatedBookingNote(
    { localId: "booking-3" },
    { total: 100 },
    "rooms",
    "Păstrează această observație."
  );

  assert.equal(note, "Păstrează această observație.\nCost total: 100 RON, Depozit: 25 RON, Rest: 75 RON");
});

test("calendar invalidation cancels timers, advances request generations, and clears quote cache", () => {
  const cleared = [];
  let cacheClears = 0;
  const sandbox = {
    availabilityTimer: "availability",
    quoteTimer: "quote",
    availabilityRequestId: 4,
    quoteRequestId: 9,
    clearTimeout(value) { cleared.push(value); },
    window: { marina: { clearQuoteCache() { cacheClears += 1; return Promise.resolve(); } } }
  };
  const invalidateCalendarRequests = evaluate(
    ["invalidateCalendarRequests"],
    "invalidateCalendarRequests",
    sandbox
  );

  invalidateCalendarRequests();
  assert.equal(sandbox.availabilityRequestId, 5);
  assert.equal(sandbox.quoteRequestId, 10);
  assert.deepEqual(cleared, ["availability", "quote"]);
  assert.equal(cacheClears, 1);
});

test("opening Add New Reservation dismisses the active booking editor before using shared calendar state", () => {
  const events = [];
  const form = {
    reset() { events.push("reset-create-form"); },
    elements: {
      approved: {},
      sendEmail: {},
      resourceId: {}
    }
  };
  const { openCreate } = evaluate(
    ["openCreate"],
    "({ openCreate })",
    {
      cancelDrag() { events.push("cancel-drag"); },
      closeBookingOverlays() { events.push("close-editor"); },
      $(selector) {
        assert.equal(selector, "#createForm");
        return form;
      },
      state: { resources: [{ id: 3, active: true }] },
      updateCreateWorkspaceFields() {},
      fillGuestCounts() {},
      setCreateAvailability() {},
      setCreatePricing() {},
      renderCreateCalendar() { events.push("render-create-calendar"); },
      createDialog: { showModal() { events.push("show-create"); } },
      monthStart(value) { return value; },
      todayIso() { return "2026-07-27"; },
      createSelectionStart: "old-start",
      createSelectionEnd: "old-end",
      availabilityState: "available",
      quoteState: "fresh",
      createQuote: { valid: true },
      createQuoteKey: "old",
      createCalendarMonth: "old-month"
    }
  );

  openCreate();

  assert.deepEqual(events, ["cancel-drag", "close-editor", "reset-create-form", "render-create-calendar", "show-create"]);
});

test("repricing opts into note replacement unless the user choice is being preserved", () => {
  const form = { elements: { replaceNoteWithPrice: { checked: false } } };
  const sandbox = {
    quoteTimer: null,
    quoteRequestId: 0,
    quoteState: "fresh",
    activeWorkspace: "camping",
    clearTimeout() {},
    calendarForm() { return form; },
    editingDetails() { return true; },
    currentQuoteKey() { return ""; },
    window: { marina: { clearQuoteCache() { return Promise.resolve(); } } },
    setCreatePricing() {},
    renderCreateSummary() {},
    form
  };
  const schedulePriceCheck = evaluate(
    ["schedulePriceCheck"],
    "schedulePriceCheck",
    sandbox
  );

  schedulePriceCheck();
  assert.equal(form.elements.replaceNoteWithPrice.checked, true);

  form.elements.replaceNoteWithPrice.checked = false;
  schedulePriceCheck({ preserveNoteChoice: true });
  assert.equal(form.elements.replaceNoteWithPrice.checked, false);
});

function saveHarness({ replaceNoteWithPrice = false, failSave = false } = {}) {
  const calls = [];
  const events = [];
  let closeCount = 0;
  let recalculatedInput = null;
  const booking = { localId: "booking-1", resourceId: 2 };
  const form = {
    elements: {
      resourceId: { value: "3" },
      start: { value: "2026-08-04" },
      end: { value: "2026-08-06" },
      replaceNoteWithPrice: { checked: replaceNoteWithPrice },
      note: { value: "Nota veche fără preț" },
      sendEmail: { checked: false }
    },
    querySelector() { return { disabled: false }; }
  };
  const saveBookingDetails = evaluate(
    ["saveBookingDetails"],
    "saveBookingDetails",
    {
      activeWorkspace: "rooms",
      selectedBookingId: booking.localId,
      selectedBookingView: "edit",
      availabilityState: "available",
      detailsInitialQuoteKey: "old-key",
      createQuote: { valid: true, total: 225 },
      runExclusive: async (_key, _controls, action) => action(),
      resourceById: () => ({ defaultForm: "standard" }),
      rangeDates: () => ["2026-08-04", "2026-08-05", "2026-08-06"],
      currentQuoteKey: () => "new-key",
      refreshPriceNow: async () => true,
      recalculatedBookingNote: async (...args) => {
        recalculatedInput = args;
        return "Cost total: 225 RON, Depozit: 75 RON, Rest: 150 RON";
      },
      detailsFormData: () => ({ details: { value: "draft" } }),
      BookingFields: { prepareFormData: (value) => value },
      workspaceChangedError: () => new Error("workspace changed"),
      async runApiAction(...args) {
        events.push("save");
        calls.push(args);
        if (failSave) throw new Error("save failed");
      },
      closeBookingOverlays() { events.push("close"); closeCount += 1; }
    }
  );
  return { booking, form, saveBookingDetails, calls, events, closeCount: () => closeCount, recalculatedInput: () => recalculatedInput };
}

test("save preserves the old note by default and persists an automatically selected recalculated note", async () => {
  const preserving = saveHarness();
  await preserving.saveBookingDetails(preserving.booking, preserving.form);
  assert.equal(preserving.calls[0][2].note, "Nota veche fără preț");
  assert.deepEqual(preserving.events, ["close", "save"]);
  assert.equal(preserving.closeCount(), 1);

  const replacing = saveHarness({ replaceNoteWithPrice: true });
  await replacing.saveBookingDetails(replacing.booking, replacing.form);
  assert.equal(replacing.calls[0][2].note, "Cost total: 225 RON, Depozit: 75 RON, Rest: 150 RON");
  assert.equal(replacing.recalculatedInput()[3], "Nota veche fără preț");
  assert.equal(replacing.closeCount(), 1);
});

test("Edit Client closes before saving and a failed request is reported after dismissal", async () => {
  const harness = saveHarness({ replaceNoteWithPrice: true, failSave: true });

  await assert.rejects(() => harness.saveBookingDetails(harness.booking, harness.form), /save failed/);

  assert.deepEqual(harness.events, ["close", "save"]);
  assert.equal(harness.closeCount(), 1);
});
