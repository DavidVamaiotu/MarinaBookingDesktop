"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "..", "wordpress-plugin", "marina-booking-api-v1.0.2", "marina-booking-api.php"), "utf8");
const editStart = source.indexOf("private static function update_booking_operation");
const editEnd = source.indexOf("\n\tpublic static function get_booking", editStart);
const editSource = source.slice(editStart, editEnd);
const mutationLookupStart = source.indexOf("private static function mutation_booking");
const mutationLookupEnd = source.indexOf("\n\tprivate static function ", mutationLookupStart + 1);
const mutationLookupSource = source.slice(mutationLookupStart, mutationLookupEnd);

test("WordPress bridge v1.0.9 moves bookings through Booking Calendar's native resource helper", () => {
  assert.match(source, /Version: 1\.0\.9/);
  assert.match(editSource, /function_exists\( 'wpbc__sql__change_booking_resource_for_booking' \)/);
  assert.match(editSource, /wpbc_api_booking_add_new\( \$dates, \$form_data, \$existing_resource_id, \$params \)/);
  assert.match(editSource, /wpbc__sql__change_booking_resource_for_booking\( \$booking_id, \$resource_id \)/);
  assert.ok(editSource.indexOf("wpbc_api_booking_add_new") < editSource.indexOf("wpbc__sql__change_booking_resource_for_booking( $booking_id"));
});

test("resource edits are atomic and preserve the submitted note without pricing math", () => {
  assert.match(editSource, /START TRANSACTION/);
  assert.match(editSource, /ROLLBACK/);
  assert.match(editSource, /COMMIT/);
  assert.match(editSource, /array_key_exists\( 'note', \$payload \)/);
  assert.match(editSource, /array\( 'remark' => \$note \)/);
  assert.doesNotMatch(editSource, /calculate_price|wpbc_calc__booking_cost|PricingNote/);
  assert.ok(editSource.indexOf("wpbc__sql__change_booking_resource_for_booking( $booking_id") < editSource.indexOf("array( 'remark' => $note )"));
});

test("resource edits derive and verify partial-day boundaries before commit", () => {
  assert.match(source, /private static function form_data_with_date_times/);
  assert.match(source, /\$form_data\['starttime'\]/);
  assert.match(source, /\$form_data\['endtime'\]/);
  assert.match(source, /private static function saved_dates_match/);
  assert.match(editSource, /marina_booking_api_edit_verification_failed/);
  assert.ok(editSource.indexOf("saved_dates_match") < editSource.indexOf("'COMMIT'"));
});

test("resource edits strip the current WordPress field suffix before saving and moving", () => {
  assert.match(source, /private static function form_data_without_resource_suffix/);
  assert.match(editSource, /form_data_without_resource_suffix\( \$form_data, \$existing_resource_id \)/);
});

test("mutation handlers use a single-table booking lookup without vendor date joins or form parsing", () => {
  assert.match(mutationLookupSource, /\$wpdb->get_row/);
  assert.match(mutationLookupSource, /SELECT \* FROM \{\$table\} WHERE booking_id = %d LIMIT 1/);
  assert.doesNotMatch(mutationLookupSource, /bookingdates|wpbc_api_get_booking_by_id/);

  const mutationFunctions = [
    "update_booking_operation",
    "set_booking_status_operation",
    "set_booking_note_operation",
    "set_booking_deposit_operation",
    "send_booking_payment_request_operation",
    "set_booking_trash_operation",
  ];
  for (const functionName of mutationFunctions) {
    const start = source.indexOf(`private static function ${functionName}`);
    const end = source.indexOf("\n\tpublic static function ", start);
    assert.notEqual(start, -1, `${functionName} is missing`);
    assert.match(source.slice(start, end), /self::mutation_booking\( \$booking_id \)/, `${functionName} still uses the vendor lookup`);
  }
});

test("read endpoints retain Booking Calendar's native booking parser", () => {
  const rawLookupStart = source.indexOf("private static function raw_booking");
  const rawLookupEnd = source.indexOf("\n\tprivate static function ", rawLookupStart + 1);
  const rawLookupSource = source.slice(rawLookupStart, rawLookupEnd);
  assert.match(rawLookupSource, /wpbc_api_get_booking_by_id\( \$booking_id \)/);
  assert.match(source, /\$excluded_booking = self::raw_booking\( \$exclude_booking_id \)/);
});

test("create keeps native availability authoritative and bundles note persistence", () => {
  const start = source.indexOf("private static function create_booking_operation");
  const end = source.indexOf("\n\tpublic static function update_booking", start);
  const createSource = source.slice(start, end);
  assert.match(createSource, /self::dates_are_booked\( \$dates, \$resource_id \)/);
  assert.match(createSource, /marina_booking_api_availability_conflict/);
  assert.match(createSource, /wpbc_api_booking_add_new\( \$dates, \$form_data, \$resource_id, \$params \)/);
  assert.match(createSource, /array_key_exists\( 'note', \$payload \)/);
  assert.match(createSource, /array\( 'remark' => \$note \)/);
  assert.match(createSource, /'note_saved' => \$note_saved/);
  assert.ok(createSource.indexOf("wpbc_api_booking_add_new") < createSource.indexOf("array( 'remark' => $note )"));
});

test("schema upgrade adds only a non-unique external-ID lookup index", () => {
  assert.match(source, /const SCHEMA_VERSION = '1\.0\.3'/);
  assert.match(source, /ADD INDEX marina_sync_gid_booking \(sync_gid\(191\), booking_id\), ALGORITHM=INPLACE, LOCK=NONE/);
  assert.doesNotMatch(source, /UNIQUE (?:KEY|INDEX) marina_sync_gid_booking/);
});
