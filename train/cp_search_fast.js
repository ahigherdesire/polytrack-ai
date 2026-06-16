// Fast finishing driver: greedy receding-horizon search using snapshot/restore
// (O(N), no prefix replay). Reward = checkpoints reached, then distance to the
// next checkpoint. Produces a finishing input sequence for the browser bridge.
//
// Usage: node train/cp_search_fast.js [data/constants.json] [chunkLen] [maxChunks]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { gridToWorld } = require('../sim/geom');

const CHUNK = parseInt(process.argv[3] || '60', 10);
const MAX_CHUNKS = parseInt(process.argv[4] || '700', 10);
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const CANDS = [
  { up: true }, { up: true, left: true }, { up: true, right: true },
  { left: true }, { right: true }, { up: true, left: true }, // (dupes harmless)
  { down: true }, { down: true, left: true }, { down: true, right: true },
];

(async () => {
  const file = process.argv[2] || path.resolve(__dirname, '..', 'data', 'constants.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init, payload.createCar);

  const cps = sim.checkpoints().map((c) => gridToWorld(c.grid));
  const startWorld = sim.rollout([{ up: false }]).last.position;
  const targetFor = (idx) => (idx < cps.length ? cps[idx] : startWorld);

  // Run CHUNK frames of a constant action from a snapshot; return final state.
  const tryFrom = (snap, act) => {
    sim.restore(snap);
    let last = null;
    for (let i = 0; i < CHUNK; i++) { const s = sim.step(act); if (!s) break; last = s; if (s.finishFrames !== null) break; }
    return last;
  };
  const score = (s) => {
    if (!s) return -Infinity;
    if (s.finishFrames !== null) return 1e12 - s.finishFrames;
    return s.nextCheckpointIndex * 1e7 - d3(s.position, targetFor(s.nextCheckpointIndex));
  };

  sim.reset();
  let snap = sim.snapshot();
  const committed = [];
  let bestSeen = -Infinity, stuck = 0, maxIdx = 0, finished = null;
  const t0 = Date.now();

  for (let c = 0; c < MAX_CHUNKS; c++) {
    let bestAct = null, bestScore = -Infinity, bestState = null;
    for (const act of CANDS) {
      const s = tryFrom(snap, act);
      const sc = score(s);
      if (sc > bestScore) { bestScore = sc; bestAct = act; bestState = s; }
    }
    // Commit best from the same snapshot, advance, re-snapshot.
    sim.restore(snap);
    for (let i = 0; i < CHUNK; i++) { const s = sim.step(bestAct); committed.push(bestAct); if (s && s.finishFrames !== null) { finished = s.finishFrames; break; } }
    snap = sim.snapshot();

    if (finished !== null) { console.log(`\n*** FINISHED at frame ${finished} (${(finished / 1000).toFixed(3)} s) ***`); break; }

    if (bestScore > bestSeen + 1e-3) { bestSeen = bestScore; stuck = 0; } else stuck++;
    if (bestState.nextCheckpointIndex > maxIdx) { maxIdx = bestState.nextCheckpointIndex; console.log(`  >> reached checkpoint ${maxIdx} at frame ${bestState.frames}`); }
    if (c % 20 === 0 || stuck > 0) {
      const tg = targetFor(bestState.nextCheckpointIndex);
      console.log(`chunk ${String(c).padStart(3)} cp=${bestState.nextCheckpointIndex} pos=(${bestState.position.x.toFixed(0)},${bestState.position.z.toFixed(0)}) v=${bestState.speedKmh.toFixed(0)} d2cp=${d3(bestState.position, tg).toFixed(0)} stuck=${stuck}`);
    }
    if (stuck > 40) { console.log('stuck 40 chunks — stopping'); break; }
  }

  console.log(`\nsearch ${((Date.now() - t0) / 1000).toFixed(1)}s, frames ${committed.length}, maxCheckpoint ${maxIdx}, finished ${finished}`);
  if (finished !== null) {
    const out = path.resolve(__dirname, '..', 'data', 'summer1_finish.json');
    fs.writeFileSync(out, JSON.stringify({ finishFrames: finished, chunk: CHUNK, actions: committed }));
    console.log('saved ->', out);
  }
})().catch((e) => { console.error(e); process.exit(1); });
