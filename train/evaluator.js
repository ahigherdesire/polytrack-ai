// Shared lap-evaluation logic for the ES trainers (single + parallel).
const fs = require('fs');
const path = require('path');
const { observe } = require('../sim/observe');
const { gridToWorld } = require('../sim/geom');
const { buildOccupancy, onTrack } = require('../sim/track_sensors');
const { Policy } = require('./policy');

const DATA = path.resolve(__dirname, '..', 'data');

// ============================================================================
//  REWARD KNOBS — tune these to change what the AI optimizes, then restart
//  training. (See instructions.md "Change the reward".)
// ============================================================================
const REWARD = {
  perCheckpoint: 3000,   // reward for each checkpoint passed. Higher = care more
                         //   about reaching checkpoints than anything else.
  distanceWeight: 2,     // penalty per world-unit of distance to the next
                         //   checkpoint. Higher = stronger pull toward the goal.
  perGuidePoint: 450,    // optional guide-waypoint reward from data/guide.<track>.json.
  guideDistanceWeight: 1.5, // optional distance pull toward the active guide point.
  finishBonus: 5e6,      // one-time reward for completing the lap (must dwarf the
                         //   checkpoint terms so finishing always wins).
  finishTimeWeight: 50,  // subtract this * finishFrames. Raise it to reward a
                         //   FASTER lap more aggressively (key for record times).
  stuckFrames: 700,      // end the run after this many frames of no progress while
                         //   nearly stopped (saves time on dead policies).
  stuckSpeed: 8,         // "nearly stopped" threshold, km/h.
  offTrackPenalty: 20000, // penalty when the car leaves the driveable mesh / hits
                          //   a wall shortcut area.
  offTrackGraceFrames: 25, // allow tiny sensor/mesh mismatches before ending.
  airborneGraceFrames: 1200, // allow jumps/flights before treating them as lost.
};
// ============================================================================

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const FINISH_TYPES = new Set([6, 74, 76, 78]);
const NEUTRAL_ACTION = { up: false, down: false, left: false, right: false, reset: false };

function guideFileForTrack(trackPath) {
  const tag = path.basename(trackPath || process.env.TRACK || 'constants', '.json');
  return path.join(DATA, tag === 'constants' ? 'guide.json' : `guide.${tag}.json`);
}

function loadGuide(trackPath) {
  const file = guideFileForTrack(trackPath);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const points = Array.isArray(raw.points) ? raw.points
      .map((p) => ({
        x: Number(p.x),
        y: Number(p.y || 0),
        z: Number(p.z),
        nx: Number(p.nx),
        ny: Number(p.ny),
        nz: Number(p.nz),
      }))
      .map((p) => (Number.isFinite(p.nx) && Number.isFinite(p.ny) && Number.isFinite(p.nz)
        ? p
        : { x: p.x, y: p.y, z: p.z }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z)) : [];
    if (raw.enabled === false || !points.length) return null;
    const radius = Number.isFinite(Number(raw.radius)) ? Math.max(4, Number(raw.radius)) : 14;
    return { file, radius, points };
  } catch {
    return null;
  }
}

function setupTrack(sim, options = {}) {
  const cps = sim.checkpoints().map((c) => gridToWorld(c.grid));
  // Finish pieces are detectors, but PolyTrack does not assign them a
  // checkpointOrder. Without this final target, the policy aims back at the
  // start after the last checkpoint instead of driving to the finish line.
  for (const p of sim._parts || []) {
    if (FINISH_TYPES.has(p[3])) cps.push(gridToWorld({ x: p[0], y: p[1], z: p[2] }));
  }
  const start = sim.rollout([{ up: false }]).last.position;
  const occ = buildOccupancy(sim._parts, sim._trackPartConfigs, { baseY: start.y });
  const guide = loadGuide(options.track || process.env.TRACK);
  return { cps, start, occ, guide };
}

