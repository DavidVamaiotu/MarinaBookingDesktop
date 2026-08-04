"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("shipped UI labels stay Romanian on desktop and mobile", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const electron = fs.readFileSync(path.join(root, "electron-main.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
  const mobileBuild = fs.readFileSync(path.join(root, "scripts", "build-mobile-web.js"), "utf8");

  assert.match(html, /<html lang="ro">/);
  assert.match(html, /<title>Marina Booking – Rezervări<\/title>/);
  assert.match(app, /displayStatus\(booking\.syncState\)/);
  assert.match(app, /DISPLAY_STATUS\[value\] \|\| "necunoscut"/);
  assert.match(app, /ErrorMessages\.message\(result\.message, "Intervalul nu poate fi tarifat\."\)/);
  assert.match(app, /Actualizat: \$\{escapeHtml\(updated\)\}/);
  assert.doesNotMatch(app, />Updated:/);
  assert.doesNotMatch(electron, /Marina Booking Desktop/);
  assert.match(preload, /Sursa rezervărilor este invalidă/);
  assert.match(mobileBuild, /Marina Booking – Rezervări/);
});
