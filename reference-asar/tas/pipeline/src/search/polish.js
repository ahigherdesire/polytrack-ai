};
// Phase 4 — Native micro-polisher (1 ms resolution).
//
// (1+λ) evolution over small sliding windows at the native 1000 Hz tick:
// the Phase-3 script is the baseline; mutants flip/shift individual 1 ms
// input frames inside a ~100 ms window and are accepted only if the run
// still passes every checkpoint no later than before and the finish frame
// strictly improves (ties broken by higher finish-line exit speed).
//
// Evaluation is exact end-to-end simulation with two cost controls:
//  - wasm-heap snapshots every `snapshotEveryMs` let a window eval start
//    right before the mutation instead of at frame 0
//  - early abort: if a checkpoint split falls behind the baseline by more
//    than `splitToleranceMs`, the mutant is rejected mid-sim.
"use strict";
const { mulberry32 } = require("./rrt");

const DEFAULTS = {
  windowMs: 100,
  windowStepMs: 50,
  lambda: 10,             // mutants per window visit
  maxPasses: 8,           // full sweeps over the run
  splitToleranceMs: 40,   // reject when a cp split lags baseline this much
  snapshotEveryMs: 2500,
  padMs: 300,             // simulate a little past the finish
  seed: 24680,
  log: null,
  maxNoImproveWindows: Infinity,
};

class Polisher {
  constructor(sim, opts = {}) {
    this.sim = sim;
    this.o = { ...DEFAULTS, ...opts };
    this.rng = mulberry32(this.o.seed);
  }

  // masks: dense Uint8Array, one mask per frame. Returns full evaluation.
  evaluate(masks, horizon, opts = {}) {
    const sim = this.sim;
    const startSnap = opts.startSnap || null;
    const collectSnapshots = opts.collectSnapshots || null; // {everyMs, out:[]}
    let f0 = 0;
    if (startSnap) {
      sim.restore(startSnap.snap);
      f0 = startSnap.frame;
    } else {
      sim.resetCar();
    }
    const splits = opts.reuseSplits ? opts.reuseSplits.slice(0, 0) : [];
    let cp = startSnap ? startSnap.cp : 0;
    const baseSplits = opts.baseSplits || null;
    const tol = this.o.splitToleranceMs;
    let st = null;
    for (let f = f0; f < horizon; f++) {
      st = sim.stepMask(f < masks.length ? masks[f] : 0);
      if (st.nextCheckpointIndex > cp) {
        for (let k = cp; k < st.nextCheckpointIndex; k++) splits[k] = f;
        cp = st.nextCheckpointIndex;
        if (baseSplits && baseSplits[cp - 1] != null && f > baseSplits[cp - 1] + tol) {
          return { rejected: true, finishFrames: null, splits, cp };
        }
      }
      if (baseSplits && cp < baseSplits.length && baseSplits[cp] != null && f > baseSplits[cp] + tol) {
        return { rejected: true, finishFrames: null, splits, cp }; // late for next cp
      }
      if (collectSnapshots && f > f0 && f % collectSnapshots.everyFrames === 0) {
        collectSnapshots.out.push({ frame: f + 1, cp, snap: sim.snapshot() });
      }
      if (st.finished) {
        return {
          rejected: false,
          finishFrames: st.finishFrames,
          exitSpeed: st.speedKmh,
          splits,
          cp,
        };
      }
    }
    return { rejected: false, finishFrames: null, splits, cp, exitSpeed: st ? st.speedKmh : 0 };
  }

