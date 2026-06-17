// Observation features for the driving policy: everything expressed in the
// car's local frame so the policy generalizes across the track.
const { horizForward } = require('./geom');
const { edgeSensors } = require('./track_sensors');
const LOCAL_FWD = { x: 0, y: 0, z: 1 };   // calibrated car forward axis

// s: decoded car state. targets: [nextCp, nextNextCp] in world coords.
// occ: road occupancy grid (for edge sensors). Returns a fixed-length vector.
function observe(s, targets, occ) {
  const fwd = horizForward(s.quaternion, LOCAL_FWD);
  const right = { x: fwd.z, z: -fwd.x };               // right-hand perpendicular
  const feat = [
    Math.tanh(s.speedKmh / 150),                       // signed speed
    s.wheelContact.filter(Boolean).length / 4 - 0.5,   // ground contact (airborne?)
  ];
  for (const t of targets) {
    const dx = t.x - s.position.x, dz = t.z - s.position.z, dy = t.y - s.position.y;
    const dist = Math.hypot(dx, dz) || 1;
    feat.push(
      (dx * fwd.x + dz * fwd.z) / dist,                // how much target is ahead
      (dx * right.x + dz * right.z) / dist,            // how much target is to the right
      Math.tanh(dist / 120),                           // distance
      Math.tanh(dy / 40),                              // elevation delta (jumps/drops)
    );
  }
  for (const r of edgeSensors(s, occ)) feat.push(r - 0.5);   // road-edge rays (centered)
  return feat;
}

observe.SIZE = 2 + 4 * 2 + edgeSensors.COUNT;
module.exports = { observe };
