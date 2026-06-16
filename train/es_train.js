// Train a driving policy with Evolution Strategies (OpenAI-ES, antithetic +
// rank-normalized). Optimizes full-lap outcome, so the policy learns to brake
// into corners on its own. All in Node, on the headless 0.6.2 sim.
//
// Usage: node train/es_train.js [generations] [pop] [maxFrames]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { observe } = require('../sim/observe');
const { gridToWorld } = require('../sim/geom');
const { Policy } = require('./policy');

const GENS = parseInt(process.argv[2] || '40', 10);
const POP = parseInt(process.argv[3] || '48', 10);        // even (antithetic pairs)
const MAXF = parseInt(process.argv[4] || '14000', 10);
const SIGMA = 0.12, LR = 0.06;
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

(async () => {
  const payload = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'constants.json'), 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init, payload.createCar);
  const cps = sim.checkpoints().map((c) => gridToWorld(c.grid));
  const start = sim.rollout([{ up: false }]).last.position;
  const tgt = (i) => (i < cps.length ? cps[i] : start);

  const policy = new Policy(observe.SIZE, 16, 4);

  // Evaluate a weight vector: simulate a lap, return {reward, frames, maxCp, finish, actions?}
  function evaluate(weights, record = false) {
    policy.setWeights(weights);
    sim.reset();
    let maxCp = 0, last = null, finish = null, stuckFor = 0, prevProg = Infinity;
    const actions = record ? [] : null;
    for (let f = 0; f < MAXF; f++) {
      const s0 = last || sim.step({ up: false });        // bootstrap first obs
      const idx = s0.nextCheckpointIndex;
      const obs = observe(s0, [tgt(idx), tgt(idx + 1)]);
      const a = policy.act(obs);
      const s = sim.step(a);
      if (record) actions.push(a);
      if (!s) break;
      last = s;
      if (s.nextCheckpointIndex > maxCp) { maxCp = s.nextCheckpointIndex; stuckFor = 0; }
      // progress = distance to next checkpoint; early-stop if wedged
      const prog = d3(s.position, tgt(s.nextCheckpointIndex));
      if (prog < prevProg - 0.5) { prevProg = prog; stuckFor = 0; } else stuckFor++;
      if (s.finishFrames !== null) { finish = s.finishFrames; break; }
      if (stuckFor > 700 && Math.abs(s.speedKmh) < 8) break;   // stuck -> end episode
    }
    const distEnd = last ? d3(last.position, tgt(last.nextCheckpointIndex)) : 1e4;
    const reward = maxCp * 3000 - distEnd + (finish !== null ? 2e6 - finish : 0);
    return { reward, frames: last ? last.frames : 0, maxCp, finish, actions };
  }

  // Init weights small.
  let theta = new Float64Array(policy.n);
  for (let i = 0; i < theta.length; i++) theta[i] = (Math.random() * 2 - 1) * 0.1;

  let bestReward = -Infinity, bestTheta = theta.slice();
  const half = POP >> 1;
  const t0 = Date.now();

  for (let g = 0; g < GENS; g++) {
    const eps = [], rewards = new Float64Array(POP);
    let bestCpThisGen = 0, bestFinish = null;
    for (let i = 0; i < half; i++) {
      const e = new Float64Array(theta.length);
      for (let k = 0; k < e.length; k++) e[k] = gaussian();
      eps.push(e);
    }
    for (let i = 0; i < POP; i++) {
      const e = eps[i % half], sign = i < half ? 1 : -1;
      const cand = new Float64Array(theta.length);
      for (let k = 0; k < cand.length; k++) cand[k] = theta[k] + sign * SIGMA * e[k];
      const r = evaluate(cand);
      rewards[i] = r.reward;
      if (r.maxCp > bestCpThisGen) bestCpThisGen = r.maxCp;
      if (r.finish !== null && (bestFinish === null || r.finish < bestFinish)) bestFinish = r.finish;
      if (r.reward > bestReward) { bestReward = r.reward; bestTheta = cand.slice(); }
    }

    // Rank-normalize rewards to [-0.5, 0.5] (robust to scale/outliers).
    const order = [...rewards.keys()].sort((a, b) => rewards[a] - rewards[b]);
    const ranks = new Float64Array(POP);
    order.forEach((idx, rank) => { ranks[idx] = rank / (POP - 1) - 0.5; });

    // ES update: theta += LR/(POP*SIGMA) * sum_i rank_i * eps_i  (antithetic)
    const step = new Float64Array(theta.length);
    for (let i = 0; i < POP; i++) {
      const e = eps[i % half], sign = i < half ? 1 : -1, w = ranks[i];
      for (let k = 0; k < step.length; k++) step[k] += w * sign * e[k];
    }
    const scale = LR / (POP * SIGMA);
    for (let k = 0; k < theta.length; k++) theta[k] += scale * step[k];

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`gen ${String(g).padStart(3)}  bestCp=${bestCpThisGen}/${cps.length}  bestReward=${bestReward.toFixed(0)}  ${bestFinish !== null ? `FINISH=${(bestFinish / 1000).toFixed(3)}s` : ''}  (${secs}s)`);

    // Persist best policy + a finishing lap if we have one.
    if (g % 5 === 0 || g === GENS - 1) {
      fs.writeFileSync(path.resolve(__dirname, '..', 'data', 'policy.json'), JSON.stringify({ nIn: policy.nIn, nH: policy.nH, nOut: policy.nOut, weights: Array.from(bestTheta) }));
    }
  }

  // Final: record the best policy's lap.
  const r = evaluate(bestTheta, true);
  console.log(`\nbest policy: maxCp=${r.maxCp}/${cps.length} finish=${r.finish}`);
  if (r.finish !== null) {
    fs.writeFileSync(path.resolve(__dirname, '..', 'data', 'es_lap.json'), JSON.stringify({ finishFrames: r.finish, actions: r.actions }));
    console.log('saved finishing lap -> data/es_lap.json');
  }
})().catch((e) => { console.error(e); process.exit(1); });

let _spare = null;
function gaussian() {                 // Box-Muller
  if (_spare !== null) { const s = _spare; _spare = null; return s; }
  let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random();
  const m = Math.sqrt(-2 * Math.log(u)); _spare = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v);
}