  // Mutation: flip steering/throttle/brake bits over random sub-ranges of the
  // window at 1 ms resolution, or micro-shift an existing input edge.
  mutate(masks, winStart, winEnd) {
    const out = masks.slice();
    const ops = 1 + ((this.rng() * 3) | 0);
    for (let i = 0; i < ops; i++) {
      const kind = this.rng();
      const bit = 1 << ([0, 1, 2, 3][(this.rng() * 4) | 0]); // up/right/down/left
      if (kind < 0.5) {
        // flip a bit over a short run of frames
        const a = winStart + ((this.rng() * (winEnd - winStart)) | 0);
        const len = 1 + ((this.rng() * 12) | 0);
        for (let f = a; f < Math.min(a + len, winEnd); f++) out[f] ^= bit;
      } else if (kind < 0.8) {
        // shift an edge: find a transition of this bit inside the window
        const edges = [];
        for (let f = Math.max(1, winStart); f < winEnd; f++) {
          if (((out[f] ^ out[f - 1]) & bit) !== 0) edges.push(f);
        }
        if (edges.length) {
          const e = edges[(this.rng() * edges.length) | 0];
          const shift = 1 + ((this.rng() * 4) | 0);
          const dir = this.rng() < 0.5 ? -1 : 1;
          const v = out[e] & bit;
          for (let s = 1; s <= shift; s++) {
            const f = e + s * dir;
            if (f <= winStart || f >= winEnd) break;
            if (dir < 0) out[f - 1] = (out[f - 1] & ~bit) | v;
            else out[e + s - 1] = (out[e + s - 1] & ~bit) | (out[e - 1] & bit);
          }
        }
      } else {
        // single-frame toggle (frame-perfect nudge)
        const f = winStart + ((this.rng() * (winEnd - winStart)) | 0);
        out[f] ^= bit;
      }
    }
    return out;
  }

  // Full polish loop. entries -> improved masks + report.
  polish(masks, opts = {}) {
    const o = this.o;
    const horizonPad = o.padMs;

    // Baseline evaluation + snapshot collection.
    let snaps = [];
    let base = this.evaluate(masks, masks.length + horizonPad, {
      collectSnapshots: { everyFrames: o.snapshotEveryMs, out: snaps },
    });
    if (base.finishFrames == null) {
      throw new Error("Polish baseline does not finish — refusing to polish");
    }
    let bestMasks = masks.slice();
    let improved = 0, tried = 0;
    const t0 = performance.now();

    for (let pass = 0; pass < o.maxPasses; pass++) {
      let passImproved = 0;
      for (let winStart = 0; winStart < base.finishFrames; winStart += o.windowStepMs) {
        const winEnd = Math.min(winStart + o.windowMs, base.finishFrames + 50);
        // nearest snapshot at/before winStart
        let startSnap = null;
        for (const s of snaps) {
          if (s.frame <= winStart && (!startSnap || s.frame > startSnap.frame)) startSnap = s;
        }
        for (let m = 0; m < o.lambda; m++) {
          tried++;
          const cand = this.mutate(bestMasks, winStart, winEnd);
          const r = this.evaluate(cand, base.finishFrames + horizonPad, {
            startSnap,
            baseSplits: base.splits,
          });
          if (r.rejected || r.finishFrames == null) continue;
          const better = r.finishFrames < base.finishFrames ||
            (r.finishFrames === base.finishFrames && r.exitSpeed > (base.exitSpeed || 0) + 1e-9);
          if (better && r.finishFrames < base.finishFrames) {
            bestMasks = cand;
            improved++;
            passImproved++;
            // re-baseline (splits + snapshots move)
            snaps = [];
            base = this.evaluate(bestMasks, r.finishFrames + horizonPad, {
              collectSnapshots: { everyFrames: o.snapshotEveryMs, out: snaps },
            });
            if (o.log) {
              o.log("polish -" + " f=" + base.finishFrames + " (win " + winStart + ", pass " + pass + ", t=" +
                ((performance.now() - t0) / 1000).toFixed(0) + "s)");
            }
          }
        }
      }
      if (o.log) o.log("polish pass " + pass + " done: " + passImproved + " improvements, finish=" + base.finishFrames);
      if (!passImproved) break;
    }
    return { masks: bestMasks, finishFrames: base.finishFrames, splits: base.splits, improved, tried };
  }
}

// dense masks <-> entries helpers
function entriesToMasks(entries, length) {
  const masks = new Uint8Array(length);
  let cur = 0, idx = 0;
  const sorted = entries.slice().sort((a, b) => a.frame - b.frame);
  for (let f = 0; f < length; f++) {
    while (idx < sorted.length && sorted[idx].frame <= f) cur = sorted[idx++].mask;
    masks[f] = cur;
  }
  return masks;
}

function masksToEntries(masks) {
  const entries = [];
  let last = -1;
  for (let f = 0; f < masks.length; f++) {
    if (masks[f] !== last) { entries.push({ frame: f, mask: masks[f] }); last = masks[f]; }
  }
  return entries;
}

module.exports = { Polisher, entriesToMasks, masksToEntries, POLISH_DEFAULTS: DEFAULTS 