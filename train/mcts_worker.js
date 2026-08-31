// Root-parallel MCTS worker. Owns a full Headless062 sim + geodesic Guidance +
// WindowedMcts. Every worker searches the same window with a different seed;
// the driver merges their visit tries, picks the consensus lock, and tells all
// workers to advance identically. Engine determinism keeps their states in
// lockstep.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { Headless062 } = require('../sim/headless062');
const { buildOccupancy } = require('../sim/track_sensors');
const { Guidance } = require('./guidance');
const { WindowedMcts } = require('./mcts_solver');

let sim = null, guidance = null, mcts = null;

async function handle(msg) {
  const { cmd, args } = msg;
  switch (cmd) {
    case 'init': {
      const payload = JSON.parse(fs.readFileSync(args.constants, 'utf8'));
      const init = payload.init || payload;
      sim = await new Headless062().init();
      await sim.waitReady();
      sim.loadCar(init, payload.createCar);
      // Driver initializes workers sequentially, so the bundle has a quiet event
      // loop to finish its async init before we reach here. Give one more settle
      // + retry as a safety net for a slow host.
      for (let tries = 0; (!sim._parts || sim._parts.length === 0) && tries < 20; tries++) {
        await sim.waitReady(400);
        sim.loadCar(init, payload.createCar);
      }
      if (!sim._parts || !sim._parts.length) throw new Error('sim did not become ready');
      const occ = buildOccupancy(sim._parts, sim._trackPartConfigs);
      guidance = new Guidance(sim._parts, sim._trackPartConfigs, occ);
      guidance.buildPotentials();
      return {
        ok: true,
        cells: guidance.cells.length,
        checkpoints: guidance.checkpointCount,
        finishes: guidance.finishes.length,
        ready: guidance.ready(),
      };
    }
    case 'mctsInit': {
      mcts = new WindowedMcts(sim, guidance, { ...args.opts, seed: args.seed });
      mcts.initRun();
      return { ok: true };
    }
    case 'greedySeed': {
      return mcts.greedyBlocks(args.maxFrames);
    }
    case 'mctsSeed': {
      return mcts.seedLocked(args.blocks);
    }
    case 'mctsSearch': {
      mcts.searchWindow(args.sims);
      return { trie: mcts.exportTrie(args.trieDepth), bestFinish: mcts.bestFinish };
    }
    case 'mctsAdvance': {
      const adv = mcts.advance(args.lockedNow);
      return { gain: adv.gain, lockedMs: adv.lockedMs, st: adv.st, finished: adv.finished };
    }
    case 'mctsRewind': {
      const len = mcts.rewindTo(args.toLockedLen);
      mcts.reseed(args.seed);
      return { lockedLen: len };
    }
    default:
      throw new Error('unknown cmd ' + cmd);
  }
}

parentPort.on('message', (msg) => {
  handle(msg)
    .then((result) => parentPort.postMessage({ id: msg.id, result }))
    .catch((err) => parentPort.postMessage({ id: msg.id, error: String((err && err.stack) || err) }));
});
