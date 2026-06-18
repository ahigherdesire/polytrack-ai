// Observation features for the driving policy: everything expressed in the
// car's local frame so the policy generalizes across the track.
const { quatRotate, dot, sub, mul, normalize } = require('./geom');
const { edgeSensors, nearestSurface } = require('./track_sensors');
const LOCAL_FWD = { x: 0, y: 0, z: 1 };   // calibrated car forward axis
const LOCAL_UP = { x: 0, y: 1, z: 0 };
const LOCAL_RIGHT = { x: 1, y: 0, z: 0 };

// s: decoded car state. targets: [nextCp, nextNextCp] in world coords.
// occ: road occupancy grid (for edge sensors). Returns a fixed-length vector.
function observe(s, targets, occ) {
  const fwd = normalize(quatRotate(s.quaternion, LOCAL_FWD), LOCAL_FWD);
  const up = normalize(quatRotate(s.quaternion, LOCAL_UP), LOCAL_UP);
  const right = normalize(quatRotate(s.quaternion, LOCAL_RIGHT), LOCAL_RIGHT);
  const surface = nearestSurface(occ, s.position, 18);
  let surfaceNormal = surface ? surface.normal : { x: 0, y: 1, z: 0 };
  if (dot(surfaceNormal, up) < 0) surfaceNormal = mul(surfaceNormal, -1);
  const feat = [
    Math.tanh(s.speedKmh / 150),                       // signed speed
    s.wheelContact.filter(Boolean).length / 4 - 0.5,   // ground contact (airborne?)
    Math.tanh(((surface ? surface.distance : 18) - 3) / 12), // distance from road surface
    Math.abs(dot(up, surfaceNormal)) - 0.5,             // car-up aligned with road normal
    dot(fwd, surfaceNormal),                            // nose digging into/away from surface
  ];
  for (const t of targets) {
    const dx = t.x - s.position.x, dz = t.z - s.position.z, dy = t.y - s.position.y;
    const v = { x: dx, y: dy, z: dz };
    const dist = Math.hypot(dx, dy, dz) || 1;
    feat.push(
      dot(v, fwd) / dist,                              // target ahead/behind
      dot(v, right) / dist,                            // target left/right
      dot(v, up) / dist,                               // target above/below in car frame
      Math.tanh(dist / 140),                           // 3D distance
    );
  }
  for (const r of edgeSensors(s, occ)) feat.push(r - 0.5);   // road-edge rays (centered)
  return feat;
}

observe.SIZE = 5 + 4 * 2 + edgeSensors.COUNT;
module.exports = { observe };
