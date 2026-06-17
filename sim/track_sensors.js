// Road-edge sensors: rasterize the placed track tiles into a 2D occupancy grid,
// then cast rays from the car to measure distance-to-edge in a frontal arc.
// Gives the policy "eyes" for the road shape / walls ahead (TrackMania-style).
const { horizForward } = require('./geom');
const LOCAL_FWD = { x: 0, y: 0, z: 1 };

// Build an occupancy bitmap (on-track = near any placed part), top-down (x,z).
// mark radius is generous so long pieces (ramps) and diagonal runs stay
// connected (we only mark a disk per piece anchor, not the full footprint).
function buildOccupancy(parts, res = 4, mark = 24) {
  const pts = parts.map((p) => [p[0] * 5, p[2] * 5]);   // grid->world
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  const pad = mark + res;
  minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
  const w = Math.ceil((maxX - minX) / res) + 1, h = Math.ceil((maxZ - minZ) / res) + 1;
  const data = new Uint8Array(w * h);
  const mr = Math.ceil(mark / res);
  for (const [x, z] of pts) {
    const cx = Math.round((x - minX) / res), cz = Math.round((z - minZ) / res);
    for (let i = -mr; i <= mr; i++) for (let j = -mr; j <= mr; j++) {
      if (i * i + j * j > mr * mr) continue;
      const gx = cx + i, gz = cz + j;
      if (gx >= 0 && gx < w && gz >= 0 && gz < h) data[gz * w + gx] = 1;
    }
  }
  return { minX, minZ, res, w, h, data };
}

function onTrack(occ, x, z) {
  const gx = Math.round((x - occ.minX) / occ.res), gz = Math.round((z - occ.minZ) / occ.res);
  if (gx < 0 || gx >= occ.w || gz < 0 || gz >= occ.h) return false;
  return occ.data[gz * occ.w + gx] === 1;
}

// Frontal arc of rays (radians, relative to car forward).
const SENSOR_ANGLES = [-1.05, -0.6, -0.28, 0, 0.28, 0.6, 1.05];

function edgeSensors(s, occ, maxR = 90, step = 4) {
  const fwd = horizForward(s.quaternion, LOCAL_FWD);
  const out = [];
  for (const ang of SENSOR_ANGLES) {
    const c = Math.cos(ang), sn = Math.sin(ang);
    const dx = fwd.x * c - fwd.z * sn, dz = fwd.x * sn + fwd.z * c;   // rotate forward by ang
    let d = maxR;
    for (let r = step; r <= maxR; r += step) {
      if (!onTrack(occ, s.position.x + dx * r, s.position.z + dz * r)) { d = r - step; break; }
    }
    out.push(d / maxR);
  }
  return out;
}
edgeSensors.COUNT = SENSOR_ANGLES.length;

module.exports = { buildOccupancy, onTrack, edgeSensors };
