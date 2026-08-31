};
// Draco mesh decoding using THE GAME'S OWN decoder (lib/draco/*) so the
// decoded vertex order and dequantized float bits match the game exactly.
// Mirrors THREE.DRACOLoader's worker decode path (DecodeArrayToMesh,
// GetAttributeByUniqueId with useUniqueIDs=true, GetTrianglesUInt32Array).
"use strict";
const fs = require("fs");
const paths = require("../paths");

let dracoPromise = null;

function getDraco() {
  if (!dracoPromise) {
    const DracoDecoderModule = require(paths.DRACO_WRAPPER);
    dracoPromise = new Promise((resolve) => {
      const config = {
        wasmBinary: fs.readFileSync(paths.DRACO_WASM),
        onModuleLoaded: (draco) => resolve(draco),
      };
      DracoDecoderModule(config);
    });
  }
  return dracoPromise;
}

// bytes: Uint8Array of the draco-compressed buffer view.
// attributeIds: { POSITION: uniqueId, ... } straight from the glTF extension.
// Returns { index: Uint32Array, attributes: { position: Float32Array, ... } }.
async function decodeMesh(bytes, attributeIds) {
  const draco = await getDraco();
  const decoder = new draco.Decoder();
  try {
    const buf = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const geometryType = decoder.GetEncodedGeometryType(buf);
    if (geometryType !== draco.TRIANGULAR_MESH) {
      throw new Error("Draco: expected TRIANGULAR_MESH, got " + geometryType);
    }
    const mesh = new draco.Mesh();
    const status = decoder.DecodeArrayToMesh(buf, buf.byteLength, mesh);
    if (!status.ok() || mesh.ptr === 0) {
      throw new Error("Draco decode failed: " + status.error_msg());
    }

    const numPoints = mesh.num_points();
    const attributes = {};
    for (const [semantic, uniqueId] of Object.entries(attributeIds)) {
      const attr = decoder.GetAttributeByUniqueId(mesh, uniqueId);
      const numComponents = attr.num_components();
      const numValues = numPoints * numComponents;
      const byteLength = numValues * 4;
      const ptr = draco._malloc(byteLength);
      decoder.GetAttributeDataArrayForAllPoints(mesh, attr, draco.DT_FLOAT32, byteLength, ptr);
      attributes[semantic] = new Float32Array(draco.HEAPF32.buffer, ptr, numValues).slice();
      draco._free(ptr);
    }

    const numFaces = mesh.num_faces();
    const numIndices = numFaces * 3;
    const idxBytes = numIndices * 4;
    const ptr = draco._malloc(idxBytes);
    decoder.GetTrianglesUInt32Array(mesh, idxBytes, ptr);
    const index = new Uint32Array(draco.HEAPF32.buffer, ptr, numIndices).slice();
    draco._free(ptr);

    draco.destroy(mesh);
    return { index, attributes, numPoints };
  } finally {
    draco.destroy(decoder);
  }
}

module.exports = { getDraco, decodeMesh 