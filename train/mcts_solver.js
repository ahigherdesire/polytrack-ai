// Windowed MCTS lap solver — the search that actually finds fast finishing
// laps (unlike ES, which stalls). Adapted from the reference TAS pipeline's
// Phase-3 optimizer to run on this project's Headless062 sim + geodesic
// Guidance field.
//
// UCT over the 16 discrete input masks (up/right/down/left; reset excluded),
// action-decimated to `decimationMs` blocks, confined to a sliding window:
//   - search a window of `windowMs` from the current locked frontier,
//   - rollouts look ahead and are scored by geodesic progress + exit velocity
//     minus airtime / slip / overspeed / regression,
//   - lock the most-visited action chain (confidence-gated), slide, repeat.
// It drives purely on the potential field, so it works from scratch.
'use strict';

const N_ACTIONS = 16;

const DEFAULTS = {
  windowMs: 450,
  decimationMs: 10,
  lockMs: 100,
  minLockBlocks: 3,
  simsPerWindow: 220,
  rolloutMs: 500,
  rolloutDecisionMs: 50,
  ucbC: 0.7,
  pwExponent: 0.5,        // progressive-widening exponent: lower = fewer actions
                         //   explored per node = deeper, more confident locks.
  maxRunMs: 60000,
  stuckWindows: 10,
  maxRewinds: 10,
  minVisitFrac: 0.02,
  finishBonus: 5e6,
  finishFrameWeight: 25,
  airtimeWeight: 0.25,
  slipWeight: 0.8,
  slipThreshold: 0.30,
  speedWeight: 0.012,
  overspeedWeight: 0.04,
  regressWeight: 3,
  cpBonus: 600,
  launchMs: 1800,
  seed: 987654321,
  wallBudgetMs: Infinity,
  log: null,
  onWindow: null,
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class WindowedMcts {
  constructor(sim, guidance, opts = {}) {
    this.sim = sim;
    this.g = guidance;
    this.o = { ...DEFAULTS, ...opts };
    this.rng = mulberry32(this.o.seed);
  }

  // Convert a decoded Headless062 state to the flat shape the search uses.
  _flat(s) {
    if (!s) return null;
    return {
      x: s.position.x, y: s.position.y, z: s.position.z,
      qx: s.quaternion.x, qy: s.quaternion.y, qz: s.quaternion.z, qw: s.quaternion.w,
      speedKmh: s.speedKmh,
      wheelContacts: s.wheelContact ? s.wheelContact.filter(Boolean).length : 4,
      nextCheckpointIndex: s.nextCheckpointIndex,
      finished: s.finishFrames !== null,
      finishFrames: s.finishFrames,
    };
  }

  _stepN(mask, n) { return this._flat(this.sim.stepMaskN(mask, n)); }

  // ---- progress + penalties -------------------------------------------------
  _progress(st) {
    if (!st) return this.rootProgress;
    return -this.g.potential(st.x, st.y, st.z, st.nextCheckpointIndex);
  }

  _blockProgress(st) {
    const pg = this._progress(st);
    if (this._lastPg != null && pg < this._lastPg - 0.02) this._potRegress += this._lastPg - pg;
    this._lastPg = pg;
    return pg;
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
    const cos = Math.abs((vx * fx + vz * fz) / (vmag * fmag));
    return Math.max(0, Math.acos(Math.min(1, cos)) - this.o.slipThreshold);
  }

  // ---- run lifecycle --------------------------------------------------------
  initRun() {
    this.locked = [];
    this.sim.reset();
    this.rootSnap = this.sim.snapshot();
    this._rootBufA = this.rootSnap; this._rootBufB = null; this._rootBufToggle = true;
    this.tree = newNode();
    this.bestFinish = null;
    this.rootProgress = this._progressOfRoot();
  }

  _progressOfRoot() {
    this.sim.restore(this.rootSnap);
    const st = this._flat(this.sim.stepMask(0));
    this._rootCpCache = st ? st.nextCheckpointIndex : 0;
    this._rootFinished = st ? st.finished : false;
    this._rootState = st ? { ...st } : { nextCheckpointIndex: 0 };
    const p = st ? -this.g.potential(st.x, st.y, st.z, st.nextCheckpointIndex) : 0;
    this.sim.restore(this.rootSnap);
    return p;
  }

  searchWindow(sims) {
    const perWin = Math.round(this.o.windowMs / this.o.decimationMs);
    let winBest = -Infinity;
    this._pv = null;
    const pvAt = Math.max(8, Math.floor(sims * 0.3));
    for (let s = 0; s < sims; s++) {
      if (s === pvAt) this._buildPvCache(perWin);
      const r = this._simulate(perWin);
      if (r.score > winBest) winBest = r.score;
      if (r.finish && (!this.bestFinish || r.finish.frames < this.bestFinish.frames)) {
        this.bestFinish = { frames: r.finish.frames, locked: this.locked.slice(), tail: r.finish.path };
      }
    }
    return winBest;
  }

  // Snapshot the state at the end of the current most-visited prefix, with the
  // penalty aggregates along it, so sims following the principal variation skip
  // re-stepping its physics.
  _buildPvCache(perWin) {
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
    this.sim.restore(this.rootSnap);
    let airtime = 0, slip = 0, overspeed = 0;
    let px = 0, pz = 0, have = false;
    this._lastPg = this.rootProgress;
    this._potRegress = 0;
    let st = null;
    for (const a of actions) {
      if (have) { px = st.x; pz = st.z; }
      st = this._stepN(a, dec);
      if (!st) break;
      airtime += st.wheelContacts === 0 ? 1 : 0;
      if (have) slip += this._slip(st, px, pz);
      overspeed += Math.max(0, st.speedKmh - this.g.speedCap(st.x, st.y, st.z, st.nextCheckpointIndex));
      this._blockProgress(st);
      have = true;
      if (st.finished) break;
    }
    this._pv = {
      actions, snap: this.sim.snapshot(this._pvSnapBuf),
      airtime, slip, overspeed, regress: this._potRegress, lastPg: this._lastPg,
      st: st ? { ...st } : null,
    };
    this._pvSnapBuf = this._pv.snap;
  }

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
    if (ranOut) { while (chain.length < minLock) chain.push(chain[chain.length - 1]); }
    return chain;
  }

  advance(lockedNow) {
    const dec = this.o.decimationMs;
    this.sim.restore(this.rootSnap);
    let st = null;
    for (const a of lockedNow) st = this._stepN(a, dec);
    this.locked.push(...lockedNow);
    const buf = this._rootBufToggle ? this._rootBufA : this._rootBufB;
    this._rootBufToggle = !this._rootBufToggle;
    this.rootSnap = this.sim.snapshot(buf);
    if (this._rootBufToggle) this._rootBufA = this.rootSnap; else this._rootBufB = this.rootSnap;
    const newProgress = this._progressOfRoot();
    const gain = newProgress - this.rootProgress;
    this.rootProgress = newProgress;
    this.tree = descend(this.tree, lockedNow) || newNode();
    return { gain, lockedMs: this.locked.length * dec, st: this._rootState, finished: this._rootFinished };
  }

  rewindTo(toLockedLen) {
    const dec = this.o.decimationMs;
    const len = Math.max(0, Math.min(this.locked.length, toLockedLen));
    this.locked.length = len;
    this.sim.reset();
    for (let i = 0; i < len; i++) this.sim.stepMaskN(this.locked[i], dec);
    this.rootSnap = this.sim.snapshot();
    this._rootBufA = this.rootSnap; this._rootBufB = null; this._rootBufToggle = true;
    this.tree = newNode();
    this.rootProgress = this._progressOfRoot();
    return this.locked.length;
  }

  reseed(seed) { this.rng = mulberry32(seed >>> 0); }

  // Drive the geodesic rollout policy open-loop from the start line and return
  // the decimated mask blocks — plus the block index at which the car last had
  // healthy forward progress (so callers can seed only the reliably-driven
  // prefix and hand the hard part to search). Cheap: one physics pass, no tree.
  greedyBlocks(maxFrames) {
    const dec = this.o.decimationMs;
    this.sim.reset();
    let s = this.sim.stepMask(0);
    let px = s.position.x, pz = s.position.z;
    const blocks = [];
    let lastProg = -this.g.potential(s.position.x, s.position.y, s.position.z, s.nextCheckpointIndex);
    let bestProg = lastProg, bestBlock = 0, stallBlocks = 0, maxCp = s.nextCheckpointIndex;
    for (let f = 0; f < maxFrames; f += dec) {
      const st = this._flat(s);
      const mask = this._steerMask(st, px, pz);
      px = s.position.x; pz = s.position.z;
      let last = null;
      for (let k = 0; k < dec; k++) { last = this.sim.stepMask(mask); if (!last) break; }
      if (!last) break;
      s = last; blocks.push(mask);
      const prog = -this.g.potential(s.position.x, s.position.y, s.position.z, s.nextCheckpointIndex);
      if (s.nextCheckpointIndex > maxCp) { maxCp = s.nextCheckpointIndex; }
      // "Healthy" = still gaining ground and carrying speed. Track the furthest
      // such point; if progress stalls for a while, stop trusting greedy.
      if (prog > bestProg + 0.5 && s.speedKmh > 40) { bestProg = prog; bestBlock = blocks.length; stallBlocks = 0; }
      else if (prog < lastProg + 0.05 || s.speedKmh < 25) { stallBlocks++; }
      lastProg = prog;
      if (s.finishFrames !== null) return { blocks, safeLen: blocks.length, finished: true, finishFrames: s.finishFrames, maxCp };
      if (stallBlocks > 40) break; // ~0.8s of no progress -> greedy is stuck
    }
    return { blocks, safeLen: bestBlock, finished: false, finishFrames: null, maxCp };
  }

  // Adopt a pre-driven mask sequence as the locked prefix and set the search
  // root at its end (physics replayed deterministically). Returns arrival state.
  seedLocked(blocks) {
    this.locked = blocks.slice();
    this.rewindTo(this.locked.length);
    this.bestFinish = null;
    return { lockedMs: this.locked.length * this.o.decimationMs, st: this._rootState, cp: this._rootState.nextCheckpointIndex };
  }

  // ---- one simulation -------------------------------------------------------
  _simulate(perWin) {
    const o = this.o, dec = o.decimationMs;

    // Phase A: dry tree walk (UCT/expansion need node stats only).
    const path = [];
    let node = this.tree, depth = 0;
    while (depth < perWin) {
      if (node.rest === null) this._initActions(node);
      const allowKids = Math.max(1, Math.floor(Math.pow(node.n + 1, o.pwExponent)));
      if (!node.untried.length && node.rest.length && node.kids < allowKids) node.untried.push(node.rest.pop());
      const expanding = node.untried.length > 0 && node.kids < allowKids;
      const action = expanding ? node.untried.pop() : bestChild(node, o.ucbC, this.rng);
      if (action < 0) break;
      path.push(action);
      let child = node.children[action];
      if (!child) { child = newNode(); node.children[action] = child; node.kids++; }
      node = child; depth++;
      if (expanding) break;
    }

    // Phase B: physics (PV cache fast path).
    let st = null, airtime = 0, slip = 0, overspeed = 0, px = 0, pz = 0, have = false;
    let finished = this._rootFinished || false;
    this._lastPg = this.rootProgress; this._potRegress = 0;
    let start = 0;
    const pv = this._pv;
    if (pv && pv.st && path.length >= pv.actions.length) {
      let match = true;
      for (let i = 0; i < pv.actions.length; i++) if (path[i] !== pv.actions[i]) { match = false; break; }
      if (match) {
        this.sim.restore(pv.snap);
        airtime = pv.airtime; slip = pv.slip; overspeed = pv.overspeed;
        this._lastPg = pv.lastPg; this._potRegress = pv.regress;
        st = { ...pv.st }; px = st.x; pz = st.z; have = true; finished = !!st.finished;
        start = pv.actions.length;
      } else this.sim.restore(this.rootSnap);
    } else this.sim.restore(this.rootSnap);

    let stepped = start;
    for (let i = start; i < path.length && !finished; i++) {
      if (have && st) { px = st.x; pz = st.z; }
      st = this._stepN(path[i], dec);
      if (!st) break;
      airtime += st.wheelContacts === 0 ? 1 : 0;
      if (have) slip += this._slip(st, px, pz);
      overspeed += Math.max(0, st.speedKmh - this.g.speedCap(st.x, st.y, st.z, st.nextCheckpointIndex));
      this._blockProgress(st);
      have = true; stepped = i + 1;
      if (st.finished) finished = true;
    }

    let rolloutMasks = null;
    if (!finished) {
      const r = this._rollout(dec, st);
      airtime += r.airtime; slip += r.slip; overspeed += r.overspeed;
      st = r.st; finished = r.finished; rolloutMasks = r.masks;
    }

    const prog = st ? this._progress(st) : this.rootProgress;
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
    let n = this.tree; n.n++; n.w += norm;
    for (let i = 0; i < stepped; i++) { n = n.children[path[i]]; if (!n) break; n.n++; n.w += norm; }
    return { score, finish: finishInfo };
  }

  _initActions(node) {
    const order = [];
    const seen = new Set();
    const push = (a) => { if (a >= 0 && a < 16 && !seen.has(a)) { seen.add(a); order.push(a); } };
    push(1); push(1 | 2); push(1 | 8); push(1 | 4); push(1 | 2 | 4); push(1 | 8 | 4);
    push(0); push(2); push(8); push(4);
    for (let a = 0; a < 16; a++) push(a);
    node.untried = [order[0]];
    node.rest = order.slice(1).reverse();
  }

  _rollout(dec, st0) {
    const o = this.o;
    const steps = Math.round(o.rolloutMs / o.rolloutDecisionMs);
    const perDecision = Math.round(o.rolloutDecisionMs / dec);
    let st = st0, airtime = 0, slip = 0, overspeed = 0;
    let px = 0, pz = 0, have = st0 != null;
    if (have) { px = st0.x; pz = st0.z; }
    let mask = 1; const masks = []; let finished = false;
    for (let i = 0; i < steps; i++) {
      mask = this._steerMask(st, px, pz);
      const r = this.rng();
      if (r < 0.10) mask ^= 4; else if (r < 0.18) mask ^= (r < 0.14 ? 2 : 8);
      for (let k = 0; k < perDecision; k++) {
        if (have && st) { px = st.x; pz = st.z; }
        st = this._stepN(mask, dec);
        if (!st) { finished = false; break; }
        masks.push(mask);
        airtime += st.wheelContacts === 0 ? 1 : 0;
        slip += this._slip(st, px, pz);
        overspeed += Math.max(0, st.speedKmh - this.g.speedCap(st.x, st.y, st.z, st.nextCheckpointIndex));
        this._blockProgress(st);
        have = true;
        if (st.finished) { finished = true; break; }
      }
      if (finished || !st) break;
    }
    return { st, airtime, slip, overspeed, finished, masks };
  }

  _steerMask(st, px, pz) {
    if (!st) return 1;
    const mx = st.x - px, mz = st.z - pz;
    const mmag = Math.hypot(mx, mz);
    if (mmag < 0.02) return 1;
    const aheadM = Math.max(9, st.speedKmh * 0.22);
    let target = this.g.routeTarget(st.x, st.y, st.z, st.nextCheckpointIndex, aheadM);
    let farTarget = null;
    if (!target) {
      const wp = this.g.checkpoints[st.nextCheckpointIndex] || this.g.finishes[0];
      if (!wp) return 1;
      target = wp.center;
    } else {
      farTarget = this.g.routeTarget(st.x, st.y, st.z, st.nextCheckpointIndex, aheadM + 20);
    }
    const tx = target[0] - st.x, tz = target[2] - st.z;
    const tmag = Math.hypot(tx, tz) || 1e-9;
    const cross = (mx * tz - mz * tx) / (mmag * tmag);
    const dot = (mx * tx + mz * tz) / (mmag * tmag);
    const lateralM = Math.abs(cross) * tmag;
    let mask = 1;
    if (lateralM > 1.1 || Math.abs(cross) > 0.15 || dot < 0) mask |= cross > 0 ? 2 : 8;
    let turn = 0;
    if (farTarget) {
      const bx = farTarget[0] - target[0], bz = farTarget[2] - target[2];
      const bmag = Math.hypot(bx, bz);
      if (bmag > 1) turn = 1 - (tx * bx + tz * bz) / (tmag * bmag);
    }
    const misal = Math.abs(cross) + Math.max(0, -dot);
    const cap = this.g.speedCap(st.x, st.y, st.z, st.nextCheckpointIndex);
    if (dot < -0.5 || st.speedKmh > cap + 10 ||
      (st.speedKmh > 170 && misal > 0.20) || (st.speedKmh > 110 && misal > 0.45) ||
      (st.speedKmh > 150 && turn > 0.30) || (st.speedKmh > 90 && turn > 0.55)) {
      mask |= 4;
      if (st.speedKmh > cap + 45 || (st.speedKmh > 200 && (misal > 0.5 || turn > 0.45)) ||
        (st.speedKmh > 140 && turn > 0.8)) mask &= ~1;
    }
    return mask;
  }

  // ---- driver ---------------------------------------------------------------
  optimize() {
    const o = this.o, dec = o.decimationMs;
    const lockN = Math.round(o.lockMs / dec);
    this.initRun();
    let stuckCount = 0, rewinds = 0, gainEma = null;
    const t0 = Date.now();

    for (let window = 0; ; window++) {
      this.searchWindow(o.simsPerWindow);
      const trie = this.exportTrie(lockN);
      const minVisits = Math.max(12, Math.round(o.simsPerWindow * o.minVisitFrac));
      const lockedNow = WindowedMcts.chooseLock(trie, lockN, minVisits, o.minLockBlocks);
      const adv = this.advance(lockedNow);

      if (o.onWindow) o.onWindow({ window, locked: adv.lockedMs, progressGain: adv.gain, st: adv.st, bestFinish: this.bestFinish });
      if (o.log && window % 10 === 0) {
        o.log(`mcts w${window} t=${((Date.now() - t0) / 1000).toFixed(0)}s locked=${adv.lockedMs}ms cp=${adv.st.nextCheckpointIndex} prog=${this.rootProgress.toFixed(1)}` +
          (this.bestFinish ? ` bestFin=${(this.bestFinish.frames / 1000).toFixed(3)}s` : ''));
      }

      if (adv.finished) return this._result(this.locked, dec, adv.st.finishFrames);
      if (this.bestFinish && this.locked.length * dec > this.bestFinish.frames + 400) {
        return this._result(this.bestFinish.locked.concat(this.bestFinish.tail), dec, this.bestFinish.frames);
      }
      if (this.locked.length * dec > o.maxRunMs) return this._result(this.locked, dec, null);
      if (Date.now() - t0 > o.wallBudgetMs) {
        if (this.bestFinish) return this._result(this.bestFinish.locked.concat(this.bestFinish.tail), dec, this.bestFinish.frames);
        return this._result(this.locked, dec, null);
      }

      gainEma = gainEma == null ? adv.gain : gainEma * 0.7 + adv.gain * 0.3;
      const pastLaunch = this.locked.length * dec > o.launchMs;
      const lockSec = lockedNow.length * dec / 1000;
      if (pastLaunch && gainEma < 0.3 * lockSec / 0.15 && !adv.finished) stuckCount++; else stuckCount = 0;
      if (stuckCount >= o.stuckWindows && rewinds < o.maxRewinds && this.locked.length > 0) {
        if (o.log) o.log(`mcts STUCK — rewinding (#${rewinds + 1})`);
        const back = Math.round(1500 * Math.pow(2, Math.min(3, rewinds)) / dec);
        this.rewindTo(this.locked.length - back);
        stuckCount = 0; gainEma = null; rewinds++;
        this.reseed(o.seed ^ (rewinds * 0x9e3779b9));
      }
    }
  }

  // Convert a mask-per-block sequence into a per-frame action list (what the
  // recording bridge / es_lap.json consumes) plus the frame at each toggle.
  _result(maskBlocks, dec, finishFrames) {
    const actions = [];
    for (let i = 0; i < maskBlocks.length; i++) {
      const c = Headless062Controls(maskBlocks[i]);
      for (let f = 0; f < dec; f++) actions.push(c);
      if (finishFrames != null && actions.length >= finishFrames) break;
    }
    return { actions, finishFrames, finishSeconds: finishFrames != null ? finishFrames / 1000 : null, maskBlocks, decimationMs: dec, bestFinish: this.bestFinish };
  }
}

