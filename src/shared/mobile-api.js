"use strict";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function createOperationSignature({ source, apiBaseUrl, resourceId, dates, formData, bookingFormType, approved }) {
  return JSON.stringify(canonicalValue({
    source,
    apiBaseUrl,
    resourceId: Number(resourceId),
    dates,
    formData,
    bookingFormType: String(bookingFormType || ""),
    approved: Boolean(approved)
  }));
}

function marinaStayPeriod(dates) {
  const values = [...new Set(dates || [])]
    .map((value) => String(value || "").slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  if (!values.length) return null;
  return {
    start_date: values[0],
    // Parkline includes the checkout date. Marina's date-only end_date is the
    // final priced night, so leave the checkout half-day available.
    end_date: values.length > 1 ? values.at(-2) : values[0]
  };
}

function marinaAvailabilityPeriod(dates) {
  const values = [...new Set(dates || [])]
    .map((value) => String(value || "").slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  if (!values.length) return null;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Bucharest", timeZoneName: "longOffset" });
  const timestamp = (date, time) => {
    const zone = formatter.formatToParts(new Date(`${date}T12:00:00Z`)).find((part) => part.type === "timeZoneName")?.value || "GMT+02:00";
    return `${date}T${time}${zone.replace(/^GMT/, "") || "+00:00"}`;
  };
  return {
    start_at: timestamp(values[0], "15:00:01"),
    end_at: timestamp(values.at(-1), "12:00:02")
  };
}

function marinaCheckoutDate(endDate) {
  const value = String(endDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function normalizeMobilePriceQuote(payload, headers = {}) {
  const mode = String(payload?.mode || "");
  const total = Number(payload?.total);
  const deposit = Number(payload?.deposit);
  const balance = Number(payload?.balance);
  if (!["fast", "full"].includes(mode) || ![total, deposit, balance].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("Endpoint-ul de prețuri a returnat un calcul invalid.");
  }
  return {
    ...payload,
    mode,
    total,
    deposit,
    balance,
    valid: payload.valid !== false,
    diagnostics: {
      serverMode: headers["X-Marina-Price-Mode"] || headers["x-marina-price-mode"] || null,
      serverCache: headers["X-Marina-Price-Cache"] || headers["x-marina-price-cache"] || null
    }
  };
}

function serverIdFromPayload(payload) {
  const value = Number(payload?.booking_id ?? payload?.id ?? payload?.booking?.booking_id ?? payload?.booking?.id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function retryDelayMs(attempt, retryAfterSeconds = null, random = Math.random) {
  const retryAfter = Number(retryAfterSeconds);
  if (retryAfterSeconds !== null && retryAfterSeconds !== "" && Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(5000, retryAfter * 1000);
  const base = Math.min(5000, 500 * (2 ** Math.max(0, attempt - 1)));
  return Math.round(base * (0.75 + random() * 0.5));
}

function scopeMobileData(resources, bookings, source) {
  const scopedBookings = bookings || [];
  const referenced = new Set(scopedBookings.map((booking) => Number(booking.resourceId)));
  const scopedResources = (resources || []).filter((resource) => {
    const id = Number(resource.id);
    return resource.active !== false || referenced.has(id);
  });
  return { resources: scopedResources, bookings: scopedBookings };
}

module.exports = { canonicalValue, createOperationSignature, marinaAvailabilityPeriod, marinaCheckoutDate, marinaStayPeriod, normalizeMobilePriceQuote, retryDelayMs, scopeMobileData, serverIdFromPayload };
