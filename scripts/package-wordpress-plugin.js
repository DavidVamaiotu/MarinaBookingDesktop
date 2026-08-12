"use strict";

const { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pluginDirectoryName = "marina-booking-api-v1.0.2";
const sourceDirectory = path.join(root, "wordpress-plugin", pluginDirectoryName);
const pluginSource = readFileSync(path.join(sourceDirectory, "marina-booking-api.php"), "utf8");
const headerVersion = pluginSource.match(/^\s*\*\s*Version:\s*(\d+\.\d+\.\d+)\s*$/m)?.[1];
const constantVersion = pluginSource.match(/const VERSION\s*=\s*'(\d+\.\d+\.\d+)'/)?.[1];

if (!headerVersion || headerVersion !== constantVersion) {
  throw new Error("WordPress plugin header and VERSION constant must contain the same semantic version.");
}

const archiveName = `marina-booking-api-v${headerVersion}-upgrade.zip`;
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "marina-booking-api-package-"));
const stagedDirectory = path.join(temporaryDirectory, pluginDirectoryName);
const temporaryArchive = path.join(temporaryDirectory, archiveName);

try {
  cpSync(sourceDirectory, stagedDirectory, { recursive: true });
  const result = spawnSync("zip", ["-X", "-q", "-r", temporaryArchive, pluginDirectoryName], {
    cwd: temporaryDirectory,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`zip exited with status ${result.status}`);

  const destinations = [
    path.join(root, "wordpress-plugin", archiveName),
    path.join(root, "plugin-upgrades", archiveName)
  ];
  for (const destination of destinations) {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(temporaryArchive, destination);
  }
  process.stdout.write(`${archiveName}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
