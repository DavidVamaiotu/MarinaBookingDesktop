"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("queue menu explicitly confirms discarding failed local work", () => {
  assert.match(htmlSource, /id="clearQueueIssues"[^>]*hidden>Anulează modificările eșuate<\/button>/);
  assert.match(appSource, /clearableStatuses = window\.marina\.platform === "android" \? \["failed", "conflict", "needs_attention"\] : \["failed"\]/);
  assert.match(appSource, /confirm\("Anulezi modificările locale eșuate și comenzile care depind de ele\?/);
  assert.match(appSource, /runApiAction\("clearFailedCommands"\)/);
});

test("sync indicator shows a red problem-count badge only for queue issues", () => {
  assert.match(appSource, /indicator\.dataset\.issueCount = info\.failed \|\| ""/);
  assert.match(stylesSource, /\.sync-indicator\.attention::after\{content:attr\(data-issue-count\)/);
  assert.match(stylesSource, /background:#c93632;color:#fff/);
});
