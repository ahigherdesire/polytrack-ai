// Finishing driver via beam search with snapshot/restore. Keeps B diverse
// trajectories (bucketed by position cell + checkpoint index) so detours around
// walls survive even when momentarily farther from the next checkpoint. Robust
// against the local minima that defeat greedy. Produces a finishing input seq.
//
// Usage: node train/beam_search.js [data/constants.json] [beamWidth] [chunkLen]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { gridToWorld, horizForward } = require('../sim/geom');
const LOCAL_FWD = { x: 0, y: 0, z: 1 };   // calibrated car forward axis

const B = parseInt(process.argv[2 + 1] || '12', 10);
const CHUNK = parseInt(process.argv[3 + 1] || '60', 10);
const CELL = 6;          // position bucket size for diversity
const MAX_GEN = 600;
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const CANDS = [
  { up: true }, { up: true, left: true }, { up: true, right: true },
  { left: true }, { right: true }, { down: true }, { down: true, left: true }, { down: true, right: true },
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
  const score = (s) => s.nextCheckpointIndex * 1e7 - d3(s.position, targetFor(s.nextCheckpointIndex));
  // Fine dedup key: keep beam genuinely diverse without collapsing branches.
  const cellKey = (s) => `${Math.round(s.position.x / 2)},${Math.round(s.position.z / 2)},${Math.round(s.speedKmh / 25)},${s.nextCheckpointIndex}`;

  // Run CHUNK frames of an action from a snapshot; return {state, finish}.
  const run = (snap, act) => {
    sim.restore(snap);
    let last = null, finish = null;
    for (let i = 0; i < CHUNK; i++) { const s = sim.step(act); if (!s) break; last = s; if (s.finishFrames !== null) { finish = s.finishFrames; break; } }
    return { state: last, finish };
  };

  sim.reset();
  const s0 = run(sim.snapshot(), { up: false }).state; sim.reset();
  let beam = [{ snap: sim.snapshot(), actions: [], state: s0 }];
  let best = { idx: 0, d: Infinity }, stale = 0, finished = null, finishActions = null;
  const t0 = Date.now();

  for (let g = 0; g < MAX_GEN; g++) {
    const buckets = new Map();       // cellKey -> {score, parent, act, state}
    for (const e of beam) {
      for (const act of CANDS) {
        const { state, finish } = run(e.snap, act);
        if (!state) continue;
        if (finish !== null) { finished = finish; finishActions = e.actions.concat(Array.from({ length: CHUNK }, () => act)); break; }
        const k = cellKey(state), sc = score(state);
        const cur = buckets.get(k);
        if (!cur || sc > cur.score) buckets.set(k, { score: sc, parent: e, act, state });
      }
      if (finished !== null) break;
    }
    if (finished !== null) { console.log(`\n*** FINISHED at frame ${finished} (${(finished / 1000).toFixed(3)} s) ***`); break; }

    // Keep top-B distinct (fine-keyed) states by score. The speed dimension in
    // the key preserves both fast and braking lines through a region.
    const survivors = [...buckets.values()].sort((a, b) => b.score - a.score).slice(0, B);
    if (survivors.length === 0) { console.log('beam emptied'); break; }
    const next = [];
    for (const sv of survivors) {
      sim.restore(sv.parent.snap);
      for (let i = 0; i < CHUNK; i++) sim.step(sv.act);
      next.push({ snap: sim.snapshot(), actions: sv.parent.actions.concat(Array.from({ length: CHUNK }, () => sv.act)), state: sv.state });
    }
    beam = next;

    // Progress tracking on the frontier leader.
    const lead = survivors[0].state;
    const d = d3(lead.position, targetFor(lead.nextCheckpointIndex));
    if (lead.nextCheckpointIndex > best.idx || (lead.nextCheckpointIndex === best.idx && d < best.d - 0.5)) {
      if (lead.nextCheckpointIndex > best.idx) console.log(`  >> checkpoint ${lead.nextCheckpointIndex} reached (frame ${lead.frames})`);
      best = { idx: lead.nextCheckpointIndex, d }; stale = 0;
    } else stale++;
    if (g % 15 === 0 || stale === 0) console.log(`gen ${String(g).padStart(3)} beam=${beam.length} lead cp=${lead.nextCheckpointIndex} pos=(${lead.position.x.toFixed(0)},${lead.position.z.toFixed(0)}) v=${lead.speedKmh.toFixed(0)} d2cp=${d.toFixed(0)} stale=${stale}`);
    if (stale > 60) { console.log('no progress for 60 gens — stopping'); break; }
  }

  console.log(`\nsearch ${((Date.now() - t0) / 1000).toFixed(1)}s, bestCheckpoint ${best.idx}, finished ${finished}`);
  if (finished !== null) {
    const out = path.resolve(__dirname, '..', 'data', 'summer1_finish.json');
    fs.writeFileSync(out, JSON.stringify({ finishFrames: finished, chunk: CHUNK, actions: finishActions }));
    console.log('saved ->', out, `(${finishActions.length} frames)`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
