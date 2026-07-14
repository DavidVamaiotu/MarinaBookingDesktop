"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "..", "wordpress-plugin", "marina-booking-api-v1.0.2", "marina-booking-api.php"), "utf8");
const editStart = source.indexOf("private static function update_booking_operation");
const editEnd = source.indexOf("\n\tpublic static function get_booking", editStart);
const editSource = source.slice(editStart, editEnd);

test("WordPress bridge v1.0.6 moves bookings through Booking Calendar's native resource helper", () => {
  assert.match(source, /Version: 1\.0\.6/);
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
