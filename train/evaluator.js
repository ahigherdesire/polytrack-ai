// Shared lap-evaluation logic for the ES trainers (single + parallel).
const { observe } = require('../sim/observe');
const { gridToWorld } = require('../sim/geom');
const { Policy } = require('./policy');

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function setupTrack(sim) {
  const cps = sim.checkpoints().map((c) => gridToWorld(c.grid));
  const start = sim.rollout([{ up: false }]).last.position;
  return { cps, start };
}

// Returns evaluate(weights, maxf, record) -> {reward, frames, maxCp, finish, actions?}
function makeEvaluate(sim, cps, start) {
  const policy = new Policy(observe.SIZE, 16, 4);
  const tgt = (i) => (i < cps.length ? cps[i] : start);

  return function evaluate(weights, maxf, record = false) {
    policy.setWeights(weights);
    sim.reset();
    let maxCp = 0, last = null, finish = null, stuckFor = 0, prevProg = Infinity;
    const actions = record ? [] : null;
    for (let f = 0; f < maxf; f++) {
      const s0 = last || sim.step({ up: false });
      const idx = s0.nextCheckpointIndex;
      const a = policy.act(observe(s0, [tgt(idx), tgt(idx + 1)]));
      const s = sim.step(a);
      if (record) actions.push(a);
      if (!s) break;
      last = s;
      if (s.nextCheckpointIndex > maxCp) { maxCp = s.nextCheckpointIndex; stuckFor = 0; }
      const prog = d3(s.position, tgt(s.nextCheckpointIndex));
      if (prog < prevProg - 0.5) { prevProg = prog; stuckFor = 0; } else stuckFor++;
      if (s.finishFrames !== null) { finish = s.finishFrames; break; }
      if (stuckFor > 700 && Math.abs(s.speedKmh) < 8) break;
    }
    const distEnd = last ? d3(last.position, tgt(last.nextCheckpointIndex)) : 1e4;
    const reward = maxCp * 3000 - distEnd + (finish !== null ? 2e6 - finish : 0);
    return { reward, frames: last ? last.frames : 0, maxCp, finish, actions };
  };
}

let _spare = null;
function gaussian() {
  if (_spare !== null) { const s = _spare; _spare = null; return s; }
  let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random();
  const m = Math.sqrt(-2 * Math.log(u)); _spare = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v);
}

module.exports = { setupTrack, makeEvaluate, gaussian, POLICY_SHAPE: [observe.SIZE, 16, 4] };
