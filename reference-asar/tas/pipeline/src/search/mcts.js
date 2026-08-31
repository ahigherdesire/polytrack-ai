};
// Phase 3 — Coarse Windowed MCTS (the 10 ms optimizer).
//
// UCT search over discrete input masks, action-decimated to 10 ms blocks,
// confined to a sliding window:
//   - search a window of `windowMs` from the current locked frontier
//   - rollouts look ahead and are scored by a fitness that rewards geodesic
//     track progress + exit velocity and punishes airtime and slip
//   - lock the most-visited action chain ONLY as deep as visits stay
//     statistically meaningful, slide the window, reuse the subtree
//
// The class is split into `searchWindow` / `exportTrie` / `advance` /
// `rewind` so a pool of workers can run ROOT-PARALLEL MCTS: every worker
// searches the same window with a different seed, the driver merges the
// visit tries, picks the consensus lock, and all workers advance
// identically (bit-exact determinism makes their states stay in lockstep).
//
// Fitness progress uses the Phase-2 ghost trace when present (arc-length
// projection), else the geodesic potential field — so Phase 3 can also
// drive tracks entirely from scratch.
"use strict";
const { maskAtFrame, entriesToChannels } = require("../engine/recording");
const { mulberry32 } = require("./rrt");

const DEFAULTS = {
  windowMs: 450,          // search window
  decimationMs: 10,       // the spec's 10 ms action decimation
  lockMs: 100,            // max inputs locked per slide
  minLockBlocks: 3,       // always lock at least this many blocks (rewind is the safety net)
  simsPerWindow: 400,     // MCTS simulations per window (per worker)
  rolloutMs: 500,         // targeted rollout beyond the tree leaf
  rolloutDecisionMs: 50,  // rollout policy decision period (coarse but far-sighted)
  ucbC: 0.7,
  maxRunMs: 240000,
  stuckWindows: 10,
  rewindWindows: 10,
  maxRewinds: 10,
  minVisitFrac: 0.02,     // lock depth confidence threshold
  finishBonus: 5e6,
  finishFrameWeight: 25,
  airtimeWeight: 0.25,
  slipWeight: 0.8,
  slipThreshold: 0.30,
  speedWeight: 0.012,
  overspeedWeight: 0.04,  // per (km/h over the curvature cap) per decision block
  regressWeight: 3,       // per meter of accumulated potential REGRESSION
  cpBonus: 600,
  seed: 987654321,
  log: null,
  onWindow: null,
};

const N_ACTIONS = 16; // up/right/down/left combos; reset excluded

class WindowedMcts {
  constructor(sim, guidance, opts = {}) {
    this.sim = sim;
    this.g = guidance;
    this.o = { ...DEFAULTS, ...opts };
    this.rng = mulberry32(this.o.seed);
    this.ghost = null;
    this.baseChannels = null;
  }

  // ---- ghost trace ---------------------------------------------------------
  buildGhost(entries) {
    const sim = this.sim;
    const dec = this.o.decimationMs;
    const channels = entriesToChannels(entries);
    sim.resetCar();
    const pts = [];
    const cum = [0];
    let lastX = 0, lastY = 0, lastZ = 0, first = true;
    let finishFrames = null;
    const lastFrame = entries.length ? entries[entries.length - 1].frame + 4000 : 10000;
    const horizon = Math.min(lastFrame, this.o.maxRunMs);
    for (let f = 0; f < horizon; f += dec) {
      const st = sim.stepMaskN(maskAtFrame(channels, f), dec);
      if (!first) {
        const d = Math.hypot(st.x - lastX, st.y - lastY, st.z - lastZ);
        cum.push(cum[cum.length - 1] + d);
      }
      pts.push(st.x, st.y, st.z);
      lastX = st.x; lastY = st.y; lastZ = st.z; first = false;
      if (st.finished) { finishFrames = st.finishFrames; break; }
    }
    this.ghost = { pts: new Float64Array(pts), cum: new Float64Array(cum), n: pts.length / 3, finishFrames };
    return this.ghost;
  }

  setBase(entries) {
    this.baseChannels = entries ? entriesToChannels(entries) : null;
    this._baseEndFrame = entries && entries.length
      ? entries[entries.length - 1].frame
      : 0;
  }

