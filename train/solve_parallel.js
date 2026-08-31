// Root-parallel MCTS lap solver — the fast, working replacement for the ES
// trainer. Spawns a pool of workers (each with its own physics sim + guidance),
// searches every window in parallel, merges the visit tries for a confident
// consensus lock, and advances all workers in lockstep. Writes the finishing
// lap to data/es_lap[.<track>].json (the format the recording bridge consumes).
//
//   node train/solve_parallel.js [budgetSeconds] [simsPerWorker] [workers]
//   TRACK=tracks/haoyuone.json node train/solve_parallel.js 900 200 3
//
// On the Pi 5 keep workers at 3. On a desktop use cores-1.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { WindowedMcts, MCTS_DEFAULTS, mergeTries, maskToControls } = require('./mcts_solver');

const DATA = path.resolve(__dirname, '..', 'data');
const CONSTANTS = process.env.TRACK ? path.resolve(process.env.TRACK) : path.join(DATA, 'constants.json');
const TAG = path.basename(CONSTANTS, '.json');
const LAP_FILE = path.join(DATA, TAG === 'constants' ? 'es_lap.json' : `es_lap.${TAG}.json`);
const RUN_FILE = path.join(DATA, TAG === 'constants' ? 'solve_run.json' : `solve_run.${TAG}.json`);

const BUDGET_S = parseFloat(process.argv[2] || '600');
const SIMS = parseInt(process.argv[3] || '160', 10);
const NW = parseInt(process.argv[4] || String(Math.min(Math.max(os.cpus().length - 1, 1), 12)), 10);

const OPTS = {
  ...MCTS_DEFAULTS,
  decimationMs: 20,       // 20 ms action blocks (coarser control, fewer stepN calls)
  windowMs: 400,          // tree lookahead frames per sim
  lockMs: 160,            // lock up to 8 blocks/window when the tree is confident
  rolloutMs: 300,         // targeted rollout beyond the tree leaf
  rolloutDecisionMs: 40,
  pwExponent: 0.42,       // fewer actions explored per node -> deeper, confident locks
  ucbC: 0.6,             // slightly more exploitation -> deeper principal variation
  minVisitFrac: 0.012,   // lock-depth confidence threshold (rewind is the safety net)
  simsPerWindow: SIMS,
  maxRunMs: 120000,
  stuckWindows: 6,        // detect a hard feature sooner...
  maxRewinds: 40,         // ...and keep re-attempting it with fresh seeds (MCTS is
                          //   asymptotically complete: each rewind is another shot
                          //   at the line through a tricky ramp/edge).
};
const DEC = OPTS.decimationMs;
const LOCK_N = Math.round(OPTS.lockMs / DEC);

let nextId = 1;
function ask(w, cmd, args) {
  return new Promise((res, rej) => {
    const id = nextId++;
    w._pending.set(id, { res, rej });
    w.postMessage({ id, cmd, args });
  });
}
function spawn() {
  const w = new Worker(path.join(__dirname, 'mcts_worker.js'), { workerData: {} });
  w._pending = new Map();
  w.on('message', (m) => {
    const p = w._pending.get(m.id);
    if (!p) return;
    w._pending.delete(m.id);
    if (m.error) p.rej(new Error(m.error)); else p.res(m.result);
  });
  w.on('error', (e) => { console.error('worker error:', e); process.exit(1); });
  return w;
}

function writeRun(o) { try { fs.writeFileSync(RUN_FILE, JSON.stringify(o, null, 2)); } catch { } }

function buildActions(maskBlocks, finishFrames) {
  const actions = [];
  for (let i = 0; i < maskBlocks.length; i++) {
    const c = maskToControls(maskBlocks[i]);
    for (let f = 0; f < DEC; f++) actions.push(c);
    if (finishFrames != null && actions.length >= finishFrames) break;
  }
  return actions;
}

function writeLap(maskBlocks, finishFrames, maxCp) {
  const actions = buildActions(maskBlocks, finishFrames);
  fs.writeFileSync(LAP_FILE, JSON.stringify({
    generation: 0,
    kind: finishFrames != null ? 'fastestFinish' : 'bestRewardFallback',
    solver: 'mcts-parallel',
    bestReward: null,
    maxCheckpoint: maxCp,
    finishFrames,
    finishSeconds: finishFrames != null ? finishFrames / 1000 : null,
    frames: actions.length,
    actions,
  }));
  return actions.length;
}

