"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "..", "wordpress-plugin", "marina-booking-api-v1.0.2", "marina-booking-api.php"), "utf8");

test("WordPress bridge v1.0.6 exposes idempotent deposit and payment-request routes", () => {
  assert.match(source, /Version: 1\.0\.6/);
  assert.match(source, /'\/bookings\/\(\?P<id>\\\\d\+\)\/payment'/);
  assert.match(source, /'\/bookings\/\(\?P<id>\\\\d\+\)\/deposit'/);
  assert.match(source, /'\/bookings\/\(\?P<id>\\\\d\+\)\/payment-request'/);
  assert.match(source, /set_booking_deposit_operation/);
  assert.match(source, /execute_idempotent/);
});

test("deposit mutation checks the expected note and writes cost plus remark together", () => {
  assert.match(source, /hash_equals\( \$current_note, \$expected_note \)/);
  assert.match(source, /WHERE booking_id = %d AND remark = %s/);
  assert.match(source, /0 === \$updated/);
  assert.match(source, /START TRANSACTION/);
  assert.match(source, /Cost total: ' \. self::format_note_amount\( \$total \) \. ' RON, Depozit: ' \. self::format_note_amount\( \$deposit \) \. ' RON, Rest: ' \. self::format_note_amount\( \$balance \) \. ' RON'/);
  assert.match(source, /pricing_note_pattern\(\)/);
  assert.match(source, /\$deposit < 0 \|\| \$total <= 0/);
  assert.match(source, /SET cost = %f, remark = %s/);
  assert.match(source, /abs\( \(float\) \$latest\['cost'\] - \$deposit \) < 0\.005/);
});

test("payment snapshot exposes the authoritative WordPress note and database deposit", () => {
  assert.match(source, /'note'\s*=> isset\( \$booking\['remark'\] \) \? \(string\) \$booking\['remark'\] : ''/);
  assert.match(source, /'deposit'\s*=> \$deposit/);
  assert.match(source, /'total'\s*=> is_wp_error\( \$pricing \) \? null : \$pricing\['total'\]/);
});

test("payment request delegates to Booking Calendar and increments only after success", () => {
  const sendIndex = source.indexOf("wpbc_send_email_payment_request(");
  const incrementIndex = source.indexOf("pay_request = COALESCE(pay_request, 0) + 1", sendIndex);
  assert.ok(sendIndex > 0);
  assert.ok(incrementIndex > sendIndex);
  assert.match(source, /marina_booking_api_client_email_missing/);
  assert.match(source, /marina_booking_api_payment_email_disabled/);
  assert.match(source, /'counter_updated' => 1 === \$updated/);
});

test("payment request validates the EuPlatesc contract and stores Booking Calendar hint fields", () => {
  assert.match(source, /\$payload\['start_date'\]/);
  assert.match(source, /\$payload\['end_date'\]/);
  assert.match(source, /\$payload\['nights'\]/);
  assert.match(source, /\/\^\[A-Za-z\]\{6\}\$\/D/);
  assert.match(source, /self::booking_dates\( \$booking_id \)/);
  assert.match(source, /selected_short_dates_hint/);
  assert.match(source, /nights_number_hint/);
  assert.match(source, /wpbc_get_dates_short_format\( implode\( ',', \$payment\['dates'\] \) \)/);
  assert.match(source, /SET form = %s WHERE booking_id = %d AND form = %s/);
  assert.match(source, /marina_booking_api_payment_form_failed/);
  assert.match(source, /could not generate or send the EuPlatesc payment request email/);
});

test("known server failures release their idempotency reservation for same-key retry", () => {
  assert.match(source, /release_idempotency_reservation\( \$id \)/);
  assert.match(source, /'state' => 'processing'/);
  assert.match(source, /catch \( Throwable \$exception \)[\s\S]*mark_idempotency_unknown/);
});

test("price previews use the read-only rate-limit bucket with the full REST route", () => {
  assert.match(source, /'\/' \. self::NAMESPACE \. '\/prices\/calculate' === untrailingslashit\( \(string\) \$request->get_route\(\) \)/);
  assert.match(source, /\( \$is_write && ! \$is_price_preview \) \? 60 : 300/);
});