  _ghostProgress(x, y, z, cursor, wide) {
    const gh = this.ghost;
    const n = gh.n;
    const lo = wide ? 0 : Math.max(0, cursor - 8);
    const hi = wide ? n - 1 : Math.min(n - 1, cursor + 25);
    let best = Infinity, bestI = cursor;
    for (let i = lo; i <= hi; i++) {
      const dx = gh.pts[i * 3] - x, dy = gh.pts[i * 3 + 1] - y, dz = gh.pts[i * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; bestI = i; }
    }
    return { arc: gh.cum[bestI], cursor: bestI, dist2: best };
  }

  _advanceCursor(st, cursorRef) {
    if (!this.ghost) return;
    const p = this._ghostProgress(st.x, st.y, st.z, cursorRef.cursor, false);
    cursorRef.cursor = p.cursor;
  }

  // Per-block progress sample; also accumulates REGRESSION (progress going
  // backwards — falls off edges, wrong-way slides, tumbles). Regression is
  // the general signature of every "looks neutral inside the horizon, wedges
  // beyond it" failure.
  _blockProgress(st) {
    let pg;
    if (this.ghost) {
      const p = this._ghostProgress(st.x, st.y, st.z, this._simCursor.cursor, false);
      this._simCursor.cursor = p.cursor;
      pg = p.arc - Math.min(30, Math.sqrt(p.dist2) * 0.35);
    } else {
      pg = -this.g.potential(st.x, st.y, st.z, st.nextCheckpointIndex);
    }
    if (this._lastPg != null && pg < this._lastPg - 0.02) {
      this._potRegress += this._lastPg - pg;
    }
    this._lastPg = pg;
    return pg;
  }

  _progress(st, cursorRef) {
    if (this.ghost) {
      const p = this._ghostProgress(st.x, st.y, st.z, cursorRef.cursor, false);
      cursorRef.cursor = p.cursor;
      return p.arc - Math.min(30, Math.sqrt(p.dist2) * 0.35);
    }
    return -this.g.potential(st.x, st.y, st.z, st.nextCheckpointIndex);
  }

  _slip(st, pvx, pvz) {
    const vx = st.x - pvx, vz = st.z - pvz;
    const vmag = Math.hypot(vx, vz);
    if (vmag < 0.05) return 0;
    const { qx, qy, qz, qw } = st;
    const fx = 2 * (qx * qz + qw * qy);
    const fz = 1 - 2 * (qx * qx + qy * qy);
    const fmag = Math.hypot(fx, fz);
    if (fmag < 1e-6) return 0;
    let cos = Math.abs((vx * fx + vz * fz) / (vmag * fmag));
    const ang = Math.acos(Math.min(1, cos));
    return Math.max(0, ang - this.o.slipThreshold);
  }

  // ---- run lifecycle -------------------------------------------------------
  initRun() {
    const sim = this.sim;
    this.locked = [];
    sim.resetCar();
    this.rootSnap = sim.snapshot();
    this._rootBufA = this.rootSnap; this._rootBufB = null; this._rootBufToggle = true;
    this._lastRootCursor = 0;
    this.tree = newNode();
    this.bestFinish = null;
    this.rootProgress = this._progressOfRoot();
  }

  _progressOfRoot() {
    const sim = this.sim;
    sim.restore(this.rootSnap);
    const st = sim.stepMask(0);
    this._rootCpCache = st.nextCheckpointIndex;
    this._rootFinished = st.finished;
    this._rootState = { ...st };
    let p;
    if (this.ghost) {
      const g = this._ghostProgress(st.x, st.y, st.z, 0, true);
      this._lastRootCursor = g.cursor;
      p = g.arc - Math.min(30, Math.sqrt(g.dist2) * 0.35);
    } else {
      p = -this.g.potential(st.x, st.y, st.z, st.nextCheckpointIndex);
    }
    sim.restore(this.rootSnap);
    return p;
  }

