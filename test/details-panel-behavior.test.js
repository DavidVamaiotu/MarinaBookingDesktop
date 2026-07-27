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

test("a recalculated note uses the newly quoted deposit without deleting unrelated note content", () => {
  const { recalculatedBookingNote } = evaluate(
    ["normalizedRecalculatedQuote", "recalculatedBookingNote"],
    "({ recalculatedBookingNote })",
    { PricingNote }
  );

  const note = recalculatedBookingNote(
    { total: 225, deposit: 75 },
    "Sosește după ora 18.\nCost total: 200 RON, Depozit: 50 RON, Rest: 150 RON\nLocul 12"
  );

  assert.equal(note, "Sosește după ora 18.\nCost total: 225 RON, Depozit: 75 RON, Rest: 150 RON\nLocul 12");
  assert.throws(
    () => recalculatedBookingNote({ total: 225, deposit: 250 }, "Nota"),
    /Avansul calculat depășește noul cost total/
  );
});

test("a recalculated pricing line is appended when the internal note has no saved price", () => {
  const recalculatedBookingNote = evaluate(
    ["normalizedRecalculatedQuote", "recalculatedBookingNote"],
    "recalculatedBookingNote",
    { PricingNote }
  );

  const note = recalculatedBookingNote(
    { total: 100, deposit: 25 },
    "Păstrează această observație."
  );

  assert.equal(note, "Păstrează această observație.\nCost total: 100 RON, Depozit: 25 RON, Rest: 75 RON");
});

test("a recalculated quote accepts zero deposit and recomputes the balance", () => {
  const normalizedRecalculatedQuote = evaluate(
    ["normalizedRecalculatedQuote"],
    "normalizedRecalculatedQuote"
  );

  const quote = normalizedRecalculatedQuote({ total: 250, deposit: 0, balance: 999 });
  assert.equal(quote.deposit, 0);
  assert.equal(quote.balance, 250);
});

test("Edit Client displays the total and deposit returned by the new quote", async () => {
  const sandbox = {
    activeWorkspace: "rooms",
    selectedBookingId: "booking-1",
    quoteRequestId: 7,
    quoteState: "stale",
    createQuote: null,
    createQuoteKey: "",
    window: {
      marina: {
        async quoteBooking() {
          return { mode: "fast", valid: true, total: 300, deposit: 150, balance: 150 };
        }
      }
    },
    calendarForm: () => ({ id: "detailsForm" }),
    setCreatePricing() {},
    renderCreateSummary() {},
    quoteInput: () => ({}),
    currentQuoteKey: () => "quote-key",
    editingDetails: () => true,
    renderQuoteBreakdown() {}
  };
  const fetchCreateQuote = evaluate(
    ["normalizedRecalculatedQuote", "fetchCreateQuote"],
    "fetchCreateQuote",
    sandbox
  );

  assert.equal(await fetchCreateQuote(7, "quote-key", { source: "rooms" }), true);
  assert.equal(sandbox.createQuote.total, 300);
  assert.equal(sandbox.createQuote.deposit, 150);
  assert.equal(sandbox.createQuote.balance, 150);
});

test("Edit Client shows a specific error when a recalculated quote has no valid deposit", async () => {
  const pricingMessages = [];
  const sandbox = {
    activeWorkspace: "rooms",
    quoteRequestId: 3,
    quoteState: "stale",
    createQuote: { valid: true, total: 100, deposit: 50 },
    createQuoteKey: "old-key",
    window: {
      marina: {
        async quoteBooking() {
          return { mode: "fast", valid: true, total: 300 };
        }
      }
    },
    calendarForm: () => ({ id: "detailsForm" }),
    setCreatePricing(...args) { pricingMessages.push(args); },
    renderCreateSummary() {},
    quoteInput: () => ({}),
    currentQuoteKey: () => "quote-key",
    editingDetails: () => true,
    renderQuoteBreakdown() {}
  };
  const fetchCreateQuote = evaluate(
    ["normalizedRecalculatedQuote", "fetchCreateQuote"],
    "fetchCreateQuote",
    sandbox
  );

  assert.equal(await fetchCreateQuote(3, "quote-key", { source: "rooms" }), false);
  assert.equal(sandbox.quoteState, "error");
  assert.equal(sandbox.createQuote, null);
  assert.deepEqual(
    pricingMessages.at(-1),
    ["Booking Calendar nu a returnat un cost și un avans valide.", "unavailable"]
  );
});

