// Finishing driver for PolyTrack via greedy receding-horizon search over the
// headless sim. No track geometry needed: reward = checkpoints reached
// (dominant), then distance from the last checkpoint (forward progress), with a
// large bonus for crossing the finish. Produces a finishing input sequence.
//
// Usage: node train/finish_search.js [data/constants.json] [chunkLen] [maxChunks]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');

const CHUNK = parseInt(process.argv[3] || '120', 10);     // frames per committed chunk
const MAX_CHUNKS = parseInt(process.argv[4] || '400', 10);
const HOLD = (a) => a;                                     // action repeated over a chunk

// Candidate constant actions per chunk.
const CANDIDATES = [
  { up: true },                 // accelerate straight
  { up: true, left: true },     // accelerate + left
  { up: true, right: true },    // accelerate + right
  { down: true },               // brake / reverse
  { down: true, left: true },
  { down: true, right: true },
];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

(async () => {
  const file = process.argv[2] || path.resolve(__dirname, '..', 'data', 'constants.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init, payload.createCar);

  // Find start position.
  const s0 = sim.rollout([{ up: false }]).last;
  let committed = [];
  let lastCpPos = { ...s0.position };
  let maxCp = 0;
  let bestEver = { score: -Infinity };
  let stuck = 0;

  const score = (r) => {
    if (r.finishFrames !== null) return 1e12 - r.finishFrames;      // finished: minimize time
    const d = dist(r.last.position, lastCpPos);
    return r.maxCheckpoint * 1e6 + d - (Math.abs(r.last.speedKmh) < 1 ? 500 : 0);
  };

  const t0 = Date.now();
  for (let c = 0; c < MAX_CHUNKS; c++) {
    let best = null, bestAct = null;
    for (const act of CANDIDATES) {
      const seq = committed.concat(Array.from({ length: CHUNK }, () => HOLD(act)));
      const r = sim.rollout(seq);
      const sc = score(r);
      if (!best || sc > best._sc) { best = r; best._sc = sc; bestAct = act; }
    }

    // Finished?
    if (best.finishFrames !== null) {
      committed = committed.concat(Array.from({ length: CHUNK }, () => bestAct));
      console.log(`\n*** FINISHED at frame ${best.finishFrames} (${(best.finishFrames / 1000).toFixed(3)} s) ***`);
      bestEver = { score: best._sc, finishFrames: best.finishFrames };
      break;
    }

    const prevCp = maxCp;
    committed = committed.concat(Array.from({ length: CHUNK }, () => bestAct));
    if (best.maxCheckpoint > maxCp) { maxCp = best.maxCheckpoint; lastCpPos = { ...best.last.position }; stuck = 0; }
    else stuck++;

    const tag = JSON.stringify(bestAct).replace(/[":{}]/g, '').replace(/true/g, '1');
    console.log(
      `chunk ${String(c).padStart(3)}  cp=${maxCp}  act=${tag.padEnd(12)}  ` +
      `pos=(${best.last.position.x.toFixed(1)},${best.last.position.z.toFixed(1)})  ` +
      `v=${best.last.speedKmh.toFixed(0)}  f=${best.frames}  stuck=${stuck}`);

    // Escape if wedged with no checkpoint progress for a while: stop and report.
    if (stuck > 25) { console.log('No progress for 25 chunks — stopping (needs deeper search).'); break; }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nsearch time: ${secs}s   committed frames: ${committed.length}   maxCheckpoint: ${maxCp}`);
  const out = path.resolve(__dirname, '..', 'data', 'summer1_inputs.json');
  fs.writeFileSync(out, JSON.stringify({ chunk: CHUNK, maxCheckpoint: maxCp, finished: bestEver.finishFrames ?? null, actions: committed }));
  console.log('saved input sequence ->', out);
})().catch((e) => { console.error(e); process.exit(1); });
