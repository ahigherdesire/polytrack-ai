};
// Phase 2 — Kinematic RRT (macro pathfinding).
//
// Builds a tree of PHYSICALLY REACHED states: every node is the result of
// actually simulating inputs from its parent through the game's wasm
// physics, so every path in the tree is a driveable input script. Nearest
// neighbors are selected with a weighted inertial pseudometric (position +
// momentum alignment + kinetic energy), never raw Euclidean distance, so the
// search doesn't try to grow from states whose momentum points away.
//
// Node states live in flat typed arrays; input segments live in shared
// buffers; wasm-heap snapshots are kept for a bounded subset of nodes and
// other nodes re-materialize by replaying from the nearest snapshotted
// ancestor (bit-exact thanks to engine determinism).
//
// Output: the fastest found finishing input timeline (the "ghost run").
"use strict";

const DEFAULTS = {
  maxIterations: 60000,
  maxNodes: 60000,
  extendPieces: 6,          // pieces per extension
  pieceFrames: 30,          // 30 ms per control piece
  candidates: 4,            // candidate control programs per extension
  goalBiasWaypoint: 0.35,   // sample exactly at the next waypoint
  goalBiasCorridor: 0.40,   // sample between a node and its waypoint
  w1: 12,                   // momentum misalignment weight
  w2: 0.08,                 // kinetic energy deficit weight
  snapEveryFrames: 900,     // snapshot a node if replay depth exceeds this
  snapCap: 80,              // max live snapshots (~20 MB each)
  stallKickIters: 300,      // no progress for this long => aggressive resampling
  stuckFrames: 500,         // rollout abort: this long below stuckSpeed
  stuckSpeed: 1.5,          // km/h
  timeBudgetMs: null,       // wall-clock budget (null = iterations only)
  afterFinishIterations: 8000, // keep improving this long after first finish
  seed: 1234567,
  log: null,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rrt {
  constructor(sim, guidance, opts = {}) {
    this.sim = sim;
    this.g = guidance;
    this.o = { ...DEFAULTS, ...opts };
    this.rng = mulberry32(this.o.seed);

    const cap = this.o.maxNodes;
    this.x = new Float64Array(cap); this.y = new Float64Array(cap); this.z = new Float64Array(cap);
    this.vx = new Float64Array(cap); this.vy = new Float64Array(cap); this.vz = new Float64Array(cap);
    this.speed = new Float64Array(cap);       // km/h
    this.frames = new Int32Array(cap);
    this.cp = new Int32Array(cap);            // nextCheckpointIndex
    this.parent = new Int32Array(cap).fill(-1);
    this.segOff = new Int32Array(cap);
    this.segLen = new Int32Array(cap);
    this.flags = new Uint8Array(cap);         // bit0 finished

    this.segMask = new Uint8Array(1 << 16);
    this.segDur = new Uint16Array(1 << 16);
    this.segCount = 0;

    this.visits = new Uint16Array(cap);       // expansion counts (exploration pressure)
    this.count = 0;
    this.snapshots = new Map();               // nodeId -> {heap, frames, carId, finished}
    this.snapOrder = [];                      // LRU
    this._snapPool = [];                      // recycled snapshot buffers
    this._trialSnap = null;                   // reused buffer for extension trials
    this.bestFinish = null;                   // {node, finishFrames}
    this.bestProgress = { cp: -1, dist: Infinity, node: 0 };
    this.iterations = 0;
    this.stats = { expansions: 0, rejected: 0, replayFrames: 0, snapshots: 0 };
  }

  _pushSeg(mask, dur) {
    if (this.segCount >= this.segMask.length) {
      const nm = new Uint8Array(this.segMask.length * 2); nm.set(this.segMask); this.segMask = nm;
      const nd = new Uint16Array(this.segDur.length * 2); nd.set(this.segDur); this.segDur = nd;
    }
    this.segMask[this.segCount] = mask;
    this.segDur[this.segCount] = dur;
    return this.segCount++;
  }

  _addNode(parent, st, pieces, prevX, prevY, prevZ, pieceFrames) {
    if (this.count >= this.o.maxNodes) return -1;
    const id = this.count++;
    this.x[id] = st.x; this.y[id] = st.y; this.z[id] = st.z;
    // velocity in m/s from the last piece of movement
    const dt = pieceFrames / 1000;
    this.vx[id] = (st.x - prevX) / dt; this.vy[id] = (st.y - prevY) / dt; this.vz[id] = (st.z - prevZ) / dt;
    this.speed[id] = st.speedKmh;
    this.frames[id] = st.frames;
    this.cp[id] = st.nextCheckpointIndex;
    this.parent[id] = parent;
    this.flags[id] = st.finished ? 1 : 0;
    this.segOff[id] = this._pushSeg(pieces[0].mask, pieces[0].dur);
    for (let i = 1; i < pieces.length; i++) this._pushSeg(pieces[i].mask, pieces[i].dur);
    this.segLen[id] = pieces.length;
    return id;
  }

  _snapshotNode(id) {
    if (this.snapshots.has(id)) return;
    const reuse = this._snapPool.length ? this._snapPool.pop() : undefined;
    this.snapshots.set(id, this.sim.snapshot(reuse));
    this.snapOrder.push(id);
    this.stats.snapshots++;
    while (this.snapOrder.length > this.o.snapCap) {
      const evict = this.snapOrder.shift();
      if (evict === 0) { this.snapOrder.push(evict); continue; } // never evict root
      this._snapPool.push(this.snapshots.get(evict));            // recycle buffer
      this.snapshots.delete(evict);
    }
  }

  // Restore the sim to node `id` (bit-exact), replaying from the nearest
  // snapshotted ancestor. Returns replayed frame count.
  materialize(id) {
    const chain = [];
    let n = id;
    while (n !== -1 && !this.snapshots.has(n)) {
      chain.push(n);
      n = this.parent[n];
    }
    if (n === -1) throw new Error("No snapshotted ancestor (root must be snapshotted)");
    this.sim.restore(this.snapshots.get(n));
    // Touch the used snapshot in the LRU so hot lineages stay cached.
    const oi = this.snapOrder.indexOf(n);
    if (oi >= 0 && oi !== this.snapOrder.length - 1) {
      this.snapOrder.splice(oi, 1);
      this.snapOrder.push(n);
    }
    let replayed = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i];
      const off = this.segOff[node], len = this.segLen[node];
      for (let s = 0; s < len; s++) {
        const dur = this.segDur[off + s];
        this.sim.stepMaskN(this.segMask[off + s], dur);
        replayed += dur;
      }
    }
    this.stats.replayFrames += replayed;
    // Snapshot if this node is deep beyond its ancestor snapshot.
    if (replayed > this.o.snapEveryFrames) this._snapshotNode(id);
    return replayed;
  }

  // Weighted inertial pseudometric from node i to target point p.
  _metric(i, px, py, pz) {
    const dx = px - this.x[i], dy = py - this.y[i], dz = pz - this.z[i];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
    const vmag = Math.sqrt(vx * vx + vy * vy + vz * vz);
    let misalign = 0;
    if (vmag > 0.5 && dist > 1e-6) {
      const cos = (vx * dx + vy * dy + vz * dz) / (vmag * dist);
      misalign = (1 - cos) * Math.min(vmag, 25);
    }
    const requiredSpeed = Math.min(90, dist * 1.2); // km/h needed to plausibly get there
    const deficit = Math.max(0, requiredSpeed - this.speed[i]);
    return dist + this.o.w1 * misalign * 0.5 + this.o.w2 * deficit * dist * 0.02 + this.o.w2 * deficit;
  }

  // Pick among the k best nodes (randomized) with a visit penalty so the
  // search branches instead of hammering one greedy chain.
  _nearest(px, py, pz) {
    const K = 3;
    const bestIds = [-1, -1, -1];
    const bestDs = [Infinity, Infinity, Infinity];
    for (let i = 0; i < this.count; i++) {
      const d = this._metric(i, px, py, pz) - this.cp[i] * 2 + this.visits[i] * 4;
      if (d < bestDs[K - 1]) {
        let j = K - 1;
        while (j > 0 && d < bestDs[j - 1]) { bestDs[j] = bestDs[j - 1]; bestIds[j] = bestIds[j - 1]; j--; }
        bestDs[j] = d; bestIds[j] = i;
      }
    }
    const r = this.rng();
    const pick = r < 0.6 ? 0 : r < 0.85 ? 1 : 2;
    for (let j = pick; j >= 0; j--) if (bestIds[j] >= 0) return bestIds[j];
    return bestIds[0];
  }

  _sampleTarget() {
    const stalled = (this.iterations - (this.lastImprovementIter || 0)) > this.o.stallKickIters;
    const r = this.rng();
    if (stalled && r < 0.5) return this.g.samplePoint(this.rng); // widen exploration
    if (r < this.o.goalBiasWaypoint) {
      // A random node's next waypoint, jittered.
      const nodeId = (this.rng() * this.count) | 0;
      const wp = this.g.targetFor(this.cp[nodeId]);
      if (wp) {
        const j = 6;
        return [
          wp.center[0] + (this.rng() * 2 - 1) * (wp.half[0] * 0.7 + j),
          wp.center[1] + (this.rng() * 2 - 1) * 2,
          wp.center[2] + (this.rng() * 2 - 1) * (wp.half[2] * 0.7 + j),
        ];
      }
    }
    if (r < this.o.goalBiasWaypoint + this.o.goalBiasCorridor) {
      // A point AHEAD ALONG THE ROUTE from a random node (geodesic route
      // following when the potential field is built; straight corridor as
      // fallback). Route points hug the road through chicanes.
      const nodeId = (this.rng() * this.count) | 0;
      if (this.g.potentialMaps && typeof this.g.routeTarget === "function") {
        const aheadM = 10 + this.rng() * 55;
        const rt = this.g.routeTarget(this.x[nodeId], this.y[nodeId], this.z[nodeId], this.cp[nodeId], aheadM);
        if (rt) {
          const jit = 5;
          return [
            rt[0] + (this.rng() * 2 - 1) * jit,
            rt[1] + this.rng() * 2,
            rt[2] + (this.rng() * 2 - 1) * jit,
          ];
        }
      }
      const wp = this.g.targetFor(this.cp[nodeId]);
      if (wp) {
        const t = this.rng();
        const jit = 14 * (1 - t) + 4;
        return [
          this.x[nodeId] + (wp.center[0] - this.x[nodeId]) * t + (this.rng() * 2 - 1) * jit,
          this.y[nodeId] + (wp.center[1] - this.y[nodeId]) * t + (this.rng() * 2 - 1) * 3,
          this.z[nodeId] + (wp.center[2] - this.z[nodeId]) * t + (this.rng() * 2 - 1) * jit,
        ];
      }
    }
    return this.g.samplePoint(this.rng);
  }

  // Steering controller: pick steer bit by bang-bang on the horizontal
  // angle between current motion (or last motion) and the direction to the
  // target. Returns mask piece list actually simulated.
  _extend(targetX, targetY, targetZ) {
    const o = this.o;
    const sim = this.sim;
    const pf = o.pieceFrames;

    const st0 = { ...sim.fastState() };       // COPY — fastState() is a shared object
    const startFrames = sim.car.frames;
    this._trialSnap = sim.snapshot(this._trialSnap); // reused buffer, no alloc
    const baseSnap = this._trialSnap;
    let bestScore = Infinity, bestPieces = null, bestEnd = null, bestPrev = null;

    for (let c = 0; c < o.candidates; c++) {
      if (c > 0) sim.restore(baseSnap);
      const pieces = [];
      let px = st0.x, py = st0.y, pz = st0.z;   // previous piece position
      let mx = 0, mz = 0;
      let stuck = 0, dead = false;
      let st = st0;
      // candidate personality
      const aggressive = this.rng();
      const brakey = this.rng() < 0.25;
      const wobble = this.rng() < 0.3 ? (this.rng() * 2 - 1) : 0;
      // Occasionally commit to a long extension to cover straights quickly.
      const numPieces = this.rng() < 0.3 ? (o.extendPieces * 2) : o.extendPieces;

      for (let p = 0; p < numPieces; p++) {
        // current motion direction (horizontal)
        mx = st.x - px; mz = st.z - pz;
        const mmag = Math.hypot(mx, mz);
        const tx = targetX - st.x, tz = targetZ - st.z;
        const tmag = Math.hypot(tx, tz) || 1e-9;
        let mask = 1; // throttle
        if (mmag > 0.02) {
          const cross = (mx * tz - mz * tx) / (mmag * tmag);
          const dot = (mx * tx + mz * tz) / (mmag * tmag);
          const steerThreshold = 0.12 + 0.25 * (1 - aggressive);
          let steerRight = cross > 0;
          if (wobble !== 0 && p === 0) steerRight = wobble > 0;
          if (Math.abs(cross) > steerThreshold || dot < 0) {
            mask |= steerRight ? 2 : 8;
            if (dot < -0.3 && brakey) mask |= 4; // hard turn: brake-drift
          }
        } else if (p === 0 && c % 2 === 1) {
          mask |= (c % 4 === 1) ? 2 : 8; // low-speed: try steering both ways
        }
        px = st.x; pz = st.z; py = st.y;
        st = sim.stepMaskN(mask, pf);
        pieces.push({ mask, dur: pf });
        if (st.frames > 600 && st.hasStarted && st.speedKmh < o.stuckSpeed) {
          stuck += pf;
          if (stuck > o.stuckFrames) { dead = true; break; }
        } else stuck = 0;
        if (st.finished) break;
      }
      if (dead) { this.stats.rejected++; continue; }
      const d = Math.hypot(targetX - st.x, targetY - st.y, targetZ - st.z);
      const score = st.finished ? -1e9 + st.finishFrames : d - (st.nextCheckpointIndex - st0.nextCheckpointIndex) * 500;
      if (score < bestScore) {
        bestScore = score;
        bestPieces = pieces.slice();
        bestEnd = { ...st };
        bestPrev = { x: px, y: py, z: pz };
      }
    }
    return bestPieces ? { pieces: bestPieces, end: bestEnd, prev: bestPrev, startFrames } : null;
  }

  // Pre-populate the tree along a known-good input script (e.g. the best
  // partial from a previous round) so the search continues from its
  // frontier instead of rediscovering the whole route.
  _seedFromEntries(entries) {
    const sim = this.sim;
    const NODE_EVERY = 400;   // frames per seeded node
    const SNAP_EVERY = 1600;  // frames per seeded snapshot
    // masks per frame runs
    const sorted = entries.slice().sort((a, b) => a.frame - b.frame);
    const end = sorted.length ? sorted[sorted.length - 1].frame : 0;
    if (end < NODE_EVERY) return;
    let parent = 0;
    let mask = 0, idx = 0;
    let pieces = [];
    let lastNodeFrame = 1, lastSnapFrame = 0;
    let px = this.x[0], py = this.y[0], pz = this.z[0];
    let st = null;
    for (let f = 1; f < end && f < 200000; ) {
      while (idx < sorted.length && sorted[idx].frame <= f) mask = sorted[idx++].mask;
      const nextChange = idx < sorted.length ? sorted[idx].frame : end;
      const runLen = Math.min(nextChange - f, 500);
      st = sim.stepMaskN(mask & 15, runLen);
      pieces.push({ mask: mask & 15, dur: runLen });
      f += runLen;
      if (f - lastNodeFrame >= NODE_EVERY || f >= end) {
        const span = Math.max(1, f - lastNodeFrame);
        const id = this._addNode(parent, st, pieces, px, py, pz, span);
        if (id < 0) break;
        parent = id;
        pieces = [];
        lastNodeFrame = f;
        px = st.x; py = st.y; pz = st.z;
        if (f - lastSnapFrame >= SNAP_EVERY) {
          this._snapshotNode(id);
          lastSnapFrame = f;
        }
        const dist = this.g.distanceToTarget(st.x, st.y, st.z, st.nextCheckpointIndex);
        if (st.nextCheckpointIndex > this.bestProgress.cp ||
          (st.nextCheckpointIndex === this.bestProgress.cp && dist < this.bestProgress.dist)) {
          this.bestProgress = { cp: st.nextCheckpointIndex, dist, node: id };
        }
        if (st.finished && (!this.bestFinish || st.finishFrames < this.bestFinish.finishFrames)) {
          this.bestFinish = { node: id, finishFrames: st.finishFrames };
        }
      }
    }
    if (this.o.log) this.o.log("rrt seeded " + this.count + " nodes from prior run (cp=" + this.bestProgress.cp + ")");
  }

  run() {
    const o = this.o;
    const sim = this.sim;
    const t0 = performance.now();

    // Root node: freshly spawned car.
    sim.resetCar();
    const st0 = sim.stepMask(0); // one settle frame so state buffer is valid
    this._addNodeRoot(st0);
    this._snapshotNode(0);
    if (o.seedEntries) this._seedFromEntries(o.seedEntries);

    let sinceFinishIters = 0;
    while (this.iterations < o.maxIterations && this.count < o.maxNodes) {
      this.iterations++;
      if (o.timeBudgetMs && performance.now() - t0 > o.timeBudgetMs) break;
      if (this.bestFinish && ++sinceFinishIters > o.afterFinishIterations) break;

      const [tx, ty, tz] = this._sampleTarget();
      const near = this._nearest(tx, ty, tz);
      if (near < 0) continue;
      this.visits[near] = Math.min(this.visits[near] + 1, 65535);
      this.materialize(near);
      const ext = this._extend(tx, ty, tz);
      if (!ext) continue;
      this.stats.expansions++;

      const id = this._addNode(near, ext.end, ext.pieces, ext.prev.x, ext.prev.y, ext.prev.z, o.pieceFrames);
      if (id < 0) break;

      // Progress tracking.
      const dist = this.g.distanceToTarget(ext.end.x, ext.end.y, ext.end.z, ext.end.nextCheckpointIndex);
      if (ext.end.nextCheckpointIndex > this.bestProgress.cp ||
        (ext.end.nextCheckpointIndex === this.bestProgress.cp && dist < this.bestProgress.dist)) {
        this.bestProgress = { cp: ext.end.nextCheckpointIndex, dist, node: id };
        this.lastImprovementIter = this.iterations;
        if (o.log && this.iterations % 1 === 0) {
          o.log("rrt it=" + this.iterations + " nodes=" + this.count + " cp=" + ext.end.nextCheckpointIndex +
            " dist=" + dist.toFixed(1) + " f=" + ext.end.frames);
        }
      }
      if (ext.end.finished) {
        const ff = ext.end.finishFrames;
        if (!this.bestFinish || ff < this.bestFinish.finishFrames) {
          this.bestFinish = { node: id, finishFrames: ff };
          sinceFinishIters = 0;
          if (o.log) o.log("rrt FINISH @" + ff + "ms  (it=" + this.iterations + ", nodes=" + this.count + ")");
        }
      }
    }

    if (!this.bestFinish) return { finished: false, stats: this.stats, bestProgress: this.bestProgress, entries: this.extractEntries(this.bestProgress.node) };
    return {
      finished: true,
      finishFrames: this.bestFinish.finishFrames,
      entries: this.extractEntries(this.bestFinish.node),
      stats: this.stats,
      bestProgress: this.bestProgress,
    };
  }

  _addNodeRoot(st) {
    const id = this.count++;
    this.x[id] = st.x; this.y[id] = st.y; this.z[id] = st.z;
    this.vx[id] = 0; this.vy[id] = 0; this.vz[id] = 0;
    this.speed[id] = 0;
    this.frames[id] = st.frames;
    this.cp[id] = st.nextCheckpointIndex;
    this.parent[id] = -1;
    this.segOff[id] = this._pushSeg(0, 1); // the settle frame
    this.segLen[id] = 1;
  }

  // Rebuild the input timeline (entries {frame,mask}) for the path to `id`.
  extractEntries(id) {
    const path = [];
    let n = id;
    while (n !== -1) { path.push(n); n = this.parent[n]; }
    path.reverse();
    const entries = [];
    let frame = 0, lastMask = -1;
    for (const node of path) {
      const off = this.segOff[node], len = this.segLen[node];
      for (let s = 0; s < len; s++) {
        const mask = this.segMask[off + s];
        const dur = this.segDur[off + s];
        if (mask !== lastMask) { entries.push({ frame, mask }); lastMask = mask; }
        frame += dur;
      }
    }
    entries.push({ frame, mask: 0 });
    return entries;
  }
}

module.exports = { Rrt, mulberry32, RRT_DEFAULTS: DEFAULTS 