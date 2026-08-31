0,
// Engine performance benchmark + snapshot cost/dirty-region diagnostics.
//   node src/cli/bench.js [track]
"use strict";
const fs = require("fs");
const path = require("path");
const paths = require("../paths");
const { HeadlessSim } = require("../engine/sim");

async function main() {
  const trackFile = process.argv[2] || path.join(paths.TRACKS_DIR, "official", "summer1.track");
  const t0 = performance.now();
  const sim = await HeadlessSim.create();
  console.log("boot+init: " + (performance.now() - t0).toFixed(0) + " ms, heap " + (sim.heapSize() / 1e6).toFixed(1) + " MB");

  sim.loadTrack(fs.readFileSync(trackFile, "utf8"));
  sim.spawnCar();

  // Warm up JIT + wasm.
  for (let f = 0; f < 20000; f++) sim.stepMask(1 | ((f >> 8) & 2));

  // Raw stepping (with readFast, as the searches use it).
  sim.resetCar();
  const N = 200000;
  let acc = 0;
  const t1 = performance.now();
  for (let f = 0; f < N; f++) {
    const st = sim.stepMask(1 | ((f >> 7) & 2) | ((f >> 9) & 8));
    acc += st.speedKmh;
  }
  const dt1 = performance.now() - t1;
  console.log("step+read: " + (dt1 * 1000 / N).toFixed(2) + " us/step  (" + Math.round(N / dt1) + "k steps/sec)  [acc " + acc.toFixed(0) + "]");

  // Snapshot / restore.
  sim.resetCar();
  for (let f = 0; f < 5000; f++) sim.stepMask(1);
  let t2 = performance.now();
  const SNAPS = 50;
  let snap;
  for (let i = 0; i < SNAPS; i++) snap = sim.snapshot();
  console.log("snapshot(full heap): " + ((performance.now() - t2) / SNAPS).toFixed(2) + " ms");
  t2 = performance.now();
  for (let i = 0; i < SNAPS; i++) sim.restore(snap);
  console.log("restore(full heap):  " + ((performance.now() - t2) / SNAPS).toFixed(2) + " ms");

  // MCTS-shaped cycle: restore + 1000 steps.
  t2 = performance.now();
  const CYCLES = 100;
  for (let i = 0; i < CYCLES; i++) {
    sim.restore(snap);
    for (let f = 0; f < 1000; f++) sim.stepMask(1 | ((f >> 6) & 2));
  }
  const cyc = (performance.now() - t2) / CYCLES;
  console.log("restore+1000 steps:  " + cyc.toFixed(2) + " ms  (" + Math.round(1000 / cyc) + " sims/sec/thread)");

  // Dirty-region analysis: which heap bytes change while simulating?
  sim.restore(snap);
  const base = snap.heap;
  for (let f = 0; f < 2000; f++) sim.stepMask(1 | ((f >> 6) & 8));
  const cur = sim.module.HEAPU8;
  let first = -1, last = -1, count = 0;
  const n = Math.min(base.length, cur.length);
  for (let i = 0; i < n; i++) {
    if (base[i] !== cur[i]) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  console.log(
    "dirty after 2000 steps: " + count + " bytes in [" + first + ", " + last + "] " +
    "(span " + (last - first + 1) + " = " + ((last - first + 1) / 1e6).toFixed(2) + " MB of " + (n / 1e6).toFixed(1) + " MB)"
  );

  // Page-level dirty map (4 KB pages) — how sparse is the span?
  const PAGE = 4096;
  let dirtyPages = 0;
  for (let p = 0; p * PAGE < n; p++) {
    const s = p * PAGE, e = Math.min(n, s + PAGE);
    for (let i = s; i < e; i++) {
      if (base[i] !== cur[i]) { dirtyPages++; break; }
    }
  }
  console.log("dirty 4KB pages: " + dirtyPages + " (" + (dirtyPages * PAGE / 1e6).toFixed(2) + " MB)");
}

main().catch((e) => { console.error(e); process.exit(1); }