function Headless062Controls(mask) {
  return { up: !!(mask & 1), right: !!(mask & 2), down: !!(mask & 4), left: !!(mask & 8), reset: false };
}

function newNode() { return { n: 0, w: 0, kids: 0, children: new Array(N_ACTIONS).fill(null), untried: [], rest: null }; }

function bestChild(node, c, rng) {
  let best = -1, bestV = -Infinity;
  const logN = Math.log(Math.max(1, node.n));
  for (let a = 0; a < N_ACTIONS; a++) {
    const ch = node.children[a];
    if (!ch || ch.n === 0) continue;
    let v = c === 0 ? ch.n : (ch.w / ch.n + c * Math.sqrt(logN / ch.n));
    if (c !== 0 && rng) v += (rng() - 0.5) * 0.02;
    if (v > bestV) { bestV = v; best = a; }
  }
  return best;
}

function descend(tree, actions) {
  let n = tree;
  for (const a of actions) { n = n && n.children[a]; if (!n) return null; }
  return n;
}

// Merge visit tries from parallel root-parallel workers (sum n/w recursively).
function mergeTries(tries) {
  const out = { n: 0, w: 0, k: {} };
  for (const t of tries) if (t) merge1(out, t);
  return out;
  function merge1(dst, src) {
    dst.n += src.n; dst.w += src.w;
    for (const [a, ch] of Object.entries(src.k)) {
      if (!dst.k[a]) dst.k[a] = { n: 0, w: 0, k: {} };
      merge1(dst.k[a], ch);
    }
  }
}

module.exports = { WindowedMcts, MCTS_DEFAULTS: DEFAULTS, mulberry32, mergeTries, maskToControls: Headless062Controls };