test("calendar invalidation cancels timers, advances request generations, and clears quote cache", () => {
  const cleared = [];
  let cacheClears = 0;
  const sandbox = {
    availabilityTimer: "availability",
    quoteTimer: "quote",
    availabilityRequestId: 4,
    quoteRequestId: 9,
    createQuote: { valid: true, total: 100, deposit: 50 },
    createQuoteKey: "old-key",
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
  assert.equal(sandbox.createQuote, null);
  assert.equal(sandbox.createQuoteKey, "");
});

test("resource availability keeps selected dates unless WordPress confirms a conflict", async () => {
  const form = {
    elements: {
      resourceId: { value: "22" },
      start: { value: "2026-08-10" },
      end: { value: "2026-08-13" }
    }
  };
  let pendingCheck;
  let resetArgs = null;
  const availabilityCalls = [];
  const sandbox = {
    availabilityTimer: null,
    availabilityRequestId: 0,
    availabilityState: "idle",
    activeWorkspace: "rooms",
    selectedBookingId: "local-71",
    clearTimeout() {},
    setTimeout(callback) {
      pendingCheck = callback();
      return 1;
    },
    calendarForm() { return form; },
    editingDetails() { return true; },
    bookingById() { return { serverId: 71 }; },
    rangeDates(start, end) { return [start, end]; },
    BookingCalendar: { toStayDateTimes(dates) { return dates; } },
    window: {
      marina: {
        async checkAvailability(input) {
          availabilityCalls.push(input);
          return { available: false };
        }
      }
    },
    setCreateAvailability() {},
    updateCreateSubmitState() {},
    resetCalendarSelection(...args) { resetArgs = args; }
  };
  const scheduleAvailabilityCheck = evaluate(
    ["scheduleAvailabilityCheck"],
    "scheduleAvailabilityCheck",
    sandbox
  );

  scheduleAvailabilityCheck({ resetSelectionOnUnavailable: true });
  await pendingCheck;

  assert.equal(availabilityCalls.length, 1);
  assert.equal(availabilityCalls[0].resourceId, 22);
  assert.equal(availabilityCalls[0].excludeBookingId, 71);
  assert.deepEqual(resetArgs, [
    "Datele selectate sunt deja ocupate în noua unitate. Selectați alt interval.",
    "unavailable"
  ]);
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
  const quoteCalls = [];
  let quoteKey = "";
  const sandbox = {
    quoteTimer: null,
    quoteRequestId: 0,
    quoteState: "fresh",
    createQuote: { valid: true },
    createQuoteKey: "old-key",
    activeWorkspace: "camping",
    clearTimeout() {},
    setTimeout(callback) { callback(); },
    calendarForm() { return form; },
    editingDetails() { return true; },
    currentQuoteKey() { return quoteKey; },
    fetchCreateQuote(...args) { quoteCalls.push(args); },
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
  assert.equal(sandbox.createQuote, null);
  assert.equal(sandbox.createQuoteKey, "");

  form.elements.replaceNoteWithPrice.checked = false;
  quoteKey = "quote-key";
  schedulePriceCheck({ preserveNoteChoice: true });
  assert.equal(form.elements.replaceNoteWithPrice.checked, false);
  assert.equal(JSON.stringify(quoteCalls), JSON.stringify([[2, "quote-key", { mode: "fast", source: "camping" }]]));
});

test("only fields that affect pricing trigger extra-field repricing", () => {
  const isPricingExtraField = evaluate(
    ["isElectricityField", "isPricingExtraField"],
    "isPricingExtraField",
    {
      BookingFields: {
        matchesName(name, canonical) {
          return canonical === "coupon" && name === "coupon";
        }
      }
    }
  );

  assert.equal(isPricingExtraField("pat-suplimentar"), true);
  assert.equal(isPricingExtraField("energie-electrica"), true);
  assert.equal(isPricingExtraField("coupon"), true);
  assert.equal(isPricingExtraField("details"), false);
  assert.equal(isPricingExtraField("numar-auto"), false);
});

function saveHarness({
  replaceNoteWithPrice = false,
  pricingChanged = true,
  failEdit = false,
  failDeposit = false,
  confirmedNote
} = {}) {
  const calls = [];
  const events = [];
  const refreshCalls = [];
  let closeCount = 0;
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
    ["normalizedRecalculatedQuote", "recalculatedBookingNote", "saveBookingDetails"],
    "saveBookingDetails",
    {
      PricingNote,
      activeWorkspace: "rooms",
      selectedBookingId: booking.localId,
      selectedBookingView: "edit",
      availabilityState: "available",
      detailsInitialQuoteKey: "old-key",
      createQuote: { valid: true, total: 225, deposit: 75, balance: 150 },
      paymentSnapshots: new Map([[booking.localId, { deposit: 50 }]]),
      paymentSnapshotErrors: new Map([[booking.localId, new Error("old")]]),
      runExclusive: async (_key, _controls, action) => action(),
      resourceById: () => ({ defaultForm: "standard" }),
      rangeDates: () => ["2026-08-04", "2026-08-05", "2026-08-06"],
      currentQuoteKey: () => pricingChanged ? "new-key" : "old-key",
      refreshPriceNow: async (options) => {
        refreshCalls.push(options);
        return true;
      },
      detailsFormData: () => ({ details: { value: "draft" } }),
      BookingFields: { prepareFormData: (value) => value },
      workspaceChangedError: () => new Error("workspace changed"),
      async runApiAction(...args) {
        events.push(args[0]);
        calls.push(args);
        if (args[0] === "editBooking" && failEdit) throw new Error("edit failed");
        if (args[0] === "updateDeposit" && failDeposit) throw new Error("deposit failed");
        if (args[0] === "editBooking") return { note: confirmedNote ?? args[2].note };
      },
      closeBookingOverlays() { events.push("close"); closeCount += 1; }
    }
  );
  return { booking, form, saveBookingDetails, calls, events, refreshCalls, closeCount: () => closeCount };
}

test("save preserves the old note and deposit when note replacement is not selected", async () => {
  const preserving = saveHarness();
  await preserving.saveBookingDetails(preserving.booking, preserving.form);
  assert.equal(JSON.stringify(preserving.refreshCalls), JSON.stringify([{ forceFresh: true }]));
  assert.equal(preserving.calls.length, 1);
  assert.equal(preserving.calls[0][0], "editBooking");
  assert.equal(preserving.calls[0][2].note, "Nota veche fără preț");
  assert.deepEqual(preserving.events, ["editBooking", "close"]);
  assert.equal(preserving.closeCount(), 1);
});

test("save persists the newly quoted note and deposit only after recalculation is selected", async () => {
  const confirmedNote = "Nota veche fără preț Cost total: 225 RON, Depozit: 75 RON, Rest: 150 RON";
  const replacing = saveHarness({ replaceNoteWithPrice: true, confirmedNote });
  await replacing.saveBookingDetails(replacing.booking, replacing.form);
  assert.equal(JSON.stringify(replacing.refreshCalls), JSON.stringify([{ forceFresh: true }]));
  assert.deepEqual(replacing.events, ["editBooking", "updateDeposit", "close"]);
  assert.equal(replacing.calls[0][2].note, "Nota veche fără preț\nCost total: 225 RON, Depozit: 75 RON, Rest: 150 RON");
  assert.equal(replacing.calls[1][0], "updateDeposit");
  assert.equal(
    JSON.stringify(replacing.calls[1][2]),
    JSON.stringify({
      deposit: 75,
      total: 225,
      note: confirmedNote,
      source: "rooms"
    })
  );
  assert.equal(replacing.form.elements.note.value, confirmedNote);
  assert.equal(replacing.closeCount(), 1);
});

test("unchanged pricing fields do not request a quote before a note-preserving save", async () => {
  const harness = saveHarness({ pricingChanged: false });
  await harness.saveBookingDetails(harness.booking, harness.form);
  assert.deepEqual(harness.refreshCalls, []);
  assert.deepEqual(harness.events, ["editBooking", "close"]);
});

test("a failed Edit Client reservation update leaves the sidebar and draft intact", async () => {
  const harness = saveHarness({ replaceNoteWithPrice: true, failEdit: true });

  await assert.rejects(() => harness.saveBookingDetails(harness.booking, harness.form), /edit failed/);

  assert.deepEqual(harness.events, ["editBooking"]);
  assert.equal(harness.closeCount(), 0);
  assert.equal(harness.form.elements.note.value, "Nota veche fără preț");
  assert.equal(harness.form.elements.start.value, "2026-08-04");
  assert.equal(harness.form.elements.end.value, "2026-08-06");
});

test("a failed deposit update leaves the sidebar open and reflects the already-saved recalculated note", async () => {
  const confirmedNote = "Nota veche fără preț Cost total: 225 RON, Depozit: 75 RON, Rest: 150 RON";
  const harness = saveHarness({ replaceNoteWithPrice: true, failDeposit: true, confirmedNote });

  await assert.rejects(() => harness.saveBookingDetails(harness.booking, harness.form), /deposit failed/);

  assert.deepEqual(harness.events, ["editBooking", "updateDeposit"]);
  assert.equal(harness.closeCount(), 0);
  assert.equal(harness.form.elements.note.value, confirmedNote);
});
