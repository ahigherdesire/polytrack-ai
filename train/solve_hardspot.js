// Critical experiment: can windowed MCTS clear the cp1->cp2 ramp that the
// greedy guidance driver stalls on? Seed the locked prefix with a greedy
// approach (car arrives at the ramp carrying speed), then search from there.
'use strict';
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { buildOccupancy } = require('../sim/track_sensors');
const { Guidance } = require('./guidance');
const { WindowedMcts, MCTS_DEFAULTS } = require('./mcts_solver');

const SEED_FRAMES = parseInt(process.env.SEED_FRAMES || '6500', 10);
const BUDGET_S = parseFloat(process.argv[2] || '240');
const SIMS = parseInt(process.argv[3] || '400', 10);

(async () => {
  const file = path.resolve(__dirname, '..', 'data', 'constants.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init || payload, payload.createCar);
  const occ = buildOccupancy(sim._parts, sim._trackPartConfigs);
  const g = new Guidance(sim._parts, sim._trackPartConfigs, occ);
  g.buildPotentials();

  const DEC = 20;
  const opts = { ...MCTS_DEFAULTS, decimationMs: DEC, windowMs: 400, lockMs: 160, rolloutMs: 300, rolloutDecisionMs: 40,
    pwExponent: 0.45, ucbC: 0.65, minVisitFrac: 0.012, simsPerWindow: SIMS, maxRunMs: 120000,
    wallBudgetMs: BUDGET_S * 1000,
    log: (m) => console.log(m),
  };
  const mcts = new WindowedMcts(sim, g, opts);
  mcts.initRun();

  // --- build greedy seed prefix as decimated mask blocks ---
  sim.reset();
  let s = sim.stepMask(0);
  let px = s.position.x, pz = s.position.z;
  const seedBlocks = [];
  for (let f = 0; f < SEED_FRAMES; f += DEC) {
    // choose one mask per block from steer policy, hold for DEC frames
    const st = mcts._flat(s);
    const mask = mcts._steerMask(st, px, pz);
    px = s.position.x; pz = s.position.z;
    for (let k = 0; k < DEC; k++) { s = sim.stepMask(mask); if (!s) break; }
    seedBlocks.push(mask);
    if (!s) break;
  }
  const seedSt = mcts._flat(s);
  console.log(`seeded ${seedBlocks.length} blocks (${(seedBlocks.length*DEC/1000).toFixed(2)}s), arrive cp=${seedSt.nextCheckpointIndex} speed=${seedSt.speedKmh.toFixed(0)} pos=(${seedSt.x.toFixed(0)},${seedSt.z.toFixed(0)})`);

  // inject as locked prefix
  mcts.locked = seedBlocks.slice();
  mcts.rewindTo(seedBlocks.length);
  console.log(`root after seed: cp=${mcts._rootState.nextCheckpointIndex} prog=${mcts.rootProgress.toFixed(0)}`);

  // --- search forward from the ramp ---
  const t0 = Date.now();
  let maxCp = mcts._rootState.nextCheckpointIndex;
  for (let window = 0; ; window++) {
    mcts.searchWindow(opts.simsPerWindow);
    const trie = mcts.exportTrie(Math.round(opts.lockMs/DEC));
    const minV = Math.max(12, Math.round(opts.simsPerWindow*opts.minVisitFrac));
    const lockedNow = WindowedMcts.chooseLock(trie, Math.round(opts.lockMs/DEC), minV, opts.minLockBlocks);
    const adv = mcts.advance(lockedNow);
    if (adv.st.nextCheckpointIndex > maxCp) { maxCp = adv.st.nextCheckpointIndex; console.log(`  *** advanced to cp ${maxCp} at locked=${(mcts.locked.length*DEC/1000).toFixed(2)}s speed=${adv.st.speedKmh.toFixed(0)}`); }
    if (window % 5 === 0) console.log(`w${window} t=${((Date.now()-t0)/1000).toFixed(0)}s locked=${(mcts.locked.length*DEC/1000).toFixed(2)}s cp=${adv.st.nextCheckpointIndex} speed=${adv.st.speedKmh.toFixed(0)} prog=${mcts.rootProgress.toFixed(0)}` + (mcts.bestFinish?` FIN=${(mcts.bestFinish.frames/1000).toFixed(3)}`:''));
    if (adv.finished) { console.log(`\n*** FINISHED ${(adv.st.finishFrames/1000).toFixed(3)}s`); break; }
    if (Date.now()-t0 > BUDGET_S*1000) { console.log(`\nbudget reached. maxCp=${maxCp} bestFinish=${mcts.bestFinish?(mcts.bestFinish.frames/1000).toFixed(3):'none'}`); break; }
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
