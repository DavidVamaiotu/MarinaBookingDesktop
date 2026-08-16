"use strict";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function addIsoDays(value, amount) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function assertDate(value, label = "data") {
  const date = String(value || "");
  if (!DATE.test(date)) throw Object.assign(new Error(`${label} este invalidă.`), { code: "marina_pricing_invalid_date", permanent: true });
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error(`${label} este invalidă.`), { code: "marina_pricing_invalid_date", permanent: true });
  }
  return date;
}

function parseMoneyMinor(value, label = "preț") {
  const raw = String(value ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw Object.assign(new Error(`${label} nu este o sumă RON validă.`), { code: "marina_pricing_invalid_money", permanent: true });
  }
  const [whole, fraction = ""] = raw.split(".");
  const minor = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw Object.assign(new Error(`${label} nu este o sumă RON validă.`), { code: "marina_pricing_invalid_money", permanent: true });
  }
  return minor;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function pricingDocument(config = {}) {
  return {
    currency: String(config.currency || "RON"),
    billing_period: String(config.billing_period || "night"),
    pricing_mode: String(config.pricing_mode || "resource_per_night"),
    resource_nightly_minor: Number(config.resource_nightly_minor),
    adult_nightly_minor: Number(config.adult_nightly_minor || 0),
    child_nightly_minor: Number(config.child_nightly_minor || 0),
    count_adults: Boolean(config.count_adults),
    count_children: Boolean(config.count_children),
    deposit_percent: Number(config.deposit_percent ?? 30),
    seasons: (Array.isArray(config.seasons) ? config.seasons : []).map((season) => ({
      name: String(season.name || ""),
      start_date: String(season.start_date),
      end_date: String(season.end_date),
      resource_nightly_minor: Number(season.resource_nightly_minor),
      adult_nightly_minor: Number(season.adult_nightly_minor || 0),
      child_nightly_minor: Number(season.child_nightly_minor || 0)
    }))
  };
}

function validateDailyPrices(days) {
  if (!Array.isArray(days) || !days.length) {
    throw Object.assign(new Error("Nu există prețuri zilnice de importat."), { code: "marina_pricing_no_days", permanent: true });
  }
  const sorted = [...days].map((item) => ({ date: assertDate(item?.date), price_minor: item?.price_minor })).sort((left, right) => left.date.localeCompare(right.date));
  const seen = new Set();
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    if (seen.has(item.date)) throw Object.assign(new Error(`Prețul pentru ${item.date} apare de mai multe ori.`), { code: "marina_pricing_duplicate_date", permanent: true });
    seen.add(item.date);
    if (!Number.isSafeInteger(item.price_minor) || item.price_minor < 0) {
      throw Object.assign(new Error(`Prețul pentru ${item.date} nu este exprimat în bani întregi.`), { code: "marina_pricing_invalid_minor", permanent: true });
    }
    if (index > 0 && item.date !== addIsoDays(sorted[index - 1].date, 1)) {
      throw Object.assign(new Error(`Lipsește un preț zilnic între ${sorted[index - 1].date} și ${item.date}.`), { code: "marina_pricing_missing_date", permanent: true, from: sorted[index - 1].date, to: item.date });
    }
  }
  return sorted;
}

function equalPriceGroups(days) {
  const valid = validateDailyPrices(days);
  const groups = [];
  for (const item of valid) {
    const previous = groups.at(-1);
    if (previous && previous.price_minor === item.price_minor && item.date === addIsoDays(previous.end_date, 1)) previous.end_date = item.date;
    else groups.push({ start_date: item.date, end_date: item.date, price_minor: item.price_minor });
  }
  return groups;
}

function configuredPriceForDate(config, date) {
  const value = assertDate(date);
  const season = (config.seasons || []).find((item) => value >= item.start_date && value <= item.end_date);
  return Number(season?.resource_nightly_minor ?? config.resource_nightly_minor);
}

function verifyPricingConfiguration(config, days) {
  const valid = validateDailyPrices(days);
  const mismatches = valid.filter((item) => configuredPriceForDate(config, item.date) !== item.price_minor);
  if (mismatches.length) {
    throw Object.assign(new Error(`Configurația Marina nu reproduce ${mismatches.length} prețuri zilnice.`), {
      code: "marina_pricing_replay_mismatch",
      permanent: true,
      mismatches: mismatches.slice(0, 20)
    });
  }
  return true;
}

function buildMarinaPricing(days, { depositPercent = 30, timezone = "Europe/Bucharest" } = {}) {
  const valid = validateDailyPrices(days);
  const groups = equalPriceGroups(valid);
  const baseGroup = groups.reduce((selected, group) => {
    if (!selected) return group;
    const selectedLength = daysBetween(selected.start_date, selected.end_date) + 1;
    const groupLength = daysBetween(group.start_date, group.end_date) + 1;
    return groupLength > selectedLength || (groupLength === selectedLength && group.start_date < selected.start_date) ? group : selected;
  }, null);
  const config = pricingDocument({
    currency: "RON",
    billing_period: "night",
    pricing_mode: "resource_per_night",
    resource_nightly_minor: baseGroup.price_minor,
    adult_nightly_minor: 0,
    child_nightly_minor: 0,
    count_adults: false,
    count_children: false,
    deposit_percent: depositPercent,
    timezone,
    seasons: groups.filter((group) => group.price_minor !== baseGroup.price_minor).map((group) => ({
      name: `Imported ${group.start_date}–${group.end_date}`,
      start_date: group.start_date,
      end_date: group.end_date,
      resource_nightly_minor: group.price_minor,
      adult_nightly_minor: 0,
      child_nightly_minor: 0
    }))
  });
  if (!Number.isInteger(config.deposit_percent) || config.deposit_percent < 0 || config.deposit_percent > 100) {
    throw Object.assign(new Error("Procentul avansului Marina este invalid."), { code: "marina_pricing_invalid_deposit", permanent: true });
  }
  verifyPricingConfiguration(config, valid);
  return {
    config,
    groups,
    coverage: { from: valid[0].date, to: valid.at(-1).date },
    sourceDays: valid
  };
}

function daysBetween(start, end) {
  return Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86_400_000);
}

function stripVersion(config) {
  const value = pricingDocument(config);
  return canonicalValue(value);
}

function samePricingConfiguration(left, right) {
  return JSON.stringify(stripVersion(left)) === JSON.stringify(stripVersion(right));
}

module.exports = {
  addIsoDays,
  buildMarinaPricing,
  canonicalValue,
  configuredPriceForDate,
  daysBetween,
  equalPriceGroups,
  parseMoneyMinor,
  pricingDocument,
  samePricingConfiguration,
  validateDailyPrices,
  verifyPricingConfiguration
};
