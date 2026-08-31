};
// worker_threads host: each worker owns a full HeadlessSim (its own wasm
// instance), guidance and search objects, and serves coarse-grained jobs.
// Root-parallel MCTS relies on engine determinism: every worker advances
// with the same locked actions and their states stay bit-identical.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const { HeadlessSim } = require("../engine/sim");
const { Guidance } = require("./guidance");
const { WindowedMcts } = require("./mcts");
const { Rrt } = require("./rrt");
const { Polisher, entriesToMasks } = require("./polish");

let sim = null, guidance = null, mcts = null, polisher = null;
let polishBase = null; // { masks, splits, finishFrames, snaps }

async function handle(msg) {
  const { cmd, args } = msg;
  switch (cmd) {
    case "init": {
      sim = await HeadlessSim.create({ context: args.contextFile });
      sim.loadTrack(fs.readFileSync(args.trackFile, "utf8"));
      sim.spawnCar();
      guidance = new Guidance(sim);
      guidance.buildPotentials();
      return { ok: true };
    }
    case "mctsInit": {
      mcts = new WindowedMcts(sim, guidance, { ...args.opts, seed: args.seed });
      if (args.ghostEntries) mcts.buildGhost(args.ghostEntries);
      if (args.baseEntries) mcts.setBase(args.baseEntries);
      mcts.initRun();
      return { ok: true };
    }
    case "mctsSearch": {
      const winBest = mcts.searchWindow(args.sims);
      return {
        winBest,
        trie: mcts.exportTrie(args.trieDepth),
        bestFinish: mcts.bestFinish,
      };
    }
    case "mctsAdvance": {
      const adv = mcts.advance(args.lockedNow);
      return { gain: adv.gain, lockedMs: adv.lockedMs, st: adv.st, finished: adv.finished };
    }
    case "mctsRewind": {
      const len = mcts.rewindTo(args.toLockedLen);
      mcts.reseed(args.seed);
      return { lockedLen: len };
    }
    case "mctsTune": {
      Object.assign(mcts.o, args.opts);
      return { ok: true };
    }
    case "rrt": {
      const rrt = new Rrt(sim, guidance, args.opts);
      const res = rrt.run();
      return { finished: res.finished, finishFrames: res.finishFrames, entries: res.entries, bestProgress: res.bestProgress, nodes: rrt.count };
    }
    case "evalEntries": {
      const masks = entriesToMasks(args.entries, args.horizon);
      const p = new Polisher(sim, {});
      const r = p.evaluate(masks, args.horizon);
      return { finishFrames: r.finishFrames, splits: Array.from(r.splits), cp: r.cp };
    }
    case "polishBaseline": {
      polisher = new Polisher(sim, { ...args.opts, seed: args.seed });
      const masks = Uint8Array.from(Buffer.from(args.masksB64, "base64"));
      const snaps = [];
      const base = polisher.evaluate(masks, masks.length + 300, {
        collectSnapshots: { everyFrames: polisher.o.snapshotEveryMs, out: snaps },
      });
      if (base.finishFrames == null) return { ok: false, reason: "baseline does not finish" };
      polishBase = { masks, splits: base.splits, finishFrames: base.finishFrames, snaps };
      return { ok: true, finishFrames: base.finishFrames, splits: base.splits };
    }
    case "polishScan": {
      // Try mutants over the assigned windows; return the best improvement.
      const { windows, lambda } = args;
      const base = polishBase;
      let best = null;
      for (const winStart of windows) {
        const winEnd = Math.min(winStart + polisher.o.windowMs, base.finishFrames + 50);
        let startSnap = null;
        for (const s of base.snaps) {
          if (s.frame <= winStart && (!startSnap || s.frame > startSnap.frame)) startSnap = s;
        }
        for (let m = 0; m < lambda; m++) {
          const cand = polisher.mutate(base.masks, winStart, winEnd);
          const r = polisher.evaluate(cand, base.finishFrames + 300, {
            startSnap,
            baseSplits: base.splits,
          });
          if (r.rejected || r.finishFrames == null) continue;
          if (r.finishFrames < base.finishFrames && (!best || r.finishFrames < best.finishFrames)) {
            // encode the diff (window slice) instead of the whole array
            best = {
              finishFrames: r.finishFrames,
              winStart,
              winEnd,
              sliceB64: Buffer.from(cand.subarray(winStart, winEnd)).toString("base64"),
            };
          }
        }
      }
      return { best };
    }
    default:
      throw new Error("Unknown cmd " + cmd);
  }
}

parentPort.on("message", (msg) => {
  handle(msg)
    .then((result) => parentPort.postMessage({ id: msg.id, result }))
    .catch((err) => parentPort.postMessage({ id: msg.id, error: String(err && err.stack || err) }));
}