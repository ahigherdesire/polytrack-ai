
}
// Textual extraction of pure data baked into main.bundle.js:
//  - the track-part configuration table (186 parts: models, detectors,
//    startOffsets, tiles, SHA-256 checksums of their physics vertices)
//  - the part-id and detector-type enums
//  - the deterministic sine table (the game REPLACES global Math.sin/cos with
//    a 361-entry table interpolation in both bundles)
//  - the mountain-generator's pre-seeded PRNG table
//  - partSize
// Everything is anchored on stable literals, never on minified identifiers,
// and the extracted vertices are verified against the baked checksums.
"use strict";
const fs = require("fs");
const paths = require("../paths");

let cache = null;

function bundleText() {
  if (!cache) cache = fs.readFileSync(paths.MAIN_BUNDLE, "utf8");
  return cache;
}

// Balanced-bracket slice starting at the first opening bracket at/after `from`.
function balancedSlice(text, from) {
  let depth = 0, started = false, inStr = null, start = -1;
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (ch === "\\") j++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "[" || ch === "(" || ch === "{") {
      if (!started) { started = true; start = j; }
      depth++;
    } else if (ch === "]" || ch === ")" || ch === "}") {
      if (!started) continue;
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error("Unbalanced brackets from offset " + from);
}

// ---- enums --------------------------------------------------------------
// Webpack enums look like: e[e.Name=0]="Name",e[e.Other=1]="Other", ...
// Collect contiguous runs and return them as [{name->value}] blocks.
function extractEnumBlocks() {
  const text = bundleText();
  const re = /(\w)\[\1\.(\w+)=(\d+)\]="(\w+)"/g;
  const blocks = [];
  let cur = null, lastEnd = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[2] !== m[4]) continue;
    if (cur && m.index <= lastEnd + 2) {
      cur.map[m[2]] = Number(m[3]);
    } else {
      cur = { map: { [m[2]]: Number(m[3]) }, at: m.index };
      blocks.push(cur);
    }
    lastEnd = m.index + m[0].length;
  }
  return blocks;
}

function extractPartIdEnum() {
  const blocks = extractEnumBlocks();
  const b = blocks.find((b) => "Start" in b.map && "StartWide" in b.map && "Straight" in b.map && "Checkpoint" in b.map);
  if (!b) throw new Error("Part-id enum not found in main bundle");
  return b.map;
}

function extractDetectorTypeEnum() {
  const blocks = extractEnumBlocks();
  const b = blocks.find((b) => "Checkpoint" in b.map && "Finish" in b.map && Object.keys(b.map).length <= 4 && !("Straight" in b.map));
  if (!b) throw new Error("Detector-type enum not found in main bundle");
  return b.map;
}

// ---- deterministic Math tables ------------------------------------------
function extractNumberArray(anchor) {
  const text = bundleText();
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error("Anchor not found: " + anchor.slice(0, 40));
  const open = text.indexOf("[", at);
  const arrText = balancedSlice(text, open);
  const arr = new Function("return " + arrText)();
  if (!Array.isArray(arr) || !arr.every((v) => typeof v === "number")) {
    throw new Error("Extracted array is not numeric: " + anchor.slice(0, 40));
  }
  return arr;
}

function extractSineTable() {
  // The 1-degree sine table used by the game's deterministic Math.sin/cos.
  return extractNumberArray("const K=[0,.01745240643728351");
}

function extractMountainRandomTable() {
  // The pre-seeded random table behind createMountainVertices.
  return extractNumberArray("={value:[.12047764760664692");
}

function extractPartSize() {
  const text = bundleText();
  const m = text.match(/\.partSize=(\d+(?:\.\d+)?)/);
  if (!m) throw new Error("partSize not found");
  return Number(m[1]);
}