  // Run `sims` simulations against the current window. Returns best finish
  // found (if any). A principal-variation snapshot cache lets sims that
  // follow the current best path skip re-stepping its physics.
  searchWindow(sims) {
    const perWin = Math.round(this.o.windowMs / this.o.decimationMs);
    let winBest = -Infinity;
    this._pv = null;
    const pvAt = Math.max(8, Math.floor(sims * 0.3));
    for (let s = 0; s < sims; s++) {
      if (s === pvAt) this._buildPvCache(perWin);
      const r = this._simulate(this.tree, this.rootSnap, perWin);
      if (r.score > winBest) winBest = r.score;
      if (r.finish && (!this.bestFinish || r.finish.frames < this.bestFinish.frames)) {
        this.bestFinish = { frames: r.finish.frames, locked: this.locked.slice(), tail: r.finish.path };
      }
    }
    return winBest;
  }

  // Snapshot the state at the end of the current most-visited path prefix,
  // together with the airtime/slip/cursor aggregates accrued along it.
  _buildPvCache(perWin) {
    const sim = this.sim;
    const dec = this.o.decimationMs;
    const actions = [];
    let node = this.tree;
    const maxLen = Math.min(perWin - 4, 30);
    while (actions.length < maxLen) {
      const a = bestChild(node, 0);
      if (a < 0) break;
      const ch = node.children[a];
      if (ch.n < 8) break;
      actions.push(a);
      node = ch;
    }
    if (actions.length < 6) { this._pv = null; return; }
    sim.restore(this.rootSnap);
    let airtime = 0, slip = 0, overspeed = 0;
    let px = 0, pz = 0, have = false;
    this._simCursor = { cursor: this._lastRootCursor || 0 };
    this._lastPg = this.rootProgress;
    this._potRegress = 0;
    let st = null;
    for (const a of actions) {
      if (have) { px = st.x; pz = st.z; }
      st = sim.stepMaskN(a, dec);
      airtime += st.wheelContacts === 0 ? 1 : 0;
      if (have) slip += this._slip(st, px, pz);
      overspeed += Math.max(0, st.speedKmh - this.g.speedCap(st.x, st.y, st.z, st.nextCheckpointIndex));
      this._blockProgress(st);
      have = true;
      if (st.finished) break;
    }
    this._pv = {
      actions,
      snap: sim.snapshot(this._pvSnapBuf),
      airtime, slip, overspeed,
      regress: this._potRegress,
      lastPg: this._lastPg,
      cursor: this._simCursor.cursor,
      st: { ...st },
    };
    this._pvSnapBuf = this._pv.snap;
  }

  // Compact visit trie for root-parallel merging (depth-limited).
  exportTrie(maxDepth) {
    const walk = (node, depth) => {
      const kids = {};
      if (depth < maxDepth) {
        for (let a = 0; a < N_ACTIONS; a++) {
          const ch = node.children[a];
          if (ch && ch.n > 0) kids[a] = walk(ch, depth + 1);
        }
      }
      return { n: node.n, w: node.w, k: kids };
    };
    return walk(this.tree, 0);
  }

  // Choose the lock chain from a (merged) trie: the most-visited chain,
  // confidence-gated by `minVisits`, but never shorter than `minLock`
  // blocks (the stuck/rewind machinery is the safety net for those).
  static chooseLock(trie, lockN, minVisits, minLock = 3) {
    const chain = [];
    let node = trie;
    let ranOut = false;
    for (let i = 0; i < lockN; i++) {
      let best = -1, bestN = -1, bestW = -Infinity;
      for (const [a, ch] of Object.entries(node.k)) {
        if (ch.n > bestN || (ch.n === bestN && ch.w > bestW)) { bestN = ch.n; bestW = ch.w; best = Number(a); }
      }
      if (best < 0) { ranOut = true; break; }
      const ch = node.k[best];
      if (i >= minLock && ch.n < minVisits) break;
      chain.push(best);
      node = ch;
    }
    if (!chain.length) chain.push(1);
    // The tree rarely reaches full lock depth; on a confident streak
    // (large minLock) extend by repeating the last action — the stuck/rewind
    // machinery catches the rare bad extrapolation.
    if (ranOut) {
      while (chain.length < minLock) chain.push(chain[chain.length - 1]);
    }
    return chain;
  }

