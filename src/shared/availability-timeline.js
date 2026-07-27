(function (root, factory) {
  const dependency = typeof module === "object" && module.exports
    ? require("./booking-calendar")
    : root.BookingCalendar;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AvailabilityTimeline = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (BookingCalendar) {
  "use strict";

  function monthStart(value) {
    const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) throw new TypeError("Invalid availability month");
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  function iso(date) {
    return date.toISOString().slice(0, 10);
  }

  function parseDate(value, label) {
    const date = value instanceof Date ? new Date(value) : new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid availability ${label}`);
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }

  function buildRange(resources, bookings, startValue, endValue) {
    const start = parseDate(startValue, "start");
    const end = parseDate(endValue, "end");
    if (end < start) throw new RangeError("Availability end must not be before start");
    const dates = BookingCalendar.dateRange(iso(start), iso(end)).map((date) => {
      const parsed = new Date(`${date}T00:00:00Z`);
      return { date, day: parsed.getUTCDate(), weekday: parsed.getUTCDay() };
    });
    const rows = (resources || []).map((resource) => {
      const occupancy = BookingCalendar.occupancyFor(bookings, resource.id);
      return {
        id: resource.id,
        title: resource.title || `Spațiul ${resource.id}`,
        cells: dates.map(({ date }) => ({
          date,
          am: occupancy[date]?.am || "available",
          pm: occupancy[date]?.pm || "available"
        }))
      };
    });
    return { start: iso(start), end: iso(end), dates, rows };
  }

  function buildMonth(resources, bookings, value) {
    const start = monthStart(value);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    return buildRange(resources, bookings, start, end);
  }

  function monthSegments(dates) {
    const segments = [];
    (dates || []).forEach(({ date }, index) => {
      const key = String(date).slice(0, 7);
      const current = segments.at(-1);
      if (current?.key === key) {
        current.length += 1;
        current.end = date;
      } else {
        segments.push({ key, start: date, end: date, offset: index, length: 1 });
      }
    });
    return segments;
  }

  function fromDate(view, value) {
    const cutoff = iso(value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
    return {
      ...view,
      dates: view.dates.filter(({ date }) => date >= cutoff),
      rows: view.rows.map((row) => ({ ...row, cells: row.cells.filter(({ date }) => date >= cutoff) }))
    };
  }

  return { buildRange, buildMonth, fromDate, monthSegments, monthStart };
});
