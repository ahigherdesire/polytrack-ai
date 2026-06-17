// Parallel Evolution Strategies across CPU cores. Each worker runs its own
// headless sim; the main process evolves the policy weights. Resumes from
// data/policy.json if present.
//
// Usage: node train/es_parallel.js [generations] [pop] [maxFrames] [workers]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { gaussian, POLICY_SHAPE } = require('./evaluator');

const DATA = path.resolve(__dirname, '..', 'data');
const CONSTANTS = path.join(DATA, 'constants.json');
const GENS = parseInt(process.argv[2] || '500', 10);
const POP = parseInt(process.argv[3] || '56', 10);            // even
const MAXF = parseInt(process.argv[4] || '16000', 10);
const NW = parseInt(process.argv[5] || String(Math.min(os.cpus().length - 1, 13)), 10);
const SIGMA = 0.12, LR = 0.06;
const [nIn, nH, nOut] = POLICY_SHAPE;
const NWEIGHTS = nIn * nH + nH + nH * nOut + nOut;

function spawnWorker() {
  const w = new Worker(path.join(__dirname, 'es_worker.js'), { workerData: { constants: CONSTANTS } });
  w._pending = null;
  w.on('message', (m) => {
    if (m.type === 'ready') { w._ready(); }
    else if (m.type === 'result' || m.type === 'recorded') { const p = w._pending; w._pending = null; p && p(m); }
    else if (m.type === 'error') { console.error('worker error:', m.error); process.exit(1); }
  });
  w.readyPromise = new Promise((res) => { w._ready = res; });
  return w;
}
const ask = (w, msg) => new Promise((res) => { w._pending = res; w.postMessage(msg); });

(async () => {
  console.log(`spawning ${NW} workers, pop ${POP}, maxFrames ${MAXF}...`);
  const workers = Array.from({ length: NW }, spawnWorker);
  await Promise.all(workers.map((w) => w.readyPromise));
  console.log('workers ready.');

  // Init / resume theta.
  let theta = new Float64Array(NWEIGHTS);
  if (fs.existsSync(path.join(DATA, 'policy.json'))) {
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'policy.json'), 'utf8'));
    if (saved.weights && saved.weights.length === NWEIGHTS) { theta.set(saved.weights); console.log('resumed from data/policy.json'); }
  }
  if (theta.every((x) => x === 0)) for (let i = 0; i < theta.length; i++) theta[i] = (Math.random() * 2 - 1) * 0.1;

  let bestReward = -Infinity, bestTheta = theta.slice(), lastLapReward = -Infinity;
  const half = POP >> 1;
  const t0 = Date.now();

  for (let g = 0; g < GENS; g++) {
    const eps = Array.from({ length: half }, () => { const e = new Float64Array(NWEIGHTS); for (let k = 0; k < e.length; k++) e[k] = gaussian(); return e; });
    // Build candidates (antithetic).
    const cands = [];
    for (let i = 0; i < POP; i++) {
      const e = eps[i % half], sign = i < half ? 1 : -1;
      const c = new Float64Array(NWEIGHTS);
      for (let k = 0; k < NWEIGHTS; k++) c[k] = theta[k] + sign * SIGMA * e[k];
      cands.push(c);
    }
    // Distribute across workers.
    const per = Math.ceil(POP / NW);
    const jobs = workers.map((w, wi) => {
      const batch = [];
      for (let i = wi * per; i < Math.min(POP, (wi + 1) * per); i++) batch.push({ id: i, weights: Array.from(cands[i]), maxf: MAXF });
      return batch.length ? ask(w, { type: 'eval', batch }) : Promise.resolve({ results: [] });
    });
    const rewards = new Float64Array(POP);
    let bestCp = 0, bestFinish = null;
    for (const r of await Promise.all(jobs)) {
      for (const res of r.results) {
        rewards[res.id] = res.reward;
        if (res.maxCp > bestCp) bestCp = res.maxCp;
        if (res.finish !== null && (bestFinish === null || res.finish < bestFinish)) bestFinish = res.finish;
        if (res.reward > bestReward) { bestReward = res.reward; bestTheta = cands[res.id].slice(); }
      }
    }

    // Rank-normalize + ES update.
    const order = [...rewards.keys()].sort((a, b) => rewards[a] - rewards[b]);
    const ranks = new Float64Array(POP);
    order.forEach((idx, rank) => { ranks[idx] = rank / (POP - 1) - 0.5; });
    const step = new Float64Array(NWEIGHTS);
    for (let i = 0; i < POP; i++) { const e = eps[i % half], sign = i < half ? 1 : -1, wgt = ranks[i]; for (let k = 0; k < NWEIGHTS; k++) step[k] += wgt * sign * e[k]; }
    const scale = LR / (POP * SIGMA);
    for (let k = 0; k < NWEIGHTS; k++) theta[k] += scale * step[k];

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`gen ${String(g).padStart(3)} bestCp=${bestCp} bestReward=${bestReward.toFixed(0)} ${bestFinish !== null ? `FINISH=${(bestFinish / 1000).toFixed(3)}s` : ''} (${secs}s, ${(g / ((Date.now() - t0) / 1000)).toFixed(2)} gen/s)`);
    fs.writeFileSync(path.join(DATA, 'policy.json'), JSON.stringify({ nIn, nH, nOut, weights: Array.from(bestTheta), bestReward }));

    // Whenever the all-time best improves, record that policy's lap (the input
    // sequence) and save it — so es_lap.json always holds the current best lap,
    // finishing or not.
    if (bestReward > lastLapReward) {
      lastLapReward = bestReward;
      const rec = await ask(workers[0], { type: 'record', weights: Array.from(bestTheta), maxf: MAXF });
      fs.writeFileSync(path.join(DATA, 'es_lap.json'), JSON.stringify({
        generation: g, bestReward, maxCheckpoint: rec.maxCp,
        finishFrames: rec.finish, finishSeconds: rec.finish !== null ? rec.finish / 1000 : null,
        frames: rec.actions.length, actions: rec.actions,
      }));
      if (rec.finish !== null) console.log(`  *** FINISH ${(rec.finish / 1000).toFixed(3)}s -> data/es_lap.json`);
    }
  }
  console.log('done. best reward', bestReward.toFixed(0));
  for (const w of workers) w.terminate();
})().catch((e) => { console.error(e); process.exit(1); });