  // Advance the locked frontier by these actions. Returns progress info.
  advance(lockedNow) {
    const o = this.o;
    const sim = this.sim;
    const dec = o.decimationMs;
    sim.restore(this.rootSnap);
    let st = null;
    for (const a of lockedNow) st = sim.stepMaskN(a, dec);
    this.locked.push(...lockedNow);
    // Ping-pong two snapshot buffers (the old rootSnap must stay intact
    // while the new one is written).
    const buf = this._rootBufToggle ? this._rootBufA : this._rootBufB;
    this._rootBufToggle = !this._rootBufToggle;
    this.rootSnap = sim.snapshot(buf);
    if (this._rootBufToggle) this._rootBufA = this.rootSnap; else this._rootBufB = this.rootSnap;
    const newProgress = this._progressOfRoot();
    const gain = newProgress - this.rootProgress;
    this.rootProgress = newProgress;
    this.tree = descend(this.tree, lockedNow) || newNode();
    return {
      gain,
      lockedMs: this.locked.length * dec,
      st: this._rootState,
      finished: this._rootFinished,
      finishFrames: this._rootState.finishFrames,
    };
  }

  // Rewind the locked frontier to `toLockedLen` blocks by REPLAYING the
  // locked inputs from frame 0 (deterministic, ~12 µs/frame — even a 60 s
  // prefix replays in under a second). Arbitrary depth, no snapshot ring.
  rewindTo(toLockedLen) {
    const dec = this.o.decimationMs;
    const len = Math.max(0, Math.min(this.locked.length, toLockedLen));
    this.locked.length = len;
    this.sim.resetCar();
    for (let i = 0; i < len; i++) this.sim.stepMaskN(this.locked[i], dec);
    this.rootSnap = this.sim.snapshot();
    this._rootBufA = this.rootSnap; this._rootBufB = null; this._rootBufToggle = true;
    this.tree = newNode();
    this.rootProgress = this._progressOfRoot();
    return this.locked.length;
  }

  reseed(seed) {
    this.rng = mulberry32(seed >>> 0);
  }

