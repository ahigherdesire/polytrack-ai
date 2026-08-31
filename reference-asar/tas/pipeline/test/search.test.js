);
// Search-layer tests: guidance geometry (rotation quats verified against the
// worker bundle), potential field sanity, RRT mechanics, MCTS mechanics.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const paths = require("../src/paths");
const { HeadlessSim } = require("../src/engine/sim");
const { Guidance, ROTATION_QUATS, extractRotationQuatsFromWorker, rotateVec } = require("../src/search/guidance");
const { Rrt, mulberry32 } = require("../src/search/rrt");
const { WindowedMcts, mergeTries } = require("../src/search/mcts");

let sim, g;
test.before(async () => {
  sim = await HeadlessSim.create();
  sim.loadTrack(fs.readFileSync(path.join(paths.TRACKS_DIR, "official", "summer1.track"), "utf8"));
  sim.spawnCar();
  g = new Guidance(sim);
  g.buildPotentials();
});

test("hardcoded rotation quaternions match the worker bundle", () => {
  const extracted = extractRotationQuatsFromWorker();
  assert.deepStrictEqual(ROTATION_QUATS, extracted);
});

test("rotateVec matches quarter-turn expectations", () => {
  // axis Y+, rotation 1 should rotate xz by 90 degrees
  const q = ROTATION_QUATS[0][1];
  const v = rotateVec(q, [1, 0, 0]);
  assert.ok(Math.abs(v[1]) < 1e-9);
  assert.ok(Math.abs(Math.hypot(v[0], v[2]) - 1) < 1e-9);
  // identity
  const i = rotateVec(ROTATION_QUATS[0][0], [1, 2, 3]);
  assert.deepStrictEqual(i, [1, 2, 3]);
});

test("guidance finds ordered checkpoints and a finish on summer1", () => {
  assert.strictEqual(g.checkpoints.length, 3);
  assert.deepStrictEqual(g.checkpoints.map((c) => c.order), [0, 1, 2]);
  assert.ok(g.finishes.length >= 1);
  assert.ok(g.cells.length > 1000);
});

test("potential decreases along a driven path and hits ~0 at the finish box", () => {
  const s = g.start.position;
  const p0 = g.potential(s.x, s.y, s.z, 0);
  assert.ok(p0 > 100, "start potential too small: " + p0);
  // driving forward must reduce potential roughly like distance travelled
  sim.resetCar();
  let prev = p0;
  let drops = 0, rises = 0;
  for (let f = 0; f < 3000; f++) {
    const st = sim.stepMask(1);
    if (f % 500 === 499) {
      const p = g.potential(st.x, st.y, st.z, st.nextCheckpointIndex);
      if (p < prev - 0.5) drops++;
      else rises++;
      prev = p;
    }
  }
  assert.ok(drops >= 4, "potential should mostly drop while driving forward (drops=" + drops + ")");
  // finish box potential at final waypoint index ~ 0
  const fin = g.finishes[0];
  const pf = g.potential(fin.center[0], fin.center[1] - fin.half[1], fin.center[2], g.checkpoints.length);
  assert.ok(pf < 15, "finish potential should be ~0, got " + pf);
});

test("mulberry32 is deterministic", () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 100; i++) assert.strictEqual(a(), b());
});

test("RRT expands, tracks progress, extracts a replayable script", () => {
  const rrt = new Rrt(sim, g, { maxIterations: 120, timeBudgetMs: 30000, seed: 7 });
  const res = rrt.run();
  assert.ok(rrt.count > 20, "tree too small: " + rrt.count);
  assert.ok(res.entries.length > 1);
  // The extracted entries must REPLAY to the recorded best-progress state.
  const bestNode = rrt.bestProgress.node;
  const entries = rrt.extractEntries(bestNode);
  const { entriesToChannels } = require("../src/engine/recording");
  const channels = entriesToChannels(entries);
  sim.resetCar();
  const st = sim.runChannels(channels, rrt.frames[bestNode]);
  assert.ok(Math.abs(st.x - rrt.x[bestNode]) < 1e-6, "replay x mismatch");
  assert.ok(Math.abs(st.z - rrt.z[bestNode]) < 1e-6, "replay z mismatch");
  assert.strictEqual(st.nextCheckpointIndex, rrt.cp[bestNode]);
});

test("MCTS locks confident prefixes and advances deterministically", () => {
  const m = new WindowedMcts(sim, g, { simsPerWindow: 120, windowMs: 300, lockMs: 60, rolloutMs: 200, seed: 5 });
  m.initRun();
  m.searchWindow(120);
  const trie = m.exportTrie(6);
  assert.ok(trie.n >= 120, "root visits " + trie.n);
  const locked = WindowedMcts.chooseLock(trie, 6, 10);
  assert.ok(locked.length >= 1 && locked.length <= 6);
  const adv1 = m.advance(locked);
  assert.strictEqual(m.locked.length, locked.length);
  assert.ok(Number.isFinite(adv1.gain));

  // Two MCTS instances with identical seeds/locks stay in lockstep (the
  // root-parallel invariant).
  const m2 = new WindowedMcts(sim, g, { simsPerWindow: 120, windowMs: 300, lockMs: 60, rolloutMs: 200, seed: 5 });
  m2.initRun();
  m2.searchWindow(120);
  const adv2 = m2.advance(locked);
  assert.strictEqual(adv2.st.x, adv1.st.x);
  assert.strictEqual(adv2.st.z, adv1.st.z);
  assert.strictEqual(adv2.st.frames, adv1.st.frames);
});

test("mergeTries sums visits recursively", () => {
  const a = { n: 10, w: 1, k: { 1: { n: 6, w: 0.5, k: {} }, 3: { n: 4, w: 0.2, k: {} } } };
  const b = { n: 8, w: 2, k: { 1: { n: 8, w: 1.5, k: { 2: { n: 3, w: 1, k: {} } } } } };
  const m = mergeTries([a, b]);
  assert.strictEqual(m.n, 18);
  assert.strictEqual(m.k[1].n, 14);
  assert.strictEqual(m.k[1].k[2].n, 3);
  assert.strictEqual(m.k[3].n, 4);
}