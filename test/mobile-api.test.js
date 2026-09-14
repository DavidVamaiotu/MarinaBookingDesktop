"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { marinaAvailabilityPeriod, marinaBookingDates, marinaBookingIsTrashed, marinaBookingQueryRange, marinaBookingResourceId, marinaCheckoutDate, marinaStayPeriod } = require("../src/shared/mobile-api");

const root = path.join(__dirname, "..");
const bridgeSource = fs.readFileSync(path.join(root, "mobile", "mobile-bridge.js"), "utf8");
const manifestSource = fs.readFileSync(path.join(root, "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
const extractionRulesSource = fs.readFileSync(path.join(root, "android", "app", "src", "main", "res", "xml", "data_extraction_rules.xml"), "utf8");

test("mobile Marina periods preserve stay and handoff boundaries", () => {
  assert.deepEqual(marinaStayPeriod(["2026-07-12 15:00:01", "2026-07-13 00:00:00", "2026-07-14 12:00:02"]), { start_date: "2026-07-12", end_date: "2026-07-13" });
  assert.deepEqual(marinaAvailabilityPeriod(["2026-07-12 15:00:01", "2026-07-13 00:00:00", "2026-07-14 12:00:02"]), { start_date: "2026-07-12", end_date: "2026-07-13" });
  assert.equal(marinaCheckoutDate("2026-12-31"), "2027-01-01");
});

test("mobile Marina booking queries use Bucharest day boundaries", () => {
  assert.deepEqual(marinaBookingQueryRange({ start: "2026-08-01", end: "2026-08-31" }), {
    from: "2026-08-01T00:00:00+03:00",
    to: "2026-08-31T23:59:59+03:00"
  });
  assert.deepEqual(marinaBookingQueryRange({ start: "2026-11-01", end: "2026-11-01" }), {
    from: "2026-11-01T00:00:00+02:00",
    to: "2026-11-01T23:59:59+02:00"
  });
});

test("mobile Marina normalizes all booking period shapes and keeps the checkout day", () => {
  const booking = {
    booking_id: "booking-periods",
    bookingPeriods: [{ resource: { id: 31 }, startDate: "2026-08-19", endDate: "2026-08-24" }]
  };
  assert.equal(marinaBookingResourceId(booking), "31");
  assert.deepEqual(marinaBookingDates(booking, { bookingMode: "date_range" }), [
    "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25"
  ]);
  assert.deepEqual(marinaBookingDates({ id: "booking-segments", segments: [{ resource_id: 31, start_at: "2026-08-19T15:00:01+03:00", end_at: "2026-08-24T12:00:02+03:00" }] }, { bookingMode: "time_slot" }), [
    "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24"
  ]);
});

test("mobile and desktop classify every Marina trash representation identically", () => {
  for (const value of [true, 1, "1", "true", "trash", "trashed"]) assert.equal(marinaBookingIsTrashed({ status: "approved", trash: value }), true, String(value));
  for (const status of ["trash", "cancelled", "canceled", "deleted"]) assert.equal(marinaBookingIsTrashed({ status }), true, status);
  for (const value of [false, 0, "0", "false"]) assert.equal(marinaBookingIsTrashed({ status: "approved", trash: value }), false, String(value));
  assert.equal(marinaBookingIsTrashed({ status: "pending" }), false);
  assert.match(bridgeSource, /trashed: marinaBookingIsTrashed\(booking\)/);
});

test("mobile resolves and scopes the Rooms and Camping workspaces", () => {
  assert.match(bridgeSource, /MARINA_ROOMS_WORKSPACE_ID/);
  assert.match(bridgeSource, /MARINA_CAMPING_WORKSPACE_ID/);
  assert.match(bridgeSource, /marinaRequest\("\/v1\/workspaces", \{ source, workspaceScoped: false \}\)/);
  assert.match(bridgeSource, /workspaceId === null \? \{\} : \{ "X-Workspace-ID": String\(workspaceId\) \}/);
  assert.match(bridgeSource, /workspaceSlug: source/);
  assert.match(bridgeSource, /const marinaOverrideKey = \(source, providerId\) => `\$\{source\}:\$\{providerId\}`/);
  assert.doesNotMatch(bridgeSource, /workspace_id\s*:/);
});

test("mobile refreshes build configuration over stale saved settings", () => {
  assert.match(bridgeSource, /MarinaConfig\.mergeWorkspaceSettings\(stored, defaults\)/);
});

test("mobile refresh sends the full local calendar range to Marina", () => {
  assert.match(bridgeSource, /marinaBookingQueryRange\(range\)/);
  assert.match(bridgeSource, /params\.set\("cursor", cursor\)/);
  assert.doesNotMatch(bridgeSource, /params\.set\("after",/);
  assert.match(bridgeSource, /typeof payload\?\.has_more !== "boolean"/);
  assert.match(bridgeSource, /marinaBookingDates\(booking, resource\)/);
  assert.match(bridgeSource, /marinaBookingResourceId\(booking, periods\)/);
});

test("mobile logout distinguishes local clearing from failed server revocation", () => {
  assert.match(bridgeSource, /payload\?\.error \|\| "marina_revocation_failed"/);
  assert.match(bridgeSource, /Contul a fost șters local, dar revocarea pe serverul Marina nu a fost confirmată/);
  assert.match(bridgeSource, /revocationUnconfirmed: true/);
});

test("mobile normalizes OAuth token scopes before deriving write capabilities", () => {
  assert.match(bridgeSource, /MarinaConfig\.normalizeScopes\(payload\.scope\)/);
});

test("mobile facilities are workspace cached and included in quotes and pricing edits", () => {
  assert.match(bridgeSource, /marinaRequest\("\/v1\/facilities", \{ source \}\)/);
  assert.match(bridgeSource, /facilities: sourceCache\.facilities \|\| \[\]/);
  assert.match(bridgeSource, /facility_ids: normalizeMarinaFacilityIds\(input\.facilityIds\)/);
  assert.match(bridgeSource, /body\.facility_ids = quote\.facility_ids/);
});

test("mobile Camping keeps real resource metadata and sends creation email preference", () => {
  assert.match(bridgeSource, /capacityMode: String\(resource\.capacity_mode/);
  assert.match(bridgeSource, /capacityUnitMode: String\(resource\.capacity_unit_mode/);
  assert.match(bridgeSource, /settings: resource\.settings/);
  assert.match(bridgeSource, /ignoreLegacy32: source !== "camping"/);
  assert.match(bridgeSource, /body\.send_email = Boolean\(input\.sendEmail\)/);
});

test("mobile Marina writes use versioning and keep payment email explicit", () => {
  assert.match(bridgeSource, /"If-Match": String\(version\)/);
  assert.match(bridgeSource, /const body = \{ deposit_minor: depositMinor, send_email: false, internal_note: nextNote \}/);
  assert.match(bridgeSource, /\/v1\/admin\/bookings\/\$\{encodeURIComponent\(bookingId\)\}\/payment-request/);
  assert.match(bridgeSource, /send_email: true,[\s\S]*payment_type: "deposit",[\s\S]*payment_reason: "Avans rezervare"/);
  assert.match(bridgeSource, /\["queued", "suppressed"\]\.includes\(outcome\)/);
});

test("mobile executes shared retry, strict sync, and conflict recovery behavior", () => {
  assert.match(bridgeSource, /MarinaOperationRegistry\.createOperationRegistry/);
  assert.match(bridgeSource, /MarinaSyncResponse\.collection\(resourcePayload/);
  assert.match(bridgeSource, /MarinaConflictRecovery\.recoverBooking/);
  assert.match(bridgeSource, /recoveryFailed: !recovered/);
});

test("mobile Marina trash actions use cancel and restore status routes", () => {
  assert.match(bridgeSource, /const action = trashed \? "cancel" : "status"/);
  assert.match(bridgeSource, /const status = trashed \? "cancelled" : "pending"/);
  assert.match(bridgeSource, /trashed \? \{ send_email \} : \{ status, send_email \}/);
  assert.match(bridgeSource, /marinaBookingIsTrashed\(booking\)/);
  assert.doesNotMatch(bridgeSource, /marina_restore_unsupported/);
});

test("mobile Marina edit and quick actions pass explicit notification preferences", () => {
  assert.match(bridgeSource, /hasOwnProperty\.call\(patch, "sendEmail"\)\) body\.send_email = Boolean\(patch\.sendEmail\)/);
  assert.match(bridgeSource, /\/status`, \{ status: patch\.status, send_email: Boolean\(patch\.sendEmail\) \}/);
});

test("mobile prefers the canonical top-level note over repeated embedded notes", () => {
  assert.match(bridgeSource, /const primaryNote = String\(booking\?\.note \|\| ""\)\.trim\(\)/);
  assert.match(bridgeSource, /hasInternalNote \? \[booking\?\.internal_note\] : primaryNote \? \[primaryNote\] : marinaNoteBodies\(booking\)/);
});

test("Android local reservation data is excluded from backup", () => {
  assert.match(manifestSource, /android:allowBackup="false"/);
  assert.match(manifestSource, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(extractionRulesSource, /<cloud-backup>[\s\S]*domain="sharedpref"[\s\S]*<device-transfer>[\s\S]*domain="sharedpref"/);
});