// ---- deterministic sin/cos (exact port of the game's replacement) --------
function makeDetMath(sineTable) {
  const K = sineTable;
  const TWO_PI = 2 * Math.PI;
  function detSin(e) {
    if (Number.isNaN(e)) return NaN;
    e %= TWO_PI;
    if (e < 0) e += TWO_PI;
    const t = (e / TWO_PI) * K.length % K.length;
    const n = Math.floor(t);
    const i = (n + 1) % K.length;
    const r = t - n;
    return K[n] * (1 - r) + K[i] * r;
  }
  function detCos(e) {
    return detSin(e + Math.PI / 2);
  }
  return { detSin, detCos };
}

// ---- track part configuration table --------------------------------------
function extractPartConfigs() {
  const text = bundleText();
  const start = text.indexOf("const u=[new d(");
  if (start < 0) throw new Error("Part config table not found");
  const tableText = balancedSlice(text, text.indexOf("[", start));

  const partIds = extractPartIdEnum();
  const detectorTypes = extractDetectorTypeEnum();
  const { detSin, detCos } = makeDetMath(extractSineTable());

  // Stub constructors matching the minified identifiers used in the table.
  class Vec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    toArray() { return [this.x, this.y, this.z]; }
  }
  class Euler {
    constructor(x = 0, y = 0, z = 0, order = "XYZ") { this.x = x; this.y = y; this.z = z; this.order = order; }
  }
  class Quat {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    // THREE Quaternion.setFromEuler with the game's table-based sin/cos —
    // that's what actually ran in the bundle when this table was built.
    setFromEuler(e) {
      const c1 = detCos(e.x / 2), c2 = detCos(e.y / 2), c3 = detCos(e.z / 2);
      const s1 = detSin(e.x / 2), s2 = detSin(e.y / 2), s3 = detSin(e.z / 2);
      switch (e.order) {
        case "XYZ":
          this.x = s1 * c2 * c3 + c1 * s2 * s3;
          this.y = c1 * s2 * c3 - s1 * c2 * s3;
          this.z = c1 * c2 * s3 + s1 * s2 * c3;
          this.w = c1 * c2 * c3 - s1 * s2 * s3;
          break;
        default:
          throw new Error("Unsupported euler order " + e.order);
      }
      return this;
    }
  }

  class PartConfig {
    constructor(checksum, category, id, models, colors, tileRanges, detector = null, startOffset = null) {
      this.checksum = checksum;
      this.category = category;
      this.id = id;
      this.models = models;
      this.tiles = [];
      for (const [min, max] of tileRanges) {
        for (let x = min[0]; x <= max[0]; x++) {
          for (let y = min[1]; y <= max[1]; y++) {
            for (let z = min[2]; z <= max[2]; z++) {
              this.tiles.push([x, y, z]);
            }
          }
        }
      }
      this.detector = detector;
      this.startOffset = startOffset ? startOffset.toArray() : null;
    }
  }

  const d = (...args) => new PartConfig(...args);
  const stubs = {
    d: function (...args) { return new PartConfig(...args); },
    r: { A: new Proxy({}, { get: (_, k) => String(k) }) },
    s: { A: partIds },
    o: { A: detectorTypes },
    c: [],
    i: { Pq0: Vec3, PTz: Quat, O9p: Euler },
  };
  // `new d(...)` needs d to be constructable:
  stubs.d = PartConfig;

  // `c` and `h` are color-set constants in the bundle — irrelevant to physics.
  const table = new Function("d", "r", "s", "o", "c", "h", "i", "return " + tableText)(
    stubs.d, stubs.r, stubs.s, stubs.o, stubs.c, stubs.c, stubs.i
  );

  const idToName = {};
  for (const [name, v] of Object.entries(partIds)) idToName[v] = name;
  for (const p of table) p.name = idToName[p.id];
  return { parts: table, partIds, detectorTypes };
}

module.exports = {
  bundleText,
  balancedSlice,
  extractEnumBlocks,
  extractPartIdEnum,
  extractDetectorTypeEnum,
  extractSineTable,
  extractMountainRandomTable,
  extractPartSize,
  makeDetMath,
  extractPartConfigs,
