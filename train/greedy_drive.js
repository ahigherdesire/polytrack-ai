// Greedy guidance driver: drive the car open-loop using ONLY the MCTS rollout
// steering policy (_steerMask over the geodesic field). Tests whether the
// guidance alone can complete a lap — a baseline finish for the optimizer.
//   node train/greedy_drive.js
'use strict';
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { buildOccupancy } = require('../sim/track_sensors');
const { Guidance } = require('./guidance');
const { WindowedMcts } = require('./mcts_solver');

(async () => {
  const file = process.env.TRACK ? path.resolve(process.env.TRACK) : path.resolve(__dirname, '..', 'data', 'constants.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const init = payload.init || payload;
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(init, payload.createCar);
  const occ = buildOccupancy(sim._parts, sim._trackPartConfigs);
  const g = new Guidance(sim._parts, sim._trackPartConfigs, occ);
  g.buildPotentials();
  console.log('cells', g.cells.length, 'cps', g.checkpointCount, 'finishes', g.finishes.length);

  const mcts = new WindowedMcts(sim, g, {});
  sim.reset();
  let s = sim.stepMask(0);
  let px = s.position.x, pz = s.position.z;
  let maxCp = 0, maxPot = null, lastReport = 0;
  const masks = [];
  const MAXF = 60000;
  for (let f = 0; f < MAXF; f++) {
    const st = mcts._flat(s);
    const mask = mcts._steerMask(st, px, pz);
    masks.push(mask);
    px = s.position.x; pz = s.position.z;
    s = sim.stepMask(mask);
    if (!s) { console.log('sim returned null at frame', f); break; }
    if (s.nextCheckpointIndex > maxCp) { maxCp = s.nextCheckpointIndex; console.log(`  reached cp ${maxCp} at frame ${f} (${(f/1000).toFixed(2)}s) speed=${s.speedKmh.toFixed(0)}`); }
    if (f - lastReport >= 2000) {
      lastReport = f;
      const pot = g.potential(s.position.x, s.position.y, s.position.z, s.nextCheckpointIndex);
      console.log(`f=${f} cp=${s.nextCheckpointIndex} pot=${pot.toFixed(0)} speed=${s.speedKmh.toFixed(0)} pos=(${s.position.x.toFixed(0)},${s.position.z.toFixed(0)})`);
    }
    if (s.finishFrames !== null) { console.log(`\n*** FINISHED at frame ${s.finishFrames} = ${(s.finishFrames/1000).toFixed(3)}s, maxCp=${s.nextCheckpointIndex}`); process.exit(0); }
  }
  console.log(`\nno finish in ${MAXF} frames. maxCp=${maxCp}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
