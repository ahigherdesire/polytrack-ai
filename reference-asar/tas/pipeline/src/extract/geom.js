};
// Float32-exact replication of the THREE.js geometry operations the game uses
// to build physicsShapeVertices. All math runs in JS doubles; results are
// rounded to f32 only when stored into the Float32Array — exactly like
// THREE's BufferAttribute (backing store is a Float32Array, intermediates are
// doubles). Verified end-to-end against the SHA-256 checksums baked into
// main.bundle.js, so any divergence from THREE's behavior is caught.
"use strict";

const fround = Math.fround;

// THREE Matrix4.compose(position, quaternion, scale) — column-major 16 floats.
function composeTRS(t, q, s) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function makeScale(x, y, z) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

function makeTranslation(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

// THREE Matrix4.makeRotationFromQuaternion == compose(0, q, 1).
function makeRotationFromQuaternion(q) {
  return composeTRS([0, 0, 0], q, [1, 1, 1]);
}

// THREE BufferAttribute.applyMatrix4 over a position array (itemSize 3).
// Mirrors Vector3.applyMatrix4: full projective form with w division.
function applyMatrix4(positions, m) {
  const e = m;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    positions[i] = fround((e[0] * x + e[4] * y + e[8] * z + e[12]) * w);
    positions[i + 1] = fround((e[1] * x + e[5] * y + e[9] * z + e[13]) * w);
    positions[i + 2] = fround((e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
  }
}

// Geometry = { positions: Float32Array, index: Uint32Array|null }

function cloneGeometry(g) {
  return { positions: g.positions.slice(), index: g.index ? g.index.slice() : null };
}

function scaleGeometry(g, x, y, z) {
  applyMatrix4(g.positions, makeScale(x, y, z));
}

function translateGeometry(g, x, y, z) {
  applyMatrix4(g.positions, makeTranslation(x, y, z));
}

function applyQuaternionGeometry(g, q) {
  applyMatrix4(g.positions, makeRotationFromQuaternion(q));
}

// The game's winding fix after mirror scaling: swap 2nd/3rd vertex of each
// triangle in the index (or shuffle raw triangles when non-indexed).
function fixWinding(g) {
  if (g.index) {
    const t = g.index;
    for (let i = 0; i + 2 < t.length; i += 3) {
      const b = t[i + 1];
      t[i + 1] = t[i + 2];
      t[i + 2] = b;
    }
  } else {
    const p = g.positions;
    for (let v = 0; v + 8 < p.length; v += 9) {
      for (let c = 0; c < 3; c++) {
        const tmp = p[v + 3 + c];
        p[v + 3 + c] = p[v + 6 + c];
        p[v + 6 + c] = tmp;
      }
    }
  }
}

// THREE BufferGeometryUtils.mergeGeometries — for our purposes: concatenate
// indices (with vertex offsets) and positions, in order.
function mergeGeometries(list) {
  let vtx = 0, idx = 0;
  for (const g of list) {
    vtx += g.positions.length / 3;
    idx += g.index ? g.index.length : g.positions.length / 3;
  }
  const positions = new Float32Array(vtx * 3);
  const index = new Uint32Array(idx);
  let vo = 0, io = 0;
  for (const g of list) {
    positions.set(g.positions, vo * 3);
    if (g.index) {
      for (let i = 0; i < g.index.length; i++) index[io + i] = g.index[i] + vo;
      io += g.index.length;
    } else {
      const n = g.positions.length / 3;
      for (let i = 0; i < n; i++) index[io + i] = vo + i;
      io += n;
    }
    vo += g.positions.length / 3;
  }
  return { positions, index };
}

// THREE BufferGeometry.toNonIndexed for the position attribute.
function toNonIndexedPositions(g) {
  if (!g.index) return g.positions.slice();
  const out = new Float32Array(g.index.length * 3);
  for (let i = 0; i < g.index.length; i++) {
    const src = g.index[i] * 3;
    out[i * 3] = g.positions[src];
    out[i * 3 + 1] = g.positions[src + 1];
    out[i * 3 + 2] = g.positions[src + 2];
  }
  return out;
}

module.exports = {
  composeTRS,
  identityMatrix,
  makeScale,
  makeTranslation,
  makeRotationFromQuaternion,
  applyMatrix4,
  cloneGeometry,
  scaleGeometry,
  translateGeometry,
  applyQuaternionGeometry,
  fixWinding,
  mergeGeometries,
  toNonIndexedPositions,
