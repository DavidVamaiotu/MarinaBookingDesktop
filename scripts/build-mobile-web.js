"use strict";

const { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist-mobile-web");

rmSync(output, { recursive: true, force: true });
mkdirSync(path.join(output, "src", "shared"), { recursive: true });

for (const filename of ["index.html", "app.js", "styles.css"]) {
  cpSync(path.join(root, filename), path.join(output, filename));
}
for (const directory of ["assets", "fonts"]) {
  cpSync(path.join(root, directory), path.join(output, directory), { recursive: true });
}
for (const filename of ["booking-fields.js", "pricing-note.js", "timeline-adapter.js", "booking-calendar.js", "camera-transform.js"]) {
  cpSync(path.join(root, "src", "shared", filename), path.join(output, "src", "shared", filename));
}

const htmlPath = path.join(output, "index.html");
const html = readFileSync(htmlPath, "utf8")
  .replace("<title>Marina Booking Desktop</title>", "<title>Marina Booking</title>")
  .replace("<script src=\"app.js\"></script>", "<script src=\"mobile-bridge.js\"></script>\n  <script src=\"app.js\"></script>")
  .replace("connect-src 'none'", "connect-src https:");
writeFileSync(htmlPath, html);

esbuild.buildSync({
  entryPoints: [path.join(root, "mobile", "mobile-bridge.js")],
  outfile: path.join(output, "mobile-bridge.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome89"],
  minify: true,
  legalComments: "none"
});

console.log(`Mobile web bundle written to ${output}`);
