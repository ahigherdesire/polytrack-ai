);
// Extraction-layer tests: the init context must exist and be provably
// bit-identical to the game's own physics payload (baked SHA-256 checksums).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const paths = require("../src/paths");
const bundleData = require("../src/extract/bundle-data");

test("part-id and detector enums extract", () => {
  const partIds = bundleData.extractPartIdEnum();
  assert.ok(Number.isInteger(partIds.Start));
  assert.ok(Number.isInteger(partIds.Straight));
  const det = bundleData.extractDetectorTypeEnum();
  assert.ok(Number.isInteger(det.Checkpoint));
  assert.ok(Number.isInteger(det.Finish));
  assert.notStrictEqual(det.Checkpoint, det.Finish);
});

test("deterministic math tables extract", () => {
  const sine = bundleData.extractSineTable();
  assert.strictEqual(sine.length, 360);
  assert.strictEqual(sine[0], 0);
  // sin(90deg) == 1 exactly in the game's table
  assert.strictEqual(sine[90], 1);
  const rng = bundleData.extractMountainRandomTable();
  assert.strictEqual(rng.length, 128);
  assert.ok(rng.every((v) => v >= 0 && v < 1));
  assert.strictEqual(bundleData.extractPartSize(), 5);
});

test("table-based sin/cos behaves like sine interpolation", () => {
  const { detSin, detCos } = bundleData.makeDetMath(bundleData.extractSineTable());
  assert.strictEqual(detSin(0), 0);
  assert.ok(Math.abs(detSin(Math.PI / 2) - 1) < 1e-6);
  assert.ok(Math.abs(detCos(0) - 1) < 1e-6);
  assert.ok(Math.abs(detSin(Math.PI) - 0) < 1e-6);
  // periodicity + negative angles
  assert.ok(Math.abs(detSin(-Math.PI / 2) + 1) < 1e-6);
});

test("part config table extracts 186 parts with detectors", () => {
  const { parts, detectorTypes } = bundleData.extractPartConfigs();
  assert.strictEqual(parts.length, 186);
  const withDetector = parts.filter((p) => p.detector);
  assert.ok(withDetector.length >= 4, "expected several detector parts, got " + withDetector.length);
  const finishes = withDetector.filter((p) => p.detector.type === detectorTypes.Finish);
  const checkpoints = withDetector.filter((p) => p.detector.type === detectorTypes.Checkpoint);
  assert.ok(finishes.length >= 1);
  assert.ok(checkpoints.length >= 1);
  // start parts carry startOffset
  assert.ok(parts.some((p) => p.startOffset));
  // every part has at least one tile and one model ref
  for (const p of parts) {
    assert.ok(p.tiles.length > 0, p.name + " has no tiles");
    assert.ok(p.models.length > 0, p.name + " has no models");
    assert.match(p.checksum, /^[0-9a-f]{64}$/);
  }
});

test("generated init context exists with ALL checksums verified", () => {
  assert.ok(
    fs.existsSync(paths.CONTEXT_FILE),
    "context missing — run `node src/extract/build-context.js`"
  );
  const ctx = JSON.parse(fs.readFileSync(paths.CONTEXT_FILE, "utf8"));
  assert.strictEqual(ctx.gameVersion, "0.6.2");
  assert.strictEqual(ctx.allChecksumsOk, true, "checksum failures in context");
  assert.strictEqual(ctx.carCollisionChecksumOk, true);
  assert.strictEqual(ctx.trackParts.length, 186);
  for (const p of ctx.trackParts) assert.strictEqual(p.checksumOk, true, "bad part " + p.name);
  assert.strictEqual(ctx.partSize, 5);
  assert.strictEqual(ctx.carMassOffset, 0.6);
}