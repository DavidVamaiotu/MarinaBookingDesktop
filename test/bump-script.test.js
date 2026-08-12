"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, statSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const bumpPath = path.join(root, "bump");
const bump = readFileSync(bumpPath, "utf8");

test("bump is executable and guards the dual-repository release", () => {
  if (process.platform !== "win32") {
    assert.ok(statSync(bumpPath).mode & 0o111);
  }
  assert.match(bump, /Including the current tracked and untracked changes/);
  assert.match(bump, /git add -A/);
  assert.match(bump, /origin\/main/);
  assert.match(bump, /mobile\/main/);
  assert.match(bump, /npm version/);
  assert.match(bump, /npm run wordpress:package/);
  assert.match(bump, /versionCode/);
});

test("bump pushes both tags, waits for both workflows, and checks release assets", () => {
  assert.match(bump, /git push origin "\$TAG"/);
  assert.match(bump, /git push mobile "\$TAG"/);
  assert.match(bump, /gh run watch/);
  assert.match(bump, /MarinaBookingDesktop-Setup-\$NEXT_VERSION\.exe/);
  assert.match(bump, /MarinaBookingMobile\.apk\.sha256/);
});
