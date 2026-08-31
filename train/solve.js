// Search-based lap solver (MCTS) — the replacement for the stalled ES trainer.
//
//   node train/solve.js [budgetSeconds] [simsPerWindow]
//   TRACK=tracks/haoyuone.json node train/solve.js 900
//
// Builds the geodesic guidance field for the track, runs windowed MCTS over the
// real physics, and writes the finishing lap to data/es_lap[.<track>].json in
// the SAME format the recording bridge already consumes — so verify / play /
// submit work unchanged.
'use strict';
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { buildOccupancy } = require('../sim/track_sensors');
const { Guidance } = require('./guidance');
const { WindowedMcts } = require('./mcts_solver');

const DATA = path.resolve(__dirname, '..', 'data');
const CONSTANTS = process.env.TRACK ? path.resolve(process.env.TRACK) : path.join(DATA, 'constants.json');
const TAG = path.basename(CONSTANTS, '.json');
const LAP_FILE = path.join(DATA, TAG === 'constants' ? 'es_lap.json' : `es_lap.${TAG}.json`);

const BUDGET_S = parseFloat(process.argv[2] || '600');
const SIMS = parseInt(process.argv[3] || '220', 10);

(async () => {
  const payload = JSON.parse(fs.readFileSync(CONSTANTS, 'utf8'));
  const init = payload.init || payload;
  const createCar = payload.createCar;
  if (!createCar) throw new Error(`${path.basename(CONSTANTS)} has no createCar payload — capture the track first`);

  console.log(`solving ${path.basename(CONSTANTS)}  (budget ${BUDGET_S}s, sims/window ${SIMS})`);
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(init, createCar);

  const occ = buildOccupancy(sim._parts, sim._trackPartConfigs);
  const t0 = Date.now();
  const g = new Guidance(sim._parts, sim._trackPartConfigs, occ);
  g.buildPotentials();
  if (!g.ready()) throw new Error('guidance field is empty — no drivable cells or waypoints found');
  console.log(`guidance: ${g.cells.length} cells, ${g.checkpointCount} checkpoints, ${g.finishes.length} finish (${Date.now() - t0}ms)`);

  const mcts = new WindowedMcts(sim, g, {
    simsPerWindow: SIMS,
    wallBudgetMs: BUDGET_S * 1000,
    maxRunMs: 120000,
    log: (m) => console.log(m),
  });
  const res = mcts.optimize();

  const maxCp = g.checkpointCount + (g.finishes.length ? 1 : 0);
  const out = {
    generation: 0,
    kind: res.finishFrames != null ? 'fastestFinish' : 'bestRewardFallback',
    solver: 'mcts',
    bestReward: null,
    maxCheckpoint: maxCp,
    finishFrames: res.finishFrames,
    finishSeconds: res.finishSeconds,
    frames: res.actions.length,
    actions: res.actions,
  };
  fs.writeFileSync(LAP_FILE, JSON.stringify(out));
  if (res.finishFrames != null) {
    console.log(`\n*** FINISH ${res.finishSeconds.toFixed(3)}s (${res.actions.length} frames) -> data/${path.basename(LAP_FILE)}`);
  } else {
    console.log(`\nno finish within budget — wrote best partial (${res.actions.length} frames) -> data/${path.basename(LAP_FILE)}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
