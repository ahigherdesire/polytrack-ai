// Responsive track map loader + guide waypoint editor.
//
// Usage:
//   node train/map_loader.js [port]
//
// Saves guide routes to data/guide.<track>.json. The ES evaluator loads that
// file automatically when TRACK points at the same track.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { setupTrack } = require('./evaluator');
const { gridToWorld, transformPartVertex, triangleNormal } = require('../sim/geom');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const TRACKS = path.join(ROOT, 'tracks');
const PORT = Number(process.argv[2] || process.env.PORT || 7792);
const FINISH_TYPES = new Set([6, 74, 76, 78]);
const NON_DRIVEABLE_TYPES = new Set([25]);

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function listTracks() {
  const out = [];
  const constants = path.join(DATA, 'constants.json');
  if (fs.existsSync(constants)) out.push({ path: rel(constants), name: 'constants' });
  try {
    for (const entry of fs.readdirSync(TRACKS, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const full = path.join(TRACKS, entry.name);
        out.push({ path: rel(full), name: path.basename(entry.name, '.json') });
      }
    }
  } catch { }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function safeTrack(track) {
  const clean = String(track || '').replace(/\\/g, '/');
  const tracks = listTracks();
  if (!tracks.some((t) => t.path === clean)) throw new Error(`Unknown track: ${clean}`);
  return clean;
}

function tagForTrack(track) {
  return path.basename(track, '.json');
}

function guideFileForTrack(track) {
  const tag = tagForTrack(track);
  return path.join(DATA, tag === 'constants' ? 'guide.json' : `guide.${tag}.json`);
}

function readGuide(track) {
  const file = guideFileForTrack(track);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return {
      exists: true,
      file: rel(file),
      enabled: raw.enabled !== false,
      radius: Number.isFinite(Number(raw.radius)) ? Number(raw.radius) : 14,
      points: Array.isArray(raw.points) ? raw.points
        .map((p) => ({
          x: Number(p.x),
          y: Number(p.y ?? 0),
          z: Number(p.z),
          nx: Number(p.nx),
          ny: Number(p.ny),
          nz: Number(p.nz),
        }))
        .map((p) => (Number.isFinite(p.nx) && Number.isFinite(p.ny) && Number.isFinite(p.nz)
          ? p
          : { x: p.x, y: p.y, z: p.z }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z)) : [],
      updatedAt: raw.updatedAt || null,
    };
  } catch {
    return { exists: false, file: rel(file), enabled: true, radius: 14, points: [] };
  }
}

function writeGuide(track, body) {
  const file = guideFileForTrack(track);
  const points = Array.isArray(body.points) ? body.points.slice(0, 200)
    .map((p) => ({
      x: Number(p.x),
      y: Number(p.y ?? 0),
      z: Number(p.z),
      nx: Number(p.nx),
      ny: Number(p.ny),
      nz: Number(p.nz),
    }))
    .map((p) => (Number.isFinite(p.nx) && Number.isFinite(p.ny) && Number.isFinite(p.nz)
      ? p
      : { x: p.x, y: p.y, z: p.z }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z)) : [];
  const radius = Number.isFinite(Number(body.radius)) ? Math.max(4, Number(body.radius)) : 14;
  const guide = {
    track,
    enabled: body.enabled !== false,
    radius,
    points,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(guide, null, 2));
  mapCache.delete(track);
  return { ...guide, exists: true, file: rel(file) };
}

function deleteGuide(track) {
  const file = guideFileForTrack(track);
  try { fs.unlinkSync(file); } catch { }
  mapCache.delete(track);
  return readGuide(track);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendText(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
  });
}

const mapCache = new Map();