  // ---- single simulation ----------------------------------------------------
  // Phase A walks the tree WITHOUT physics (UCT/PW need node stats only) to
  // pick the whole path; Phase B executes the physics, teleporting through
  // the PV snapshot cache when the path follows the principal variation.
  _simulate(tree, rootSnap, perWin) {
    const o = this.o;
    const sim = this.sim;
    const dec = o.decimationMs;
    const lockedLen = this.locked.length;

    // --- Phase A: dry selection/expansion walk
    const path = [];
    let node = tree;
    let depth = 0;
    while (depth < perWin) {
      if (node.rest === null) this._initActions(node, lockedLen + depth, dec);
      const allowKids = Math.max(1, Math.floor(Math.pow(node.n + 1, 0.55)));
      if (!node.untried.length && node.rest.length && node.kids < allowKids) {
        node.untried.push(node.rest.pop());
      }
      const expanding = node.untried.length > 0 && node.kids < allowKids;
      const action = expanding ? node.untried.pop() : bestChild(node, o.ucbC, this.rng);
      if (action < 0) break;
      path.push(action);
      let child = node.children[action];
      if (!child) { child = newNode(); node.children[action] = child; node.kids++; }
      node = child;
      depth++;
      if (expanding) break;
    }

    // --- Phase B: physics execution (PV cache fast path)
    let st = null;
    let airtime = 0, slip = 0, overspeed = 0;
    let px = 0, pz = 0, have = false;
    let finished = this._rootFinished || false;
    this._simCursor = { cursor: this._lastRootCursor || 0 };
    this._lastPg = this.rootProgress;
    this._potRegress = 0;
    let start = 0;
    const pv = this._pv;
    if (pv && path.length >= pv.actions.length) {
      let match = true;
      for (let i = 0; i < pv.actions.length; i++) {
        if (path[i] !== pv.actions[i]) { match = false; break; }
      }
      if (match) {
        sim.restore(pv.snap);
        airtime = pv.airtime;
        slip = pv.slip;
        overspeed = pv.overspeed;
        this._simCursor.cursor = pv.cursor;
        this._lastPg = pv.lastPg;
        this._potRegress = pv.regress;
        st = this._pvStScratch || (this._pvStScratch = {});
        Object.assign(st, pv.st);
        px = st.x; pz = st.z; have = true;
        finished = !!st.finished;
        start = pv.actions.length;
      } else {
        sim.restore(rootSnap);
      }
    } else {
      sim.restore(rootSnap);
    }
    let stepped = start;
    for (let i = start; i < path.length && !finished; i++) {
      if (have) { px = st ? st.x : 0; pz = st ? st.z : 0; }
      st = sim.stepMaskN(path[i], dec);
      airtime += st.wheelContacts === 0 ? 1 : 0;
      if (have) slip += this._slip(st, px, pz);
      overspeed += Math.max(0, st.speedKmh - this.g.speedCap(st.x, st.y, st.z, st.nextCheckpointIndex));
      this._blockProgress(st);
      have = true;
      stepped = i + 1;
      if (st.finished) finished = true;
    }

    let rolloutMasks = null;
    if (!finished) {
      const r = this._rollout(lockedLen + stepped, dec, st);
      airtime += r.airtime; slip += r.slip;
      overspeed += r.overspeed;
      st = r.st;
      finished = r.finished;
      rolloutMasks = r.masks;
    }

    const prog = st ? this._progress(st, this._simCursor) : this.rootProgress;
    let score = (prog - this.rootProgress)
      + o.speedWeight * (st ? st.speedKmh : 0) * 10
      - o.airtimeWeight * airtime
      - o.slipWeight * slip
      - o.overspeedWeight * overspeed
      - o.regressWeight * Math.max(0, this._potRegress - 3)
      + o.cpBonus * Math.max(0, (st ? st.nextCheckpointIndex : 0) - this._rootCpCache);
    let finishInfo = null;
    if (finished && st && st.finishFrames != null) {
      score += o.finishBonus - o.finishFrameWeight * st.finishFrames;
      finishInfo = { frames: st.finishFrames, path: path.slice(0, stepped).concat(rolloutMasks || []) };
    }

    const norm = Math.tanh(score / 400);
    let n = tree;
    n.n++; n.w += norm;
    for (let i = 0; i < stepped; i++) {
      n = n.children[path[i]];
      if (!n) break;
      n.n++; n.w += norm;
    }
    return { score, finish: finishInfo };
  }

  _initActions(node, blockIndex, dec) {
    const baseMask = this.baseChannels ? (maskAtFrame(this.baseChannels, blockIndex * dec) & 15) : 1;
    const order = [];
    const seen = new Set();
    const push = (a) => { if (a >= 0 && a < 16 && !seen.has(a)) { seen.add(a); order.push(a); } };
    push(baseMask);
    push(1); push(1 | 2); push(1 | 8); push(baseMask | 1);
    push(1 | 4); push(1 | 2 | 4); push(1 | 8 | 4);
    push(0); push(2); push(8); push(4);
    for (let a = 0; a < 16; a++) push(a);
    // untried starts with just the best prior; progressive widening pulls
    // more from `rest` as the node earns visits.
    node.untried = [order[0]];
    node.rest = order.slice(1).reverse();
  }

  _rollout(startBlock, dec, st0) {
    const o = this.o;
    const sim = this.sim;
    const steps = Math.round(o.rolloutMs / o.rolloutDecisionMs);
    const perDecision = Math.round(o.rolloutDecisionMs / dec);
    let st = st0;
    let airtime = 0, slip = 0, overspeed = 0;
    let px = 0, pz = 0, have = st0 != null;
    if (have) { px = st0.x; pz = st0.z; }
    let mask = 1;
    const masks = [];
    let finished = false;
    let block = startBlock;
    for (let i = 0; i < steps; i++) {
      // Follow base inputs while they exist; beyond a PARTIAL base's end,
      // fall back to the route-following steering controller. An epsilon of
      // seeded randomness keeps parallel workers' searches DIVERSE — with
      // fully deterministic rollouts every worker explores identically and
      // root parallelization degenerates to one search times N.
      if (this.baseChannels && block * dec < this._baseEndFrame && this.rng() > 0.15) {
        mask = maskAtFrame(this.baseChannels, block * dec) & 15;
      } else {
        mask = this._steerMask(st, px, pz);
        const r = this.rng();
        if (r < 0.10) mask ^= 4;            // brake flip
        else if (r < 0.18) mask ^= (r < 0.14 ? 2 : 8); // steer nudge
      }
      for (let k = 0; k < perDecision; k++) {
        if (have) { px = st.x; pz = st.z; }
        st = sim.stepMaskN(mask, dec);
        masks.push(mask);
        block++;
        airtime += st.wheelContacts === 0 ? 1 : 0;
        slip += this._slip(st, px, pz);
        overspeed += Math.max(0, st.speedKmh - this.g.speedCap(st.x, st.y, st.z, st.nextCheckpointIndex));
        this._blockProgress(st);
        have = true;
        if (st.finished) { finished = true; break; }
      }
      if (finished) break;
    }
    return { st, airtime, slip, overspeed, finished, masks };
  }

