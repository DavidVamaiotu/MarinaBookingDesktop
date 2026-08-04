(function (root, factory) {
  const fields = typeof module === "object" && module.exports ? require("./booking-fields") : root.BookingFields;
  const api = factory(fields);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TimelineAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (BookingFields) {
  "use strict";

  function field(booking, ...names) {
    return BookingFields.value(booking, ...names);
  }

  function toItem(booking) {
    const lastName = field(booking, "lastName");
    const name = lastName || field(booking, "firstName") || field(booking, "email") || `Rezervare ${booking.serverId || "local"}`;
    return {
      key: booking.localId,
      serverId: booking.serverId,
      resourceId: Number(booking.timelineResourceId ?? booking.resourceId),
      start: booking.startDate || booking.dates?.[0],
      end: booking.endDate || booking.dates?.[booking.dates.length - 1],
      title: name,
      subtitle: field(booking, "phone") || field(booking, "email"),
      status: booking.trashed ? "trashed" : booking.status,
      syncState: booking.syncState || "synced",
      booking
    };
  }

  function mapState(resources, bookings, { includeTrashed = false } = {}) {
    const items = bookings.filter((booking) => includeTrashed || !booking.trashed).map(toItem);
    return resources.map((resource) => ({
      id: Number(resource.id),
      title: resource.title || `Spațiul ${resource.id}`,
      subtitle: "",
      items: items.filter((item) => item.resourceId === Number(resource.id))
    }));
  }

  function assignLanes(items) {
    const laneEnds = [];
    const laneLastKeys = [];
    const assigned = [...items]
      .sort((first, second) => first.start.localeCompare(second.start) || first.end.localeCompare(second.end))
      .map((item) => {
        let lane = laneEnds.findIndex((laneEnd) => item.start >= laneEnd);
        const predecessorKey = lane >= 0 && item.start === laneEnds[lane] ? laneLastKeys[lane] : "";
        if (lane < 0) {
          lane = laneEnds.length;
          laneEnds.push(item.end);
          laneLastKeys.push(item.key);
        } else {
          laneEnds[lane] = item.end;
          laneLastKeys[lane] = item.key;
        }
        return { item, lane: lane + 1, predecessorKey };
      });
    return { items: assigned, count: Math.max(1, laneEnds.length) };
  }

  function barSignature(item, lane, predecessorKey, windowStart, dayCount) {
    return JSON.stringify([
      windowStart,
      dayCount,
      item.start,
      item.end,
      item.title,
      item.subtitle,
      item.status,
      item.syncState,
      lane,
      predecessorKey
    ]);
  }

  return { assignLanes, barSignature, field, mapState, toItem };
});
