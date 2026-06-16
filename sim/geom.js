// Small geometry helpers + grid->world for PolyTrack 0.6.2.
// Empirically, world position = grid * 5 (a track part spans 4 grid units = 20 world units).
const CELL = 5;

const gridToWorld = (g) => ({ x: g.x * CELL, y: g.y * CELL, z: g.z * CELL });

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

// Horizontal (x,z) forward direction given a quaternion and the car's local
// forward axis. Returns a normalized {x,z}.
function horizForward(q, localFwd) {
  const f = quatRotate(q, localFwd);
  const n = Math.hypot(f.x, f.z) || 1;
  return { x: f.x / n, z: f.z / n };
}

module.exports = { CELL, gridToWorld, quatRotate, horizForward };
