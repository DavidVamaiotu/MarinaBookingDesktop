"use strict";

function quoteEntity(payload) {
  if (payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)) return payload.data;
  if (payload?.quote && typeof payload.quote === "object") return payload.quote;
  return payload || {};
}

function integer(value, label, { allowNull = false } = {}) {
  if (allowNull && (value === undefined || value === null || value === "")) return null;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw Object.assign(new Error(`Câmpul ${label} returnat de Marina este invalid.`), { code: "marina_invalid_quote", permanent: true });
  return parsed;
}

function moneyMajor(minor) {
  return Number((minor / 100).toFixed(2));
}

function formatMoney(minor) {
  return `${new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(moneyMajor(minor))} lei`;
}

function normalizeMarinaQuote(payload, { mode = "full" } = {}) {
  const value = quoteEntity(payload);
  const quoteId = String(value.quote_id ?? value.quoteId ?? "").trim();
  if (!quoteId) throw Object.assign(new Error("Marina nu a returnat identificatorul cotației."), { code: "marina_invalid_quote", permanent: true });
  const nights = integer(value.nights, "nights");
  const totalMinor = integer(value.total_minor ?? value.totalMinor, "total_minor");
  const depositMinor = integer(value.deposit_minor ?? value.depositMinor, "deposit_minor");
  const balanceMinor = integer(value.balance_minor ?? value.balanceMinor, "balance_minor");
  const depositPercent = Number(value.deposit_percent ?? value.depositPercent ?? 30);
  if (!Number.isFinite(depositPercent) || depositPercent < 0 || depositPercent > 100 || depositMinor > totalMinor || balanceMinor !== totalMinor - depositMinor) {
    throw Object.assign(new Error("Marina a returnat o cotație inconsistentă."), { code: "marina_invalid_quote", permanent: true });
  }
  const expiresAt = String(value.expires_at ?? value.expiresAt ?? "").trim();
  if (!expiresAt || Number.isNaN(new Date(expiresAt).getTime())) throw Object.assign(new Error("Marina nu a returnat expirarea cotației."), { code: "marina_invalid_quote", permanent: true });
  const pricingVersion = value.pricing_version ?? value.pricingVersion ?? null;
  const nightsBreakdown = Array.isArray(value.nights_breakdown ?? value.nightsBreakdown) ? (value.nights_breakdown ?? value.nightsBreakdown) : [];
  return {
    ...value,
    valid: value.valid !== false,
    mode,
    quoteId,
    quote_id: quoteId,
    pricingVersion,
    pricing_version: pricingVersion,
    nights,
    days: nights,
    totalMinor,
    total_minor: totalMinor,
    depositPercent,
    deposit_percent: depositPercent,
    depositMinor,
    deposit_minor: depositMinor,
    balanceMinor,
    balance_minor: balanceMinor,
    nightsBreakdown,
    nights_breakdown: nightsBreakdown,
    expiresAt,
    expires_at: expiresAt,
    total: moneyMajor(totalMinor),
    deposit: moneyMajor(depositMinor),
    balance: moneyMajor(balanceMinor),
    formatted: {
      total: formatMoney(totalMinor),
      deposit: formatMoney(depositMinor),
      balance: formatMoney(balanceMinor)
    }
  };
}

function quoteIsFresh(quote, now = Date.now(), safetyMs = 30_000) {
  const expires = new Date(String(quote?.expiresAt ?? quote?.expires_at ?? "")).getTime();
  return Boolean(quote?.valid && quote?.quoteId && Number.isFinite(expires) && expires > now + safetyMs);
}

module.exports = { formatMoney, moneyMajor, normalizeMarinaQuote, quoteEntity, quoteIsFresh };
