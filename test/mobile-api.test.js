"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalValue, createOperationSignature, marinaAvailabilityPeriod, marinaCheckoutDate, marinaStayPeriod, normalizeMobilePriceQuote, retryDelayMs, scopeMobileData, serverIdFromPayload } = require("../src/shared/mobile-api");

const bridgeSource = fs.readFileSync(path.join(__dirname, "..", "mobile", "mobile-bridge.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const manifestSource = fs.readFileSync(path.join(__dirname, "..", "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
const extractionRulesSource = fs.readFileSync(path.join(__dirname, "..", "android", "app", "src", "main", "res", "xml", "data_extraction_rules.xml"), "utf8");

test("mobile price responses fail closed like desktop responses", () => {
  assert.equal(normalizeMobilePriceQuote({ mode: "full", total: "100", deposit: "30", balance: "70" }).valid, true);
  assert.equal(normalizeMobilePriceQuote({ mode: "fast", total: 100, deposit: 30, balance: 70, valid: false }).valid, false);
  assert.throws(() => normalizeMobilePriceQuote({ total: 100, deposit: 30, balance: 70 }), /calcul invalid/);
  assert.throws(() => normalizeMobilePriceQuote({ mode: "full", total: -1, deposit: 0, balance: 0 }), /calcul invalid/);
});

test("mobile Marina periods keep the checkout half-day available", () => {
  assert.deepEqual(
    marinaStayPeriod(["2026-07-12 15:00:01", "2026-07-13 00:00:00", "2026-07-14 12:00:02"]),
    { start_date: "2026-07-12", end_date: "2026-07-13" }
  );
  assert.deepEqual(
    marinaStayPeriod(["2026-07-14 12:00:02", "2026-07-13 15:00:01"]),
    { start_date: "2026-07-13", end_date: "2026-07-13" }
  );
});

test("mobile Marina availability uses the actual room handoff times", () => {
  assert.deepEqual(
    marinaAvailabilityPeriod(["2026-07-12 15:00:01", "2026-07-14 12:00:02"]),
    { start_at: "2026-07-12T15:00:01+03:00", end_at: "2026-07-14T12:00:02+03:00" }
  );
  assert.deepEqual(
    marinaAvailabilityPeriod(["2026-12-12 15:00:01", "2026-12-14 12:00:02"]),
    { start_at: "2026-12-12T15:00:01+02:00", end_at: "2026-12-14T12:00:02+02:00" }
  );
});

test("mobile Marina display restores the checkout day after an inclusive final night", () => {
  assert.equal(marinaCheckoutDate("2026-08-24"), "2026-08-25");
  assert.equal(marinaCheckoutDate("2026-12-31"), "2027-01-01");
});

test("mobile create retry signatures are canonical and endpoint-scoped", () => {
  const first = createOperationSignature({ source: "rooms", apiBaseUrl: "https://one.test/api", resourceId: 4, dates: ["2026-07-12"], formData: { phone: { type: "text", value: "1" }, name: { value: "Ana", type: "text" } }, note: "Late", approved: false });
  const second = createOperationSignature({ source: "rooms", apiBaseUrl: "https://one.test/api", resourceId: 4, dates: ["2026-07-12"], formData: { name: { type: "text", value: "Ana" }, phone: { value: "1", type: "text" } }, note: "Late", approved: false });
  assert.equal(first, second);
  assert.equal(first, createOperationSignature({ source: "rooms", apiBaseUrl: "https://one.test/api", resourceId: 4, dates: ["2026-07-12"], formData: { name: { value: "Ana", type: "text" }, phone: { value: "1", type: "text" } }, note: "Changed after retry", approved: false, sendEmail: true }));
  assert.notEqual(first, createOperationSignature({ source: "rooms", apiBaseUrl: "https://two.test/api", resourceId: 4, dates: ["2026-07-12"], formData: canonicalValue({ name: { value: "Ana", type: "text" } }), note: "Late" }));
});

test("mobile API extracts create IDs and keeps every Camping resource and reservation", () => {
  assert.equal(serverIdFromPayload({ booking: { booking_id: "42" } }), 42);
  assert.equal(serverIdFromPayload({}), null);
  const scoped = scopeMobileData([{ id: 1, active: true }, { id: 2, active: false }, { id: 3, active: true }], [{ serverId: 1, resourceId: 2 }, { serverId: 2, resourceId: 3 }], "camping");
  assert.deepEqual(scoped.resources.map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(scoped.bookings.map((item) => item.serverId), [1, 2]);
});

test("mobile retry backoff is bounded and honors Retry-After", () => {
  assert.equal(retryDelayMs(1, 0, () => 0.5), 0);
  assert.equal(retryDelayMs(1, null, () => 0.5), 500);
  assert.equal(retryDelayMs(10, null, () => 0.5), 5000);
  assert.equal(retryDelayMs(1, 30, () => 0.5), 5000);
});

test("mobile mutations persist create recovery, save notes, and do not fail after refresh", () => {
  assert.match(bridgeSource, /PENDING_CREATES_KEY/);
  assert.match(bridgeSource, /bookingByExternalId\(pending\.externalId, source, action\.apiBaseUrl\)/);
  assert.match(bridgeSource, /idempotencyKey: pending\.externalId/);
  assert.match(bridgeSource, /bookings\/\$\{pending\.serverId\}\/note/);
  assert.match(bridgeSource, /await refreshAfterMutation\(source, currentRange\)/);
  assert.match(bridgeSource, /if \(generation !== requestGeneration \|\| source !== currentSource\) throw error/);
  assert.match(bridgeSource, /disableRedirects: true/);
  assert.match(bridgeSource, /expectedApiBaseUrl/);
  assert.match(bridgeSource, /serializeMutation/);
  assert.match(bridgeSource, /requireAvailability/);
  assert.match(bridgeSource, /source === "camping" \|\| !dates\.length/);
  assert.match(bridgeSource, /App\.addListener\("appStateChange"/);
  assert.match(bridgeSource, /MOBILE_REFRESH_INTERVAL_MS/);
  assert.match(bridgeSource, /refreshOperations/);
  assert.match(bridgeSource, /SOURCES\.has\(patch\?\.source\) \? patch\.source : currentSource/);
  assert.match(bridgeSource, /async getSettings\(requestedSource = currentSource\)/);
});

test("mobile Marina Edit Client opens from cache and hydrates full details in the background", () => {
  assert.match(bridgeSource, /async getBooking\(id\)/);
  assert.match(bridgeSource, /marinaRequest\(`\/v1\/bookings\/\$\{encodeURIComponent\(cached\.providerId\)\}`\)/);
  assert.match(bridgeSource, /function fetchMarinaNotes\(providerId\)[\s\S]*marinaRequest\(`\/v1\/bookings\/\$\{encodeURIComponent\(key\)\}\/notes`\)/);
  assert.match(bridgeSource, /const notesPromise = hasNoteOverride \|\| hasInternalNote \|\| detailed\.note \|\| cached\.note[\s\S]*fetchMarinaNotes\(cached\.providerId\)\.catch\(\(\) => \[\]\)/);
  assert.match(bridgeSource, /setNote:[\s\S]*marinaMutation\(`\/v1\/bookings\/\$\{encodeURIComponent\(booking\.providerId\)\}`, \{ internal_note: note \}, \{ method: "PATCH", version: booking\.version \}\)/);
  assert.doesNotMatch(bridgeSource, /setNote:[\s\S]*marinaMutation\(`\/v1\/bookings\/\$\{encodeURIComponent\(booking\.providerId\)\}\/notes`/);
  assert.match(bridgeSource, /const marinaNoteOverrides = new Map\(\)/);
  assert.match(bridgeSource, /marinaNoteOverrides\.has\(normalized\.providerId\)/);
  assert.match(bridgeSource, /storeMarinaMutationBooking\([^\n]*\{ noteOverride: note \}\)/);
  assert.match(bridgeSource, /const bookingPayload = await marinaRequest/);
  assert.match(bridgeSource, /normalizeMarinaBookingRecord\(\{ \.\.\.record, id: record\?\.id \?\? cached\.providerId \}, resources\)/);
  assert.match(bridgeSource, /cache\.marina\.bookings = cache\.marina\.bookings\.map/);
  assert.match(bridgeSource, /if \(!normalized\.note && previous\?\.note\) normalized\.note = previous\.note/);
  assert.doesNotMatch(bridgeSource, /prefetchMarinaNotes|MARINA_NOTE_PREFETCH/);
  assert.match(appSource, /populateDetails\(cached\);\s*void window\.marina\.getBooking\(cached\.localId\)\.catch/);
});

test("mobile Marina Avans uses the API payment snapshot and versioned deposit mutation", () => {
  assert.match(bridgeSource, /import \{ MANUAL_DEPOSIT_FIELD, marinaCustomFieldsWithDeposit, normalizeMarinaPayment \} from "\.\.\/src\/shared\/marina-payment\.js"/);
  assert.match(bridgeSource, /async getPayment\(id, input = \{\}\)[\s\S]*if \(source === "marina"\)[\s\S]*marinaRequest\(`\/v1\/bookings\/\$\{encodeURIComponent\(booking\.providerId\)\}`\)/);
  assert.match(bridgeSource, /async getPayment\(id, input = \{\}\)[\s\S]*marinaNoteOverrides\.has\(booking\.providerId\)[\s\S]*snapshot\.note = marinaNoteOverrides\.get\(booking\.providerId\)/);
  assert.match(bridgeSource, /async updateDeposit\(id, input\)[\s\S]*marinaCustomFieldsWithDeposit\(latestPayload, \{ deposit, total \}\)[\s\S]*PricingNote\.update\(currentNote, deposit, total\)\.note[\s\S]*const body = \{ custom_fields: customFields, internal_note: nextNote \}[\s\S]*marinaMutation\(`\/v1\/bookings\/\$\{encodeURIComponent\(booking\.providerId\)\}`, body, \{ method: "PATCH", version: latestRecord\.version \?\? booking\.version \}\)/);
  assert.match(bridgeSource, /const currentNote = String\(marinaNoteOverrides\.has\(booking\.providerId\)[\s\S]*marinaNoteOverrides\.get\(booking\.providerId\)[\s\S]*input\.note \?\? booking\.note/);
  assert.match(bridgeSource, /storeMarinaMutationBooking\([\s\S]*\{ noteOverride: updatedNote \}\)/);
  assert.match(bridgeSource, /name !== "migration" && name !== MANUAL_DEPOSIT_FIELD/);
});

test("Android Back closes every transient app layer and local client data is not backed up", () => {
  for (const expression of [/settingsDialog\.open/, /createDialog\.open/, /!bookingMenu\.hidden/, /!detailsPanel\.hidden/, /!diagnostics\.hidden/]) assert.match(appSource, expression);
  assert.match(appSource, /if \(!dismissTopLayer\(\)\) return;\s*event\.preventDefault\(\)/);
  assert.match(manifestSource, /android:allowBackup="false"/);
  assert.match(manifestSource, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(extractionRulesSource, /<cloud-backup>[\s\S]*domain="sharedpref"[\s\S]*<device-transfer>[\s\S]*domain="sharedpref"/);
  assert.ok(manifestSource.indexOf("uses-permission") < manifestSource.indexOf("<application"));
});
