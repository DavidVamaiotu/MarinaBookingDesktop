"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { occupancyFor, rangeAvailability, toStayDateTimes } = require("../src/shared/booking-calendar");

const bookings = [
  { resourceId: 14, status: "approved", dates: ["2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11"] },
  { resourceId: 14, status: "approved", dates: ["2026-07-16", "2026-07-17"] },
  { resourceId: 14, status: "approved", dates: ["2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21", "2026-07-22"] },
  { resourceId: 14, status: "pending", dates: ["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19"] },
  { resourceId: 14, status: "approved", trashed: true, dates: ["2026-07-12", "2026-07-13"] },
  { resourceId: 99, status: "approved", dates: ["2026-07-12", "2026-07-13"] }
];

test("calendar occupancy renders arrival, departure, adjacent, pending, and ignored dates", () => {
  const occupancy = occupancyFor(bookings, 14);
  assert.deepEqual(occupancy["2026-07-04"], { am: "available", pm: "booked" });
  assert.deepEqual(occupancy["2026-07-11"], { am: "booked", pm: "available" });
  assert.deepEqual(occupancy["2026-07-17"], { am: "booked", pm: "booked" });
  assert.deepEqual(occupancy["2026-08-14"], { am: "available", pm: "pending" });
  assert.deepEqual(occupancy["2026-08-19"], { am: "pending", pm: "available" });
  assert.equal(occupancy["2026-07-12"], undefined);
});

test("range selection allows handoffs but rejects occupied halves and interior days", () => {
  const occupancy = occupancyFor(bookings, 14);
  assert.deepEqual(rangeAvailability(occupancy, "2026-07-11", "2026-07-16"), { available: true, nights: 5 });
  assert.equal(rangeAvailability(occupancy, "2026-07-10", "2026-07-12").available, false);
  assert.equal(rangeAvailability(occupancy, "2026-07-15", "2026-07-17").available, false);
});

test("invalid range selection explains the required dates in Romanian", () => {
  assert.equal(
    rangeAvailability({}, "2026-07-20", "2026-07-20").reason,
    "Selectați data sosirii și o dată de plecare ulterioară."
  );
});

test("selected stays are sent with Booking Calendar check-in and checkout times", () => {
  assert.deepEqual(toStayDateTimes(["2026-07-20", "2026-07-21", "2026-07-22"]), [
    "2026-07-20 15:00:01",
    "2026-07-21 00:00:00",
    "2026-07-22 12:00:02"
  ]);
});

test("camping stays can use the site's earlier check-in time", () => {
  assert.deepEqual(toStayDateTimes(["2026-07-20", "2026-07-21", "2026-07-22"], { checkIn: "14:00:01", checkOut: "12:00:02" }), [
    "2026-07-20 14:00:01",
    "2026-07-21 00:00:00",
    "2026-07-22 12:00:02"
  ]);
});
