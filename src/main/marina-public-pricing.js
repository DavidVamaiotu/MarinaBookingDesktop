"use strict";

const { createHash } = require("node:crypto");
const { addIsoDays, daysBetween, parseMoneyMinor } = require("./marina-pricing");

const MARINA_PUBLIC_PRICING_URL = "https://www.marinapark.ro/preturi-cazare-camping/";
const MARINA_PUBLIC_PRICING_ORIGIN = "https://www.marinapark.ro";
const MARINA_CAMPING_PRICING_URL = "https://camping.marinapark.ro/preturi-camping/";
const MARINA_CAMPING_PRICING_ORIGIN = "https://camping.marinapark.ro";
const MAX_RESPONSE_BYTES = 300_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_YEAR = 2026;
const CARAVAN_MINIMUM_GUESTS = 2;
const MONTHS = Object.freeze({
  aprilie: 4,
  aprile: 4,
  mai: 5,
  iunie: 6,
  iulie: 7,
  august: 8,
  septembrie: 9,
  sept: 9
});

const CATEGORY_ORDER = Object.freeze(["double", "quadruple", "bungalow", "bungalow_superior", "glamping"]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function textContent(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function categoryKey(value) {
  const name = normalizeText(value);
  if (name === "camera dubla") return "double";
  if (name === "camera cvadrupla") return "quadruple";
  if (name === "camera dubla in bungalow") return "bungalow";
  if (name === "camera dubla in bungalow superior") return "bungalow_superior";
  if (name === "glamping") return "glamping";
  return null;
}

function resourceCategory(value) {
  const name = normalizeText(value);
  if (name.includes("rulota") || name.includes("caravan")) return "caravan";
  if (name.includes("bungalow superior")) return "bungalow_superior";
  if (name.includes("bungalow")) return "bungalow";
  if (name.includes("cvadrupl") || name.includes("quadrupl")) return "quadruple";
  if (name.includes("glamping")) return "glamping";
  if (name.includes("dubla") || name.includes("dublă") || name.includes("double")) return "double";
  return null;
}

function categoryLabel(key) {
  return {
    double: "Camera dubla",
    quadruple: "Camera Cvadrupla",
    bungalow: "Camera dubla in bungalow",
    bungalow_superior: "Camera dubla in bungalow superior",
    glamping: "Glamping",
    caravan: "Campare cu rulota personală"
  }[key] || key;
}

function isoDate(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`Interval public invalid: ${value}`);
  return value;
}

function parseRangeLabel(label, year, warnings = null) {
  const original = textContent(label);
  const clean = normalizeText(original)
    .replace(/\([^)]*\)/g, "")
    .replace(/[.]/g, "")
    .replace(/\s+/g, "")
    .trim();
  let match = clean.match(/^(\d{1,2})([a-z]+)-(\d{1,2})([a-z]+)$/);
  if (match) {
    const startMonth = MONTHS[match[2]];
    const endMonth = MONTHS[match[4]];
    if (!startMonth || !endMonth) throw Object.assign(new Error(`Luna din intervalul public este necunoscută: ${original}`), { code: "marina_public_pricing_invalid_range", permanent: true });
    return { label: original, start_date: isoDate(year, startMonth, Number(match[1])), end_date: isoDate(year, endMonth, Number(match[3])) };
  }
  match = clean.match(/^(\d{1,2})-(\d{1,2})([a-z]+)$/);
  if (match) {
    const month = MONTHS[match[3]];
    if (!month) throw Object.assign(new Error(`Luna din intervalul public este necunoscută: ${original}`), { code: "marina_public_pricing_invalid_range", permanent: true });
    const startDay = Number(match[1]);
    let endDay = Number(match[2]);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (endDay > lastDay && startDay <= lastDay) {
      endDay = lastDay;
      warnings?.push(`${original}: ziua finală a fost limitată la ultima zi validă din luna publicată.`);
    }
    return { label: original, start_date: isoDate(year, month, startDay), end_date: isoDate(year, month, endDay) };
  }
  throw Object.assign(new Error(`Intervalul public nu poate fi interpretat: ${original}`), { code: "marina_public_pricing_invalid_range", permanent: true });
}

function correctionFor(category, range, warnings) {
  const normalized = normalizeText(range.label).replace(/[.\s]/g, "");
  if (category === "quadruple" && normalized === "29aprilie-31mai") {
    warnings.push("Camera Cvadrupla: eticheta publică 29Aprilie-31Mai a fost interpretată ca 29Mai-31Mai pentru a elimina suprapunerea evidentă.");
    return { ...range, start_date: `${range.start_date.slice(0, 4)}-05-29` };
  }
  return range;
}

