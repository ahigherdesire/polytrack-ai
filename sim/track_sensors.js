// Road-edge sensors: rasterize the placed track tiles into a searchable road
// surface mesh, then cast rays from the car to measure distance-to-edge in a
// frontal arc. The mesh path is 3D, so jumps, banks, walls, and loops can be
// checked against the actual road plane instead of only top-down X/Z.
const {
  CELL,
  quatRotate,
  transformPartVertex,
  triangleNormal,
  add,
  sub,
  mul,
  dot,
  cross,
  normalize,
} = require('./geom');
const LOCAL_FWD = { x: 0, y: 0, z: 1 };
const LOCAL_UP = { x: 0, y: 1, z: 0 };
const LOCAL_RIGHT = { x: 1, y: 0, z: 0 };
const DEFAULT_NON_DRIVEABLE_TYPES = new Set([25]);

function buildAnchorOccupancy(parts, res = 4, mark = 24) {
  const pts = parts.map((p) => [p[0] * CELL, p[2] * CELL]);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
  const pad = mark + res;
  minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
  const w = Math.ceil((maxX - minX) / res) + 1, h = Math.ceil((maxZ - minZ) / res) + 1;
  const data = new Uint8Array(w * h);
  const mr = Math.ceil(mark / res);
  for (const [x, z] of pts) {
    const cx = Math.round((x - minX) / res), cz = Math.round((z - minZ) / res);
    for (let i = -mr; i <= mr; i++) for (let j = -mr; j <= mr; j++) {
      if (i * i + j * j > mr * mr) continue;
      const gx = cx + i, gz = cz + j;
      if (gx >= 0 && gx < w && gz >= 0 && gz < h) data[gz * w + gx] = 1;
    }
  }
  return { minX, minZ, res, w, h, data, mode: 'anchors' };
}

function isLocalRoadSurface(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-6) return false;
  // Pick road/deck faces before the part is rotated. A loop road can become
  // vertical in world space, but it is still a local top/bottom surface.
  if (Math.abs(ny) / len < 0.22) return false;
  return true;
}

function isDriveableTriangle(a, b, c, minDriveHeight, maxDriveHeight) {
  const avgY = (a.y + b.y + c.y) / 3;
  if (avgY < minDriveHeight || avgY > maxDriveHeight) return false;
  return true;
}

function pointInTri(px, pz, t) {
  const [ax, az, bx, bz, cx, cz] = t;
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function closestPointOnTriangle(p, a, b, c) {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    return add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return add(a, add(mul(ab, v), mul(ac, w)));
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function dilate(data, w, h, steps) {
  let src = data;
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(src);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!src[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && xx < w && yy >= 0 && yy < h) next[yy * w + xx] = 1;
          }
        }
      }
    }
    src = next;
  }
  data.set(src);
}

