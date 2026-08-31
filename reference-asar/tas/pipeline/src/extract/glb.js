};
// Minimal GLB (binary glTF 2.0) container + JSON accessor helpers.
// We only need: scenes/nodes (names + TRS), meshes/primitives with the
// KHR_draco_mesh_compression extension, and bufferViews into the BIN chunk.
"use strict";

function parseGlb(buf) {
  if (buf.length < 12 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error("Not a GLB file");
  }
  let off = 12;
  let json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, bin };
}

function bufferViewBytes(glb, index) {
  const bv = glb.json.bufferViews[index];
  const start = bv.byteOffset || 0;
  return glb.bin.subarray(start, start + bv.byteLength);
}

// Depth-first search over the default scene for a node by name,
// mirroring THREE's Object3D.getObjectByName traversal order.
function findNodeByName(glb, name) {
  const json = glb.json;
  const scene = json.scenes[json.scene || 0];
  const stack = [];
  const visit = (nodeIdx) => {
    const node = json.nodes[nodeIdx];
    if (node.name === name) return node;
    for (const c of node.children || []) {
      const r = visit(c);
      if (r) return r;
    }
    return null;
  };
  for (const n of scene.nodes) {
    const r = visit(n);
    if (r) return r;
  }
  return null;
}

function sceneName(glb) {
  const json = glb.json;
  return json.scenes[json.scene || 0].name;
}

module.exports = { parseGlb, bufferViewBytes, findNodeByName, sceneName 