  _steerMask(st, px, pz) {
    if (!st) return 1;
    const mx = st.x - px, mz = st.z - pz;
    const mmag = Math.hypot(mx, mz);
    if (mmag < 0.02) return 1;
    // Aim at the route a speed-scaled distance ahead, not the raw waypoint
    // (which cuts straight into inside barriers on chicanes).
    const aheadM = Math.max(9, st.speedKmh * 0.22);
    let target = this.g.routeTarget(st.x, st.y, st.z, st.nextCheckpointIndex, aheadM);
    let farTarget = null;
    if (!target) {
      const wp = this.g.targetFor(st.nextCheckpointIndex);
      if (!wp) return 1;
      target = wp.center;
    } else {
      farTarget = this.g.routeTarget(st.x, st.y, st.z, st.nextCheckpointIndex, aheadM + 20);
    }
    const tx = target[0] - st.x, tz = target[2] - st.z;
    const tmag = Math.hypot(tx, tz) || 1e-9;
    const cross = (mx * tz - mz * tx) / (mmag * tmag);
    const dot = (mx * tx + mz * tz) / (mmag * tmag);
    const lateralM = Math.abs(cross) * tmag; // absolute cross-track error
    let mask = 1;
    if (lateralM > 1.1 || Math.abs(cross) > 0.15 || dot < 0) mask |= cross > 0 ? 2 : 8;
    // Curvature lookahead: how much does the ROUTE bend between the near
    // and far targets? A controller that only reacts to current heading
    // error slams into every fast corner — it must brake for the bend it
    // can see coming, or no rollout ever demonstrates a threaded corner.
    let turn = 0;
    if (farTarget) {
      const bx = farTarget[0] - target[0], bz = farTarget[2] - target[2];
      const bmag = Math.hypot(bx, bz);
      if (bmag > 1) turn = 1 - (tx * bx + tz * bz) / (tmag * bmag);
    }
    const misal = Math.abs(cross) + Math.max(0, -dot);
    // The curvature speed-cap field is the primary braking authority.
    const cap = this.g.speedCap(st.x, st.y, st.z, st.nextCheckpointIndex);
    if (dot < -0.5 ||
      st.speedKmh > cap + 10 ||
      (st.speedKmh > 170 && misal > 0.20) ||
      (st.speedKmh > 110 && misal > 0.45) ||
      (st.speedKmh > 150 && turn > 0.30) ||
      (st.speedKmh > 90 && turn > 0.55)) {
      mask |= 4;
      if (st.speedKmh > cap + 45 ||
        (st.speedKmh > 200 && (misal > 0.5 || turn > 0.45)) ||
        (st.speedKmh > 140 && turn > 0.8)) {
        mask &= ~1; // lift throttle entirely
      }
    }
    return mask;
  }