// Returns evaluate(weights, maxf, record) -> {reward, frames, maxCp, finish, actions?}
function makeEvaluate(sim, cps, start, occ, guide = null) {
  const policy = new Policy(observe.SIZE, 16, 4);
  const tgt = (i) => (i < cps.length ? cps[i] : start);
  const guidePoints = guide && Array.isArray(guide.points) ? guide.points : [];
  const guideRadius = guide ? guide.radius : 0;

  function guideTarget(state, guideIdx) {
    if (guideIdx < guidePoints.length) return guidePoints[guideIdx];
    return tgt(state.nextCheckpointIndex);
  }

  function guideNextTarget(state, guideIdx) {
    if (guideIdx + 1 < guidePoints.length) return guidePoints[guideIdx + 1];
    return tgt(state.nextCheckpointIndex);
  }

  return function evaluate(weights, maxf, record = false) {
    policy.setWeights(weights);
    sim.reset();
    let maxCp = 0, last = null, finish = null, stuckFor = 0, prevProg = Infinity, offTrackFor = 0, airborneFor = 0, offTrack = false;
    let guideIdx = 0, maxGuide = 0;
    const actions = record ? [] : null;
    for (let f = 0; f < maxf; f++) {
      let s0 = last;
      if (!s0) {
        s0 = sim.step(NEUTRAL_ACTION);
        if (record) actions.push(NEUTRAL_ACTION);
      }
      const idx = s0.nextCheckpointIndex;
      while (guideIdx < guidePoints.length && d3(s0.position, guidePoints[guideIdx]) <= guideRadius) {
        guideIdx++;
        if (guideIdx > maxGuide) maxGuide = guideIdx;
      }
      const targetA = guidePoints.length ? guideTarget(s0, guideIdx) : tgt(idx);
      const targetB = guidePoints.length ? guideNextTarget(s0, guideIdx) : tgt(idx + 1);
      const a = policy.act(observe(s0, [targetA, targetB], occ));
      const s = sim.step(a);
      if (record) actions.push(a);
      if (!s) break;
      last = s;
      if (s.nextCheckpointIndex > maxCp) { maxCp = s.nextCheckpointIndex; stuckFor = 0; }
      const contactCount = Array.isArray(s.wheelContact) ? s.wheelContact.filter(Boolean).length : 4;
      const grounded = contactCount >= 2;
      if (grounded) {
        airborneFor = 0;
        if (onTrack(occ, s.position.x, s.position.z, s.position.y)) {
          offTrackFor = 0;
        } else if (++offTrackFor > REWARD.offTrackGraceFrames) {
          offTrack = true;
          break;
        }
      } else {
        offTrackFor = 0;
        if (++airborneFor > REWARD.airborneGraceFrames) {
          offTrack = true;
          break;
        }
      }
      while (guideIdx < guidePoints.length && d3(s.position, guidePoints[guideIdx]) <= guideRadius) {
        guideIdx++;
        if (guideIdx > maxGuide) maxGuide = guideIdx;
      }
      const prog = d3(s.position, tgt(s.nextCheckpointIndex));
      if (prog < prevProg - 0.5) { prevProg = prog; stuckFor = 0; } else stuckFor++;
      if (s.finishFrames !== null) { finish = s.finishFrames; break; }
      if (stuckFor > REWARD.stuckFrames && Math.abs(s.speedKmh) < REWARD.stuckSpeed) break;
    }
    const distEnd = last ? d3(last.position, tgt(last.nextCheckpointIndex)) : 1e4;
    const guideDistEnd = guidePoints.length && last && guideIdx < guidePoints.length
      ? d3(last.position, guidePoints[guideIdx])
      : 0;
    const reward = maxCp * REWARD.perCheckpoint
      - distEnd * REWARD.distanceWeight
      + maxGuide * REWARD.perGuidePoint
      - guideDistEnd * REWARD.guideDistanceWeight
      - (offTrack ? REWARD.offTrackPenalty : 0)
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
