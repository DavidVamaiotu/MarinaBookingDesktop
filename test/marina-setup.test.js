"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("Marina Calendar remains visible and connects through OAuth before protected API calls", () => {
  const html = read("index.html");
  const app = read("app.js");
  const preload = read("preload.js");
  const main = read("electron-main.js");
  const builder = read("electron-builder.yml");
  const mobile = read("mobile/mobile-bridge.js");
  assert.match(html, /data-workspace="marina"/);
  assert.match(html, /id="marinaSetupPanel"[^>]+hidden/);
  assert.match(html, /id="marinaSetupAction"[^>]+disabled/);
  assert.match(app, /new Set\(\["rooms", "camping", "marina"\]\)/);
  assert.match(app, /showTrashedByWorkspace\s*=\s*\{\s*rooms:\s*false,\s*camping:\s*false,\s*marina:\s*false\s*\}/);
  assert.doesNotMatch(app, /marina_contract_required|backend\/OpenAPI/);
  assert.match(app, /connectMarina/);
  assert.match(preload, /new Set\(\["rooms", "camping", "marina"\]\)/);
  assert.match(mobile, /new Set\(\["rooms", "camping", "marina"\]\)/);
  assert.match(main, /contexts\.marina = createMarinaSetupContext\(\)/);
  assert.match(main, /MarinaOAuthController/);
  assert.match(main, /MarinaBookingProvider/);
  assert.match(main, /assertWritableSource\(source\)/);
  assert.match(main, /registerDesktopOAuthProtocol/);
  assert.match(main, /x-scheme-handler\/ro\.marinapark\.booking\.desktop/);
  assert.match(builder, /schemes:[\s\S]*ro\.marinapark\.booking\.desktop/);
  assert.doesNotMatch(main, /openapi\.json|\/docs/);
});
