
}
// Exact port of the game's MountainManager.createMountainVertices
// (main.bundle.js). The game generates mountain collision geometry on the
// MAIN thread from the track's grid bounds and ships it to the physics
// worker with CreateCar — so a headless pipeline must reproduce it
// bit-for-bit or physics near the map edge could diverge from the real game.
//
// Determinism notes (why this port is exact):
//  - "Randomness" comes from a 128-entry pre-seeded table baked into the
//    bundle (extracted verbatim into the context JSON). The generator's PRNG
//    starts at index 0 and PRE-increments, wrapping at the table length.
//  - The game replaces global Math.sin/Math.cos with a 360-entry table
//    interpolation in both bundles; the generator runs under that Math, so
//    we use the same table interpolation here (tables from the context).
//  - All arithmetic is plain JS doubles, same as the game (the f32 rounding
//    happens later, inside the worker, when the vertices hit HEAPF32).
"use strict";

function makeDetSin(sineTable) {
  const K = sineTable;
  const TWO_PI = 2 * Math.PI;
  return function detSin(e) {
    if (Number.isNaN(e)) return NaN;
    e %= TWO_PI;
    if (e < 0) e += TWO_PI;
    const t = (e / TWO_PI) * K.length % K.length;
    const n = Math.floor(t);
    const i = (n + 1) % K.length;
    const r = t - n;
    return K[n] * (1 - r) + K[i] * r;
  };
}

// bounds: {min:{x,y}, max:{x,y}} in track grid coordinates (the worker
// Track.getBounds() shape). Returns { vertices: number[], offset: {x,y,z} }.
function createMountainVertices(bounds, context) {
  const table = context.mountainRandomTable;
  const partSize = context.partSize;
  const detSin = makeDetSin(context.sineTable);
  const detCos = (e) => detSin(e + Math.PI / 2);

  let rngIndex = 0;
  const next = () => {
    rngIndex++;
    if (rngIndex >= table.length) rngIndex = 0;
    return table[rngIndex];
  };

  const e = bounds;
  const n = Math.max(
    200,
    160 + Math.max(
      Math.abs(e.max.x - e.min.x) * partSize / 2 * Math.SQRT2,
      Math.abs(e.max.y - e.min.y) * partSize / 2 * Math.SQRT2
    )
  );
  const cx = (e.min.x + (e.max.x - e.min.x) / 2) * partSize;
  const cz = (e.min.y + (e.max.y - e.min.y) / 2) * partSize;
  if (n > 4500) return { vertices: [], offset: { x: 0, y: 0, z: 0 } };

  const ringCount = Math.floor(n / 10);
  const profiles = [];
  for (let k = 0; k < ringCount; ++k) {
    const profile = [];
    for (let j = 0; j < 8; ++j) {
      // NB operator precedence in the original:
      // (0==j) || (7==j) || ((1==j) && (next() < .5))
      if (j === 0 || j === 7 || (j === 1 && next() < 0.5)) profile.push(0);
      else profile.push(next());
    }
    profiles.push(profile);
  }

  const heightScale = 100;
  const verts = [];
  for (let k = 0; k < profiles.length; ++k) {
    const t = k / profiles.length * Math.PI * 2;
    const t2 = (k + 1) / profiles.length * Math.PI * 2;
    const cur = profiles[k];
    const nxt = k + 1 < profiles.length ? profiles[k + 1] : profiles[0];
    for (let j = 0; j < cur.length - 1; ++j) {
      const r0 = n + 100 * j;
      const r1 = n + 100 * (j + 1);
      verts.push(detCos(t) * r0, cur[j] * heightScale, detSin(t) * r0);
      verts.push(detCos(t2) * r0, nxt[j] * heightScale, detSin(t2) * r0);
      verts.push(detCos(t2) * r1, nxt[j + 1] * heightScale, detSin(t2) * r1);
      verts.push(detCos(t) * r0, cur[j] * heightScale, detSin(t) * r0);
      verts.push(detCos(t2) * r1, nxt[j + 1] * heightScale, detSin(t2) * r1);
      verts.push(detCos(t) * r1, cur[j + 1] * heightScale, detSin(t) * r1);
    }
  }
  return { vertices: verts, offset: { x: cx, y: 0, z: cz } };
}

module.exports = { createMountainVertices, makeDetSin 