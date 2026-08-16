"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMarinaPricing, configuredPriceForDate, equalPriceGroups, parseMoneyMinor, verifyPricingConfiguration } = require("../src/main/marina-pricing");
const { parsePublicCampingPricingHtml, parsePublicPricingHtml, resourceCategory } = require("../src/main/marina-public-pricing");

test("pricing money is parsed exactly into bani", () => {
  assert.equal(parseMoneyMinor("150"), 15000);
  assert.equal(parseMoneyMinor("150.5"), 15050);
  assert.equal(parseMoneyMinor("150,50"), 15050);
  assert.throws(() => parseMoneyMinor("150.555"), /sumă RON validă/);
  assert.throws(() => parseMoneyMinor("-1"), /sumă RON validă/);
});

test("daily prices group consecutive days and choose the earliest longest base", () => {
  const days = [
    { date: "2026-06-01", price_minor: 10000 },
    { date: "2026-06-02", price_minor: 10000 },
    { date: "2026-06-03", price_minor: 20000 },
    { date: "2026-06-04", price_minor: 20000 },
    { date: "2026-06-05", price_minor: 10000 },
    { date: "2026-06-06", price_minor: 10000 }
  ];
  assert.deepEqual(equalPriceGroups(days), [
    { start_date: "2026-06-01", end_date: "2026-06-02", price_minor: 10000 },
    { start_date: "2026-06-03", end_date: "2026-06-04", price_minor: 20000 },
    { start_date: "2026-06-05", end_date: "2026-06-06", price_minor: 10000 }
  ]);
  const generated = buildMarinaPricing(days);
  assert.equal(generated.config.resource_nightly_minor, 10000);
  assert.equal(generated.config.seasons.length, 1);
  assert.equal(configuredPriceForDate(generated.config, "2026-06-03"), 20000);
  assert.equal(configuredPriceForDate(generated.config, "2026-06-06"), 10000);
  assert.throws(() => equalPriceGroups([{ date: "2026-06-01", price_minor: 10000 }, { date: "2026-06-03", price_minor: 10000 }]), /Lipsește un preț zilnic/);
});

test("public Marina page parser recognizes every accommodation category", () => {
  const categories = ["Camera dubla", "Camera Cvadrupla", "Camera dubla in bungalow", "Camera dubla in bungalow superior", "Glamping"];
  const html = `<p>Tarife pentru sezonul 2026</p>${categories.map((category, index) => `<div class="vc_tta-panel${index ? "" : " vc_active"}"><div class="vc_tta-panel-heading"><span class="vc_tta-title-text">${category}</span></div><h3>17Aprilie-30Septembrie</h3><p><del>${150 + index}Lei</del></p></div>`).join("")}`;
  const catalog = parsePublicPricingHtml(html);
  assert.deepEqual(Object.keys(catalog.categories), ["double", "quadruple", "bungalow", "bungalow_superior", "glamping"]);
  assert.equal(catalog.categories.double.days.length, 167);
  assert.equal(resourceCategory("Camera dubla in bungalow superior 2"), "bungalow_superior");
});

test("public camping page maps personal caravans to the two-person minimum nightly price", () => {
  const entries = [
    ["17-29Aprile", 40],
    ["29Aprilie-3Mai", 55],
    ["4Mai-30Iunie", 50],
    ["1-31Iulie", 55],
    ["1-31August", 70],
    ["1-31Sept.", 60]
  ];
  const html = `<p>Preturi/persoana/noapte valabile pentru sezonul <strong>2026</strong></p><div class="vc_tta-panel"><div class="vc_tta-panel-heading"><span class="vc_tta-title-text">Campare cu Rulota Personala</span></div>${entries.map(([label, price]) => `<h3>${label}</h3><p><del>${price}Lei</del></p>`).join("")}</div>`;
  const catalog = parsePublicCampingPricingHtml(html);
  assert.equal(catalog.categories.caravan.days.length, 167);
  assert.equal(catalog.categories.caravan.days[0].price_minor, 8000);
  assert.equal(catalog.categories.caravan.days.find((day) => day.date === "2026-04-29").price_minor, 11000);
  assert.equal(catalog.categories.caravan.days.at(-1).price_minor, 12000);
  assert.equal(resourceCategory("rulota 1"), "caravan");
});

test("pricing replay detects an altered Marina document", () => {
  const generated = buildMarinaPricing([
    { date: "2026-06-01", price_minor: 10000 },
    { date: "2026-06-02", price_minor: 12000 }
  ]);
  assert.throws(() => verifyPricingConfiguration({ ...generated.config, resource_nightly_minor: 999 }, generated.sourceDays), /nu reproduce/);
});
