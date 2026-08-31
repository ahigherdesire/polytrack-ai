// Geodesic track guidance for the search-based solver.
//
// The old reward used raw Euclidean distance to the next checkpoint. On a
// winding track that is a terrible gradient: driving *along* the road barely
// changes it, and it happily points the car straight through walls. This
// module builds a proper cost-to-go field instead — Dijkstra over the graph of
// occupied road cells, seeded from each waypoint (checkpoints in order, then
// the finish). `potential(x,y,z,cpIdx)` returns metres of track left to drive
// (lower = better); `routeTarget(...)` gives an on-road steering aim ahead of
// the car; `speedCap(...)` gives a curvature-derived speed limit.
//
// Cells are voxelised straight from the driveable road triangles that
// track_sensors already builds (`occ.surfaces3d`), so the graph only contains
// real road — no "open plaza" cells behind barriers to route through.
const { CELL, gridToWorld, partRotationQuat, quatRotate } = require('../sim/geom');

const FINISH_DETECTOR = 1;      // detector.type: 0 = Checkpoint, 1 = Finish
const CHECKPOINT_DETECTOR = 0;

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [v[p], v[i]] = [v[i], v[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [v[m], v[i]] = [v[i], v[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

class Guidance {
  // parts: sim._parts (placed parts). configs: sim._trackPartConfigs.
  // occ: mesh occupancy from buildOccupancy (needs surfaces3d).
  constructor(parts, configs, occ) {
    this.ps = CELL;
    const cfg = new Map((configs || []).map((c) => [c.id, c]));

    // ---- waypoint boxes (checkpoints in order, then finishes) --------------
    const checkpoints = [];
    const finishes = [];
    for (const p of parts || []) {
      const config = cfg.get(p[3]);
      if (!config || !config.detector) continue;
      const q = partRotationQuat(p[4], p[5]);
      const base = gridToWorld({ x: p[0], y: p[1], z: p[2] });
      const c = quatRotate(q, { x: config.detector.center[0], y: config.detector.center[1], z: config.detector.center[2] });
      const s = quatRotate(q, { x: config.detector.size[0], y: config.detector.size[1], z: config.detector.size[2] });
      const box = {
        center: [base.x + c.x, base.y + c.y, base.z + c.z],
        half: [Math.abs(s.x) / 2, Math.abs(s.y) / 2, Math.abs(s.z) / 2],
      };
      if (config.detector.type === FINISH_DETECTOR) finishes.push(box);
      else if (config.detector.type === CHECKPOINT_DETECTOR) checkpoints.push({ order: p[7], ...box });
    }
    checkpoints.sort((a, b) => a.order - b.order);
    this.checkpoints = checkpoints;
    this.finishes = finishes;
    this.checkpointCount = checkpoints.length;

    // ---- occupied road cells (voxelise the driveable surface triangles) ----
    const ps = this.ps;
    const cellSet = new Set();
    let cells = [];
    const key = (x, y, z) => ((x + 1024) | ((y + 1024) << 11)) * 2048 + (z + 1024);
    const addCell = (x, y, z) => {
      const cx = Math.floor(x / ps), cy = Math.floor(y / ps), cz = Math.floor(z / ps);
      const k = key(cx, cy, cz);
      if (!cellSet.has(k)) { cellSet.add(k); cells.push([cx, cy, cz]); }
    };
    for (const t of (occ && occ.surfaces3d) || []) {
      // Skip down-facing faces: the underside of a road/deck slab is never
      // drivable, but the occupancy mesh keeps both faces. Voxelising undersides
      // spawns phantom cells a slab-thickness below the real road that the
      // geodesic then routes through. (World up is +y; a real driving surface
      // faces up.)
      if (t.normal && t.normal.y <= 0.15) continue;
      const e1 = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y, t.b.z - t.a.z);
      const e2 = Math.hypot(t.c.x - t.a.x, t.c.y - t.a.y, t.c.z - t.a.z);
      const n = Math.max(1, Math.min(12, Math.ceil(Math.max(e1, e2) / (ps * 0.5))));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          const u = i / n, w = j / n;
          addCell(
            t.a.x + (t.b.x - t.a.x) * u + (t.c.x - t.a.x) * w,
            t.a.y + (t.b.y - t.a.y) * u + (t.c.y - t.a.y) * w,
            t.a.z + (t.b.z - t.a.z) * u + (t.c.z - t.a.z) * w,
          );
        }
      }
    }
    // Drop "shadowed" floor cells: where a road cell sits 1-3 cells (~5-15 m)
    // directly above another in the same column, only the top is real drivable
    // road — the lower one is the ground/floor under an elevated section. The
    // car keeps falling onto those floors, which dead-end at the wall where the
    // elevated road steps up. A genuine stacked road (tunnel/underpass) needs
    // far more head-room than 3 cells, so this leaves real multi-level road
    // intact while deleting the phantom floor. (Ramps rise in x/z, not in a
    // single vertical column, so they are unaffected.)
    {
      const present = new Set(cells.map((c) => key(c[0], c[1], c[2])));
      const kept = [];
      for (const c of cells) {
        // Only a LOW cell (near ground level) that has road directly above is a
        // phantom floor; genuine stacked road levels sit higher up and are kept.
        const lowEnough = (c[1] + 0.5) * ps < 2.5;
        let shadowed = false;
        if (lowEnough) for (let dy = 1; dy <= 3; dy++) if (present.has(key(c[0], c[1] + dy, c[2]))) { shadowed = true; break; }
        if (!shadowed) kept.push(c);
      }
      cells = kept;
    }
    this.cells = cells;
    this._key = key;
    this._index = new Map();
    for (let i = 0; i < cells.length; i++) this._index.set(key(cells[i][0], cells[i][1], cells[i][2]), i);
  }

  ready() { return this.cells.length > 0 && (this.checkpoints.length > 0 || this.finishes.length > 0); }

  // ---- geodesic potential field --------------------------------------------
  buildPotentials({ neighborRadius = 3 } = {}) {
    const cells = this.cells;
    const n = cells.length;
    const ps = this.ps;
    const index = this._index;
    const key = this._key;

    // Neighbour offsets. Radius-1 links model contiguous road; longer links
    // bridge jump gaps and carry a surcharge so the field never prefers
    // tunnelling through a barrier over driving around it. Climbing costs
    // extra (cars need ramps).
    const R = neighborRadius;
    const offsets = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          if (!dx && !dy && !dz) continue;
          const cheb = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
          const mult = cheb === 1 ? 1 : cheb === 2 ? 2.6 : 3.4;
          const climb = Math.max(0, dy) * ps * 0.5;
          offsets.push([dx, dy, dz, Math.hypot(dx, dy, dz) * ps * mult + climb]);
        }
      }
    }
    // Long-drop links: cars fall much further than the cube radius.
    for (let dy = -10; dy <= -(R + 1); dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        for (let dz = -4; dz <= 4; dz++) {
          offsets.push([dx, dy, dz, Math.hypot(dx, dy, dz) * ps * 3.0]);
        }
      }
    }

    // Wallness: horizontal neighbours missing around a cell. Weighting edges by
    // the target cell's wallness pulls geodesics toward the road centre.
    const wallness = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const cx = cells[i][0], cy = cells[i][1], cz = cells[i][2];
      let present = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          for (let dy = -1; dy <= 1; dy++) {
            if (index.has(key(cx + dx, cy + dy, cz + dz))) { present++; break; }
          }
        }
      }
      wallness[i] = 8 - present;
    }

    const nbr = new Array(n);
    for (let i = 0; i < n; i++) {
      const cx = cells[i][0], cy = cells[i][1], cz = cells[i][2];
      const list = [];
      for (const [dx, dy, dz, w] of offsets) {
        const j = index.get(key(cx + dx, cy + dy, cz + dz));
        if (j != null) {
          const ww = w * (1 + 0.08 * wallness[j]);
          list.push(j, ww, dy);
        }
      }
      // Flight links: launched jumps far beyond the cube radius.
      for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        outer:
        for (let r = R + 1; r <= 14; r++) {
          for (let dy = 2; dy >= -10; dy--) {
            const j = index.get(key(cx + ux * r, cy + dy, cz + uz * r));
            if (j != null) {
              const dist = Math.hypot(ux * r, dy, uz * r) * ps;
              list.push(j, dist * (3.0 + 0.1 * r), dy);
              break outer;
            }
          }
        }
      }
      nbr[i] = list;
    }
    this._nbr = nbr;

    // Waypoint sequence.
    const targets = [];
    for (const cp of this.checkpoints) targets.push([cp]);
    if (this.finishes.length) targets.push(this.finishes);

    const maps = [];
    for (const boxes of targets) {
      const dist = new Float64Array(n).fill(Infinity);
      const heap = new MinHeap();
      for (let i = 0; i < n; i++) {
        const wx = (cells[i][0] + 0.5) * ps, wy = (cells[i][1] + 0.5) * ps, wz = (cells[i][2] + 0.5) * ps;
        for (const b of boxes) {
          const m = ps;
          if (Math.abs(wx - b.center[0]) <= b.half[0] + m &&
            Math.abs(wy - b.center[1]) <= b.half[1] + m + 2 &&
            Math.abs(wz - b.center[2]) <= b.half[2] + m) {
            dist[i] = 0; heap.push(i, 0); break;
          }
        }
      }
      while (heap.size) {
        const [u, du] = heap.pop();
        if (du > dist[u]) continue;
        const list = nbr[u];
        for (let k = 0; k < list.length; k += 3) {
          const v = list[k];
          const w = list[k + 1];
          const climbMove = -list[k + 2]; // car moves v -> u
          if (climbMove > 2) continue;    // can't climb > 2 cells without a ramp chain
          if (du + w < dist[v]) { dist[v] = du + w; heap.push(v, du + w); }
        }
      }
      // Downhill gradient per cell (de-quantises the potential inside a cell).
      const grad = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dist[i])) continue;
        const list = nbr[i];
        let bx = 0, by = 0, bz = 0, bestDrop = 0;
        for (let k = 0; k < list.length; k += 3) {
          const j = list[k], w = list[k + 1];
          const drop = (dist[i] - dist[j]) / w;
          if (drop > bestDrop) { bestDrop = drop; bx = cells[j][0] - cells[i][0]; by = cells[j][1] - cells[i][1]; bz = cells[j][2] - cells[i][2]; }
        }
        const m = Math.hypot(bx, by, bz);
        if (m > 0) { grad[i * 3] = bx / m; grad[i * 3 + 1] = by / m; grad[i * 3 + 2] = bz / m; }
      }
      maps.push({ dist, grad });
    }
    this.potentialMaps = maps;

    // Chain tail so the potential is comparable across checkpoint indices.
    const chain = new Float64Array(maps.length).fill(0);
    for (let k = maps.length - 2; k >= 0; k--) {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (maps[k].dist[i] === 0 && maps[k + 1].dist[i] < best) best = maps[k + 1].dist[i];
      }
      if (!Number.isFinite(best)) best = 200;
      chain[k] = best + chain[k + 1];
    }
    this.potentialChain = chain;
    this.buildSpeedCaps();
    return this;
  }

  // ---- curvature speed caps -------------------------------------------------
  buildSpeedCaps() {
    const ps = this.ps;
    const n = this.cells.length;
    this.speedCaps = [];
    for (let k = 0; k < this.potentialMaps.length; k++) {
      const dist = this.potentialMaps[k].dist;
      const caps = new Float32Array(n).fill(999);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dist[i])) continue;
        let cell = i, travelled = 0, horiz = 0;
        let pMid = null, pFar = null, pEnd = null;
        const p0 = this.cells[i];
        for (let s = 0; s < 20; s++) {
          const list = this._nbr[cell];
          let best = -1, bestD = dist[cell];
          for (let m = 0; m < list.length; m += 3) { if (dist[list[m]] < bestD) { bestD = dist[list[m]]; best = list[m]; } }
          if (best < 0) break;
          const a = this.cells[cell], b = this.cells[best];
          travelled += Math.hypot((b[0] - a[0]) * ps, (b[1] - a[1]) * ps, (b[2] - a[2]) * ps);
          horiz += Math.hypot((b[0] - a[0]) * ps, (b[2] - a[2]) * ps);
          cell = best; pEnd = this.cells[cell];
          if (!pMid && travelled >= 18) pMid = this.cells[cell];
          if (travelled >= 38) { pFar = this.cells[cell]; break; }
        }
        // Descent cap: a steep downhill ahead flings the car airborne and it
        // overshoots the landing onto whatever lies beyond (here, a dead-end
        // lower deck). Cap the approach so the car stays grounded and lands on
        // the road it's actually driving. Grade = metres dropped / metres forward.
        if (pEnd) {
          const drop = (p0[1] - pEnd[1]) * ps;
          const grade = drop / Math.max(horiz, ps);
          if (grade > 0.30) {
            const dcap = Math.max(50, 135 - (grade - 0.30) * 150);
            if (dcap < caps[i]) caps[i] = dcap;
          }
        }
        if (!pMid || !pFar) continue;
        const ax = pMid[0] - p0[0], az = pMid[2] - p0[2];
        const bx = pFar[0] - pMid[0], bz = pFar[2] - pMid[2];
        const am = Math.hypot(ax, az), bm = Math.hypot(bx, bz);
        if (am < 1e-6 || bm < 1e-6) { if (caps[i] > 70) caps[i] = 70; continue; }
        const turn = 1 - (ax * bx + az * bz) / (am * bm);
        const tcap = turn < 0.10 ? 999 : turn < 0.25 ? 185 : turn < 0.5 ? 130 : turn < 0.9 ? 92 : 65;
        if (tcap < caps[i]) caps[i] = tcap;
      }
      // Overhead-clearance cap: where road runs under an upper deck / ramp
      // structure (a multi-level junction), threading it at 240 km/h flings the
      // car sideways into a pillar or the deck edge. If another road cell sits a
      // short height directly above, treat it as a tight covered section and cap
      // the speed so the car holds its line through it.
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dist[i])) continue;
        const cx = this.cells[i][0], cy = this.cells[i][1], cz = this.cells[i][2];
        let overhead = false;
        for (let dy = 2; dy <= 9 && !overhead; dy++) {
          if (this._index.has(this._key(cx, cy + dy, cz))) overhead = true;
        }
        if (overhead && caps[i] > 115) caps[i] = 115;
      }
      // Backward propagation with braking physics.
      const succ = new Int32Array(n).fill(-1);
      const succD = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dist[i])) continue;
        const list = this._nbr[i];
        let best = -1, bestD = dist[i];
        for (let m = 0; m < list.length; m += 3) { if (dist[list[m]] < bestD) { bestD = dist[list[m]]; best = list[m]; } }
        if (best >= 0) {
          succ[i] = best;
          const a = this.cells[i], b = this.cells[best];
          succD[i] = Math.hypot((b[0] - a[0]) * ps, (b[1] - a[1]) * ps, (b[2] - a[2]) * ps);
        }
      }
      const A = 16; // usable deceleration, m/s^2
      for (let iter = 0; iter < 120; iter++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
          const s = succ[i];
          if (s < 0 || caps[s] >= 900) continue;
          const vNext = caps[s] / 3.6;
          const allowed = Math.sqrt(vNext * vNext + 2 * A * succD[i]) * 3.6;
          if (allowed < caps[i] - 0.5) { caps[i] = allowed; changed = true; }
        }
        if (!changed) break;
      }
      this.speedCaps.push(caps);
    }
  }

  _nearestCell(x, y, z) {
    const ps = this.ps;
    const cx = Math.floor(x / ps), cy = Math.floor(y / ps), cz = Math.floor(z / ps);
    // 1-entry memo: potential / speedCap / routeTarget are all called for the
    // same car position within a search block, and consecutive blocks land in
    // the same cell — so this collapses the radius search to a single hit most
    // of the time (the dominant cost in the search hot loop).
    const memoKey = this._key(cx, cy, cz);
    if (this._ncKey === memoKey) return this._ncVal;
    for (let r = 0; r <= 4; r++) {
      let bestI = -1, bestD = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const j = this._index.get(this._key(cx + dx, cy + dy, cz + dz));
            if (j != null) {
              const c = this.cells[j];
              const d = Math.hypot((c[0] + 0.5) * ps - x, (c[1] + 0.5) * ps - y, (c[2] + 0.5) * ps - z);
              if (d < bestD) { bestD = d; bestI = j; }
            }
          }
        }
      }
      if (bestI >= 0) { this._ncKey = memoKey; this._ncVal = bestI; return bestI; }
    }
    this._ncKey = memoKey; this._ncVal = -1;
    return -1;
  }

  // Euclidean cost-to-go fallback (position off-domain or maps missing).
  remainingDistance(x, y, z, nextCheckpointIndex) {
    let d = 0, px = x, py = y, pz = z;
    for (let k = nextCheckpointIndex; k < this.checkpoints.length; k++) {
      const c = this.checkpoints[k].center;
      d += Math.hypot(c[0] - px, c[1] - py, c[2] - pz); px = c[0]; py = c[1]; pz = c[2];
    }
    let best = Infinity;
    for (const f of this.finishes) { const c = f.center; const dd = Math.hypot(c[0] - px, c[1] - py, c[2] - pz); if (dd < best) best = dd; }
    if (best < Infinity) d += best;
    return d;
  }

  // Metres of track left to drive (geodesic). Lower is better.
  potential(x, y, z, nextCheckpointIndex) {
    if (!this.potentialMaps) return this.remainingDistance(x, y, z, nextCheckpointIndex);
    const k = Math.min(nextCheckpointIndex, this.potentialMaps.length - 1);
    const cell = this._nearestCell(x, y, z);
    if (cell < 0) return this.remainingDistance(x, y, z, nextCheckpointIndex);
    const map = this.potentialMaps[k];
    let d = map.dist[cell];
    if (!Number.isFinite(d)) return this.remainingDistance(x, y, z, nextCheckpointIndex);
    const ps = this.ps;
    const c = this.cells[cell];
    const ox = x - (c[0] + 0.5) * ps, oy = y - (c[1] + 0.5) * ps, oz = z - (c[2] + 0.5) * ps;
    d -= ox * map.grad[cell * 3] + oy * map.grad[cell * 3 + 1] + oz * map.grad[cell * 3 + 2];
    return d + this.potentialChain[k];
  }

  // A steering target ON THE ROUTE ~maxDistM metres ahead (gradient descent).
  routeTarget(x, y, z, nextCheckpointIndex, maxDistM = 15) {
    if (!this.potentialMaps) return null;
    const k = Math.min(nextCheckpointIndex, this.potentialMaps.length - 1);
    let cell = this._nearestCell(x, y, z);
    if (cell < 0) return null;
    const ps = this.ps;
    const dist = this.potentialMaps[k].dist;
    let travelled = 0;
    for (let s = 0; s < 24; s++) {
      const list = this._nbr[cell];
      let best = -1, bestD = dist[cell];
      for (let i = 0; i < list.length; i += 3) { const j = list[i]; if (dist[j] < bestD) { bestD = dist[j]; best = j; } }
      if (best < 0) break;
      const a = this.cells[cell], b = this.cells[best];
      travelled += Math.hypot((b[0] - a[0]) * ps, (b[1] - a[1]) * ps, (b[2] - a[2]) * ps);
      cell = best;
      if (dist[cell] === 0 || travelled >= maxDistM) break;
    }
    const c = this.cells[cell];
    return [(c[0] + 0.5) * ps, (c[1] + 0.5) * ps, (c[2] + 0.5) * ps];
  }

  speedCap(x, y, z, nextCheckpointIndex) {
    if (!this.speedCaps) return 999;
    const k = Math.min(nextCheckpointIndex, this.speedCaps.length - 1);
    const cell = this._nearestCell(x, y, z);
    return cell < 0 ? 999 : this.speedCaps[k][cell];
  }
}

module.exports = { Guidance };
