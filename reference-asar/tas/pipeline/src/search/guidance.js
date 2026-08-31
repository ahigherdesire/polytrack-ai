};
// Track guidance for the searches: ordered checkpoint / finish detector
// boxes in world space + a spatial sampling domain built from part tiles.
//
// The track data itself carries the checkpoint ordering (each checkpoint
// part instance has an `order` field consumed by the wasm), so
// CarState.nextCheckpointIndex counts through exactly these boxes.
"use strict";
const fs = require("fs");
const paths = require("../paths");

const FLIGHT_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const H_DIRS = FLIGHT_DIRS; // 8 compass directions (shared)

// Rotation quaternions per [rotationAxis][rotation] — the game's `eo` table
// (x, y, z, w). Verified against the worker bundle by tests.
const ROTATION_QUATS = [
  [[0, 0, 0, 1], [0, .7071067811865475, 0, .7071067811865476], [0, 1, 0, 0], [0, .7071067811865476, 0, -.7071067811865475]],
  [[0, 0, 1, 0], [.7071067811865475, 0, .7071067811865476, 0], [1, 0, 0, 0], [.7071067811865476, 0, -.7071067811865475, 0]],
  [[0, 0, -.7071067811865477, .7071067811865475], [.5, .5, -.5, .5], [.7071067811865475, .7071067811865477, 0, 0], [.5, .5, .5, -.5]],
  [[0, 0, .7071067811865475, .7071067811865476], [.5, -.5, .5, .5], [.7071067811865476, -.7071067811865475, 0, 0], [.5, -.5, -.5, -.5]],
  [[.7071067811865475, 0, 0, .7071067811865476], [.5, .5, .5, .5], [0, .7071067811865476, .7071067811865475, 0], [-.5, .5, .5, -.5]],
  [[-.7071067811865477, 0, 0, .7071067811865475], [-.5, -.5, .5, .5], [0, -.7071067811865475, .7071067811865477, 0], [.5, -.5, .5, -.5]],
];

function extractRotationQuatsFromWorker() {
  const s = fs.readFileSync(paths.SIM_WORKER_BUNDLE, "utf8");
  const at = s.indexOf("eo=[[new D(");
  if (at < 0) throw new Error("eo quaternion table not found in worker bundle");
  let depth = 0, end = -1;
  for (let j = at + 3; j < s.length; j++) {
    const ch = s[j];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") { depth--; if (depth === 0 && ch === "]") { end = j; break; } }
  }
  const text = s.slice(at + 3, end + 1);
  class D { constructor(x = 0, y = 0, z = 0, w = 1) { return [x, y, z, w]; } }
  return new Function("D", "return " + text)(D);
}

