// Finishing driver: greedy receding-horizon search with a real checkpoint
// compass. Each chunk, try constant actions and keep the one that best reduces
// distance to the NEXT checkpoint (or advances past it). Walls are avoided
// naturally — ramming one doesn't reduce distance. Produces a finishing seq.
//
// Usage: node train/cp_search.js [data/constants.json] [chunkLen] [maxChunks]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { gridToWorld } = require('../sim/geom');

const CHUNK = parseInt(process.argv[3] || '90', 10);
const MAX_CHUNKS = parseInt(process.argv[4] || '500', 10);
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const CANDS = [
  { up: true }, { up: true, left: true }, { up: true, right: true },
  { left: true }, { right: true },
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
  console.log('targets:', cps.map((c, i) => `#${i}(${c.x},${c.y},${c.z})`).join(' '), `then finish@(${startWorld.x.toFixed(0)},${startWorld.z.toFixed(0)})`);

  const score = (r) => {
    if (r.finishFrames !== null) return 1e12 - r.finishFrames;
    const idx = r.last.nextCheckpointIndex;
    return idx * 1e7 - d3(r.last.position, targetFor(idx));
  };

  let committed = [];
  let bestSeen = -Infinity, stuck = 0, maxIdx = 0;
  const t0 = Date.now();

  for (let c = 0; c < MAX_CHUNKS; c++) {
    let best = null, bestAct = null, bestScore = -Infinity;
    for (const act of CANDS) {
      const seq = committed.concat(Array.from({ length: CHUNK }, () => act));
      const r = sim.rollout(seq);
      const sc = score(r);
      if (sc > bestScore) { bestScore = sc; best = r; bestAct = act; }
    }
    committed = committed.concat(Array.from({ length: CHUNK }, () => bestAct));

    if (best.finishFrames !== null) {
      console.log(`\n*** FINISHED at frame ${best.finishFrames} (${(best.finishFrames / 1000).toFixed(3)} s) ***`);
      const out = path.resolve(__dirname, '..', 'data', 'summer1_finish.json');
      fs.writeFileSync(out, JSON.stringify({ finishFrames: best.finishFrames, chunk: CHUNK, actions: committed }));
      console.log('saved ->', out);
      return;
    }

    if (bestScore > bestSeen + 1e-3) { bestSeen = bestScore; stuck = 0; } else stuck++;
    if (best.last.nextCheckpointIndex > maxIdx) maxIdx = best.last.nextCheckpointIndex;
    const tag = JSON.stringify(bestAct).replace(/[":{}]/g, '').replace(/true/g, '1');
    const tgt = targetFor(best.last.nextCheckpointIndex);
    console.log(`chunk ${String(c).padStart(3)} cp=${best.last.nextCheckpointIndex} act=${tag.padEnd(11)} pos=(${best.last.position.x.toFixed(0)},${best.last.position.z.toFixed(0)}) v=${best.last.speedKmh.toFixed(0)} dist2cp=${d3(best.last.position, tgt).toFixed(0)} stuck=${stuck}`);

    if (stuck > 30) { console.log('stuck 30 chunks — stopping'); break; }
  }
  console.log(`\nsearch ${(Date.now() - t0) / 1000}s, committed ${committed.length} frames, maxCheckpoint ${maxIdx}`);
})().catch((e) => { console.error(e); process.exit(1); });
