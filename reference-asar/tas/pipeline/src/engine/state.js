};
// CarState readers over the worker's 227-byte scratch buffer.
// Layout (little-endian, variable length — port of the game's decoder, see
// tas/AGENTS.md §4):
//   +0  u32  carId
//   +4  u24  frames (1 frame = 1 ms)
//   +7  f32  speedKmh
//   +11 u8   flags: bit0 hasStarted, bit1 finished, bit2 hasCheckpointToRespawnAt,
//            bits3-6 wheel contact FL/FR/RL/RR
//   [+12 u24 finishFrames — ONLY when finished]
//   u16  nextCheckpointIndex
//   3xf32 position, 4xf32 quaternion
//   u8 impCount (<=4), impCount x f32 collisionImpulses
//   per set contact-flag wheel: 6xf32 {position, normal}
//   4xf32 wheelSuspensionLength, 4xf32 wheelSuspensionVelocity,
//   4xf32 wheelDeltaRotation, 4xf32 wheelSkidInfo
//   f32 steering, u8 controlByte
"use strict";

// Fast reader: only the fields the searches touch every tick.
// dv is a DataView over the wasm heap; ptr is the scratch pointer.
// out is a reusable object to avoid per-tick allocation.
function readFast(dv, ptr, out) {
  out.frames = dv.getUint8(ptr + 4) | (dv.getUint8(ptr + 5) << 8) | (dv.getUint8(ptr + 6) << 16);
  out.speedKmh = dv.getFloat32(ptr + 7, true);
  const flags = dv.getUint8(ptr + 11);
  out.flags = flags;
  out.hasStarted = (flags & 1) !== 0;
  out.finished = (flags & 2) !== 0;
  out.wheelContacts = ((flags >> 3) & 1) + ((flags >> 4) & 1) + ((flags >> 5) & 1) + ((flags >> 6) & 1);
  let o = ptr + 12;
  if (out.finished) {
    out.finishFrames = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    o += 3;
  } else {
    out.finishFrames = null;
  }
  out.nextCheckpointIndex = dv.getUint16(o, true); o += 2;
  out.x = dv.getFloat32(o, true);
  out.y = dv.getFloat32(o + 4, true);
  out.z = dv.getFloat32(o + 8, true);
  out.qx = dv.getFloat32(o + 12, true);
  out.qy = dv.getFloat32(o + 16, true);
  out.qz = dv.getFloat32(o + 20, true);
  out.qw = dv.getFloat32(o + 24, true);
  return out;
}

function newFastState() {
  return {
    frames: 0, speedKmh: 0, flags: 0, hasStarted: false, finished: false,
    wheelContacts: 0, finishFrames: null, nextCheckpointIndex: 0,
    x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1,
  };
}

// Full parse (diagnostics / telemetry / tests).
function readFull(dv, ptr) {
  const st = {};
  st.carId = dv.getUint32(ptr, true);
  st.frames = dv.getUint8(ptr + 4) | (dv.getUint8(ptr + 5) << 8) | (dv.getUint8(ptr + 6) << 16);
  st.speedKmh = dv.getFloat32(ptr + 7, true);
  const flags = dv.getUint8(ptr + 11);
  st.hasStarted = (flags & 1) !== 0;
  st.finished = (flags & 2) !== 0;
  st.hasCheckpointToRespawnAt = (flags & 4) !== 0;
  st.wheelContactFlags = [(flags >> 3) & 1, (flags >> 4) & 1, (flags >> 5) & 1, (flags >> 6) & 1];
  let o = ptr + 12;
  if (st.finished) {
    st.finishFrames = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    o += 3;
  } else st.finishFrames = null;
  st.nextCheckpointIndex = dv.getUint16(o, true); o += 2;
  st.position = { x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true) }; o += 12;
  st.quaternion = { x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true), w: dv.getFloat32(o + 12, true) }; o += 16;
  const impCount = dv.getUint8(o); o += 1;
  if (impCount > 4) throw new Error("Malformed CarState: impCount=" + impCount);
  st.collisionImpulses = [];
  for (let k = 0; k < impCount; k++) { st.collisionImpulses.push(dv.getFloat32(o, true)); o += 4; }
  st.wheelContact = [null, null, null, null];
  for (let w = 0; w < 4; w++) {
    if (st.wheelContactFlags[w]) {
      st.wheelContact[w] = {
        position: { x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true) },
        normal: { x: dv.getFloat32(o + 12, true), y: dv.getFloat32(o + 16, true), z: dv.getFloat32(o + 20, true) },
      };
      o += 24;
    }
  }
  const grp = () => { const a = [0, 0, 0, 0]; for (let w = 0; w < 4; w++) { a[w] = dv.getFloat32(o, true); o += 4; } return a; };
  st.wheelSuspensionLength = grp();
  st.wheelSuspensionVelocity = grp();
  st.wheelDeltaRotation = grp();
  st.wheelSkidInfo = grp();
  st.steering = dv.getFloat32(o, true); o += 4;
  st.controlByte = dv.getUint8(o); o += 1;
  st.byteLength = o - ptr;
  return st;
}

module.exports = { readFast, readFull, newFastState 