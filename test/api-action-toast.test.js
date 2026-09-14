"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const renderer = fs.readFileSync(path.join(root, "app.js"), "utf8");
const markup = fs.readFileSync(path.join(root, "index.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("important API mutations use the shared action toast", () => {
  for (const method of ["createBooking", "editBooking", "setStatus", "setNote", "setTrash", "updateDeposit", "requestPayment"]) {
    assert.match(renderer, new RegExp(`${method}: \\[".+", ".+"\\]`));
  }
  assert.match(renderer, /const toast = showToast\(pendingMessage, "pending"\)/);
  assert.match(renderer, /showToast\(mailSuppressed \? [^;]+ : successMessage, mailSuppressed \? "error" : "success", toast\)/);
  assert.doesNotMatch(renderer, /createBooking: "Rezervarea a fost pusă în coada locală/);
  assert.match(renderer, /showToast\(shortErrorMessage\(error\), "error", toast\)/);
});

test("toast is bottom-right, accessible, and has animated status icons", () => {
  assert.match(markup, /class="toast-region" id="toast" role="status" aria-live="polite"/);
  assert.match(styles, /\.toast-region\{[^}]*right:[^;]+;bottom:/);
  assert.match(styles, /\.toast-item\.pending \.toast-icon\{[^}]*animation:toast-spin/);
  assert.match(styles, /\.toast-item\.success \.toast-icon\{background:#2f8a5d\}/);
  assert.match(styles, /\.toast-item\.error \.toast-icon\{background:#bd4a45\}/);
  assert.match(renderer, /state === "pending" \? "⚙" : state === "error" \? "×" : "✓"/);
});

test("API errors are shortened and do not produce a duplicate toast", () => {
  assert.match(renderer, /const apiToastErrors = new WeakSet\(\)/);
  assert.match(renderer, /const toastTimers = new WeakMap\(\)/);
  assert.match(renderer, /message\.length > 150 \? `\$\{message\.slice\(0, 147\)\}…` : message/);
  assert.match(renderer, /apiToastErrors\.add\(error\)/);
  assert.match(renderer, /apiToastErrors\.has\(error\)/);
});
