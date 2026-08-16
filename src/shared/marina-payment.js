"use strict";

const MANUAL_DEPOSIT_FIELD = "parkline_manual_deposit_minor";

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function paymentEntity(payload) {
  const root = objectValue(payload) || {};
  const data = objectValue(root.data);
  if (data) return objectValue(data.payment) || objectValue(data.booking) || data;
  return objectValue(root.payment) || objectValue(root.booking) || root;
}

function paymentAmount(value, minorValue) {
  if (value !== undefined && value !== null && value !== "") {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount >= 0) return amount;
  }
  if (minorValue !== undefined && minorValue !== null && minorValue !== "") {
    const minor = Number(minorValue);
    if (Number.isFinite(minor) && minor >= 0) return Number((minor / 100).toFixed(2));
  }
  return null;
}

function paymentSources(source) {
  return [
    source,
    objectValue(source.price),
    objectValue(source.payment),
    objectValue(source.pricing),
    objectValue(source.quote),
    objectValue(source.amounts)
  ].filter(Boolean);
}

function moneyMinor(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw Object.assign(new Error(`${field} nu este valid.`), { code: "invalid_deposit", permanent: true });
  return Math.round(amount * 100);
}

function marinaPriceWithDeposit(payload, { total, deposit } = {}) {
  const source = paymentEntity(payload);
  const current = objectValue(source.price) || objectValue(source.pricing) || {};
  const requestedTotalMinor = moneyMinor(total, "Costul total");
  const depositMinor = moneyMinor(deposit, "Avansul");
  const storedTotalMinor = Number(current.total_minor ?? current.totalMinor);
  const totalMinor = Number.isInteger(storedTotalMinor) && storedTotalMinor >= 0 ? storedTotalMinor : requestedTotalMinor;
  if (Math.abs(totalMinor - requestedTotalMinor) > 1 || depositMinor > totalMinor) {
    throw Object.assign(new Error("Avansul trebuie să fie între zero și costul rezervării Marina."), { code: "invalid_deposit", permanent: true });
  }
  return {
    currency: String(current.currency || "RON"),
    base_minor: Number.isInteger(Number(current.base_minor ?? current.baseMinor)) ? Number(current.base_minor ?? current.baseMinor) : totalMinor,
    discount_minor: Number.isInteger(Number(current.discount_minor ?? current.discountMinor)) ? Number(current.discount_minor ?? current.discountMinor) : 0,
    tax_minor: Number.isInteger(Number(current.tax_minor ?? current.taxMinor)) ? Number(current.tax_minor ?? current.taxMinor) : 0,
    total_minor: totalMinor,
    deposit_minor: depositMinor,
    balance_minor: totalMinor - depositMinor,
    payment_status: String(current.payment_status ?? current.paymentStatus ?? "unpaid"),
    source: String(current.source || "app"),
    breakdown: objectValue(current.breakdown) || {}
  };
}

function marinaCustomFieldsWithDeposit(payload, { total, deposit } = {}) {
  const source = paymentEntity(payload);
  const price = marinaPriceWithDeposit(payload, { total, deposit });
  return {
    ...(objectValue(source.custom_fields) || objectValue(source.customFields) || {}),
    [MANUAL_DEPOSIT_FIELD]: price.deposit_minor
  };
}

function minorNames(name) {
  const camel = name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
  return [`${name}_minor`, `${camel}Minor`];
}

function amountFromSources(sources, names) {
  for (const source of sources) {
    for (const name of names) {
      const minor = minorNames(name).map((key) => source[key]).find((value) => value !== undefined);
      const amount = paymentAmount(source[name], minor);
      if (amount !== null) return amount;
    }
  }
  return null;
}

function normalizeMarinaPayment(payload, { bookingId = null, fallbackNote = "", fallbackEmail = "" } = {}) {
  const source = paymentEntity(payload);
  const snapshot = { ...source };
  const sources = paymentSources(source);
  const total = amountFromSources(sources, [
    "total", "total_amount", "totalAmount", "total_price", "totalPrice",
    "grand_total", "grandTotal", "price_total", "priceTotal", "amount_total", "amountTotal"
  ]);
  const customFields = objectValue(source.custom_fields) || objectValue(source.customFields) || {};
  const manualDeposit = paymentAmount(null, customFields[MANUAL_DEPOSIT_FIELD]);
  const deposit = manualDeposit !== null ? manualDeposit : amountFromSources(sources, [
    "deposit", "deposit_amount", "depositAmount", "advance", "advance_amount", "advanceAmount", "cost"
  ]);
  const rawBalance = manualDeposit !== null ? null : amountFromSources(sources, [
    "balance", "remaining", "remaining_amount", "remainingAmount", "amount_due", "amountDue", "due", "rest"
  ]);
  const balance = rawBalance !== null
    ? rawBalance
    : total !== null && deposit !== null
      ? Number((total - deposit).toFixed(2))
      : null;
  if (total !== null) snapshot.total = total;
  if (deposit !== null) snapshot.deposit = deposit;
  if (balance !== null) snapshot.balance = balance;
  if (snapshot.booking_id === undefined) snapshot.booking_id = snapshot.bookingId ?? snapshot.id ?? bookingId;
  if (typeof snapshot.note !== "string" && typeof snapshot.internal_note === "string") snapshot.note = snapshot.internal_note;
  if (typeof snapshot.note !== "string" && typeof snapshot.internalNote === "string") snapshot.note = snapshot.internalNote;
  if (typeof snapshot.note !== "string" && typeof snapshot.remark === "string") snapshot.note = snapshot.remark;
  if (typeof snapshot.note !== "string" && fallbackNote !== undefined) snapshot.note = String(fallbackNote || "");
  if (typeof snapshot.email !== "string" && fallbackEmail) snapshot.email = String(fallbackEmail);
  // Marina payment-email support is deliberately deferred; keep the shared
  // popup from enabling the existing WordPress email action for Marina.
  snapshot.email_available = false;
  return snapshot;
}

module.exports = { MANUAL_DEPOSIT_FIELD, marinaCustomFieldsWithDeposit, marinaPriceWithDeposit, normalizeMarinaPayment, paymentAmount, paymentEntity };
