// Small geometry helpers + grid->world for PolyTrack 0.6.2.
// Empirically, world position = grid * 5 (a track part spans 4 grid units = 20 world units).
const CELL = 5;

const gridToWorld = (g) => ({ x: g.x * CELL, y: g.y * CELL, z: g.z * CELL });

// Exact copy of PolyTrack 0.6.2's `vb(rotation, rotationAxis)` quaternion table.
// Axis enum: 0=Y+, 1=Y-, 2=X+, 3=X-, 4=Z+, 5=Z-.
const PART_ROTATION_QUATS = [
  [
    { x: 0, y: 0, z: 0, w: 1 },
    { x: 0, y: 0.7071067811865475, z: 0, w: 0.7071067811865476 },
    { x: 0, y: 1, z: 0, w: 0 },
    { x: 0, y: 0.7071067811865476, z: 0, w: -0.7071067811865475 },
  ],
  [
    { x: 0, y: 0, z: 1, w: 0 },
    { x: 0.7071067811865475, y: 0, z: 0.7071067811865476, w: 0 },
    { x: 1, y: 0, z: 0, w: 0 },
    { x: 0.7071067811865476, y: 0, z: -0.7071067811865475, w: 0 },
  ],
  [
    { x: 0, y: 0, z: -0.7071067811865477, w: 0.7071067811865475 },
    { x: 0.5, y: 0.5, z: -0.5, w: 0.5 },
    { x: 0.7071067811865475, y: 0.7071067811865477, z: 0, w: 0 },
    { x: 0.5, y: 0.5, z: 0.5, w: -0.5 },
  ],
  [
    { x: 0, y: 0, z: 0.7071067811865475, w: 0.7071067811865476 },
    { x: 0.5, y: -0.5, z: 0.5, w: 0.5 },
    { x: 0.7071067811865476, y: -0.7071067811865475, z: 0, w: 0 },
    { x: 0.5, y: -0.5, z: -0.5, w: -0.5 },
  ],
  [
    { x: 0.7071067811865475, y: 0, z: 0, w: 0.7071067811865476 },
    { x: 0.5, y: 0.5, z: 0.5, w: 0.5 },
    { x: 0, y: 0.7071067811865476, z: 0.7071067811865475, w: 0 },
    { x: -0.5, y: 0.5, z: 0.5, w: -0.5 },
  ],
  [
    { x: -0.7071067811865477, y: 0, z: 0, w: 0.7071067811865475 },
    { x: -0.5, y: -0.5, z: 0.5, w: 0.5 },
    { x: 0, y: -0.7071067811865475, z: 0.7071067811865477, w: 0 },
    { x: 0.5, y: -0.5, z: 0.5, w: -0.5 },
  ],
];

function clampPartRotation(rotation) {
  return ((Number(rotation) || 0) % 4 + 4) % 4;
}

function clampPartAxis(rotationAxis) {
  const axis = Number(rotationAxis);
  return Number.isInteger(axis) && axis >= 0 && axis < PART_ROTATION_QUATS.length ? axis : 0;
}

function partRotationQuat(rotation = 0, rotationAxis = 0) {
  return PART_ROTATION_QUATS[clampPartAxis(rotationAxis)][clampPartRotation(rotation)];
}

// Rotate vector v by quaternion q = {x,y,z,w}.
function quatRotate(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function mul(v, s) { return { x: v.x * s, y: v.y * s, z: v.z * s }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function normalize(v, fallback = { x: 0, y: 1, z: 0 }) {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len, z: v.z / len } : fallback;
}

function triangleNormal(a, b, c) {
  return normalize(cross(sub(b, a), sub(c, a)));
}

function rotatePartVector(v, rotation = 0, rotationAxis = 0) {
  return quatRotate(partRotationQuat(rotation, rotationAxis), v);
}

function transformPartVertex(part, lx, ly, lz) {
  const v = rotatePartVector({ x: lx, y: ly, z: lz }, part.rotation, part.rotationAxis);
  return { x: part.x + v.x, y: part.y + v.y, z: part.z + v.z };
}

// Horizontal (x,z) forward direction given a quaternion and the car's local
// forward axis. Returns a normalized {x,z}.
function horizForward(q, localFwd) {
  const f = quatRotate(q, localFwd);
  const n = Math.hypot(f.x, f.z) || 1;
  return { x: f.x / n, z: f.z / n };
}

module.exports = {
  CELL,
  gridToWorld,
  PART_ROTATION_QUATS,
  partRotationQuat,
  quatRotate,
  rotatePartVector,
  transformPartVertex,
  add,
  sub,
  mul,
  dot,
  cross,
  normalize,
  triangleNormal,
  horizForward,
};
