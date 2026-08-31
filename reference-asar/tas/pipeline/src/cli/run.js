);
// Autonomous TAS pipeline orchestrator.
//
//   node src/cli/run.js <track-file> [options]
//
// Phases:
//   1. headless engine (always)
//   2. Kinematic RRT ghost search  — parallel racing across workers
//   3. Windowed MCTS 10ms optimizer — ROOT-PARALLEL across workers
//   4. (1+λ) 1ms micro-polisher     — parallel proposal rounds
//   5. verification with the game's own Verify handler + artifact output
//
// Options:
//   --out <dir>          output directory (default runs/<track>/)
//   --workers <n>        worker count (default: cpus-1, max 12)
//   --rrt-budget <sec>   phase 2 wall budget (default 180; 0 = skip RRT)
//   --sims <n>           MCTS sims per worker per window (default 320)
//   --mcts-budget <sec>  phase 3 wall budget (default 1800)
//   --polish-rounds <n>  max phase 4 improvement rounds (default 200)
//   --polish-budget <sec> phase 4 wall budget (default 600)
//   --seed <n>           master seed
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const paths = require("../paths");
const { Pool } = require("../search/pool");
const { HeadlessSim } = require("../engine/sim");
const { Guidance } = require("../search/guidance");
const { WindowedMcts, mergeTries } = require("../search/mcts");
const { entriesToMasks, masksToEntries } = require("../search/polish");
const rec = require("../engine/recording");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const trackFile = args._[0];
  if (!trackFile || !fs.existsSync(trackFile)) {
    console.error("Usage: node src/cli/run.js <track-file> [--workers N] [--rrt-budget S] [--sims N] ...");
    process.exit(2);
  }
  const trackName = path.basename(trackFile).replace(/\.track$/, "");
  const outDir = args.out || path.join(paths.PIPELINE_ROOT, "runs", trackName);
  fs.mkdirSync(outDir, { recursive: true });

  const nWorkers = Math.min(Number(args.workers) || Math.max(2, os.cpus().length - 1), 14);
  const masterSeed = Number(args.seed) || 1337;
  const rrtBudget = args["rrt-budget"] != null ? Number(args["rrt-budget"]) : 180;
  const simsPerWorker = Number(args.sims) || 320;
  const mctsBudget = (Number(args["mcts-budget"]) || 1800) * 1000;
  const polishRounds = Number(args["polish-rounds"]) || 200;
  const polishBudget = (Number(args["polish-budget"]) || 600) * 1000;

  const log = (s) => console.log("[" + new Date().toISOString().slice(11, 19) + "] " + s);
  log("track=" + trackName + " workers=" + nWorkers + " out=" + outDir);

  // Local engine for verification + ghost prep.
  const local = await HeadlessSim.create();
  local.loadTrack(fs.readFileSync(trackFile, "utf8"));
  local.spawnCar();
  const guidance = new Guidance(local);
  guidance.buildPotentials();
  log("guidance: " + guidance.checkpoints.length + " checkpoints, " + guidance.finishes.length +
    " finish boxes, " + guidance.cells.length + " cells");

  const pool = new Pool(nWorkers);
  await pool.broadcast("init", { trackFile: path.resolve(trackFile), contextFile: paths.CONTEXT_FILE });
  log("pool of " + nWorkers + " engines ready");

  // ---------- Phase 2: RRT ghost (parallel racing, warm-started rounds) ----------
  let ghostEntries = null;
  let ghostFinish = null;
  let bestPartialEntries = null;
  if (rrtBudget > 0) {
    // Warm-started rounds: each round seeds its trees with the best partial
    // from the previous one, so progress compounds. Runs until a finisher,
    // stagnation, or the total budget is spent.
    const roundBudgetMs = Math.min(200, rrtBudget / 2) * 1000;
    const t2 = performance.now();
    let seedEntries = null;
    let prevBest = { cp: -1, dist: Infinity };
    let stagnant = 0;
    for (let round = 0; !ghostEntries && performance.now() - t2 < rrtBudget * 1000 && stagnant < 2; round++) {
      const budget = Math.min(roundBudgetMs, rrtBudget * 1000 - (performance.now() - t2));
      if (budget < 20000) break;
      log("phase 2: RRT round " + (round + 1) + " (" + Math.round(budget / 1000) + "s" +
        (seedEntries ? ", warm-started" : "") + ")...");
      const results = await pool.broadcast("rrt", (i) => ({
        opts: {
          seed: (masterSeed * 7919 + (round * 977 + i) * 104729) >>> 0,
          timeBudgetMs: budget,
          afterFinishIterations: 600,
          maxIterations: 1e9,
          snapCap: 36, // parallel engines — keep snapshot RAM in check
          seedEntries,
        },
      }));
      const finishers = results.filter((r) => r.finished);
      if (finishers.length) {
        finishers.sort((a, b) => a.finishFrames - b.finishFrames);
        ghostEntries = finishers[0].entries;
        ghostFinish = finishers[0].finishFrames;
        log("phase 2: " + finishers.length + "/" + nWorkers + " finished; best ghost " + ghostFinish + "ms");
        break;
      }
      const best = results.slice().sort((a, b) =>
        (b.bestProgress.cp - a.bestProgress.cp) || (a.bestProgress.dist - b.bestProgress.dist))[0];
      log("phase 2: round " + (round + 1) + " best cp=" + best.bestProgress.cp +
        " dist=" + best.bestProgress.dist.toFixed(1) + " — seeding next round");
      const improved = best.bestProgress.cp > prevBest.cp ||
        (best.bestProgress.cp === prevBest.cp && best.bestProgress.dist < prevBest.dist - 5);
      if (improved) stagnant = 0; else stagnant++;
      if (improved || !bestPartialEntries) {
        seedEntries = best.entries;
        bestPartialEntries = best.entries;
        prevBest = best.bestProgress;
      }
    }
    if (ghostEntries) {
      fs.writeFileSync(path.join(outDir, "phase2-ghost.json"), JSON.stringify({ finishFrames: ghostFinish, entries: ghostEntries }));
      fs.writeFileSync(path.join(outDir, "phase2-ghost.tas"), rec.entriesToScript(ghostEntries, "phase2 RRT ghost " + ghostFinish + "ms " + trackName));
    } else {
      log("phase 2: no finisher — MCTS will drive from the best partial");
    }
  } else {
    log("phase 2: skipped (--rrt-budget 0)");
  }

  // ---------- Phase 3: root-parallel windowed MCTS (two passes) ----------
  // Pass A scouts at 20 ms decimation (fast, coarse); pass B re-optimizes at
  // the spec's 10 ms decimation using pass A's run as ghost + base inputs.
  async function runMctsPass(label, mctsOpts, passGhost, passBase, budgetMs) {
    log(label + ": windowed MCTS dec=" + mctsOpts.decimationMs + "ms (sims/worker=" + simsPerWorker +
      ", total/window=" + simsPerWorker * nWorkers + ")...");
    await pool.broadcast("mctsInit", (i) => ({
      opts: mctsOpts,
      seed: (masterSeed * 31 + i * 15485863 + mctsOpts.decimationMs * 7) >>> 0,
      ghostEntries: passGhost,
      baseEntries: passBase,
    }));

    const dec = mctsOpts.decimationMs;
    const lockN = Math.round(mctsOpts.lockMs / dec);
    const minVisits = Math.max(16, Math.round(simsPerWorker * nWorkers * 0.02));
    let locked = [];
    let globalBestFinish = null; // {frames, masks}
    let gainEma = null, stuckCount = 0, rewinds = 0;
    let minLock = 3; // adaptive: grows on clean progress, shrinks on trouble
    let cleanStreak = 0; // consecutive windows tracking road speed
    let recovery = 0;    // windows left in widened-horizon recovery mode
    let lastStuckLen = null, rewindEscalation = 0, stuckPos = null;
    const t3 = performance.now();

    for (let window = 0; ; window++) {
      // Clean straights need far less search than corners; recovery mode
      // (after a rewind) searches harder.
      const simsNow = recovery > 0 ? simsPerWorker
        : cleanStreak >= 3 ? Math.max(60, Math.round(simsPerWorker * 0.4)) : simsPerWorker;
      const searches = await pool.broadcast("mctsSearch", { sims: simsNow, trieDepth: lockN + 2 });
      for (const s of searches) {
        if (s.bestFinish && (!globalBestFinish || s.bestFinish.frames < globalBestFinish.frames)) {
          globalBestFinish = { frames: s.bestFinish.frames, masks: s.bestFinish.locked.concat(s.bestFinish.tail) };
        }
      }
      const merged = mergeTries(searches.map((s) => s.trie));
      const lockedNow = WindowedMcts.chooseLock(merged, lockN, minVisits, minLock);
      const advs = await pool.broadcast("mctsAdvance", { lockedNow });
      locked.push(...lockedNow);
      const adv = advs[0];

      // Adaptive pacing: when locked progress tracks the car's actual
      // speed, lock deeper next window; when it lags, back off.
      {
        const lockSecNow = lockedNow.length * dec / 1000;
        const expect = (adv.st.speedKmh / 3.6) * lockSecNow;
        if (expect > 0.12) {
          const ratio = adv.gain / expect;
          if (ratio > 0.75) { minLock = Math.min(lockN, minLock + 2); cleanStreak++; }
          else if (ratio > 0.55) { minLock = Math.min(lockN, minLock + 1); cleanStreak = 0; }
          else if (ratio < 0.3) { minLock = Math.max(2, minLock - 2); cleanStreak = 0; }
          else cleanStreak = 0;
        } else if (adv.st.speedKmh < 15 && locked.length * dec < 1500) {
          minLock = Math.min(lockN, minLock + 1);
          cleanStreak = 0;
        } else cleanStreak = 0;
        if (recovery > 0) minLock = Math.min(Math.max(minLock, 3), 4); // cautious but not crawling
      }

      if (window % 10 === 0) {
        log(label + ": w" + window + " locked=" + (locked.length * dec) + "ms cp=" + adv.st.nextCheckpointIndex +
          " spd=" + adv.st.speedKmh.toFixed(0) + " gain=" + adv.gain.toFixed(2) + " lockPace=" + lockedNow.length +
          " pos(" + adv.st.x.toFixed(0) + "," + adv.st.y.toFixed(0) + "," + adv.st.z.toFixed(0) + ")" +
          (globalBestFinish ? " bestFin=" + globalBestFinish.frames : ""));
      }

      if (adv.finished) {
        return { finishFrames: adv.st.finishFrames, entries: masksBlocksToEntries(locked, dec) };
      }
      if (globalBestFinish && locked.length * dec > globalBestFinish.frames + 400) {
        return { finishFrames: globalBestFinish.frames, entries: masksBlocksToEntries(globalBestFinish.masks, dec) };
      }
      if (locked.length * dec > 240000 || performance.now() - t3 > budgetMs) {
        log(label + ": budget reached" + (globalBestFinish ? " (best finish " + globalBestFinish.frames + "ms)" : " (NO FINISH)"));
        if (globalBestFinish) {
          return { finishFrames: globalBestFinish.frames, entries: masksBlocksToEntries(globalBestFinish.masks, dec) };
        }
        return { finishFrames: null, entries: masksBlocksToEntries(locked, dec) };
      }

      gainEma = gainEma == null ? adv.gain : gainEma * 0.7 + adv.gain * 0.3;
      const pastLaunch = locked.length * dec > 1800;
      const lockSec = lockedNow.length * dec / 1000;
      if (pastLaunch && gainEma < 0.3 * lockSec / 0.15 && !adv.finished) stuckCount++;
      else stuckCount = 0;
      // Recovery mode ends after a stretch of real progress.
      // Recovery mode ends only once the run has locked PAST the original
      // stuck frontier and is physically clear of the trap position —
      // otherwise the narrow window just re-races into the same wall.
      if (recovery > 0 && adv.gain > 1.0 &&
        (lastStuckLen == null || locked.length > lastStuckLen + Math.round(600 / dec)) &&
        (!stuckPos || Math.hypot(adv.st.x - stuckPos[0], adv.st.z - stuckPos[1]) > 35)) {
        if (--recovery === 0) {
          await pool.broadcast("mctsTune", {
            opts: { windowMs: mctsOpts.windowMs, rolloutMs: mctsOpts.rolloutMs, ucbC: 0.7, speedWeight: 0.012 },
          });
          log(label + ": recovery over — normal window restored");
        }
      }
      const stuckTrigger = adv.st.speedKmh < 25 ? 5 : 8;
      if (stuckCount >= stuckTrigger && rewinds < 14) {
        // Escalating rewind: each consecutive rewind near the same spot goes
        // back twice as far (replay-based, arbitrary depth).
        if (lastStuckLen != null && Math.abs(locked.length - lastStuckLen) * dec < 2500) rewindEscalation++;
        else rewindEscalation = 0;
        lastStuckLen = locked.length;
        stuckPos = [adv.st.x, adv.st.z];
        const backMs = Math.min(10000, 1500 * Math.pow(2, rewindEscalation));
        const toLockedLen = Math.max(0, locked.length - Math.round(backMs / dec));
        log(label + ": STUCK at " + (locked.length * dec) + "ms pos(" + adv.st.x.toFixed(0) + "," +
          adv.st.y.toFixed(0) + "," + adv.st.z.toFixed(0) + ") — rewinding " + backMs + "ms (#" + (rewinds + 1) + "), widening window");
        const rw = await pool.broadcast("mctsRewind", (i) => ({
          toLockedLen,
          seed: (masterSeed ^ ((rewinds + 1) * 2654435761) ^ (i * 40503)) >>> 0,
        }));
        locked = locked.slice(0, rw[0].lockedLen);
        // Widen the horizon so the search can see braking points beyond the
        // trap; restored once the run is moving again.
        const tuneOpts = {
          windowMs: Math.round(mctsOpts.windowMs * 1.6),
          rolloutMs: Math.round(mctsOpts.rolloutMs * 1.7),
          ucbC: 1.1,
        };
        // Repeated trap at the same spot: stop rewarding raw speed so the
        // search stops greeding into the same wall.
        if (rewindEscalation >= 1) tuneOpts.speedWeight = 0.003;
        await pool.broadcast("mctsTune", { opts: tuneOpts });
        recovery = 4;
        gainEma = null; stuckCount = 0; rewinds++; minLock = 2; cleanStreak = 0;
      }
    }
  }

  // Without a finishing ghost, pass A carries the burden of route discovery
  // — give it most of the budget (pass B is a pure 10ms refinement).
  // NOTE: a PARTIAL RRT run must NOT be used as rollout base — base inputs
  // are indexed by absolute frame, and once the MCTS run is faster than the
  // partial they misalign and poison every rollout. Only a same-pace ghost
  // (a finishing run being refined) is safe to follow.
  const splitA = ghostEntries ? 0.45 : 0.8;
  const passA = await runMctsPass("phase 3a", {
    windowMs: 640, decimationMs: 20, lockMs: 200, rolloutMs: 600, rolloutDecisionMs: 60,
  }, ghostEntries, ghostEntries, mctsBudget * splitA);

  // A FINISHING RUN MUST NEVER BE LOST: if the optimizer's own pass ran out
  // of budget, fall back to the phase-2 ghost (a complete, driveable run)
  // rather than aborting with a partial.
  let baseRun = null; // {entries, finishFrames}
  if (passA.finishFrames != null) {
    baseRun = { entries: passA.entries, finishFrames: passA.finishFrames };
    log("phase 3a: finish " + passA.finishFrames + "ms — refining at 10ms");
  } else if (ghostFinish != null) {
    baseRun = { entries: ghostEntries, finishFrames: ghostFinish };
    log("phase 3a did not finish within budget — falling back to the phase 2 ghost (" + ghostFinish + "ms) and refining that");
  }

  let phase3Entries, phase3Finish;
  if (baseRun) {
    fs.writeFileSync(path.join(outDir, "phase3a.tas"), rec.entriesToScript(baseRun.entries, "phase3a base " + baseRun.finishFrames + "ms"));
    const passB = await runMctsPass("phase 3b", {
      windowMs: 450, decimationMs: 10, lockMs: 100, rolloutMs: 500, rolloutDecisionMs: 50,
    }, baseRun.entries, baseRun.entries, mctsBudget * (1 - splitA));
    if (passB.finishFrames != null && passB.finishFrames <= baseRun.finishFrames) {
      phase3Entries = passB.entries; phase3Finish = passB.finishFrames;
    } else {
      log("phase 3b did not improve (" + passB.finishFrames + ") — keeping the base run");
      phase3Entries = baseRun.entries; phase3Finish = baseRun.finishFrames;
    }
    // Last guard: never emit anything slower than a finisher we already hold.
    if (ghostFinish != null && (phase3Finish == null || ghostFinish < phase3Finish)) {
      log("ghost (" + ghostFinish + "ms) still beats phase 3 (" + phase3Finish + "ms) — keeping the ghost");
      phase3Entries = ghostEntries; phase3Finish = ghostFinish;
    }
  } else {
    phase3Entries = passA.entries; phase3Finish = null;
  }

  if (phase3Finish == null) {
    log("phase 3 did not finish the track — aborting (partial script written)");
    fs.writeFileSync(path.join(outDir, "phase3-partial.tas"), rec.entriesToScript(phase3Entries, "PARTIAL phase3 " + trackName));
    await pool.destroy();
    process.exit(1);
  }
  log("phase 3: finish " + phase3Finish + "ms" + (ghostFinish ? " (ghost was " + ghostFinish + "ms)" : ""));
  fs.writeFileSync(path.join(outDir, "phase3.json"), JSON.stringify({ finishFrames: phase3Finish, entries: phase3Entries }));
  fs.writeFileSync(path.join(outDir, "phase3.tas"), rec.entriesToScript(phase3Entries, "phase3 MCTS " + phase3Finish + "ms " + trackName));

  // ---------- Phase 4: parallel (1+λ) micro-polish ----------
  log("phase 4: 1ms micro-polish...");
  let masks = entriesToMasks(phase3Entries, phase3Finish + 400);
  let curFinish = phase3Finish;
  const t4 = performance.now();
  const windowStep = 50;
  let round = 0, dry = 0;
  while (round < polishRounds && performance.now() - t4 < polishBudget && dry < 2) {
    const b64 = Buffer.from(masks).toString("base64");
    const baselines = await pool.broadcast("polishBaseline", (i) => ({
      masksB64: b64,
      seed: (masterSeed * 131 + round * 65537 + i * 8191) >>> 0,
      opts: { windowMs: 100, lambda: 8 },
    }));
    if (!baselines[0].ok) throw new Error("polish baseline failed: " + baselines[0].reason);
    curFinish = baselines[0].finishFrames;

    // distribute windows round-robin
    const allWindows = [];
    for (let w = 0; w < curFinish; w += windowStep) allWindows.push(w);
    const scans = await pool.broadcast("polishScan", (i) => ({
      windows: allWindows.filter((_, k) => k % nWorkers === i),
      lambda: 8,
    }));
    const proposals = scans.map((s) => s.best).filter(Boolean).sort((a, b) => a.finishFrames - b.finishFrames);
    if (!proposals.length) { dry++; round++; log("phase 4: round " + round + " dry (finish " + curFinish + "ms)"); continue; }
    dry = 0;
    const p = proposals[0];
    const slice = Uint8Array.from(Buffer.from(p.sliceB64, "base64"));
    masks.set(slice, p.winStart);
    log("phase 4: round " + round + " improved " + curFinish + " -> " + p.finishFrames + "ms (window " + p.winStart + ")");
    curFinish = p.finishFrames;
    round++;
  }

  const finalEntries = masksToEntries(masks);

  // ---------- Final verification ----------
  log("verifying with the game's own Verify handler...");
  const channels = rec.entriesToChannels(finalEntries);
  const recording = rec.channelsToRecordingString(local, channels);
  // exact finish frame from a clean local simulation:
  local.resetCar();
  let finalState = null;
  for (let f = 0; f < curFinish + 2000; f++) {
    finalState = local.stepMask(f < masks.length ? masks[f] : 0);
    if (finalState.finished) break;
  }
  if (!finalState || !finalState.finished) throw new Error("Final script does not finish in local sim!");
  const finalFinish = finalState.finishFrames;
  const verifyOk = local.verifyRecording(recording, finalFinish);
  log("final: " + finalFinish + "ms  verify=" + (verifyOk ? "PASS" : "FAIL"));

  const meta = {
    track: trackName,
    finishMs: finalFinish,
    verify: verifyOk,
    phases: {
      rrtGhostMs: ghostFinish,
      mctsMs: phase3Finish,
      polishedMs: finalFinish,
    },
    workers: nWorkers,
    seed: masterSeed,
  };
  fs.writeFileSync(path.join(outDir, "final.tas"), rec.entriesToScript(finalEntries,
    trackName + " " + finalFinish + "ms — autonomous TAS pipeline (RRT+MCTS+polish), verify=" + verifyOk));
  fs.writeFileSync(path.join(outDir, "final.recording.txt"), recording);
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  log("artifacts written to " + outDir);

  await pool.destroy();
  if (!verifyOk) process.exit(1);
}

function masksBlocksToEntries(blocks, dec) {
  const entries = [];
  let last = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] !== last) { entries.push({ frame: i * dec, mask: blocks[i] }); last = blocks[i]; }
  }
  entries.push({ frame: blocks.length * dec, mask: 0 });
  return entries;
}

main().catch((e) => { console.error(e); process.exit(1); }