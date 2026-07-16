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

  function buildMonth(resources, bookings, value) {
    const start = monthStart(value);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
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

  function fromDate(view, value) {
    const cutoff = iso(value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
    return {
      ...view,
      dates: view.dates.filter(({ date }) => date >= cutoff),
      rows: view.rows.map((row) => ({ ...row, cells: row.cells.filter(({ date }) => date >= cutoff) }))
    };
  }

  return { buildMonth, fromDate, monthStart };
});
