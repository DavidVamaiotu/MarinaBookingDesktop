"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { quoteInput } = require("../src/main/validation");

test("price preview validation preserves native select and checkbox field types", () => {
  const input = quoteInput({
    resourceId: 14,
    dates: ["2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25"],
    formData: {
      visitors: { value: "2", type: "selectbox-one" },
      children: { value: "0", type: "selectbox-one" },
      "pat-suplimentar": { value: "true", type: "checkbox" }
    },
    bookingFormType: "standard",
    mode: "full",
    forceFresh: true
  });
  assert.equal(input.resourceId, 14);
  assert.equal(input.formData.visitors.type, "selectbox-one");
  assert.equal(input.formData["pat-suplimentar"].value, "true");
  assert.equal(input.bookingFormType, "standard");
  assert.equal(input.mode, "full");
  assert.equal(input.forceFresh, true);
});

test("price preview validation rejects invalid resources, dates and empty form data", () => {
  assert.throws(() => quoteInput({ resourceId: 0, dates: ["2026-07-22"], formData: { visitors: { value: "1", type: "selectbox-one" } } }), /resourceId/);
  assert.throws(() => quoteInput({ resourceId: 14, dates: ["not-a-date"], formData: { visitors: { value: "1", type: "selectbox-one" } } }), /Datele/);
  assert.throws(() => quoteInput({ resourceId: 14, dates: ["2026-07-22"], formData: {} }), /cel puțin un câmp/);
  assert.throws(() => quoteInput({ resourceId: 14, dates: ["2026-07-22"], formData: { visitors: { value: "1", type: "selectbox-one" } }, mode: "slow" }), /modul/);
});

test("price preview validation rejects more than 80 form fields locally with the exact count", () => {
  const formData = Object.fromEntries(Array.from({ length: 81 }, (_, index) => [`field_${index}`, { value: String(index), type: "text" }]));
  assert.throws(() => quoteInput({ resourceId: 1, dates: ["2026-07-20"], formData, bookingFormType: "standard", mode: "full" }), (error) => {
    assert.equal(error.code, "form_data_too_many_fields");
    assert.equal(error.fieldCount, 81);
    return true;
  });
});

test("renderer uses fast quotes while editing and forced full quotes before saves", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(source, /setTimeout\(\(\) => void fetchCreateQuote\(requestId, key, \{ mode: "fast", source \}\), 300\)/);
  assert.match(source, /fetchCreateQuote\(requestId, key, \{ mode: "full", forceFresh, source: activeWorkspace \}\)/);
  assert.match(source, /mode: "full", forceFresh: true/);
  assert.match(source, /source !== activeWorkspace \|\| requestId !== quoteRequestId \|\| key !== currentQuoteKey/);
  assert.match(source, /requireValidQuote\(await window\.marina\.quoteBooking/);
  assert.match(source, /Plecare trebuie să fie după sosire/);
  assert.match(source, /const minimumSpan = Math\.max\(0, daysBetween\(start, end\) - 1\)/);
  assert.match(source, /if \(reset\) \{/);
  assert.match(source, /function todayIso\(\)/);
  assert.doesNotMatch(source, /nights\s*\*\s*baseCost|baseCost\s*\*\s*nights/);
});

test("create submit keeps the form reference across the final asynchronous quote", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(renderer, /\$\("#createForm"\)\.addEventListener\("submit", async \(event\) => \{\s*event\.preventDefault\(\);\s*const form = event\.currentTarget;/);
  assert.match(renderer, /if \(!await refreshPriceNow\(\{ forceFresh: true \}\)\) return;\s*if \(source !== activeWorkspace \|\| !createDialog\.open\) throw workspaceChangedError\(\);\s*const input = \{ \.\.\.formBookingInput\(form\), source \};\s*createDialog\.close\(\);\s*const created = await runApiAction\("createBooking", input\);\s*await waitForCreatedBooking\(created, input, source\);/);
  assert.doesNotMatch(renderer, /if \(!createDialog\.open\) createDialog\.showModal\(\)/);
  assert.doesNotMatch(renderer, /formBookingInput\(event\.currentTarget\)/);
});

test("new reservations generate their note from the confirmed quote", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(renderer, /return PricingNote\.format\(quote\)/);
  assert.match(renderer, /note: createPricingNote\(createQuote\)/);
});
