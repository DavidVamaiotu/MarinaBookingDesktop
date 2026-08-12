"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { inflateRawSync } = require("node:zlib");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pluginDirectoryName = "marina-booking-api-v1.0.2";
const sourcePath = path.join(root, "wordpress-plugin", pluginDirectoryName, "marina-booking-api.php");
const source = readFileSync(sourcePath);
const archiveName = "marina-booking-api-v1.0.10-upgrade.zip";
const archives = [
  path.join(root, "wordpress-plugin", archiveName),
  path.join(root, "plugin-upgrades", archiveName)
];

function archivePluginSource(archive) {
  const zip = readFileSync(archive);
  const target = `${pluginDirectoryName}/marina-booking-api.php`;
  let endOffset = zip.length - 22;
  while (endOffset >= 0 && zip.readUInt32LE(endOffset) !== 0x06054b50) endOffset -= 1;
  assert.ok(endOffset >= 0, `${archive} has no ZIP end record`);

  const entryCount = zip.readUInt16LE(endOffset + 10);
  let centralOffset = zip.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50, `${archive} has an invalid central directory`);
    const method = zip.readUInt16LE(centralOffset + 10);
    const compressedSize = zip.readUInt32LE(centralOffset + 20);
    const nameLength = zip.readUInt16LE(centralOffset + 28);
    const extraLength = zip.readUInt16LE(centralOffset + 30);
    const commentLength = zip.readUInt16LE(centralOffset + 32);
    const localOffset = zip.readUInt32LE(centralOffset + 42);
    const name = zip.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
    if (name === target) {
      assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, `${archive} has an invalid local entry`);
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return inflateRawSync(compressed);
      assert.fail(`${archive} uses unsupported ZIP method ${method}`);
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`${archive} does not contain ${target}`);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("WordPress upgrade archives contain the exact v1.0.10 capacity-aware source", () => {
  assert.match(source.toString("utf8"), /Version: 1\.0\.10/);
  for (const archive of archives) {
    const packagedSource = archivePluginSource(archive);
    assert.equal(digest(packagedSource), digest(source), `${archive} contains stale plugin source`);
    assert.match(packagedSource.toString("utf8"), /'as_single_resource'\s*=> false/);
    assert.doesNotMatch(packagedSource.toString("utf8"), /'as_single_resource'\s*=> true/);
  }
  assert.equal(digest(readFileSync(archives[0])), digest(readFileSync(archives[1])));
});