(async () => {
  console.log(`solving ${path.basename(CONSTANTS)}  budget=${BUDGET_S}s  workers=${NW}  sims/worker=${SIMS}  (effective ${SIMS * NW}/window)`);
  const workers = Array.from({ length: NW }, spawn);
  // Initialize workers sequentially: booting many wasm instances at once
  // saturates the event loop and races the worker bundle's async init. One at a
  // time keeps each boot reliable (the cost is a one-time ~1-2 s per worker).
  const infos = [];
  for (let i = 0; i < workers.length; i++) {
    infos.push(await ask(workers[i], 'init', { constants: CONSTANTS }));
    process.stdout.write(`\rinitializing workers ${i + 1}/${NW}...`);
  }
  process.stdout.write('\n');
  const info = infos[0];
  if (!info.ready) { console.error('guidance field empty — cannot solve (no drivable cells / waypoints)'); process.exit(1); }
  console.log(`guidance: ${info.cells} cells, ${info.checkpoints} checkpoints, ${info.finishes} finish`);
  const maxCp = info.checkpoints + (info.finishes ? 1 : 0);

  await Promise.all(workers.map((w, i) => ask(w, 'mctsInit', { opts: OPTS, seed: (OPTS.seed ^ (i * 0x9e3779b9)) >>> 0 })));

  const totalSims = SIMS * NW;
  const minVisits = Math.max(10, Math.round(totalSims * OPTS.minVisitFrac));
  const locked = [];              // driver-side mirror of every worker's locked chain

  // ---- greedy seed: drive the easy opening with the guidance rollout policy
  // (which nails straights/gentle turns instantly) and hand only the reliably
  // driven prefix to search. MCTS then starts at the first hard feature carrying
  // speed, instead of wasting minutes re-deriving the trivial launch. SEED=0
  // disables; SEED_FRAMES caps how far greedy may drive.
  if (process.env.SEED !== '0') {
    const maxFrames = parseInt(process.env.SEED_FRAMES || '30000', 10);
    const g = await ask(workers[0], 'greedySeed', { maxFrames });
    // Trust greedy only up to its last healthy-progress point, and back off a
    // touch so search owns the approach to the hard feature, not just the jump.
    const backoff = Math.round(2500 / DEC); // ~2.5 s of runway: hand search a full-speed run at the hard feature
    const safe = Math.max(0, Math.min(g.blocks.length, (g.finished ? g.blocks.length : g.safeLen) - backoff));
    if (safe > 0) {
      const seed = g.blocks.slice(0, safe);
      const seedInfos = await Promise.all(workers.map((w) => ask(w, 'mctsSeed', { blocks: seed })));
      locked.push(...seed);
      const si = seedInfos[0];
      console.log(`greedy seed: drove ${(g.blocks.length * DEC / 1000).toFixed(2)}s (maxCp=${g.maxCp}` +
        `${g.finished ? `, FINISHED ${(g.finishFrames / 1000).toFixed(3)}s` : ''}); ` +
        `locked ${(seed.length * DEC / 1000).toFixed(2)}s -> search resumes at cp=${si.cp} speed=${si.st.speedKmh != null ? si.st.speedKmh.toFixed(0) : '?'}`);
    } else {
      console.log('greedy seed produced no reliable prefix — searching from the start');
    }
  }
  let bestFinish = null;          // { frames, blocks:[...] }  full winning mask sequence
  let stuckCount = 0, rewinds = 0, gainEma = null;
  const t0 = Date.now();
  let result = null;

  for (let window = 0; ; window++) {
    const searches = await Promise.all(workers.map((w) => ask(w, 'mctsSearch', { sims: SIMS, trieDepth: LOCK_N })));
    for (const s of searches) {
      if (s.bestFinish && (!bestFinish || s.bestFinish.frames < bestFinish.frames)) {
        bestFinish = { frames: s.bestFinish.frames, blocks: s.bestFinish.locked.concat(s.bestFinish.tail) };
      }
    }
    const merged = mergeTries(searches.map((s) => s.trie));
    const lockedNow = WindowedMcts.chooseLock(merged, LOCK_N, minVisits, OPTS.minLockBlocks);

    const advs = await Promise.all(workers.map((w) => ask(w, 'mctsAdvance', { lockedNow })));
    locked.push(...lockedNow);
    const adv = advs[0];
    const lockedMs = locked.length * DEC;

    if (window % 5 === 0) {
      const st = adv.st;
      const pos = st.x != null ? `pos=(${st.x.toFixed(0)},${st.y != null ? st.y.toFixed(0) : '?'},${st.z != null ? st.z.toFixed(0) : '?'})` : '';
      console.log(`w${window} t=${((Date.now() - t0) / 1000).toFixed(0)}s locked=${(lockedMs / 1000).toFixed(2)}s cp=${st.nextCheckpointIndex} ` +
        `speed=${st.speedKmh != null ? st.speedKmh.toFixed(0) : '?'} ${pos} wheels=${st.wheelContacts != null ? st.wheelContacts : '?'}` +
        (bestFinish ? ` bestFin=${(bestFinish.frames / 1000).toFixed(3)}s` : ''));
      writeRun({ track: TAG, window, elapsedS: (Date.now() - t0) / 1000, lockedS: lockedMs / 1000, cp: adv.st.nextCheckpointIndex, bestFinishS: bestFinish ? bestFinish.frames / 1000 : null, status: 'running' });
      if (process.env.DUMP_LOCKED) { try { fs.writeFileSync(path.join(DATA, 'locked_dump.json'), JSON.stringify(locked)); } catch { } }
    }

    // ---- termination ----
    if (adv.finished) {
      const ff = adv.st.finishFrames;
      console.log(`\n*** FINISH (locked) ${(ff / 1000).toFixed(3)}s`);
      result = { blocks: locked.slice(), finishFrames: ff };
      break;
    }
    if (bestFinish && lockedMs > bestFinish.frames + 400) {
      console.log(`\n*** FINISH (rollout) ${(bestFinish.frames / 1000).toFixed(3)}s`);
      result = { blocks: bestFinish.blocks, finishFrames: bestFinish.frames };
      break;
    }
    if (lockedMs > OPTS.maxRunMs || Date.now() - t0 > BUDGET_S * 1000) {
      console.log(`\nbudget/horizon reached — ${bestFinish ? 'best rollout finish ' + (bestFinish.frames / 1000).toFixed(3) + 's' : 'no finish, writing partial'}`);
      result = bestFinish ? { blocks: bestFinish.blocks, finishFrames: bestFinish.frames } : { blocks: locked.slice(), finishFrames: null };
      break;
    }

    // ---- stuck detection + coordinated rewind ----
    gainEma = gainEma == null ? adv.gain : gainEma * 0.7 + adv.gain * 0.3;
    const pastLaunch = lockedMs > OPTS.launchMs;
    const lockSec = lockedNow.length * DEC / 1000;
    if (pastLaunch && gainEma < 0.3 * lockSec / 0.15) stuckCount++; else stuckCount = 0;
    if (stuckCount >= OPTS.stuckWindows && rewinds < OPTS.maxRewinds && locked.length > 0) {
      const back = Math.round(1500 * Math.pow(2, Math.min(3, rewinds)) / DEC);
      const target = Math.max(0, locked.length - back);
      console.log(`STUCK — rewinding to ${(target * DEC / 1000).toFixed(2)}s (#${rewinds + 1})`);
      locked.length = target;
      await Promise.all(workers.map((w, i) => ask(w, 'mctsRewind', { toLockedLen: target, seed: (OPTS.seed ^ ((rewinds + 1) * 0x9e3779b9) ^ (i * 0x85ebca6b)) >>> 0 })));
      stuckCount = 0; gainEma = null; rewinds++;
    }
  }

  const frames = writeLap(result.blocks, result.finishFrames, maxCp);
  writeRun({ track: TAG, elapsedS: (Date.now() - t0) / 1000, bestFinishS: result.finishFrames != null ? result.finishFrames / 1000 : null, status: 'done', frames });
  if (result.finishFrames != null) console.log(`wrote ${(result.finishFrames / 1000).toFixed(3)}s lap (${frames} frames) -> data/${path.basename(LAP_FILE)}`);
  else console.log(`wrote partial (${frames} frames) -> data/${path.basename(LAP_FILE)}`);
  for (const w of workers) w.terminate();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