function expandBounds(bounds, x, z) {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

function expandHeight(bounds, y) {
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxY = Math.max(bounds.maxY, y);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function isGuideSurfaceLocal(a, b, c, partType) {
  if (NON_DRIVEABLE_TYPES.has(partType)) return false;
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-6) return false;
  const upness = Math.abs(ny) / len;
  return upness >= 0.22;
}

function buildPartMesh(part, config, bounds) {
  const vertices = config && Array.isArray(config.vertices) ? config.vertices : [];
  const triangles = [];
  const surfaces = [];
  for (let i = 0; i + 8 < vertices.length; i += 9) {
    const la = { x: vertices[i], y: vertices[i + 1], z: vertices[i + 2] };
    const lb = { x: vertices[i + 3], y: vertices[i + 4], z: vertices[i + 5] };
    const lc = { x: vertices[i + 6], y: vertices[i + 7], z: vertices[i + 8] };
    const a = transformPartVertex(part, la.x, la.y, la.z);
    const b = transformPartVertex(part, lb.x, lb.y, lb.z);
    const c = transformPartVertex(part, lc.x, lc.y, lc.z);
    const area = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    expandBounds(bounds, a.x, a.z);
    expandBounds(bounds, b.x, b.z);
    expandBounds(bounds, c.x, c.z);
    expandHeight(bounds, a.y);
    expandHeight(bounds, b.y);
    expandHeight(bounds, c.y);
    if (area >= 0.02) {
      triangles.push(round1(a.x), round1(a.z), round1(b.x), round1(b.z), round1(c.x), round1(c.z));
    }
    if (isGuideSurfaceLocal(la, lb, lc, part.type)) {
      const n = triangleNormal(a, b, c);
      surfaces.push(
        round1(a.x), round1(a.z), round1(a.y),
        round1(b.x), round1(b.z), round1(b.y),
        round1(c.x), round1(c.z), round1(c.y),
        round3(n.x), round3(n.y), round3(n.z),
      );
    }
  }
  return { triangles, surfaces };
}

async function buildMap(track) {
  const clean = safeTrack(track);
  const abs = path.join(ROOT, clean);
  const st = fs.statSync(abs);
  const cached = mapCache.get(clean);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.map;

  const payload = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const configs = new Map((payload.init.trackParts || []).map((p) => [p.id, p]));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init, payload.createCar);
  const { start } = setupTrack(sim, { track: clean });
  const guide = readGuide(clean);

  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity };
  const surfaces = [];
  const parts = (sim._parts || []).map((p) => {
    const item = {
      x: p[0] * 5,
      y: p[1] * 5,
      z: p[2] * 5,
      type: p[3],
      rotation: p[4],
      rotationAxis: p[5],
      checkpointOrder: p[7],
      startOrder: p[8],
    };
    const mesh = buildPartMesh(item, configs.get(item.type), bounds);
    item.triangles = mesh.triangles;
    surfaces.push(...mesh.surfaces);
    if (!item.triangles.length) expandBounds(bounds, item.x, item.z);
    expandHeight(bounds, item.y);
    return item;
  });

  const checkpoints = sim.checkpoints().map((c) => {
    const w = gridToWorld(c.grid);
    return { x: w.x, y: w.y, z: w.z, order: c.order };
  });
  for (const c of checkpoints) expandBounds(bounds, c.x, c.z);
  expandBounds(bounds, start.x, start.z);
  expandHeight(bounds, start.y);
  for (const p of guide.points) {
    expandBounds(bounds, p.x, p.z);
    expandHeight(bounds, p.y);
  }

  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = -50; bounds.maxX = 50; bounds.minZ = -50; bounds.maxZ = 50;
  }
  if (!Number.isFinite(bounds.minY)) {
    bounds.minY = 0; bounds.maxY = 0;
  }
  const pad = 35;
  bounds.minX -= pad; bounds.maxX += pad; bounds.minZ -= pad; bounds.maxZ += pad;

  const finishTargets = parts.filter((p) => FINISH_TYPES.has(p.type));
  const typeCounts = {};
  for (const p of parts) typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;

  const map = {
    track: clean,
    tag: tagForTrack(clean),
    guideFile: guide.file,
    bounds,
    heightRange: { minY: bounds.minY, maxY: bounds.maxY },
    surfaceStride: 12,
    surfaces,
    parts,
    typeCounts,
    start: { x: start.x, y: start.y, z: start.z },
    checkpoints,
    finishTargets,
    guide,
  };
  mapCache.set(clean, { mtimeMs: st.mtimeMs, map });
  return map;
}

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyTrack Guide Map Loader</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--panel2:#0f141b;--line:#30363d;--mut:#8b949e;--fg:#e6edf3;--blue:#58a6ff;--cyan:#39d5d5;--green:#3fb950;--yellow:#d29922;--red:#f85149}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Arial,sans-serif}
button,select,input{font:inherit}
.app{min-height:100%;display:grid;grid-template-rows:auto 1fr}
.top{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:10px;align-items:end;padding:10px 12px;border-bottom:1px solid var(--line);background:#111821}
.title{min-width:0}.title h1{font-size:16px;margin:0 0 2px}.title div{color:var(--mut);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toolbar{display:flex;gap:8px;align-items:end;flex-wrap:wrap;justify-content:flex-end}
label{display:grid;gap:4px;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
select,input{height:34px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:6px;padding:0 9px;min-width:0}
input[type=number]{width:82px}
.check{display:flex;align-items:center;gap:6px;height:34px;text-transform:none;letter-spacing:0;font-size:12px;color:var(--fg)}
.check input{height:auto;width:auto}
.btn{height:34px;border:1px solid var(--line);background:#202733;color:var(--fg);border-radius:6px;padding:0 10px;font-weight:700;cursor:pointer}
.btn:hover{border-color:#657385}.btn.primary{background:#174f87;border-color:#296da9}.btn.good{background:#1c6337;border-color:#2f8d51}.btn.warn{background:#664b18;border-color:#92712b}.btn.bad{background:#6e2525;border-color:#9d3535}
.main{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:10px;padding:10px;min-height:0}
.mapCard,.side{background:var(--panel);border:1px solid var(--line);border-radius:8px;min-width:0}
.mapCard{display:grid;grid-template-rows:1fr auto;min-height:420px;overflow:hidden}
#map{display:block;width:100%;height:100%;min-height:360px;background:#080c12;touch-action:none;cursor:crosshair}
.status{display:flex;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:8px 10px;color:var(--mut);font-size:12px}
.legend{display:flex;gap:6px;flex-wrap:wrap}.pill{display:inline-flex;align-items:center;gap:5px;background:#202733;border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--blue)}
.side{display:grid;grid-template-rows:auto auto 1fr auto;gap:10px;padding:10px;min-height:0}
.panel{background:var(--panel2);border:1px solid #232b35;border-radius:8px;padding:10px;min-width:0}
.panel h2{font-size:12px;color:var(--mut);margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em}
.editGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:end}
.editGrid .wide{grid-column:1/-1}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.metric{background:#111821;border:1px solid #27313d;border-radius:7px;padding:8px;min-width:0}
.metric b{display:block;font-size:18px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric span{display:block;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.points{overflow:auto;display:grid;gap:6px;padding-right:2px}
.point{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;background:#111821;border:1px solid #27313d;border-radius:7px;padding:7px}
.point.active{border-color:var(--cyan);box-shadow:0 0 0 1px rgba(57,213,213,.25) inset}
.idx{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--cyan);color:#061113;font-weight:800;font-size:12px}
.coords{font:12px/1.3 ui-monospace,Consolas,monospace;color:#c9d7e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini{height:28px;padding:0 8px;border-radius:5px}
pre{margin:0;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#080c12;border:1px solid #27313d;border-radius:7px;padding:8px;color:#b8c7d9;font:11px/1.35 ui-monospace,Consolas,monospace}
@media (max-width:950px){.top{grid-template-columns:1fr}.toolbar{justify-content:flex-start}.main{grid-template-columns:1fr}.side{grid-template-rows:auto auto auto auto}.mapCard{min-height:58vh}#map{min-height:52vh}}
@media (max-width:560px){.top,.main{padding:8px}.toolbar{display:grid;grid-template-columns:1fr 1fr;width:100%}.toolbar label,.toolbar button{width:100%}select{width:100%}.metrics{grid-template-columns:1fr}.status{align-items:flex-start;flex-direction:column}.mapCard{min-height:56vh}#map{min-height:50vh}}
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <div class="title">
      <h1>PolyTrack Guide Map Loader</h1>
      <div id="subtitle">loading</div>
    </div>
    <div class="toolbar">
      <label>Track<select id="track"></select></label>
      <label>Radius<input id="radius" type="number" min="4" max="80" step="1" value="14"></label>
      <label class="check"><input id="enabled" type="checkbox" checked> Enabled</label>
      <button class="btn primary" id="load">Load</button>
      <button class="btn" id="fit">Fit</button>
      <button class="btn warn" id="undo">Undo</button>
      <button class="btn bad" id="clear">Clear</button>
      <button class="btn good" id="save">Save</button>
    </div>
  </header>
  <main class="main">
    <section class="mapCard">
      <canvas id="map"></canvas>
      <div class="status">
        <div id="status">Ready</div>
        <div class="legend">
          <span class="pill"><i class="dot" style="background:var(--green)"></i>start</span>
          <span class="pill"><i class="dot" style="background:var(--yellow)"></i>checkpoint</span>
          <span class="pill"><i class="dot" style="background:var(--red)"></i>finish</span>
          <span class="pill"><i class="dot" style="background:var(--cyan)"></i>guide</span>
        </div>
      </div>
    </section>
    <aside class="side">
      <section class="panel metrics">
        <div class="metric"><span>Guide points</span><b id="pointCount">0</b></div>
        <div class="metric"><span>Track parts</span><b id="partCount">0</b></div>
        <div class="metric"><span>Checkpoints</span><b id="cpCount">0</b></div>
        <div class="metric"><span>Height</span><b id="heightRange">-</b></div>
        <div class="metric"><span>Guide file</span><b id="guideFile">-</b></div>
      </section>
      <section class="panel">
        <h2>Selected point</h2>
        <div class="editGrid">
          <label>X<input id="pointX" type="number" step="0.1"></label>
          <label>Z<input id="pointZ" type="number" step="0.1"></label>
          <label>Y<input id="pointY" type="number" step="0.1"></label>
          <button class="btn mini" id="snapY">Snap Y</button>
          <button class="btn mini" id="snapLow">Low</button>
          <button class="btn mini" id="snapHigh">High</button>
          <button class="btn mini wide" id="snapAll">Snap all Y</button>
          <button class="btn mini" id="up">Move up</button>
          <button class="btn mini" id="down">Move down</button>
          <button class="btn mini bad" id="delete">Delete</button>
        </div>
      </section>
      <section class="panel points" id="points"></section>
      <section class="panel">
        <h2>Saved JSON</h2>
        <pre id="json"></pre>
      </section>
    </aside>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
let tracks = [];
let mapData = null;
let guide = { enabled: true, radius: 14, points: [] };
let selected = -1;
let dragging = false;
let fitted = false;
let view = { scale: 1, tx: 0, ty: 0 };

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function setStatus(text) { $('status').textContent = text; }

function trackParam() { return encodeURIComponent($('track').value); }

async function loadTracks() {
  const data = await api('/api/tracks');
  tracks = data.tracks || [];
  $('track').innerHTML = tracks.map((t) => '<option value="' + t.path + '">' + t.name + ' - ' + t.path + '</option>').join('');
  const preferred = tracks.find((t) => t.path === 'tracks/haoyuone.json') || tracks[0];
  if (preferred) $('track').value = preferred.path;
  await loadMap();
}

async function loadMap() {
  if (!$('track').value) return;
  setStatus('Loading track...');
  mapData = await api('/api/map?track=' + trackParam());
  guide = mapData.guide || { enabled: true, radius: 14, points: [] };
  $('enabled').checked = guide.enabled !== false;
  $('radius').value = guide.radius || 14;
  selected = guide.points.length ? 0 : -1;
  fitted = false;
  updateUi();
  resizeCanvas();
  fitView();
  draw();
  setStatus('Loaded ' + mapData.track);
}

function saveGuide() {
  guide.enabled = $('enabled').checked;
  guide.radius = Number($('radius').value) || 14;
  guide.points = (guide.points || []).map(cleanGuidePoint);
  return api('/api/guide?track=' + trackParam(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(guide),
  }).then((saved) => {
    guide = saved;
    updateUi();
    draw();
    setStatus('Saved ' + saved.file);
  }).catch((e) => setStatus('Save failed: ' + e.message));
}

function fitView() {
  if (!mapData) return;
  const r = canvas.getBoundingClientRect();
  const W = Math.max(1, r.width), H = Math.max(1, r.height);
  const b = mapData.bounds;
  const sx = (W - 34) / Math.max(1, b.maxX - b.minX);
  const sz = (H - 34) / Math.max(1, b.maxZ - b.minZ);
  view.scale = Math.max(0.1, Math.min(sx, sz));
  view.tx = (W - (b.minX + b.maxX) * view.scale) / 2;
  view.ty = (H - (b.minZ + b.maxZ) * view.scale) / 2;
  fitted = true;
  draw();
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(r.width * dpr));
  const h = Math.max(1, Math.floor(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    if (!fitted) fitView();
  }
}

function S(p) { return { x: p.x * view.scale + view.tx, y: p.z * view.scale + view.ty }; }
function Wp(x, y) { return { x: (x - view.tx) / view.scale, z: (y - view.ty) / view.scale }; }
function r1(n) { return +Number(n || 0).toFixed(1); }
function r3(n) { return +Number(n || 0).toFixed(3); }

function cleanGuidePoint(p) {
  const out = { x: r1(p.x), y: r1(p.y), z: r1(p.z) };
  if (Number.isFinite(p.nx) && Number.isFinite(p.ny) && Number.isFinite(p.nz)) {
    out.nx = r3(p.nx); out.ny = r3(p.ny); out.nz = r3(p.nz);
  }
  return out;
}

function triHeightAt(x, z, tri) {
  const x1 = tri[0], z1 = tri[1], y1 = tri[2];
  const x2 = tri[3], z2 = tri[4], y2 = tri[5];
  const x3 = tri[6], z3 = tri[7], y3 = tri[8];
  const nx = tri[9], ny = tri[10], nz = tri[11];
  const den = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
  if (Math.abs(den) < 1e-6) {
    const minX = Math.min(x1, x2, x3) - 2;
    const maxX = Math.max(x1, x2, x3) + 2;
    const minZ = Math.min(z1, z2, z3) - 2;
    const maxZ = Math.max(z1, z2, z3) + 2;
    if (x < minX || x > maxX || z < minZ || z > maxZ) return null;
    return { y: (y1 + y2 + y3) / 3, nx, ny, nz };
  }
  const a = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / den;
  const b = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / den;
  const c = 1 - a - b;
  if (a < -0.025 || b < -0.025 || c < -0.025) return null;
  return { y: a * y1 + b * y2 + c * y3, nx, ny, nz };
}

function surfaceYAt(x, z, currentY = null, mode = 'nearest') {
  const surfaces = mapData && mapData.surfaces || [];
  const stride = mapData && mapData.surfaceStride || 12;
  let best = null, count = 0;
  for (let i = 0; i + stride - 1 < surfaces.length; i += stride) {
    const hit = triHeightAt(x, z, surfaces.slice(i, i + stride));
    if (!hit || !Number.isFinite(hit.y)) continue;
    count++;
    if (!best) { best = { ...hit, count }; continue; }
    if (mode === 'low' && hit.y < best.y) best = { ...hit, count };
    else if (mode === 'high' && hit.y > best.y) best = { ...hit, count };
    else if (mode === 'nearest' && Number.isFinite(currentY) && Math.abs(hit.y - currentY) < Math.abs(best.y - currentY)) best = { ...hit, count };
    else if (mode === 'nearest' && !Number.isFinite(currentY) && hit.y > best.y) best = { ...hit, count };
  }
  return best ? { y: r1(best.y), nx: r3(best.nx), ny: r3(best.ny), nz: r3(best.nz), count } : null;
}

function makeGuidePoint(x, z, currentY = null, mode = 'nearest') {
  const snapped = surfaceYAt(x, z, currentY, mode);
  const y = snapped ? snapped.y : (Number.isFinite(currentY) ? currentY : 0);
  const p = { x: r1(x), y: r1(y), z: r1(z) };
  if (snapped) { p.nx = snapped.nx; p.ny = snapped.ny; p.nz = snapped.nz; }
  return p;
}

function snapSelected(mode = 'nearest') {
  if (selected < 0 || !guide.points[selected]) return;
  const p = guide.points[selected];
  guide.points[selected] = makeGuidePoint(p.x, p.z, p.y, mode);
  updateUi(); draw();
}

function snapAllY() {
  guide.points = (guide.points || []).map((p) => makeGuidePoint(p.x, p.z, p.y, 'nearest'));
  if (selected >= guide.points.length) selected = guide.points.length - 1;
  updateUi(); draw();
}

function heightColor(p) {
  const r = mapData && mapData.heightRange;
  if (!r || !Number.isFinite(r.minY) || !Number.isFinite(r.maxY) || r.maxY <= r.minY) return '#39d5d5';
  const t = Math.max(0, Math.min(1, ((p.y || 0) - r.minY) / (r.maxY - r.minY)));
  const hue = 185 + t * 95;
  return 'hsl(' + hue.toFixed(0) + ' 78% 62%)';
}

function colorForPart(p) {
  if (p.startOrder >= 0 || p.type === 5) return '#245c3c';
  if (p.checkpointOrder >= 0) return '#7a5a19';
  if ([6,74,76,78].includes(p.type)) return '#743036';
  if (p.type === 36) return '#5b2f32';
  return '#1c2c3e';
}

function drawPart(p) {
  ctx.fillStyle = colorForPart(p);
  const tris = p.triangles || [];
  if (tris.length) {
    for (let i = 0; i + 5 < tris.length; i += 6) {
      const a = S({ x: tris[i], z: tris[i + 1] });
      const b = S({ x: tris[i + 2], z: tris[i + 3] });
      const c = S({ x: tris[i + 4], z: tris[i + 5] });
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.fill();
    }
    return;
  }
  const q = S(p);
  const base = p.type === 36 ? 30 : 20;
  const size = Math.max(3, base * view.scale);
  ctx.fillRect(q.x - size / 2, q.y - size / 2, size, size);
}

function draw() {
  resizeCanvas();
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#080c12';
  ctx.fillRect(0, 0, W, H);
  if (!mapData) return;

  for (const p of mapData.parts) drawPart(p);

  for (const f of mapData.finishTargets || []) {
    const q = S(f);
    ctx.fillStyle = '#f85149';
    ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill();
  }
  for (const c of mapData.checkpoints || []) {
    const q = S(c);
    ctx.fillStyle = '#d29922';
    ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#081018'; ctx.font = '10px ui-monospace,Consolas,monospace';
    ctx.fillText(String(c.order), q.x - 3, q.y + 4);
  }
  const st = S(mapData.start);
  ctx.fillStyle = '#3fb950';
  ctx.beginPath(); ctx.arc(st.x, st.y, 7, 0, Math.PI * 2); ctx.fill();

  const pts = guide.points || [];
  if (pts.length) {
    ctx.strokeStyle = '#39d5d5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => { const q = S(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
    ctx.stroke();
    pts.forEach((p, i) => {
      const q = S(p);
      ctx.fillStyle = i === selected ? '#f0f6fc' : heightColor(p);
      ctx.beginPath(); ctx.arc(q.x, q.y, i === selected ? 7 : 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = i === selected ? '#071018' : '#041014';
      ctx.font = '10px ui-monospace,Consolas,monospace';
      ctx.fillText(String(i + 1), q.x - 3, q.y + 4);
      if (i === selected) {
        ctx.fillStyle = '#d7e7ff';
        ctx.fillText('y=' + r1(p.y), q.x + 9, q.y - 8);
      }
    });
  }
}

function hitPoint(x, y) {
  let best = -1, bestD = 12;
  for (let i = 0; i < guide.points.length; i++) {
    const q = S(guide.points[i]);
    const d = Math.hypot(q.x - x, q.y - y);
    if (d < bestD) { best = i; bestD = d; }
  }
  return best;
}

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!mapData) return;
  canvas.setPointerCapture(e.pointerId);
  const p = canvasPos(e);
  const hit = hitPoint(p.x, p.y);
  if (hit >= 0) {
    selected = hit;
    dragging = true;
  } else {
    const w = Wp(p.x, p.y);
    guide.points.push(makeGuidePoint(w.x, w.z, null, 'high'));
    selected = guide.points.length - 1;
    dragging = true;
  }
  updateUi();
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging || selected < 0) return;
  const p = canvasPos(e);
  const w = Wp(p.x, p.y);
  const oldY = guide.points[selected] ? guide.points[selected].y : null;
  guide.points[selected] = makeGuidePoint(w.x, w.z, oldY, 'nearest');
  updateUi();
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (dragging || !mapData) return;
  const p = canvasPos(e);
  const w = Wp(p.x, p.y);
  const s = surfaceYAt(w.x, w.z, null, 'high');
  setStatus('x=' + r1(w.x) + ' y=' + (s ? s.y : '-') + ' z=' + r1(w.z));
});

canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointercancel', () => { dragging = false; });

canvas.addEventListener('wheel', (e) => {
  if (!mapData) return;
  e.preventDefault();
  const p = canvasPos(e);
  const before = Wp(p.x, p.y);
  const factor = e.deltaY < 0 ? 1.12 : 0.88;
  view.scale = Math.max(0.05, Math.min(20, view.scale * factor));
  view.tx = p.x - before.x * view.scale;
  view.ty = p.y - before.z * view.scale;
  draw();
}, { passive: false });

function updateUi() {
  const pts = guide.points || [];
  $('subtitle').textContent = mapData ? mapData.track + ' | ' + guide.file : 'No track loaded';
  $('pointCount').textContent = String(pts.length);
  $('partCount').textContent = mapData ? String(mapData.parts.length) : '0';
  $('cpCount').textContent = mapData ? String(mapData.checkpoints.length) : '0';
  $('heightRange').textContent = mapData && mapData.heightRange
    ? r1(mapData.heightRange.minY) + '...' + r1(mapData.heightRange.maxY)
    : '-';
  $('guideFile').textContent = guide.file ? guide.file.replace(/^data\\//, '') : '-';
  const active = selected >= 0 && pts[selected];
  $('pointX').disabled = !active; $('pointY').disabled = !active; $('pointZ').disabled = !active;
  $('pointX').value = active ? r1(pts[selected].x) : '';
  $('pointY').value = active ? r1(pts[selected].y) : '';
  $('pointZ').value = active ? r1(pts[selected].z) : '';
  $('points').innerHTML = pts.length ? pts.map((p, i) =>
    '<div class="point ' + (i === selected ? 'active' : '') + '" data-i="' + i + '">' +
    '<div class="idx">' + (i + 1) + '</div><div class="coords">x=' + r1(p.x) + ' y=' + r1(p.y) + ' z=' + r1(p.z) + '</div>' +
    '<button class="btn mini bad" data-del="' + i + '">Delete</button></div>').join('') :
    '<div class="coords">No guide points saved for this track.</div>';
  $('json').textContent = JSON.stringify({ enabled: $('enabled').checked, radius: Number($('radius').value) || 14, points: pts }, null, 2);
  document.querySelectorAll('[data-i]').forEach((el) => el.onclick = (ev) => {
    if (ev.target && ev.target.dataset.del !== undefined) return;
    selected = Number(el.dataset.i); updateUi(); draw();
  });
  document.querySelectorAll('[data-del]').forEach((el) => el.onclick = () => {
    const i = Number(el.dataset.del);
    guide.points.splice(i, 1);
    selected = Math.min(selected, guide.points.length - 1);
    updateUi(); draw();
  });
}

function moveSelected(dir) {
  if (selected < 0) return;
  const next = selected + dir;
  if (next < 0 || next >= guide.points.length) return;
  const tmp = guide.points[selected];
  guide.points[selected] = guide.points[next];
  guide.points[next] = tmp;
  selected = next;
  updateUi(); draw();
}

function updateSelectedFromInputs() {
  if (selected < 0 || !guide.points[selected]) return;
  const x = Number($('pointX').value);
  const y = Number($('pointY').value);
  const z = Number($('pointZ').value);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  guide.points[selected] = cleanGuidePoint({ ...guide.points[selected], x, y, z });
  updateUi(); draw();
}

$('load').onclick = loadMap;
$('track').onchange = loadMap;
$('fit').onclick = fitView;
$('save').onclick = saveGuide;
$('undo').onclick = () => { guide.points.pop(); selected = Math.min(selected, guide.points.length - 1); updateUi(); draw(); };
$('clear').onclick = () => {
  if (!confirm('Clear guide points for ' + $('track').value + '?')) return;
  guide.points = []; selected = -1; updateUi(); draw();
};
$('delete').onclick = () => {
  if (selected < 0) return;
  guide.points.splice(selected, 1);
  selected = Math.min(selected, guide.points.length - 1);
  updateUi(); draw();
};
$('up').onclick = () => moveSelected(-1);
$('down').onclick = () => moveSelected(1);
$('snapY').onclick = () => snapSelected('nearest');
$('snapLow').onclick = () => snapSelected('low');
$('snapHigh').onclick = () => snapSelected('high');
$('snapAll').onclick = snapAllY;
$('pointX').onchange = updateSelectedFromInputs;
$('pointY').onchange = updateSelectedFromInputs;
$('pointZ').onchange = updateSelectedFromInputs;
$('radius').oninput = updateUi;
$('enabled').onchange = updateUi;

new ResizeObserver(() => { resizeCanvas(); draw(); }).observe(canvas);
loadTracks().catch((e) => setStatus('Error: ' + e.message));
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendText(res, 200, HTML, 'text/html');
    }
    if (req.method === 'GET' && url.pathname === '/api/tracks') {
      return sendJson(res, 200, { tracks: listTracks() });
    }
    if (req.method === 'GET' && url.pathname === '/api/map') {
      const track = safeTrack(url.searchParams.get('track'));
      return sendJson(res, 200, await buildMap(track));
    }
    if (req.method === 'GET' && url.pathname === '/api/guide') {
      const track = safeTrack(url.searchParams.get('track'));
      return sendJson(res, 200, readGuide(track));
    }
    if (req.method === 'POST' && url.pathname === '/api/guide') {
      const track = safeTrack(url.searchParams.get('track'));
      return sendJson(res, 200, writeGuide(track, await readBody(req)));
    }
    if (req.method === 'DELETE' && url.pathname === '/api/guide') {
      const track = safeTrack(url.searchParams.get('track'));
      return sendJson(res, 200, deleteGuide(track));
    }
    return sendText(res, 404, 'not found');
  } catch (e) {
    return sendText(res, 500, e.stack || String(e));
  }
});

server.listen(PORT, () => {
  console.log(`map loader at http://localhost:${PORT}`);
});