  // ---- single-threaded driver (used by tests / no-pool runs) ---------------
  optimize(baseEntries) {
    const o = this.o;
    const dec = o.decimationMs;
    const lockN = Math.round(o.lockMs / dec);
    if (baseEntries) this.setBase(baseEntries);
    this.initRun();
    let stuckCount = 0, rewinds = 0;
    let gainEma = null;
    const t0 = performance.now();

    for (let window = 0; ; window++) {
      this.searchWindow(o.simsPerWindow);
      const trie = this.exportTrie(lockN);
      const minVisits = Math.max(12, Math.round(o.simsPerWindow * o.minVisitFrac));
      const lockedNow = WindowedMcts.chooseLock(trie, lockN, minVisits, o.minLockBlocks);
      const adv = this.advance(lockedNow);

      if (o.onWindow) o.onWindow({ window, locked: adv.lockedMs, progressGain: adv.gain, st: adv.st, bestFinish: this.bestFinish });
      if (o.log && window % 10 === 0) {
        o.log("mcts w" + window + " t=" + ((performance.now() - t0) / 1000).toFixed(0) + "s locked=" + adv.lockedMs +
          "ms cp=" + adv.st.nextCheckpointIndex + " prog=" + this.rootProgress.toFixed(1) +
          (this.bestFinish ? " bestFin=" + this.bestFinish.frames : ""));
      }

      if (adv.finished) return this._result(this.locked, dec, adv.st.finishFrames);
      if (this.bestFinish && this.locked.length * dec > this.bestFinish.frames + 400) {
        return this._result(this.bestFinish.locked.concat(this.bestFinish.tail), dec, this.bestFinish.frames);
      }
      if (this.locked.length * dec > o.maxRunMs) return this._result(this.locked, dec, null);

      gainEma = gainEma == null ? adv.gain : gainEma * 0.7 + adv.gain * 0.3;
      const pastLaunch = this.locked.length * dec > 1800;
      const lockSec = lockedNow.length * dec / 1000;
      if (pastLaunch && gainEma < 0.3 * lockSec / 0.15 && !adv.finished) stuckCount++;
      else stuckCount = 0;
      if (stuckCount >= o.stuckWindows && rewinds < o.maxRewinds && this.locked.length > 0) {
        if (o.log) o.log("mcts STUCK — rewinding (rewind #" + (rewinds + 1) + ")");
        const back = Math.round(1500 * Math.pow(2, Math.min(3, rewinds)) / dec);
        this.rewindTo(this.locked.length - back);
        stuckCount = 0;
        gainEma = null;
        rewinds++;
        this.reseed(this.o.seed ^ (rewinds * 0x9e3779b9));
      }
    }
  }

  _result(maskBlocks, dec, finishFrames) {
    const entries = [];
    let last = -1;
    for (let i = 0; i < maskBlocks.length; i++) {
      if (maskBlocks[i] !== last) { entries.push({ frame: i * dec, mask: maskBlocks[i] }); last = maskBlocks[i]; }
    }
    entries.push({ frame: maskBlocks.length * dec, mask: 0 });
    return { entries, finishFrames, bestFinish: this.bestFinish };
  }
}

function newNode() {
  return { n: 0, w: 0, kids: 0, children: new Array(N_ACTIONS).fill(null), untried: [], rest: null };
}

function bestChild(node, c, rng) {
  let best = -1, bestV = -Infinity;
  const logN = Math.log(Math.max(1, node.n));
  for (let a = 0; a < N_ACTIONS; a++) {
    const ch = node.children[a];
    if (!ch || ch.n === 0) continue;
    let v = c === 0 ? ch.n : (ch.w / ch.n + c * Math.sqrt(logN / ch.n));
    if (c !== 0 && rng) v += (rng() - 0.5) * 0.02; // per-worker tie-break jitter
    if (v > bestV) { bestV = v; best = a; }
  }
  return best;
}

function descend(tree, actions) {
  let n = tree;
  for (const a of actions) {
    n = n && n.children[a];
    if (!n) return null;
  }
  return n;
}

// Merge visit tries from parallel workers (sum n/w recursively).
function mergeTries(tries) {
  const out = { n: 0, w: 0, k: {} };
  const stack = tries.map((t) => [t, out]);
  for (const t of tries) {
    merge1(out, t);
  }
  return out;
  function merge1(dst, src) {
    dst.n += src.n;
    dst.w += src.w;
    for (const [a, ch] of Object.entries(src.k)) {
      if (!dst.k[a]) dst.k[a] = { n: 0, w: 0, k: {} };
      merge1(dst.k[a], ch);
    }
  }
}

module.exports = { WindowedMcts, mergeTries, MCTS_DEFAULTS: DEFAULTS, N_ACTIONS 