// Build an occupancy bitmap plus a 3D triangle index of driveable road surface.
// Local-space filtering keeps road faces even after they rotate into loops.
function buildOccupancy(parts, trackPartConfigs = null, options = {}) {
  if (typeof trackPartConfigs === 'number') {
    return buildAnchorOccupancy(parts, trackPartConfigs, typeof options === 'number' ? options : 24);
  }
  if (!trackPartConfigs || !trackPartConfigs.length) return buildAnchorOccupancy(parts);

  const cfg = new Map(trackPartConfigs.map((p) => [p.id, p]));
  const res = Number.isFinite(options.res) ? options.res : 2;
  const minDriveHeight = Number.isFinite(options.minDriveHeight) ? options.minDriveHeight : -Infinity;
  const maxDriveHeight = Number.isFinite(options.maxDriveHeight) ? options.maxDriveHeight : Infinity;
  const yTolerance = Number.isFinite(options.yTolerance) ? options.yTolerance : 9;
  const nonDriveableTypes = options.nonDriveableTypes || DEFAULT_NON_DRIVEABLE_TYPES;
  const pad = Number.isFinite(options.pad) ? options.pad : 8;
  const surfaces = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  for (const p of parts || []) {
    if (nonDriveableTypes.has(p[3])) continue;
    const config = cfg.get(p[3]);
    const vertices = config && config.vertices;
    if (!vertices || vertices.length < 9) continue;
    const part = { x: p[0] * CELL, y: p[1] * CELL, z: p[2] * CELL, rotation: p[4], rotationAxis: p[5] };
    for (let i = 0; i + 8 < vertices.length; i += 9) {
      const la = { x: vertices[i], y: vertices[i + 1], z: vertices[i + 2] };
      const lb = { x: vertices[i + 3], y: vertices[i + 4], z: vertices[i + 5] };
      const lc = { x: vertices[i + 6], y: vertices[i + 7], z: vertices[i + 8] };
      if (!isLocalRoadSurface(la, lb, lc)) continue;
      const a = transformPartVertex(part, la.x, la.y, la.z);
      const b = transformPartVertex(part, lb.x, lb.y, lb.z);
      const c = transformPartVertex(part, lc.x, lc.y, lc.z);
      if (!isDriveableTriangle(a, b, c, minDriveHeight, maxDriveHeight)) continue;
      const normal = triangleNormal(a, b, c);
      const t2d = [a.x, a.z, b.x, b.z, c.x, c.z];
      const area2d = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      surfaces.push({
        a, b, c, normal, t2d, area2d,
        minX: Math.min(a.x, b.x, c.x),
        maxX: Math.max(a.x, b.x, c.x),
        minZ: Math.min(a.z, b.z, c.z),
        maxZ: Math.max(a.z, b.z, c.z),
        minY: Math.min(a.y, b.y, c.y),
        maxY: Math.max(a.y, b.y, c.y),
      });
      for (const v of [a, b, c]) {
        if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
        if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
      }
    }
  }

  if (!surfaces.length) return buildAnchorOccupancy(parts);

  minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
  const w = Math.ceil((maxX - minX) / res) + 1;
  const h = Math.ceil((maxZ - minZ) / res) + 1;
  const data = new Uint8Array(w * h);
  const minY = new Float32Array(w * h);
  const maxY = new Float32Array(w * h);
  const cellTris = Array.from({ length: w * h }, () => []);
  minY.fill(Infinity);
  maxY.fill(-Infinity);

  for (let si = 0; si < surfaces.length; si++) {
    const t = surfaces[si];
    const gx0 = Math.max(0, Math.floor((t.minX - minX) / res) - 1);
    const gx1 = Math.min(w - 1, Math.ceil((t.maxX - minX) / res) + 1);
    const gz0 = Math.max(0, Math.floor((t.minZ - minZ) / res) - 1);
    const gz1 = Math.min(h - 1, Math.ceil((t.maxZ - minZ) / res) + 1);
    for (let gz = gz0; gz <= gz1; gz++) {
      const z = minZ + gz * res;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = minX + gx * res;
        if (t.area2d <= 0.05 || pointInTri(x, z, t.t2d)) {
          const idx = gz * w + gx;
          data[idx] = 1;
          cellTris[idx].push(si);
          if (t.minY < minY[idx]) minY[idx] = t.minY;
          if (t.maxY > maxY[idx]) maxY[idx] = t.maxY;
        }
      }
    }
  }

  dilate(data, w, h, 1);
  return {
    minX, minZ, res, w, h, data, minY, maxY, yTolerance,
    mode: 'mesh',
    triangles: surfaces.length,
    surfaces3d: surfaces,
    cellTris,
    _queryMark: new Uint32Array(surfaces.length),
    _queryId: 1,
  };
}

