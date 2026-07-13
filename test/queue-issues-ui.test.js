"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("queue menu can dismiss issue messages without changing queued commands", () => {
  assert.match(htmlSource, /id="clearQueueIssues"[^>]*hidden>Șterge problemele<\/button>/);
  assert.match(appSource, /QUEUE_ISSUE_STATUSES = new Set\(\["failed", "conflict", "needs_attention"\]\)/);
  assert.match(appSource, /queueIssueToken\(command\).*command\.updatedAt/);
  assert.match(appSource, /dismissed\.add\(queueIssueToken\(command\)\);\s*renderCommands\(\);/);
  assert.doesNotMatch(appSource, /clearQueueIssues[\s\S]{0,500}window\.marina\.(?:retryCommand|revertBooking)/);
});
