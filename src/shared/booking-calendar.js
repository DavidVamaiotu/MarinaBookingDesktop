(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BookingCalendar = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY_MS = 86_400_000;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const PRIORITY = { available: 0, pending: 1, booked: 2 };

  function utcDate(value) {
    return new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  }

  function iso(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(value, count) {
    const date = utcDate(value);
    date.setUTCDate(date.getUTCDate() + count);
    return iso(date);
  }

  function daysBetween(start, end) {
    return Math.round((utcDate(end) - utcDate(start)) / DAY_MS);
  }

  function dateRange(start, end) {
    if (!DATE.test(start) || !DATE.test(end) || start > end) return [];
    return Array.from({ length: daysBetween(start, end) + 1 }, (_, index) => addDays(start, index));
  }

  function toStayDateTimes(dates, { checkIn = "15:00:01", checkOut = "12:00:02" } = {}) {
    const values = [...new Set((dates || []).map((value) => String(value).slice(0, 10)).filter((value) => DATE.test(value)))].sort();
    if (values.length < 2) return values.map((value) => `${value} 00:00:00`);
    return values.map((value, index) => {
      if (index === 0) return `${value} ${checkIn}`;
      if (index === values.length - 1) return `${value} ${checkOut}`;
      return `${value} 00:00:00`;
    });
  }

  function stronger(first = "available", second = "available") {
    return PRIORITY[second] > PRIORITY[first] ? second : first;
  }

  function occupancyFor(bookings, resourceId) {
    const occupancy = {};
    for (const booking of bookings || []) {
      if (booking.trashed || Number(booking.resourceId) !== Number(resourceId)) continue;
      const dates = [...new Set((booking.dates || []).map((value) => String(value).slice(0, 10)).filter((value) => DATE.test(value)))].sort();
      if (!dates.length) continue;
      const state = booking.status === "approved" ? "booked" : "pending";
      dates.forEach((date, index) => {
        const day = occupancy[date] || { am: "available", pm: "available" };
        if (dates.length === 1 || index > 0) day.am = stronger(day.am, state);
        if (dates.length === 1 || index < dates.length - 1) day.pm = stronger(day.pm, state);
        occupancy[date] = day;
      });
    }
    return occupancy;
  }

  function rangeAvailability(occupancy, start, end) {
    if (!DATE.test(start || "") || !DATE.test(end || "") || start >= end) {
      return { available: false, reason: "Selectați data sosirii și o dată de plecare ulterioară." };
    }
    const dates = dateRange(start, end);
    for (let index = 0; index < dates.length; index += 1) {
      const date = dates[index];
      const day = occupancy[date] || { am: "available", pm: "available" };
      const halves = index === 0 ? ["pm"] : index === dates.length - 1 ? ["am"] : ["am", "pm"];
      const conflictHalf = halves.find((half) => day[half] !== "available");
      if (conflictHalf) return { available: false, date, half: conflictHalf, state: day[conflictHalf] };
    }
    return { available: true, nights: daysBetween(start, end) };
  }

  return { addDays, dateRange, daysBetween, occupancyFor, rangeAvailability, toStayDateTimes };
});
