// Random mode: take a lap and scramble its inputs into a DIFFERENT lap that
// still finishes (a bit slower is fine). Use this so a copied run doesn't look
// byte-identical to the original player's recording.
//
// It does a random walk: keep applying random input tweaks, accepting any that
// still finish within a time budget (original + maxSlower seconds). Over many
// iterations the inputs drift away from the original while staying a valid lap.
//
// Usage: node bridge/randomize-lap.js <seed-lap.json> <track.json> [iters] [out.json] [maxSlowerSeconds]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { actionsToRecording } = require('./make-recording');

const KEYS = ['up', 'down', 'left', 'right'];

(async () => {
  const seedFile = process.argv[2];
  const trackFile = process.argv[3];
  const ITERS = parseInt(process.argv[4] || '1500', 10);
  const out = process.argv[5] || seedFile.replace(/\.json$/, '') + '.random.json';
  const maxSlower = parseFloat(process.argv[6] || '2');      // seconds we'll allow it to get slower
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const track = JSON.parse(fs.readFileSync(trackFile, 'utf8'));

  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(track.init, track.createCar);

  const MARGIN = Math.ceil(maxSlower * 1000) + 1500;
  function finishFrames(actions, cap) {
    sim.reset();
    let last = null;
    for (let f = 0; f < Math.min(actions.length, cap); f++) {
      const s = sim.step(actions[f]); if (!s) return null; last = s;
      if (s.finishFrames !== null) return s.finishFrames;
    }
    return last && last.finishFrames !== null ? last.finishFrames : null;
  }

  const orig = seed.actions.map((a) => ({ up: !!a.up, down: !!a.down, left: !!a.left, right: !!a.right, reset: !!a.reset }));
  let cur = orig.map((a) => ({ ...a }));
  const seedF = finishFrames(cur, cur.length + MARGIN);
  if (seedF === null) { console.error('seed does not finish in this sim — track/seed mismatch?'); process.exit(1); }
  const budget = seedF + Math.ceil(maxSlower * 1000);
  let curF = seedF;
  console.error(`seed ${seedF} (${(seedF / 1000).toFixed(3)}s). randomizing ${ITERS} iters, budget ${(budget / 1000).toFixed(3)}s...`);

  const rnd = (n) => (Math.random() * n) | 0;
  const diffFrames = () => { let d = 0; for (let f = 0; f < curF; f++) { const a = cur[f] || {}, b = orig[f] || {}; if (KEYS.some((k) => !!a[k] !== !!b[k])) d++; } return d; };
  const outFile = out;
  function save() {
    const trimmed = cur.slice(0, curF);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ kind: 'randomizedLap', finishFrames: curF, finishSeconds: curF / 1000, frames: curF, divergedFrames: diffFrames(), recording: actionsToRecording(trimmed, {}), actions: trimmed }));
  }
  save();

  const t0 = Date.now();
  for (let it = 0; it < ITERS; it++) {
    const cand = cur.map((a) => ({ ...a }));
    const a = rnd(curF), L = 1 + rnd(14), k = KEYS[rnd(4)], v = Math.random() < 0.5;
    for (let f = a; f < Math.min(a + L, cand.length); f++) { cand[f][k] = v; if (k === 'up' && v) cand[f].down = false; if (k === 'down' && v) cand[f].up = false; }
    const f = finishFrames(cand, budget + 50);
    if (f !== null && f <= budget) { cur = cand; curF = f; if (it % 25 === 0) save(); }
    if (it % 100 === 99) { const d = diffFrames(); console.error(`  ${it + 1}/${ITERS}  time=${(curF / 1000).toFixed(3)}s  diverged ${d} frames (${(100 * d / curF).toFixed(0)}%)  (${((Date.now() - t0) / 1000) | 0}s)`); }
  }
  save();
  const d = diffFrames();
  console.error(`\ndone. time=${(curF / 1000).toFixed(3)}s (was ${(seedF / 1000).toFixed(3)}s)  diverged ${d}/${curF} frames (${(100 * d / curF).toFixed(0)}% different)`);
  console.error('wrote', outFile, '(different inputs, still finishes; has .recording)');
})().catch((e) => { console.error(e.message); process.exit(1); });