function priorityForRange(range, category) {
  const normalized = normalizeText(range.label).replace(/[.\s]/g, "");
  if (normalized.startsWith("29mai-31mai") || normalized.startsWith("9-23august")) return 2;
  if (category === "quadruple" && normalized.startsWith("29aprilie-31mai")) return 2;
  if (category === "caravan" && normalized.startsWith("29aprilie-3mai")) return 2;
  return 1;
}

function parsePanelEntries(panel, category, year, warnings) {
  const entries = [];
  const itemPattern = /<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|<h4\b|$)/gi;
  for (const match of panel.matchAll(itemPattern)) {
    const label = textContent(match[1]);
    if (!/\d/.test(label)) continue;
    let range = parseRangeLabel(label, year, warnings);
    range = correctionFor(category, range, warnings);
    const money = match[2].match(/<del\b[^>]*>\s*([^<]+?)\s*<\/del>/i)?.[1];
    if (money === undefined) continue;
    entries.push({ ...range, price_minor: parseMoneyMinor(textContent(money).replace(/(?:lei|ron)$/i, ""), `${categoryLabel(category)} ${label}`), priority: priorityForRange(range, category) });
  }
  return entries;
}

function expandEntries(entries, warnings, category) {
  const byDate = new Map();
  for (const entry of entries) {
    for (let date = entry.start_date; date <= entry.end_date; date = addIsoDays(date, 1)) {
      const previous = byDate.get(date);
      if (!previous || entry.priority > previous.priority) {
        if (previous && previous.price_minor !== entry.price_minor) warnings.push(`${categoryLabel(category)}: ${date} a fost rezolvat în favoarea intervalului mai specific.`);
        byDate.set(date, { date, price_minor: entry.price_minor, priority: entry.priority });
      } else if (entry.priority === previous.priority && previous.price_minor !== entry.price_minor) {
        throw Object.assign(new Error(`${categoryLabel(category)} are prețuri ambigue pentru ${date}.`), { code: "marina_public_pricing_ambiguous", permanent: true, date, category });
      } else if (previous && previous.price_minor !== entry.price_minor) {
        warnings.push(`${categoryLabel(category)}: ${date} a rămas la intervalul mai specific.`);
      }
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function parsePublicPricingHtml(html, { year = DEFAULT_YEAR } = {}) {
  const source = String(html || "");
  if (!source) throw Object.assign(new Error("Pagina publică de prețuri este goală."), { code: "marina_public_pricing_empty", permanent: true });
  const seasonMatch = textContent(source.match(/.{0,120}sezonul\s+(20\d{2}).{0,120}/i)?.[0] || "").match(/sezonul\s+(20\d{2})/i);
  if (!seasonMatch || Number(seasonMatch[1]) !== Number(year)) throw Object.assign(new Error(`Pagina publică nu publică sezonul ${year}.`), { code: "marina_public_pricing_year_missing", permanent: true, year });
  const panelStarts = [];
  for (const match of source.matchAll(/<div\b[^>]*class="([^"]*)"[^>]*>/gi)) {
    if (match[1].split(/\s+/).includes("vc_tta-panel")) panelStarts.push(match.index);
  }
  const categories = {};
  const warnings = [];
  for (let index = 0; index < panelStarts.length; index += 1) {
    const panel = source.slice(panelStarts[index], panelStarts[index + 1] ?? source.length);
    const title = textContent(panel.match(/<span\b[^>]*class="[^"]*\bvc_tta-title-text\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    const category = categoryKey(title);
    if (!category || categories[category]) continue;
    const entries = parsePanelEntries(panel, category, year, warnings);
    if (!entries.length) throw Object.assign(new Error(`Pagina publică nu conține intervale pentru ${categoryLabel(category)}.`), { code: "marina_public_pricing_category_missing", permanent: true, category });
    const days = expandEntries(entries, warnings, category);
    const from = `${year}-04-17`;
    const to = `${year}-09-30`;
    const expected = daysBetween(from, to) + 1;
    if (days.length !== expected || days[0]?.date !== from || days.at(-1)?.date !== to) {
      throw Object.assign(new Error(`${categoryLabel(category)} nu acoperă continuu sezonul public ${from}–${to}.`), { code: "marina_public_pricing_gap", permanent: true, category, from, to });
    }
    categories[category] = { category, title, entries, days, from, to };
  }
  const missing = CATEGORY_ORDER.filter((category) => !categories[category]);
  if (missing.length) throw Object.assign(new Error(`Lipsesc categoriile publice: ${missing.map(categoryLabel).join(", ")}.`), { code: "marina_public_pricing_categories_incomplete", permanent: true, missing });
  return {
    source: "marina-public-prices",
    source_url: MARINA_PUBLIC_PRICING_URL,
    year: Number(year),
    categories,
    warnings,
    coverage: { from: `${year}-04-17`, to: `${year}-09-30` },
    fingerprint: createHash("sha256").update(source).digest("hex")
  };
}

function parsePublicCampingPricingHtml(html, { year = DEFAULT_YEAR } = {}) {
  const source = String(html || "");
  if (!source) throw Object.assign(new Error("Pagina publică de prețuri camping este goală."), { code: "marina_public_pricing_empty", permanent: true });
  const seasonMatch = textContent(source.match(/.{0,160}sezonul[\s\S]{0,160}?(20\d{2}).{0,160}/i)?.[0] || "").match(/sezonul[\s\S]*?(20\d{2})/i);
  if (!seasonMatch || Number(seasonMatch[1]) !== Number(year)) throw Object.assign(new Error(`Pagina publică camping nu publică sezonul ${year}.`), { code: "marina_public_pricing_year_missing", permanent: true, year });
  const panelStarts = [];
  for (const match of source.matchAll(/<div\b[^>]*class="([^"]*)"[^>]*>/gi)) {
    if (match[1].split(/\s+/).includes("vc_tta-panel")) panelStarts.push(match.index);
  }
  const warnings = [];
  let selected = null;
  for (let index = 0; index < panelStarts.length; index += 1) {
    const panel = source.slice(panelStarts[index], panelStarts[index + 1] ?? source.length);
    const title = textContent(panel.match(/<span\b[^>]*class="[^\"]*\bvc_tta-title-text\b[^\"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    if (resourceCategory(title) !== "caravan") continue;
    const entries = parsePanelEntries(panel, "caravan", year, warnings);
    if (!entries.length) throw Object.assign(new Error("Pagina publică camping nu conține intervale pentru rulote."), { code: "marina_public_pricing_category_missing", permanent: true, category: "caravan" });
    const days = expandEntries(entries, warnings, "caravan");
    const from = `${year}-04-17`;
    const to = `${year}-09-30`;
    const expected = daysBetween(from, to) + 1;
    if (days.length !== expected || days[0]?.date !== from || days.at(-1)?.date !== to) {
      throw Object.assign(new Error(`Tariful camping pentru rulote nu acoperă continuu sezonul public ${from}–${to}.`), { code: "marina_public_pricing_gap", permanent: true, category: "caravan", from, to });
    }
    selected = { category: "caravan", title, entries, days, from, to };
    break;
  }
  if (!selected) throw Object.assign(new Error("Pagina publică camping nu conține categoria Campare cu Rulota Personala."), { code: "marina_public_pricing_category_missing", permanent: true, category: "caravan" });
  warnings.push("Tariful public pentru rulote este per persoană și a fost convertit la tariful minim pentru două persoane; nu se adaugă suplimente pe persoană în Marina.");
  return {
    source: "marina-public-camping-prices",
    source_url: MARINA_CAMPING_PRICING_URL,
    year: Number(year),
    categories: { caravan: { ...selected, days: selected.days.map((day) => ({ ...day, price_minor: day.price_minor * CARAVAN_MINIMUM_GUESTS })) } },
    warnings,
    coverage: { from: selected.from, to: selected.to },
    fingerprint: createHash("sha256").update(source).digest("hex")
  };
}

async function readResponseText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw Object.assign(new Error("Pagina publică de prețuri este prea mare."), { code: "marina_public_pricing_response_too_large", permanent: true });
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw Object.assign(new Error("Pagina publică de prețuri este prea mare."), { code: "marina_public_pricing_response_too_large", permanent: true });
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error("Pagina publică de prețuri este prea mare."), { code: "marina_public_pricing_response_too_large", permanent: true });
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

class MarinaPublicPricingSource {
  constructor({ fetchImpl = globalThis.fetch, url = MARINA_PUBLIC_PRICING_URL, timeoutMs = DEFAULT_TIMEOUT_MS, year = DEFAULT_YEAR } = {}) {
    this.fetchImpl = fetchImpl;
    this.url = String(url);
    this.timeoutMs = timeoutMs;
    this.year = year;
  }

  async fetchCatalog(url, origin, parser, label = "publică") {
    let target;
    try { target = new URL(url); } catch { throw Object.assign(new Error(`Sursa ${label} de prețuri este invalidă.`), { code: "marina_public_pricing_url_invalid", permanent: true }); }
    if (target.protocol !== "https:" || target.origin !== origin) throw Object.assign(new Error(`Sursa ${label} de prețuri nu este allowlistată.`), { code: "marina_public_pricing_url_invalid", permanent: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(target.toString(), { method: "GET", headers: { Accept: "text/html" }, redirect: "follow", signal: controller.signal });
      if (!response.ok) throw Object.assign(new Error(`Pagina ${label} de prețuri a returnat HTTP ${response.status}.`), { code: "marina_public_pricing_http_error", status: response.status, temporary: response.status >= 500, permanent: response.status < 500 });
      const finalUrl = new URL(response.url || target.toString());
      if (finalUrl.protocol !== "https:" || finalUrl.origin !== origin) throw Object.assign(new Error(`Sursa ${label} de prețuri a redirecționat către o origine invalidă.`), { code: "marina_public_pricing_redirect_invalid", permanent: true });
      return parser(await readResponseText(response), { year: this.year });
    } catch (error) {
      if (error?.name === "AbortError") throw Object.assign(new Error(`Citirea paginii ${label} de prețuri a expirat.`), { code: "marina_public_pricing_timeout", temporary: true });
      throw error;
    } finally { clearTimeout(timer); }
  }

  async catalog() {
    return this.fetchCatalog(this.url, MARINA_PUBLIC_PRICING_ORIGIN, parsePublicPricingHtml);
  }

  async campingCatalog() {
    return this.fetchCatalog(MARINA_CAMPING_PRICING_URL, MARINA_CAMPING_PRICING_ORIGIN, parsePublicCampingPricingHtml, "camping");
  }

  async forResources(resources) {
    const catalog = await this.catalog();
    const resourceCategories = new Map((resources || []).map((resource) => [String(resource.id), resourceCategory([
      resource.title,
      resource.name,
      resource.label,
      resource.category,
      resource.type,
      resource.slug,
      resource.form,
      resource.default_form,
      resource.defaultForm,
      resource.parent_title,
      resource.parentName,
      resource.parent?.title,
      resource.parent?.name
    ].filter(Boolean).join(" "))]));
    const campingCatalog = [...resourceCategories.values()].includes("caravan") ? await this.campingCatalog() : null;
    const mapped = [];
    const unmapped = [];
    for (const resource of resources || []) {
      const category = resourceCategories.get(String(resource.id));
      const selectedCatalog = category === "caravan" ? campingCatalog : catalog;
      if (!category || !selectedCatalog?.categories[category]) {
        unmapped.push({ source_resource_id: String(resource.id), resource_name: String(resource.title || resource.name || "") });
        continue;
      }
      mapped.push({
        source: selectedCatalog.source,
        source_url: selectedCatalog.source_url,
        source_fingerprint: selectedCatalog.fingerprint,
        source_resource_id: String(resource.id),
        resource_name: String(resource.title || resource.name || ""),
        category,
        currency: "RON",
        timezone: "Europe/Bucharest",
        from: selectedCatalog.coverage.from,
        to: selectedCatalog.coverage.to,
        warnings: selectedCatalog.warnings,
        days: selectedCatalog.categories[category].days
      });
    }
    if (unmapped.length) throw Object.assign(new Error(`Nu s-au putut mapa categoriile publice pentru ${unmapped.length} resurse Marina.`), { code: "marina_public_pricing_resource_unmapped", permanent: true, unmapped });
    return { catalog: { ...catalog, warnings: [...catalog.warnings, ...(campingCatalog?.warnings || [])] }, campingCatalog, mapped };
  }
}

module.exports = {
  CATEGORY_ORDER,
  CARAVAN_MINIMUM_GUESTS,
  DEFAULT_YEAR,
  MARINA_CAMPING_PRICING_ORIGIN,
  MARINA_CAMPING_PRICING_URL,
  MARINA_PUBLIC_PRICING_ORIGIN,
  MARINA_PUBLIC_PRICING_URL,
  MarinaPublicPricingSource,
  categoryKey,
  normalizeText,
  parsePublicCampingPricingHtml,
  parsePublicPricingHtml,
  parseRangeLabel,
  resourceCategory
};
