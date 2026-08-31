};
// Builds context/init-context.json — everything the headless simulation
// worker needs for its Init message, extracted offline from the game's own
// data files and VERIFIED against the SHA-256 checksums baked into
// main.bundle.js. If every checksum passes, the physics context is
// bit-identical to what the real game sends its physics worker.
//
//   node src/extract/build-context.js
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const paths = require("../paths");
const { parseGlb, bufferViewBytes, findNodeByName, sceneName } = require("./glb");
const { decodeMesh } = require("./draco");
const geom = require("./geom");
const bundleData = require("./bundle-data");

const MODEL_FILES = [
  "blocks.glb", "pillar.glb", "planes.glb", "road.glb",
  "road_wide.glb", "signs.glb", "wall_track.glb",
];

// --- glTF → geometry (replicating THREE.GLTFLoader for what we need) ------

async function primitiveGeometry(glb, prim) {
  const ext = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
  if (!ext) throw new Error("Primitive without draco compression (unsupported)");
  const bytes = bufferViewBytes(glb, ext.bufferView);
  const decoded = await decodeMesh(bytes, { POSITION: ext.attributes.POSITION });
  return { positions: decoded.attributes.POSITION, index: decoded.index };
}

// Returns { single: geometry } or { children: geometry[] } exactly as THREE
// would present the node (multi-primitive mesh => Group with child meshes).
async function nodeGeometries(glb, node) {
  if (node.mesh == null) throw new Error("Node has no mesh: " + node.name);
  const mesh = glb.json.meshes[node.mesh];
  const prims = mesh.primitives;
  if (prims.length === 1 && !(node.children || []).length) {
    return { single: await primitiveGeometry(glb, prims[0]) };
  }
  const children = [];
  for (const p of prims) children.push(await primitiveGeometry(glb, p));
  return { children };
}

function nodeLocalMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return geom.composeTRS(t, r, s);
}

// Port of the game's per-model-entry geometry builder (main.bundle.js,
// TrackPartManager.init inner function s):
//   node matrix -> [scale opt] -> [quaternion opt] -> mirror flips ->
//   winding fix -> translate (offset / flipY peak).
async function buildModelEntryGeometries(glb, meshName, opts) {
  const node = findNodeByName(glb, meshName);
  if (!node) throw new Error('Mesh "' + meshName + '" not found in scene "' + sceneName(glb) + '"');
  const flipX = !!(opts && opts.flipX);
  const flipY = !!(opts && opts.flipY);
  const flipZ = !!(opts && opts.flipZ);
  const offset = (opts && opts.offset) || null;
  const scale = (opts && opts.scale) || null;
  const quaternion = (opts && opts.quaternion) || null;

  const got = await nodeGeometries(glb, node);
  const matrix = nodeLocalMatrix(node);
  let list;
  if (got.single) {
    const g = got.single;
    geom.applyMatrix4(g.positions, matrix);
    list = [g];
  } else {
    list = got.children;
    for (const g of list) geom.applyMatrix4(g.positions, matrix);
  }

  // flipY translation peak: max Y over all geometries BEFORE opts transforms.
  let peak = -Infinity;
  if (flipY) {
    for (const g of list) {
      const p = g.positions;
      for (let i = 1; i < p.length; i += 3) if (p[i] > peak) peak = p[i];
    }
  }

  for (const g of list) {
    if (scale) geom.scaleGeometry(g, scale.x, scale.y, scale.z);
    if (quaternion) geom.applyQuaternionGeometry(g, [quaternion.x, quaternion.y, quaternion.z, quaternion.w]);
    geom.scaleGeometry(g, flipX ? -1 : 1, flipY ? -1 : 1, flipZ ? -1 : 1);
    if (flipX || flipY || flipZ) geom.fixWinding(g);
    if (offset) {
      if (flipY) geom.translateGeometry(g, offset.x, offset.y + peak, offset.z);
      else geom.translateGeometry(g, offset.x, offset.y, offset.z);
    } else if (flipY) {
      geom.translateGeometry(g, 0, peak, 0);
    }
  }
  return list;
}

async function buildPartVertices(glbByScene, part) {
  const pieces = [];
  for (const entry of part.models) {
    const [scene, meshName, opts] = entry;
    const glb = glbByScene.get(scene);
    if (!glb) throw new Error('Scene "' + scene + '" not loaded (part ' + part.name + ")");
    const list = await buildModelEntryGeometries(glb, meshName, opts || null);
    for (const g of list) pieces.push(g);
  }
  const merged = geom.mergeGeometries(pieces);
  return geom.toNonIndexedPositions(merged);
}

