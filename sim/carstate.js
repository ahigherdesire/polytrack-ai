// Exact port of the 0.6.2 main bundle's carState decoder (`VO`/`r`).
// Input: the 227-byte buffer returned by the worker per frame, which is
//   [carId: uint32 LE][variable-length carState record].
// We split off the carId and decode the record byte-for-byte as the game does.

function decodeRecord(e) {
  const ERR = 'CarState data is too short';
  const n = new DataView(e.buffer, e.byteOffset, e.byteLength);
  let i = 0;
  const need = (k) => { if (e.length < i + k) throw new Error(ERR); };
  const f32 = (o) => n.getFloat32(o, true);

  need(3);
  const frames = e[i] | (e[i + 1] << 8) | (e[i + 2] << 16); i += 3;
  need(4);
  const speedKmh = f32(i); i += 4;
  need(1);
  const flags = e[i];
  const hasStarted = !!(1 & flags);
  const finishPresent = !!(2 & flags);
  const hasCheckpointToRespawnAt = !!(4 & flags);
  const contact = [!!(8 & flags), !!(16 & flags), !!(32 & flags), !!(64 & flags)];
  i += 1;

  let finishFrames = null;
  if (finishPresent) { need(3); finishFrames = e[i] | (e[i + 1] << 8) | (e[i + 2] << 16); i += 3; }

  need(2);
  const nextCheckpointIndex = n.getUint16(i, true); i += 2;
  need(12);
  const position = { x: f32(i), y: f32(i + 4), z: f32(i + 8) }; i += 12;
  need(16);
  const quaternion = { x: f32(i), y: f32(i + 4), z: f32(i + 8), w: f32(i + 12) }; i += 16;

  need(1);
  const nImp = n.getUint8(i); i += 1;
  if (nImp > 4) throw new Error('Number of collision impulses exceeds maximum allowed');
  const collisionImpulses = [];
  for (let r = 0; r < nImp; r++) { need(4); collisionImpulses.push(f32(i)); i += 4; }

  const wheelContact = [null, null, null, null];
  for (let r = 0; r < 4; r++) {
    if (contact[r]) {
      need(24);
      const position = { x: f32(i), y: f32(i + 4), z: f32(i + 8) }; i += 12;
      const normal = { x: f32(i), y: f32(i + 4), z: f32(i + 8) }; i += 12;
      wheelContact[r] = { position, normal };
    }
  }

  const read4 = () => { const a = [0, 0, 0, 0]; for (let r = 0; r < 4; r++) { need(4); a[r] = f32(i); i += 4; } return a; };
  const wheelSuspensionLength = read4();
  const wheelSuspensionVelocity = read4();
  const wheelDeltaRotation = read4();
  const wheelSkidInfo = read4();

  need(4);
  const steering = f32(i); i += 4;
  need(1);
  const cb = e[i];
  const controls = { up: !!(1 & cb), right: !!(2 & cb), down: !!(4 & cb), left: !!(8 & cb), reset: !!(16 & cb) };
  const brakeLightEnabled = !!(32 & cb);
  i += 1;

  return {
    numberOfBytes: i,
    carState: {
      frames, speedKmh, hasStarted, finishFrames, nextCheckpointIndex,
      hasCheckpointToRespawnAt, position, quaternion, collisionImpulses,
      wheelContact, wheelSuspensionLength, wheelSuspensionVelocity,
      wheelDeltaRotation, wheelSkidInfo, steering, brakeLightEnabled, controls,
    },
  };
}

// Decode a full 227-byte worker buffer (ArrayBuffer or Uint8Array).
function decodeCarStateBuffer(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const carId = u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24);
  const { carState } = decodeRecord(u8.subarray(4));
  return { carId, ...carState };
}

module.exports = { decodeCarStateBuffer, decodeRecord };
