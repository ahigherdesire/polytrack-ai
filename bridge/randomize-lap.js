// Random mode: take a lap and scramble its inputs into a DIFFERENT lap that
// still finishes, WITHOUT wasting much time (lap stays fast) and WITHOUT wasting
// search effort (every simulated edit pushes divergence up, never reverts).
//
// How it's fast + divergent:
//   - Edits flip inputs to the OPPOSITE of the original, so each accepted edit
//     adds divergence. Edits that wouldn't add divergence are skipped before any
//     simulation (no wasted rollouts).
//   - A snapshot ladder lets each iteration re-simulate only the tail AFTER the
//     edit instead of replaying the whole lap from frame 0.
//   - A tight time budget (default +0.5s) means divergence collects in
//     physics-neutral inputs (redundant taps / opposing keys) that change the
//     recording but barely cost lap time.
//
// Usage: node bridge/randomize-lap.js <seed-lap.json> <track.json> [iters] [out.json] [maxSlowerSeconds] [snaps]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { actionsToRecording } = require('./make-recording');

const KEYS = ['up', 'down', 'left', 'right'];
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };

(async () => {
  const seedFile = process.argv[2];
  const trackFile = process.argv[3];
  const ITERS = parseInt(process.argv[4] || '2000', 10);
  const out = process.argv[5] || seedFile.replace(/\.json$/, '') + '.random.json';
  const maxSlower = parseFloat(process.argv[6] || '0.5');   // seconds the lap may get slower
  const SNAPS = parseInt(process.argv[7] || '8', 10);       // snapshot ladder size (16MB each)
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const track = JSON.parse(fs.readFileSync(trackFile, 'utf8'));

  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(track.init, track.createCar);

  const norm = (a) => ({ up: !!a.up, down: !!a.down, left: !!a.left, right: !!a.right, reset: !!a.reset });
  const orig = seed.actions.map(norm);

  // --- pad both orig and working copy so the lap has room to get a touch slower
  // (held last input). Padding frames match between orig & cur => no fake divergence.
  const slowF = Math.ceil(maxSlower * 1000);
  const padLen = Math.max(orig.length, orig.length + slowF) + 4;
  const lastOrig = orig.length ? orig[orig.length - 1] : { up: false, down: false, left: false, right: false, reset: false };
  while (orig.length < padLen) orig.push({ ...lastOrig });
  let cur = orig.map((a) => ({ ...a }));

  // --- snapshot ladder: snapByFrame[F] = physics state right BEFORE stepping cur[F].
  let STRIDE = 1;
  let snapByFrame = Object.create(null);
  let curF = null;

  function finishOnly() {
    // light replay of cur — just the finish frame, no snapshots.
    sim.reset();
    for (let f = 0; f < cur.length; f++) {
      const s = sim.step(cur[f]); if (!s) break;
      if (s.finishFrames !== null) return s.finishFrames;
    }
    return null;
  }
  function rolloutBuild() {
    // full replay of cur, recording one snapshot every STRIDE frames + frame 0.
    sim.reset();
    snapByFrame = Object.create(null);
    snapByFrame[0] = sim.snapshot();
    let fin = null;
    for (let f = 0; f < cur.length; f++) {
      const s = sim.step(cur[f]); if (!s) break;
      if (s.finishFrames !== null) { fin = s.finishFrames; break; }
      if ((f + 1) % STRIDE === 0) snapByFrame[f + 1] = sim.snapshot();
    }
    return fin;
  }

  const seedF0 = finishOnly();
  if (seedF0 === null) { console.error('seed does not finish in this sim — track/seed mismatch?'); process.exit(1); }
  curF = seedF0;
  const budget = seedF0 + slowF;
  STRIDE = Math.max(128, Math.ceil(budget / SNAPS));   // ~SNAPS snapshots across the lap
  rolloutBuild();                                       // build ladder at the real stride

  // --- divergence accounting (per-key over frames): incremental, O(edit) per iter.
  const keyDiffAt = (f) => { let d = 0; const a = cur[f], b = orig[f]; for (const k of KEYS) if (!!a[k] !== !!b[k]) d++; return d; };
  let keyDiff = 0; for (let f = 0; f < cur.length; f++) keyDiff += keyDiffAt(f);
  const frameDiff = () => { let d = 0; for (let f = 0; f < curF; f++) { for (const k of KEYS) if (!!cur[f][k] !== !!orig[f][k]) { d++; break; } } return d; };

  console.error(`seed ${seedF0} (${(seedF0 / 1000).toFixed(3)}s). randomizing ${ITERS} iters, budget ${(budget / 1000).toFixed(3)}s, stride ${STRIDE}...`);

  // Evaluate cur from frame `a`: restore nearest snapshot <= a, sim the tail.
  // If capture, stash refreshed snapshots into `pending` (committed on accept).
  function evalFrom(a, cap, pending) {
    let bf = Math.floor(a / STRIDE) * STRIDE;
    while (bf > 0 && snapByFrame[bf] === undefined) bf -= STRIDE;
    sim.restore(snapByFrame[bf]);
    for (let f = bf; f < cap; f++) {
      if (pending && f > bf && f % STRIDE === 0) pending[f] = sim.snapshot();
      const s = sim.step(cur[f]); if (!s) return null;
      if (s.finishFrames !== null) return s.finishFrames;
    }
    return null;   // didn't finish inside cap
  }

  const outFile = out;
  function save() {
    const trimmed = cur.slice(0, curF);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
      kind: 'randomizedLap', finishFrames: curF, finishSeconds: curF / 1000, frames: curF,
      divergedFrames: frameDiff(), keyDiff, recording: actionsToRecording(trimmed, {}), actions: trimmed,
    }));
  }
  save();

  const rnd = (n) => (Math.random() * n) | 0;
  const t0 = Date.now();
  let sims = 0, accepts = 0;

  for (let it = 0; it < ITERS; it++) {
    const a = rnd(curF), L = 1 + rnd(14);
    const k = KEYS[rnd(4)];
    const randomMode = Math.random() < 0.15;   // a little exploration

    // Apply edit in place, remembering old values and the divergence delta.
    const changes = [];
    let delta = 0;
    const set = (f, kk, nv) => {
      if (!!cur[f][kk] === !!nv) return;
      const was = !!cur[f][kk];
      changes.push([f, kk, was]);
      delta += ((nv !== !!orig[f][kk]) ? 1 : 0) - ((was !== !!orig[f][kk]) ? 1 : 0);
      cur[f][kk] = nv;
    };
    const end = Math.min(a + L, curF);
    for (let f = a; f < end; f++) {
      const nv = randomMode ? (Math.random() < 0.5) : !orig[f][k];   // bias: opposite of original
      set(f, k, nv);
      if (nv) set(f, OPP[k], false);   // can't hold opposing keys at once
    }

    // Skip before simulating: nothing changed, or it wouldn't add divergence.
    if (changes.length === 0 || (!randomMode && delta <= 0)) {
      for (let i = changes.length - 1; i >= 0; i--) cur[changes[i][0]][changes[i][1]] = changes[i][2];
      continue;
    }

    const pending = Object.create(null);
    const f = evalFrom(a, budget + 1, pending);
    sims++;
    if (f !== null && f <= budget && keyDiff + delta >= keyDiff) {
      // accept: commit divergence, refresh ladder, drop stale high snapshots.
      curF = f; keyDiff += delta; accepts++;
      for (const fr in pending) snapByFrame[fr] = pending[fr];
      for (const fr in snapByFrame) if (+fr > curF) delete snapByFrame[fr];
      if (accepts % 20 === 0) save();
    } else {
      for (let i = changes.length - 1; i >= 0; i--) cur[changes[i][0]][changes[i][1]] = changes[i][2];
    }

    if (it % 200 === 199) {
      const fd = frameDiff();
      console.error(`  ${it + 1}/${ITERS}  time=${(curF / 1000).toFixed(3)}s  diverged ${fd} frames (${(100 * fd / curF).toFixed(0)}%)  keyDiff ${keyDiff}  [${accepts} accepted / ${sims} sims, ${((Date.now() - t0) / 1000) | 0}s]`);
    }
  }
  save();
  const fd = frameDiff();
  console.error(`\ndone. time=${(curF / 1000).toFixed(3)}s (was ${(seedF0 / 1000).toFixed(3)}s)  diverged ${fd}/${curF} frames (${(100 * fd / curF).toFixed(0)}% different)  keyDiff ${keyDiff}  [${accepts} accepted / ${sims} sims in ${((Date.now() - t0) / 1000) | 0}s]`);
  console.error('wrote', outFile, '(different inputs, still finishes; has .recording)');
})().catch((e) => { console.error(e.message); process.exit(1); });