function sha256Hex(f32) {
  return crypto.createHash("sha256")
    .update(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength))
    .digest("hex");
}

async function buildCarCollision() {
  const glb = parseGlb(fs.readFileSync(path.join(paths.MODELS_DIR, "..", "models", "car.glb")));
  const node = findNodeByName(glb, "Collision");
  if (!node) throw new Error("Collision mesh not found in car.glb");
  const got = await nodeGeometries(glb, node);
  const matrix = nodeLocalMatrix(node);
  let g;
  if (got.single) {
    g = got.single;
    geom.applyMatrix4(g.positions, matrix); // identity in practice; harmless
  } else {
    g = geom.mergeGeometries(got.children);
    geom.applyMatrix4(g.positions, matrix);
  }
  return geom.toNonIndexedPositions(g);
}

function extractCarMassOffset() {
  const m = bundleData.bundleText().match(/\.massOffset=(\d*\.?\d+)/);
  if (!m) throw new Error("carMassOffset not found in main bundle");
  return Number(m[1]);
}

function extractCarChecksum() {
  const m = bundleData.bundleText().match(/"([0-9a-f]{64})",r=n==i/) ||
    bundleData.bundleText().match(/const i="([0-9a-f]{64})"/);
  if (!m) throw new Error("Car collision checksum not found in main bundle");
  return m[1];
}

function b64(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64");
}

async function buildContext({ log = console.log } = {}) {
  log("Extracting part configuration table from main.bundle.js ...");
  const { parts, partIds, detectorTypes } = bundleData.extractPartConfigs();
  const partSize = bundleData.extractPartSize();
  const sineTable = bundleData.extractSineTable();
  const mountainRandomTable = bundleData.extractMountainRandomTable();
  log("  " + parts.length + " parts, partSize=" + partSize +
    ", sineTable=" + sineTable.length + ", mountainTable=" + mountainRandomTable.length);

  log("Loading model GLBs ...");
  const glbByScene = new Map();
  for (const f of MODEL_FILES) {
    const glb = parseGlb(fs.readFileSync(path.join(paths.MODELS_DIR, f)));
    glbByScene.set(sceneName(glb), glb);
  }
  log("  scenes: " + Array.from(glbByScene.keys()).join(", "));

  log("Building physics vertices for " + parts.length + " parts ...");
  const trackParts = [];
  let failures = 0;
  for (const part of parts) {
    const vertices = await buildPartVertices(glbByScene, part);
    const hash = sha256Hex(vertices);
    const ok = hash === part.checksum;
    if (!ok) {
      failures++;
      log("  CHECKSUM MISMATCH part " + part.id + " " + part.name + ": " + hash + " != " + part.checksum);
    }
    trackParts.push({
      id: part.id,
      name: part.name,
      vertices: b64(vertices),
      vertexCount: vertices.length / 3,
      detector: part.detector,
      startOffset: part.startOffset,
      tiles: part.tiles,
      checksum: part.checksum,
      checksumOk: ok,
    });
  }

  log("Building car collision shape ...");
  const carVertices = await buildCarCollision();
  const carChecksum = extractCarChecksum();
  const carHash = sha256Hex(carVertices);
  const carOk = carHash === carChecksum;
  if (!carOk) {
    failures++;
    log("  CAR CHECKSUM MISMATCH: " + carHash + " != " + carChecksum);
  }

  const context = {
    gameVersion: "0.6.2",
    generatedAt: null, // stamped by caller if desired; keep file deterministic
    partSize,
    detectorTypes,
    partIds,
    sineTable,
    mountainRandomTable,
    carMassOffset: extractCarMassOffset(),
    carCollisionShapeVertices: b64(carVertices),
    carCollisionChecksumOk: carOk,
    trackParts,
    allChecksumsOk: failures === 0,
  };
  return { context, failures };
}

async function main() {
  const { context, failures } = await buildContext();
  fs.mkdirSync(paths.CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(paths.CONTEXT_FILE, JSON.stringify(context));
  const sz = fs.statSync(paths.CONTEXT_FILE).size;
  console.log("Wrote " + paths.CONTEXT_FILE + " (" + (sz / 1e6).toFixed(1) + " MB)");
  if (failures > 0) {
    console.error("FAILED: " + failures + " checksum mismatches — context is NOT game-identical.");
    process.exit(1);
  }
  console.log("All " + (context.trackParts.length + 1) + " checksums verified — context is bit-identical to the game's.");
}

module.exports = { buildContext, buildPartVertices, buildCarCollision, sha256Hex };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });