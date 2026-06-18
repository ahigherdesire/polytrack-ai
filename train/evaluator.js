// Shared lap-evaluation logic for the ES trainers (single + parallel).
const { observe } = require('../sim/observe');
const { gridToWorld } = require('../sim/geom');
const { buildOccupancy } = require('../sim/track_sensors');
const { Policy } = require('./policy');

// ============================================================================
//  REWARD KNOBS — tune these to change what the AI optimizes, then restart
//  training. (See instructions.md "Change the reward".)
// ============================================================================
const REWARD = {
  perCheckpoint: 3000,   // reward for each checkpoint passed. Higher = care more
                         //   about reaching checkpoints than anything else.
  distanceWeight: 1,     // penalty per world-unit of distance to the next
                         //   checkpoint. Higher = stronger pull toward the goal.
  finishBonus: 2e6,      // one-time reward for completing the lap (must dwarf the
                         //   checkpoint terms so finishing always wins).
  finishTimeWeight: 5,   // subtract this * finishFrames. Raise it to reward a
                         //   FASTER lap more aggressively (key for record times).
  stuckFrames: 700,      // end the run after this many frames of no progress while
                         //   nearly stopped (saves time on dead policies).
  stuckSpeed: 8,         // "nearly stopped" threshold, km/h.
};
// ============================================================================

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const FINISH_TYPES = new Set([6, 74, 76, 78]);

function setupTrack(sim) {
  const cps = sim.checkpoints().map((c) => gridToWorld(c.grid));
  // Finish pieces are detectors, but PolyTrack does not assign them a
  // checkpointOrder. Without this final target, the policy aims back at the
  // start after the last checkpoint instead of driving to the finish line.
  for (const p of sim._parts || []) {
    if (FINISH_TYPES.has(p[3])) cps.push(gridToWorld({ x: p[0], y: p[1], z: p[2] }));
  }
  const start = sim.rollout([{ up: false }]).last.position;
  const occ = buildOccupancy(sim._parts);
  return { cps, start, occ };
}

// Returns evaluate(weights, maxf, record) -> {reward, frames, maxCp, finish, actions?}
function makeEvaluate(sim, cps, start, occ) {
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
      const a = policy.act(observe(s0, [tgt(idx), tgt(idx + 1)], occ));
      const s = sim.step(a);
      if (record) actions.push(a);
      if (!s) break;
      last = s;
      if (s.nextCheckpointIndex > maxCp) { maxCp = s.nextCheckpointIndex; stuckFor = 0; }
      const prog = d3(s.position, tgt(s.nextCheckpointIndex));
      if (prog < prevProg - 0.5) { prevProg = prog; stuckFor = 0; } else stuckFor++;
      if (s.finishFrames !== null) { finish = s.finishFrames; break; }
      if (stuckFor > REWARD.stuckFrames && Math.abs(s.speedKmh) < REWARD.stuckSpeed) break;
    }
    const distEnd = last ? d3(last.position, tgt(last.nextCheckpointIndex)) : 1e4;
    const reward = maxCp * REWARD.perCheckpoint
      - distEnd * REWARD.distanceWeight
      + (finish !== null ? REWARD.finishBonus - finish * REWARD.finishTimeWeight : 0);
    return { reward, frames: last ? last.frames : 0, maxCp, finish, actions };
  };
}

let _spare = null;
function gaussian() {
  if (_spare !== null) { const s = _spare; _spare = null; return s; }
  let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random();
  const m = Math.sqrt(-2 * Math.log(u)); _spare = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v);
}

module.exports = { setupTrack, makeEvaluate, gaussian, REWARD, POLICY_SHAPE: [observe.SIZE, 16, 4] };