function nearestSurface(occ, p, maxDist = 14) {
  if (!occ || !occ.surfaces3d || !occ.surfaces3d.length) return null;
  const gx = Math.round((p.x - occ.minX) / occ.res);
  const gz = Math.round((p.z - occ.minZ) / occ.res);
  const radius = Math.max(1, Math.ceil(maxDist / occ.res) + 1);
  const qid = ++occ._queryId || 1;
  if (qid === 1) occ._queryMark.fill(0);

  let best = null;
  const consider = (si) => {
    if (si < 0 || si >= occ.surfaces3d.length || occ._queryMark[si] === qid) return;
    occ._queryMark[si] = qid;
    const t = occ.surfaces3d[si];
    if (p.x < t.minX - maxDist || p.x > t.maxX + maxDist || p.z < t.minZ - maxDist || p.z > t.maxZ + maxDist) return;
    const point = closestPointOnTriangle(p, t.a, t.b, t.c);
    const distance = dist3(p, point);
    if (distance <= maxDist && (!best || distance < best.distance)) {
      best = { index: si, point, normal: t.normal, distance };
    }
  };

  for (let zz = gz - radius; zz <= gz + radius; zz++) {
    if (zz < 0 || zz >= occ.h) continue;
    for (let xx = gx - radius; xx <= gx + radius; xx++) {
      if (xx < 0 || xx >= occ.w) continue;
      const tris = occ.cellTris[zz * occ.w + xx];
      for (const si of tris) consider(si);
    }
  }

  // If the top-down cell index misses a near-vertical road face, do one bounded
  // fallback scan. This only triggers when the fast cell lookup found nothing.
  if (!best) {
    const limit = Math.min(occ.surfaces3d.length, 3000);
    for (let si = 0; si < limit; si++) consider(si);
  }

  return best;
}

function onTrack(occ, x, z, y = null) {
  if (occ && occ.surfaces3d && y !== null && y !== undefined) {
    return !!nearestSurface(occ, { x, y, z }, occ.yTolerance ?? 9);
  }
  const gx = Math.round((x - occ.minX) / occ.res), gz = Math.round((z - occ.minZ) / occ.res);
  if (gx < 0 || gx >= occ.w || gz < 0 || gz >= occ.h) return false;
  const idx = gz * occ.w + gx;
  if (occ.data[idx] !== 1) return false;
  if (y === null || y === undefined || !occ.minY || !occ.maxY) return true;
  const tol = occ.yTolerance ?? 8;
  return y >= occ.minY[idx] - tol && y <= occ.maxY[idx] + tol;
}

// Frontal arc of rays (radians, relative to car forward).
const SENSOR_ANGLES = [-1.05, -0.6, -0.28, 0, 0.28, 0.6, 1.05];

function surfaceFrame(s, occ) {
  const fwdRaw = normalize(quatRotate(s.quaternion, LOCAL_FWD), LOCAL_FWD);
  const upRaw = normalize(quatRotate(s.quaternion, LOCAL_UP), LOCAL_UP);
  const rightRaw = normalize(quatRotate(s.quaternion, LOCAL_RIGHT), LOCAL_RIGHT);
  const near = nearestSurface(occ, s.position, 18);
  let normal = near ? near.normal : upRaw;
  if (dot(normal, upRaw) < 0) normal = mul(normal, -1);
  const fwd = normalize(sub(fwdRaw, mul(normal, dot(fwdRaw, normal))), fwdRaw);
  const right = normalize(cross(normal, fwd), rightRaw);
  return { near, normal, fwd, right };
}

function edgeSensors(s, occ, maxR = 90, step = 4) {
  const { fwd, right } = surfaceFrame(s, occ);
  const out = [];
  for (const ang of SENSOR_ANGLES) {
    const c = Math.cos(ang), sn = Math.sin(ang);
    const dir = normalize(add(mul(fwd, c), mul(right, sn)), fwd);
    let d = maxR;
    for (let r = step; r <= maxR; r += step) {
      const p = add(s.position, mul(dir, r));
      if (!onTrack(occ, p.x, p.z, p.y)) { d = r - step; break; }
    }
    out.push(d / maxR);
  }
  return out;
}
edgeSensors.COUNT = SENSOR_ANGLES.length;

module.exports = { buildOccupancy, nearestSurface, onTrack, edgeSensors };
