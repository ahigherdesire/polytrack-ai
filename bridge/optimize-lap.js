// TAS hill-climber: start from a seed lap (e.g. a world record's inputs) and
// search for a FASTER finish. Every candidate is simulated frame-exact in our
// headless sim; a change is kept only if the lap still finishes AND finishes in
// fewer frames. Honest by construction — it can't claim a time it can't reproduce.
//
// Usage: node bridge/optimize-lap.js <seed-lap.json> <track.json> [iterations] [out.json]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { actionsToRecording } = require('./make-recording');

const KEYS = ['up', 'down', 'left', 'right'];   // we don't perturb 'reset'

(async () => {
  const seedFile = process.argv[2];
  const trackFile = process.argv[3] || path.resolve(__dirname, '..', 'tracks', 'hollowdunes.json');
  const ITERS = parseInt(process.argv[4] || '400', 10);
  const out = process.argv[5];
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const track = JSON.parse(fs.readFileSync(trackFile, 'utf8'));

  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(track.init, track.createCar);

  // Drive a live car with an action array; return finish frame (or null).
  const MARGIN = 2000;
  function finishFrames(actions, cap) {
    sim.reset();
    const limit = Math.min(actions.length, cap);
    let last = null;
    for (let f = 0; f < limit; f++) {
      const s = sim.step(actions[f]);
      if (!s) return null;
      last = s;
      if (s.finishFrames !== null) return s.finishFrames;
    }
    return last && last.finishFrames !== null ? last.finishFrames : null;
  }

  let best = seed.actions.map((a) => ({ up: !!a.up, down: !!a.down, left: !!a.left, right: !!a.right, reset: !!a.reset }));
  let bestF = finishFrames(best, best.length + MARGIN);
  if (bestF === null) { console.error('seed does not finish in this sim — track/seed mismatch?'); process.exit(1); }
  console.error(`seed finishes at ${bestF} (${(bestF / 1000).toFixed(3)}s). hill-climbing ${ITERS} iters...`);

  const outFile = out || seedFile.replace(/\.json$/, '') + '.optimized.json';
  function saveBest() {
    const trimmed = best.slice(0, bestF);
    const recording = actionsToRecording(trimmed, {});
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ kind: 'optimizedLap', finishFrames: bestF, finishSeconds: bestF / 1000, frames: bestF, recording, actions: trimmed }));
  }
  saveBest();   // save the seed-as-best immediately so the file always exists

  const rnd = (n) => (Math.random() * n) | 0;
  let accepted = 0;
  const t0 = Date.now();
  for (let it = 0; it < ITERS; it++) {
    // perturb a copy: set a random key to a random value over a short window
    const cand = best.map((a) => ({ ...a }));
    const a = rnd(bestF), L = 1 + rnd(8), k = KEYS[rnd(KEYS.length)], v = Math.random() < 0.5;
    for (let f = a; f < Math.min(a + L, cand.length); f++) {
      cand[f][k] = v;
      if (k === 'up' && v) cand[f].down = false;   // can't hold both
      if (k === 'down' && v) cand[f].up = false;
    }
    const f = finishFrames(cand, bestF + MARGIN);
    if (f !== null && f < bestF) { best = cand; bestF = f; accepted++; saveBest(); console.error(`  it ${it}: improved -> ${bestF} (${(bestF / 1000).toFixed(3)}s)`); }
    if (it % 50 === 49) console.error(`  ...${it + 1}/${ITERS}  best=${bestF}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  saveBest();
  console.error(`\ndone. best=${bestF} (${(bestF / 1000).toFixed(3)}s)  accepted ${accepted}/${ITERS}  vs seed ${seed.finishFrames ?? '?'}`);
  console.error('wrote', outFile, '(updated on every improvement; has .recording you can play/submit)');
})().catch((e) => { console.error(e.message); process.exit(1); });