function rotateVec(q, v) {
  const [qx, qy, qz, qw] = q;
  const [x, y, z] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

// Port of the game's tile rotation (so sampling cells land where parts do).
// axis enum: 0 YPositive, 1 YNegative, 2 XPositive, 3 XNegative, 4 ZPositive, 5 ZNegative.
const AXIS = { YPositive: 0, YNegative: 1, XPositive: 2, XNegative: 3, ZPositive: 4, ZNegative: 5 };
function rotateTile(t, e, i, rotation, axis) {
  if (axis === AXIS.YNegative || axis === AXIS.XNegative || axis === AXIS.ZNegative) {
    switch (rotation) {
      case 0: break;
      case 1: { const nt = -i - 1; i = t; t = nt; break; }
      case 2: { const nt = -t - 1; const ni = -i - 1; t = nt; i = ni; break; }
      case 3: { const nt = i; const ni = -t - 1; t = nt; i = ni; break; }
      default: throw new Error("Invalid rotation");
    }
  } else {
    switch (rotation) {
      case 0: break;
      case 1: { const nt = i; const ni = -t - 1; t = nt; i = ni; break; }
      case 2: { const nt = -t - 1; const ni = -i - 1; t = nt; i = ni; break; }
      case 3: { const nt = -i - 1; const ni = t; t = nt; i = ni; break; }
      default: throw new Error("Invalid rotation");
    }
  }
  if (axis !== AXIS.YPositive) {
    if (axis === AXIS.YNegative) { const nt = -t - 1, ne = -e - 1; t = nt; e = ne; }
    else if (axis === AXIS.XPositive) { const nt = e, ne = -t - 1; t = nt; e = ne; }
    else if (axis === AXIS.XNegative) { const nt = -e - 1, ne = t; t = nt; e = ne; }
    else if (axis === AXIS.ZPositive) { const nE = -i - 1, ni = e; e = nE; i = ni; }
    else { const nE = i, ni = -e - 1; e = nE; i = ni; }
  }
  return [t, e, i];
}

class Guidance {
  // sim: a HeadlessSim with a loaded track.
  constructor(sim) {
    const context = sim.context;
    const partSize = context.partSize;
    this.partSize = partSize;
    this._context = context;
    const cfgById = new Map(context.trackParts.map((p) => [p.id, p]));
    const detTypes = context.detectorTypes;

    const checkpoints = [];
    const finishes = [];
    const cells = [];
    const cellSet = new Set();

    this._instances = sim.trackParts();
    for (const inst of this._instances) {
      const cfg = cfgById.get(inst.partId);
      if (!cfg) continue;
      const q = ROTATION_QUATS[inst.rotationAxis][inst.rotation];
      const base = [inst.x * partSize, inst.y * partSize, inst.z * partSize];

      if (cfg.detector) {
        const c = rotateVec(q, cfg.detector.center);
        const center = [base[0] + c[0], base[1] + c[1], base[2] + c[2]];
        const s = rotateVec(q, cfg.detector.size);
        const half = [Math.abs(s[0]) / 2, Math.abs(s[1]) / 2, Math.abs(s[2]) / 2];
        // Track direction through the box = the detector's local Z axis.
        const normal = rotateVec(q, [0, 0, 1]);
        const box = { center, half, normal, quat: q, size: cfg.detector.size.slice() };
        if (cfg.detector.type === detTypes.Finish) finishes.push(box);
        else if (cfg.detector.type === detTypes.Checkpoint) checkpoints.push({ order: inst.order, ...box });
      }

      const isWallTrack = cfg.name && cfg.name.includes("WallTrack");
      for (const [tx, ty, tz] of cfg.tiles) {
        const [rx, ry, rz] = rotateTile(tx, ty, tz, inst.rotation, inst.rotationAxis);
        const cx = inst.x + rx, cy = inst.y + ry, cz = inst.z + rz;
        const key = cx + "," + cy + "," + cz;
        if (!cellSet.has(key)) {
          cellSet.add(key);
          cells.push([cx, cy, cz]);
        }
        // Wall-track cells are drivable on VERTICAL surfaces — exempt from
        // the deck-support filter.
        if (isWallTrack) (this._wallTrackCells || (this._wallTrackCells = new Set())).add(key);
      }
    }

    checkpoints.sort((a, b) => a.order - b.order);
    this.checkpoints = checkpoints;
    this.finishes = finishes;
    this.cells = cells;                 // grid cells occupied by track parts
    this.cellSet = cellSet;
    this.start = sim.track.getStartTransform();
    this.checkpointCount = checkpoints.length;
  }

  // The waypoint the car must reach given its nextCheckpointIndex:
  // checkpoint boxes in order, then any finish box.
  targetFor(nextCheckpointIndex) {
    if (nextCheckpointIndex < this.checkpoints.length) return this.checkpoints[nextCheckpointIndex];
    return this.nearestFinish || this.finishes[0];
  }

  // Total remaining waypoint chain distance from a position (position ->
  // next cp -> next cp -> ... -> finish), used as a coarse cost-to-go.
  remainingDistance(x, y, z, nextCheckpointIndex) {
    let d = 0;
    let px = x, py = y, pz = z;
    for (let k = nextCheckpointIndex; k < this.checkpoints.length; k++) {
      const c = this.checkpoints[k].center;
      d += Math.hypot(c[0] - px, c[1] - py, c[2] - pz);
      px = c[0]; py = c[1]; pz = c[2];
    }
    let best = Infinity;
    for (const f of this.finishes) {
      const c = f.center;
      const dd = Math.hypot(c[0] - px, c[1] - py, c[2] - pz);
      if (dd < best) best = dd;
    }
    if (best < Infinity) d += best;
    return d;
  }

  distanceToTarget(x, y, z, nextCheckpointIndex) {
    if (nextCheckpointIndex < this.checkpoints.length) {
      const c = this.checkpoints[nextCheckpointIndex].center;
      return Math.hypot(c[0] - x, c[1] - y, c[2] - z);
    }
    let best = Infinity;
    for (const f of this.finishes) {
      const c = f.center;
      const dd = Math.hypot(c[0] - x, c[1] - y, c[2] - z);
      if (dd < best) best = dd;
    }
    return best;
  }

  // ---- wall voxelization -----------------------------------------------------
  // Part TILES cover barrier interiors, so the cell graph alone sees corner
  // pockets as open road. The physics collision meshes know better: barrier
  // faces are STEEP (|normal.y| < 0.5) while decks — even ramps — are not.
  // Voxelize only steep triangles at 1.25 m resolution; a radius-1 graph
  // edge crossing wall voxels near car height is physically blocked.
  buildWalls() {
    if (this._wallVoxX) return;
    const ps = this.partSize;
    const V = 1.25;
    // Orientation-split voxel sets: a wall only blocks edges that CROSS it,
    // so a fence along the road (normal across the road) must not block
    // along-road edges. voxX = walls facing ±x, voxZ = walls facing ±z.
    const voxX = new Set();
    const voxZ = new Set();
    const vkey = (ix, iy, iz) => ((iy + 512) * 4096 + (ix + 2048)) * 4096 + (iz + 2048);
    this._voxKey = vkey;

    // decode + cache part collision vertices
    if (!this._partVerts) {
      this._partVerts = new Map();
      for (const p of this._context.trackParts) {
        const buf = Buffer.from(p.vertices, "base64");
        const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        this._partVerts.set(p.id, f32);
      }
    }

    for (const inst of this._instances) {
      const verts = this._partVerts.get(inst.partId);
      if (!verts) continue;
      const q = ROTATION_QUATS[inst.rotationAxis][inst.rotation];
      const bx = inst.x * ps, by = inst.y * ps, bz = inst.z * ps;
      for (let t = 0; t + 8 < verts.length; t += 9) {
        const a = rotateVec(q, [verts[t], verts[t + 1], verts[t + 2]]);
        const b = rotateVec(q, [verts[t + 3], verts[t + 4], verts[t + 5]]);
        const c = rotateVec(q, [verts[t + 6], verts[t + 7], verts[t + 8]]);
        // steepness from the (unnormalized) face normal
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const nlen = Math.hypot(nx, ny, nz);
        if (nlen < 1e-9 || Math.abs(ny / nlen) >= 0.5) continue; // deck/ceiling — skip
        const hlen = Math.hypot(nx, nz) || 1e-9;
        const fx = Math.abs(nx / hlen) >= 0.5;  // faces ±x
        const fz = Math.abs(nz / hlen) >= 0.5;  // faces ±z
        // sample the triangle at ~1 m spacing
        const e1 = Math.hypot(ux, uy, uz), e2 = Math.hypot(wx, wy, wz);
        const n = Math.max(1, Math.min(24, Math.ceil(Math.max(e1, e2))));
        for (let i = 0; i <= n; i++) {
          for (let j = 0; j <= n - i; j++) {
            const s = i / n, r = j / n;
            const k = vkey(
              Math.floor((bx + a[0] + ux * s + wx * r) / V),
              Math.floor((by + a[1] + uy * s + wy * r) / V),
              Math.floor((bz + a[2] + uz * s + wz * r) / V)
            );
            if (fx) voxX.add(k);
            if (fz) voxZ.add(k);
          }
        }
      }
    }
    this._wallVoxX = voxX;
    this._wallVoxZ = voxZ;
    this._wallV = V;

    // Second pass: DECK voxels (drivable-ish surfaces, |normal.y| >= 0.5),
    // used to drop tile cells that overhang past the physical deck edge —
    // the "open shoulder" cells that lure cars off unfenced drops.
    const deck = new Set();
    for (const inst of this._instances) {
      const verts = this._partVerts.get(inst.partId);
      if (!verts) continue;
      const q = ROTATION_QUATS[inst.rotationAxis][inst.rotation];
      const bx = inst.x * ps, by = inst.y * ps, bz = inst.z * ps;
      for (let t = 0; t + 8 < verts.length; t += 9) {
        const a = rotateVec(q, [verts[t], verts[t + 1], verts[t + 2]]);
        const b = rotateVec(q, [verts[t + 3], verts[t + 4], verts[t + 5]]);
        const c = rotateVec(q, [verts[t + 6], verts[t + 7], verts[t + 8]]);
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const nlen = Math.hypot(nx, ny, nz);
        if (nlen < 1e-9 || Math.abs(ny / nlen) < 0.5) continue; // steep — not deck
        const e1 = Math.hypot(ux, uy, uz), e2 = Math.hypot(wx, wy, wz);
        const n = Math.max(1, Math.min(24, Math.ceil(Math.max(e1, e2))));
        for (let i = 0; i <= n; i++) {
          for (let j = 0; j <= n - i; j++) {
            const s = i / n, r = j / n;
            deck.add(vkey(
              Math.floor((bx + a[0] + ux * s + wx * r) / V),
              Math.floor((by + a[1] + uy * s + wy * r) / V),
              Math.floor((bz + a[2] + uz * s + wz * r) / V)
            ));
          }
        }
      }
    }
    this._deckVox = deck;
  }

  // Does this cell have deck support (a drivable surface near its base)?
  // Ground-level cells are always supported (the world ground plane), and
  // wall-track cells are exempt (vertical driving surfaces).
  _cellSupported(cellIdx) {
    const c = this.cells[cellIdx];
    if (c[1] <= 0) return true;
    if (this._wallTrackCells && this._wallTrackCells.has(c[0] + "," + c[1] + "," + c[2])) return true;
    const ps = this.partSize;
    const V = this._wallV;
    const cx = (c[0] + 0.5) * ps, cz = (c[2] + 0.5) * ps;
    const baseY = c[1] * ps;
    const iy0 = Math.floor((baseY - 1.2) / V), iy1 = Math.floor((baseY + 4.2) / V);
    for (const [ox, oz] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]]) {
      const ix = Math.floor((cx + ox) / V), iz = Math.floor((cz + oz) / V);
      for (let iy = iy0; iy <= iy1; iy++) {
        if (this._deckVox.has(this._voxKey(ix, iy, iz))) return true;
      }
    }
    return false;
  }

  // Is the straight segment between two cell centers blocked by a wall that
  // FACES the crossing? Checks 3 sample columns along the segment in the
  // band 0.3–3.4 m above the lower cell's base, against the wall set whose
  // orientation opposes the edge direction (a fence parallel to the road
  // must not block along-road edges).
  _edgeBlocked(ci, cj) {
    const ps = this.partSize;
    const V = this._wallV;
    const vkey = this._voxKey;
    const a = this.cells[ci], b = this.cells[cj];
    const ax = (a[0] + 0.5) * ps, az = (a[2] + 0.5) * ps;
    const bx = (b[0] + 0.5) * ps, bz = (b[2] + 0.5) * ps;
    const ex = bx - ax, ez = bz - az;
    const elen = Math.hypot(ex, ez) || 1e-9;
    const useX = Math.abs(ex / elen) > 0.45 ? this._wallVoxX : null;
    const useZ = Math.abs(ez / elen) > 0.45 ? this._wallVoxZ : null;
    if (!useX && !useZ) return false;
    const baseY = Math.min(a[1], b[1]) * ps;
    const iy0 = Math.floor((baseY + 0.3) / V), iy1 = Math.floor((baseY + 3.4) / V);
    let hits = 0;
    for (const t of [0.3, 0.5, 0.7]) {
      const px = ax + ex * t, pz = az + ez * t;
      const ix = Math.floor(px / V), iz = Math.floor(pz / V);
      let hit = false;
      for (let iy = iy0; iy <= iy1 && !hit; iy++) {
        const k = vkey(ix, iy, iz);
        if ((useX && useX.has(k)) || (useZ && useZ.has(k))) hit = true;
      }
      if (hit) hits++;
    }
    return hits >= 2;
  }

  // ---- geodesic potential field --------------------------------------------
  // Euclidean distance to the next checkpoint is a terrible gradient on a
  // winding track (progress along the road barely moves it, walls don't
  // exist in it). Instead: Dijkstra over the occupied cell graph from each
  // waypoint's cells, with a neighbor radius that tolerates jump gaps.
  // potential(pos, cpIdx) ≈ meters of track left to drive. Lower = better.
  buildPotentials({ neighborRadius = 3 } = {}) {
    // Drop tile cells that overhang past the physical deck (unfenced
    // shoulders) BEFORE building the graph — they lure routes off edges.
    this.buildWalls();
    if (!this._deckFiltered) {
      const kept = [];
      let dropped = 0;
      for (let i = 0; i < this.cells.length; i++) {
        if (this._cellSupported(i)) kept.push(this.cells[i]);
        else dropped++;
      }
      if (dropped > 0 && kept.length > this.cells.length * 0.35) {
        this.cells = kept;
      }
      this._deckFiltered = true;
    }
    const cells = this.cells;
    const n = cells.length;
    const ps = this.partSize;
    // integer cell key (coords fit comfortably in ±1024)
    const key = (x, y, z) => ((x + 1024) | ((y + 1024) << 11)) * 2048 + (z + 1024);
    const index = new Map();
    for (let i = 0; i < n; i++) {
      index.set(key(cells[i][0], cells[i][1], cells[i][2]), i);
    }
    this._cellIndex = index;
    this._cellKey = key;

    // Neighbor lists (built once). Radius-1 links model contiguous track;
    // longer links exist only to bridge jump gaps and carry a surcharge so
    // the field never prefers "tunneling" through a barrier over driving
    // around it. Climbing also costs extra (cars need ramps), and climbs
    // steeper than +2 cells per link are impossible (directional).
    const R = neighborRadius;
    const offsets = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          if (!dx && !dy && !dz) continue;
          const cheb = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
          // Links beyond radius 1 exist to bridge REAL gaps (jumps), not to
          // tunnel through barriers: price them so a wall shortcut always
          // loses to any honest driveable path (dead-end pockets otherwise
          // score better than the corner they bypass).
          const mult = cheb === 1 ? 1 : cheb === 2 ? 2.6 : 3.4;
          const climb = Math.max(0, dy) * ps * 0.5;
          offsets.push([dx, dy, dz, Math.round((Math.hypot(dx, dy, dz) * ps * mult + climb) * 16)]);
        }
      }
    }
    // Long-drop links: cars CAN fall much further than the cube radius
    // (sheer drops between track levels would otherwise disconnect the
    // graph). Priced steeply so the field only routes off an edge when no
    // driveable path exists — falling is a last resort, not a shortcut.
    for (let dy = -10; dy <= -(R + 1); dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        for (let dz = -4; dz <= 4; dz++) {
          offsets.push([dx, dy, dz, Math.round(Math.hypot(dx, dy, dz) * ps * 3.0 * 16)]);
        }
      }
    }
    // Wall proximity ("wallness"): horizontal neighbors missing around a
    // cell. Shortest paths hug inside walls; weighting edges by the target
    // cell's wallness pulls geodesics toward the road CENTER, so steering
    // targets stop dragging cars along barriers.
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
    this._wallness = wallness;

    this.buildWalls();
    // Fence proximity: count physically blocked lateral directions per cell
    // so routes center through door openings instead of clipping the posts.
    const fenceCount = new Uint8Array(n);
    const blockedMask = new Uint8Array(n); // bit per H_DIRS entry
    {
      for (let i = 0; i < n; i++) {
        const cx = cells[i][0], cy = cells[i][1], cz = cells[i][2];
        for (let d = 0; d < H_DIRS.length; d++) {
          const [dx, dz] = H_DIRS[d];
          for (const dy of [0, 1, -1]) {
            const j = index.get(key(cx + dx, cy + dy, cz + dz));
            if (j != null) {
              if (this._edgeBlocked(i, j)) { fenceCount[i]++; blockedMask[i] |= 1 << d; }
              break;
            }
          }
        }
      }
    }
    this._fenceCount = fenceCount;
    this._blockedMask = blockedMask;

    const nbr = new Array(n);
    for (let i = 0; i < n; i++) {
      const cx = cells[i][0], cy = cells[i][1], cz = cells[i][2];
      const list = [];
      for (const [dx, dy, dz, w] of offsets) {
        const j = index.get(key(cx + dx, cy + dy, cz + dz));
        if (j != null) {
          // Radius-1 lateral edges crossing a physical barrier are removed
          // outright — that's the difference between "open plaza" and the
          // actual road layout.
          const cheb = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
          if (cheb === 1 && (dx !== 0 || dz !== 0) && this._edgeBlocked(i, j)) continue;
          // Mild fence-proximity nudge only — roads are fenced on both sides,
          // so anything stronger makes open ground cheaper than the road.
          const ww = Math.round(w * (1 + 0.08 * wallness[j] + 0.09 * Math.min(fenceCount[j], 3)));
          list.push(j, ww, dy);
        }
      }
      // Flight links: tracks contain LAUNCHED JUMPS far beyond the cube
      // radius (summer1: a ~60 m ramp jump to an elevated road). Probe the
      // 8 compass directions outward and link the first landing found —
      // surcharged so ground routes win whenever they exist.
      for (const [ux, uz] of FLIGHT_DIRS) {
        outer:
        for (let r = R + 1; r <= 14; r++) {
          for (let dy = 2; dy >= -10; dy--) {
            const j = index.get(key(cx + ux * r, cy + dy, cz + uz * r));
            if (j != null) {
              const dist = Math.hypot(ux * r, dy, uz * r) * ps;
              const ww = Math.round(dist * (3.0 + 0.1 * r) * 16);
              list.push(j, ww, dy);
              break outer;
            }
          }
        }
      }
      nbr[i] = list;
    }

    // Waypoint sequence: checkpoints in order, then the finish set.
    const targets = [];
    for (const cp of this.checkpoints) targets.push([cp]);
    targets.push(this.finishes);

    const maps = [];
    for (const boxes of targets) {
      const dist = new Float64Array(n).fill(Infinity);
      // seed: cells whose center lies inside (or within 1 cell of) a box
      const heap = new MinHeap();
      for (let i = 0; i < n; i++) {
        const wx = (cells[i][0] + 0.5) * ps, wy = (cells[i][1] + 0.5) * ps, wz = (cells[i][2] + 0.5) * ps;
        for (const b of boxes) {
          const m = ps; // margin
          if (Math.abs(wx - b.center[0]) <= b.half[0] + m &&
            Math.abs(wy - b.center[1]) <= b.half[1] + m + 2 &&
            Math.abs(wz - b.center[2]) <= b.half[2] + m) {
            dist[i] = 0;
            heap.push(i, 0);
            break;
          }
        }
      }
      while (heap.size) {
        const [u, du] = heap.pop();
        if (du > dist[u]) continue;
        const list = nbr[u];
        for (let k = 0; k < list.length; k += 3) {
          const v = list[k];
          const w = list[k + 1] / 16;
          // dist maps are distance-to-target; the car MOVES v -> u, so the
          // move climbs (u.y - v.y) = -dyOffset. Climbs over +2 cells are
          // physically impossible without a ramp chain — skip those edges.
          const climbMove = -list[k + 2];
          if (climbMove > 2) continue;
          if (du + w < dist[v]) {
            dist[v] = du + w;
            heap.push(v, du + w);
          }
        }
      }
      // Downhill gradient per cell (unit vector toward steepest descent),
      // used to de-quantize the potential between cell centers.
      const grad = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dist[i])) continue;
        const list = nbr[i];
        let bx = 0, by = 0, bz = 0, bestDrop = 0;
        for (let k = 0; k < list.length; k += 3) {
          const j = list[k];
          const w = list[k + 1] / 16;
          const drop = (dist[i] - dist[j]) / w; // descent rate
          if (drop > bestDrop) {
            bestDrop = drop;
            bx = cells[j][0] - cells[i][0];
            by = cells[j][1] - cells[i][1];
            bz = cells[j][2] - cells[i][2];
          }
        }
        const m = Math.hypot(bx, by, bz);
        if (m > 0) { grad[i * 3] = bx / m; grad[i * 3 + 1] = by / m; grad[i * 3 + 2] = bz / m; }
      }
      maps.push({ dist, grad });
    }
    this.potentialMaps = maps;
    this._nbr = nbr; // kept for route-ahead queries

    // Chain tail: chain[k] = typical geodesic distance from waypoint k's
    // cells to the rest of the chain (so potential is comparable across cp
    // indices). Measured as min over waypoint-k seed cells of map[k+1].
    const chain = new Float64Array(maps.length).fill(0);
    for (let k = maps.length - 2; k >= 0; k--) {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (maps[k].dist[i] === 0 && maps[k + 1].dist[i] < best) best = maps[k + 1].dist[i];
      }
      if (!Number.isFinite(best)) best = 200; // disconnected fallback
      chain[k] = best + chain[k + 1];
    }
    this.potentialChain = chain;
    this.buildSpeedCaps();
    return this;
  }

  // ---- curvature speed caps -------------------------------------------------
  // Per-cell, per-waypoint-map speed limits derived from how much the route
  // BENDS over the next ~40 m. Overspeed is penalized in the search fitness
  // itself: without this, a clean fast approach into a hard corner scores
  // well right up until it is physically impossible to brake, and the
  // optimizer re-races into the same wall forever.
  buildSpeedCaps() {
    const ps = this.partSize;
    const n = this.cells.length;
    this.speedCaps = [];
    for (let k = 0; k < this.potentialMaps.length; k++) {
      const dist = this.potentialMaps[k].dist;
      const caps = new Float32Array(n).fill(999);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dist[i])) continue;
        // walk the downhill chain gathering points at ~18 m and ~38 m
        let cell = i, travelled = 0;
        let pMid = null, pFar = null;
        const p0 = this.cells[i];
        for (let s = 0; s < 20; s++) {
          const list = this._nbr[cell];
          let best = -1, bestD = dist[cell];
          for (let m = 0; m < list.length; m += 3) {
            if (dist[list[m]] < bestD) { bestD = dist[list[m]]; best = list[m]; }
          }
          if (best < 0) break;
          const a = this.cells[cell], b = this.cells[best];
          travelled += Math.hypot((b[0] - a[0]) * ps, (b[1] - a[1]) * ps, (b[2] - a[2]) * ps);
          cell = best;
          if (!pMid && travelled >= 18) pMid = this.cells[cell];
          if (travelled >= 38) { pFar = this.cells[cell]; break; }
        }
        if (!pMid || !pFar) continue;
        const ax = pMid[0] - p0[0], az = pMid[2] - p0[2];
        const bx = pFar[0] - pMid[0], bz = pFar[2] - pMid[2];
        const am = Math.hypot(ax, az), bm = Math.hypot(bx, bz);
        if (am < 1e-6 || bm < 1e-6) { caps[i] = 70; continue; } // route goes vertical-ish
        const cos = (ax * bx + az * bz) / (am * bm);
        const turn = 1 - cos;
        caps[i] = turn < 0.10 ? 999 : turn < 0.25 ? 185 : turn < 0.5 ? 130 : turn < 0.9 ? 92 : 65;
      }
      // Backward propagation with braking physics: a cap only helps if it
      // extends far enough upstream to shed the speed (v² = v_next² + 2·a·d).
      const succ = new Int32Array(n).fill(-1);
      const succD = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(dist[i])) continue;
        const list = this._nbr[i];
        let best = -1, bestD = dist[i];
        for (let m = 0; m < list.length; m += 3) {
          if (dist[list[m]] < bestD) { bestD = dist[list[m]]; best = list[m]; }
        }
        if (best >= 0) {
          succ[i] = best;
          const a = this.cells[i], b = this.cells[best];
          succD[i] = Math.hypot((b[0] - a[0]) * ps, (b[1] - a[1]) * ps, (b[2] - a[2]) * ps);
        }
      }
      // GATE caps: curvature misses narrow doorways (the path bend is gentle
      // but the passage demands precision). When the route's forward
      // direction points near-head-on at a physically blocked direction on
      // this cell or the next, the car is being threaded at a wall gap —
      // cap it hard. EXPERIMENTAL: threshold needs per-track calibration;
      // disable with TAS_GATECAP=0.
      if (this._blockedMask && process.env.TAS_GATECAP !== "0") {
        for (let i = 0; i < n; i++) {
          const s = succ[i];
          if (s < 0) continue;
          const a = this.cells[i], b = this.cells[s];
          const fxd = b[0] - a[0], fzd = b[2] - a[2];
          const fm = Math.hypot(fxd, fzd);
          if (fm < 1e-6) continue;
          for (const ci of [i, s]) {
            const mask = this._blockedMask[ci];
            if (!mask) continue;
            for (let d = 0; d < H_DIRS.length; d++) {
              if (!(mask & (1 << d))) continue;
              const [dx, dz] = H_DIRS[d];
              const dm = Math.hypot(dx, dz);
              // 0.85: a side fence's diagonal is cos45° ≈ 0.707 and must NOT
              // count — only near-head-on walls mark a gate.
              if ((fxd * dx + fzd * dz) / (fm * dm) > 0.85) {
                caps[i] = Math.min(caps[i], 85);
                break;
              }
            }
          }
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

  speedCap(x, y, z, nextCheckpointIndex) {
    if (!this.speedCaps) return 999;
    const k = Math.min(nextCheckpointIndex, this.speedCaps.length - 1);
    const cell = this._nearestCell(x, y, z);
    return cell < 0 ? 999 : this.speedCaps[k][cell];
  }

  _nearestCell(x, y, z) {
    const ps = this.partSize;
    const cx = Math.floor(x / ps), cy = Math.floor(y / ps), cz = Math.floor(z / ps);
    for (let r = 0; r <= 4; r++) {
      let bestI = -1, bestD = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const j = this._cellIndex.get(this._cellKey(cx + dx, cy + dy, cz + dz));
            if (j != null) {
              const c = this.cells[j];
              const d = Math.hypot((c[0] + 0.5) * ps - x, (c[1] + 0.5) * ps - y, (c[2] + 0.5) * ps - z);
              if (d < bestD) { bestD = d; bestI = j; }
            }
          }
        }
      }
      if (bestI >= 0) return bestI;
    }
    return -1;
  }

  // Meters of track left to drive (geodesic). Lower is better. Falls back to
  // the euclidean chain if the position is off-domain or maps are missing.
  potential(x, y, z, nextCheckpointIndex) {
    if (!this.potentialMaps) return this.remainingDistance(x, y, z, nextCheckpointIndex);
    const k = Math.min(nextCheckpointIndex, this.potentialMaps.length - 1);
    const cell = this._nearestCell(x, y, z);
    if (cell < 0) return this.remainingDistance(x, y, z, nextCheckpointIndex);
    const map = this.potentialMaps[k];
    let d = map.dist[cell];
    if (!Number.isFinite(d)) return this.remainingDistance(x, y, z, nextCheckpointIndex);
    // De-quantize: project the offset from the cell center onto the local
    // downhill direction so the gradient is continuous inside a cell.
    const ps = this.partSize;
    const c = this.cells[cell];
    const ox = x - (c[0] + 0.5) * ps, oy = y - (c[1] + 0.5) * ps, oz = z - (c[2] + 0.5) * ps;
    d -= ox * map.grad[cell * 3] + oy * map.grad[cell * 3 + 1] + oz * map.grad[cell * 3 + 2];
    return d + this.potentialChain[k];
  }

  // A steering target ON THE ROUTE ~`maxDistM` METERS ahead of the given
  // position (gradient descent along the potential map). Distance-capped —
  // never link-count-capped, because long bridge/flight links would throw
  // the target 50+ m out and make steering deadbands useless.
  routeTarget(x, y, z, nextCheckpointIndex, maxDistM = 15) {
    if (!this.potentialMaps) return null;
    const k = Math.min(nextCheckpointIndex, this.potentialMaps.length - 1);
    let cell = this._nearestCell(x, y, z);
    if (cell < 0) return null;
    const ps = this.partSize;
    const dist = this.potentialMaps[k].dist;
    let travelled = 0;
    for (let s = 0; s < 24; s++) {
      const list = this._nbr[cell];
      let best = -1, bestD = dist[cell];
      for (let i = 0; i < list.length; i += 3) {
        const j = list[i];
        if (dist[j] < bestD) { bestD = dist[j]; best = j; }
      }
      if (best < 0) break;
      const a = this.cells[cell], b = this.cells[best];
      travelled += Math.hypot((b[0] - a[0]) * ps, (b[1] - a[1]) * ps, (b[2] - a[2]) * ps);
      cell = best;
      if (dist[cell] === 0 || travelled >= maxDistM) break;
    }
    const c = this.cells[cell];
    return [(c[0] + 0.5) * ps, (c[1] + 0.5) * ps, (c[2] + 0.5) * ps];
  }

  // Random world-space point on the track surface domain.
  samplePoint(rng) {
    const cell = this.cells[(rng() * this.cells.length) | 0];
    const ps = this.partSize;
    return [
      cell[0] * ps + rng() * ps,
      cell[1] * ps + 0.3 + rng() * 2.5,
      cell[2] * ps + rng() * ps,
    ];
  }
}

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

module.exports = { Guidance, MinHeap, ROTATION_QUATS, extractRotationQuatsFromWorker, rotateVec, rotateTile, AXIS 