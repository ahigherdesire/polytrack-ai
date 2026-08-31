// Live training dashboard. Parses the ES training log and renders metrics + a
// top-down track maps with the current-generation and best policy paths.
//
// Usage: node train/dashboard.js [logfile] [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { setupTrack, REWARD } = require('./evaluator');
const { observe } = require('../sim/observe');
const { Policy } = require('./policy');

const DATA = path.resolve(__dirname, '..', 'data');
const LOG = process.argv[2] || path.join(__dirname, '..', 'train3.log');
// Track to visualize (match the TRACK you trained). Default = Summer 1.
const TRACK = process.env.TRACK ? path.resolve(process.env.TRACK) : path.join(DATA, 'constants.json');
const TAG = path.basename(TRACK, '.json');
const BEST_POLICY_FILE = path.join(DATA, TAG === 'constants' ? 'policy.json' : `policy.${TAG}.json`);
const CURRENT_POLICY_FILE = path.join(DATA, TAG === 'constants' ? 'policy.current.json' : `policy.current.${TAG}.json`);
const BEST_LAP_FILE = path.join(DATA, TAG === 'constants' ? 'es_lap.json' : `es_lap.${TAG}.json`);
const RUN_FILE = path.join(DATA, TAG === 'constants' ? 'learning_run.json' : `learning_run.${TAG}.json`);
const PORT = parseInt(process.argv[3] || '7780', 10);

const LINE = /^gen\s+(\d+)\s+(.+?)\s+\((\d+)s,\s+([\d.]+)\s+gen\/s\)/gm;
const TRAIN_LINE = /spawning\s+(\d+)\s+workers,\s+pop\s+(\d+),\s+maxFrames\s+(\d+)/;
const num = (v, fallback = null) => (v === undefined ? fallback : Number(String(v).replace(/s$/, '')));
const NEUTRAL_ACTION = { up: false, down: false, left: false, right: false, reset: false };
const finite = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function parseLog() {
  let txt = ''; try { txt = fs.readFileSync(LOG, 'utf8'); } catch { return { history: [] }; }
  const history = []; let m;
  const tm = txt.match(TRAIN_LINE);
  const train = tm ? { workers: +tm[1], pop: +tm[2], maxFrames: +tm[3] } : null;
  LINE.lastIndex = 0;
  while ((m = LINE.exec(txt))) {
    const fields = {};
    for (const kv of m[2].matchAll(/([A-Za-z]+)=([^\s]+)/g)) fields[kv[1]] = kv[2];
    const bestReward = num(fields.bestReward, 0);
    const currentReward = num(fields.currentReward, bestReward);
    const meanReward = num(fields.meanReward, currentReward);
    const finishers = fields.finishers ? Number(fields.finishers.split('/')[0]) : 0;
    const pop = fields.finishers ? Number(fields.finishers.split('/')[1]) : null;
    history.push({
      gen: +m[1], bestCp: num(fields.bestCp, 0),
      currentReward, meanReward, bestReward,
      minReward: num(fields.minReward, currentReward),
      rewardStd: num(fields.rewardStd, 0),
      rewardGap: bestReward - currentReward,
      finishers, pop,
      finishRate: pop ? finishers / pop : 0,
      finish: num(fields.FINISH),
      bestFinish: num(fields.bestFinish, num(fields.FINISH)),
      elapsed: +m[3], genPerSec: +m[4],
    });
  }
  return { history, train };
}

function readRun() {
  try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); } catch { return null; }
}

function readSystemStats() {
  const stats = { cpuTempC: null, memTotalMb: null, memAvailableMb: null, memUsedMb: null, memUsedPct: null };
  try {
    const raw = Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim());
    if (Number.isFinite(raw)) stats.cpuTempC = raw > 1000 ? raw / 1000 : raw;
  } catch { }

  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const vals = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) vals[m[1]] = Number(m[2]);
    }
    const available = vals.MemAvailable || vals.MemFree;
    if (vals.MemTotal && available) {
      const used = vals.MemTotal - available;
      stats.memTotalMb = vals.MemTotal / 1024;
      stats.memAvailableMb = available / 1024;
      stats.memUsedMb = used / 1024;
      stats.memUsedPct = (used / vals.MemTotal) * 100;
    }
  } catch { }
  return stats;
}

(async () => {
  const payload = JSON.parse(fs.readFileSync(TRACK, 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init, payload.createCar);
  const { cps, start, occ, guide } = setupTrack(sim, { track: TRACK });

  // Static track map: unique downsampled tile points + checkpoints + bounds.
  const seen = new Set(); const tiles = [];
  for (const p of sim._parts) { const x = p[0] * 5, z = p[2] * 5; const k = `${x},${z}`; if (!seen.has(k)) { seen.add(k); tiles.push([x, z]); } }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of tiles) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const guidePoints = guide && Array.isArray(guide.points) ? guide.points : [];
  for (const p of guidePoints) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const trackMap = { tiles, checkpoints: cps.map((c, i) => ({ x: c.x, z: c.z, order: i })), start: { x: start.x, z: start.z }, guide: guide ? { radius: guide.radius, points: guidePoints.map((p, i) => ({ x: p.x, z: p.z, order: i + 1 })) } : null, bounds: { minX, maxX, minZ, maxZ } };

  // Replay policy files -> paths (throttled).
  const policy = new Policy(observe.SIZE, 16, 4);
  const tgt = (i) => (i < cps.length ? cps[i] : start);
  const guideRadius = guide ? guide.radius : 0;
  function guideTarget(s, guideIdx) {
    if (guideIdx < guidePoints.length) return guidePoints[guideIdx];
    return tgt(s.nextCheckpointIndex);
  }
  function guideNextTarget(s, guideIdx) {
    if (guideIdx + 1 < guidePoints.length) return guidePoints[guideIdx + 1];
    return tgt(s.nextCheckpointIndex);
  }
  const lapCaches = new Map();
  function replayPolicy(file, label) {
    const cached = lapCaches.get(file);
    if (cached && Date.now() - cached.t < 2500) return cached.data;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
    const weights = saved && saved.weights;
    if (!weights || weights.length !== policy.n) {
      const data = { label, file: path.basename(file), missing: true, path: [], maxCp: 0, finish: null };
      lapCaches.set(file, { t: Date.now(), data });
      return data;
    }
    policy.setWeights(weights);
    sim.reset();
    const pathPts = []; let last = null, maxCp = 0, finish = null, stuck = 0, prev = Infinity;
    let guideIdx = 0;
    // Use the current run's horizon so a valid >16 s Summer 1 finish is drawn
    // all the way to the line instead of being visually truncated on the map.
    const replayMaxFrames = Math.max(16000, Number(readRun()?.maxFrames) || 16000);
    for (let f = 0; f < replayMaxFrames; f++) {
      const s0 = last || sim.step({ up: false });
      const idx = s0.nextCheckpointIndex;
      while (guideIdx < guidePoints.length && Math.hypot(s0.position.x - guidePoints[guideIdx].x, s0.position.z - guidePoints[guideIdx].z) <= guideRadius) guideIdx++;
      const targetA = guidePoints.length ? guideTarget(s0, guideIdx) : tgt(idx);
      const targetB = guidePoints.length ? guideNextTarget(s0, guideIdx) : tgt(idx + 1);
      const s = sim.step(policy.act(observe(s0, [targetA, targetB], occ)));
      if (!s) break; last = s;
      if (f % 12 === 0) pathPts.push([+s.position.x.toFixed(1), +s.position.z.toFixed(1), +s.speedKmh.toFixed(0)]);
      if (s.nextCheckpointIndex > maxCp) { maxCp = s.nextCheckpointIndex; stuck = 0; }
      while (guideIdx < guidePoints.length && Math.hypot(s.position.x - guidePoints[guideIdx].x, s.position.z - guidePoints[guideIdx].z) <= guideRadius) guideIdx++;
      const pr = Math.hypot(s.position.x - tgt(s.nextCheckpointIndex).x, s.position.z - tgt(s.nextCheckpointIndex).z);
      if (pr < prev - 0.5) { prev = pr; stuck = 0; } else stuck++;
      if (s.finishFrames !== null) { finish = s.finishFrames; break; }
      if (stuck > 700 && Math.abs(s.speedKmh) < 8) break;
    }
    const data = {
      label, file: path.basename(file),
      generation: Number.isFinite(saved.generation) ? saved.generation : null,
      reward: Number.isFinite(saved.reward) ? saved.reward : saved.bestReward,
      path: pathPts, maxCp, finish,
      end: last ? { x: +last.position.x.toFixed(0), z: +last.position.z.toFixed(0) } : null,
    };
    lapCaches.set(file, { t: Date.now(), data });
    return data;
  }

  function replaySavedLap(file, fallbackPolicyFile) {
    const key = `lap:${file}`;
    const cached = lapCaches.get(key);
    if (cached && Date.now() - cached.t < 2500) return cached.data;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
    if (!saved || !Array.isArray(saved.actions) || !saved.actions.length) return replayPolicy(fallbackPolicyFile, 'best');

    sim.reset();
    const finishFrames = finite(saved.finishFrames);
    const needsInitialNeutral = finishFrames !== null && finishFrames === saved.actions.length + 1;
    let last = needsInitialNeutral ? sim.step(NEUTRAL_ACTION) : null;
    const pathPts = []; let maxCp = 0, finish = null;
    for (let f = 0; f < saved.actions.length; f++) {
      const s = sim.step(saved.actions[f]);
      if (!s) break;
      last = s;
      if (f % 12 === 0) pathPts.push([+s.position.x.toFixed(1), +s.position.z.toFixed(1), +s.speedKmh.toFixed(0)]);
      if (s.nextCheckpointIndex > maxCp) maxCp = s.nextCheckpointIndex;
      if (s.finishFrames !== null) { finish = s.finishFrames; break; }
    }
    if (finish === null) finish = finite(saved.finishFrames);
    const data = {
      label: 'best', file: path.basename(file), source: 'actions', kind: saved.kind || null,
      generation: finite(saved.generation), reward: finite(saved.bestReward),
      path: pathPts, maxCp: Math.max(maxCp, finite(saved.maxCheckpoint) ?? 0), finish,
      end: last ? { x: +last.position.x.toFixed(0), z: +last.position.z.toFixed(0) } : null,
    };
    lapCaches.set(key, { t: Date.now(), data });
    return data;
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return; }
    if (req.url === '/api/metrics') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...parseLog(), nCheckpoints: cps.length, reward: REWARD, system: readSystemStats(), run: readRun(), track: path.basename(TRACK), policy: path.basename(BEST_POLICY_FILE), currentPolicy: path.basename(CURRENT_POLICY_FILE), bestLap: path.basename(BEST_LAP_FILE), log: path.basename(LOG) })); return; }
    if (req.url === '/api/track') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(trackMap)); return; }
    if (req.url === '/api/laps') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ current: replayPolicy(CURRENT_POLICY_FILE, 'current'), best: replaySavedLap(BEST_LAP_FILE, BEST_POLICY_FILE) })); return; }
    if (req.url === '/api/lap') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(replayPolicy(BEST_POLICY_FILE, 'best'))); return; }
    res.writeHead(404); res.end('not found');
  });
  server.listen(PORT, () => console.log(`dashboard at http://localhost:${PORT}  (log: ${path.basename(LOG)})`));
})().catch((e) => { console.error(e); process.exit(1); });

const HTML = `<!doctype html><html lang=en><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>PolyTrack AI — Learning Lab</title>
<style>
:root{--bg:#08101d;--card:#101c2d;--card2:#0c1727;--bd:rgba(164,201,255,.15);--fg:#edf5ff;--mut:#91a6c2;--green:#5df0b5;--blue:#72b7ff;--violet:#bd9cff;--orange:#ffc17a;--red:#ff8293}
*{box-sizing:border-box}body{min-width:320px;margin:0;background:radial-gradient(900px 600px at 6% -15%,#173c76 0,transparent 60%),radial-gradient(760px 500px at 110% 0,#30226b 0,transparent 55%),var(--bg);color:var(--fg);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}body:before{content:"";position:fixed;inset:0;z-index:-1;opacity:.18;background-image:linear-gradient(rgba(148,184,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(148,184,255,.07) 1px,transparent 1px);background-size:36px 36px;mask-image:linear-gradient(to bottom,#000,transparent 72%)}
.wrap{max-width:1740px;margin:0 auto;padding:24px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(114,183,255,.55);border-radius:13px;background:linear-gradient(135deg,#226cb9,#7b5be4);box-shadow:0 8px 28px #2366b565;font-weight:900;letter-spacing:-1px}.eyebrow{margin:0;color:var(--blue);font:700 10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.15em}.brand h1{margin:3px 0 0;font-size:22px;letter-spacing:-.04em}.sub{color:var(--mut);font-size:12px;margin-top:2px}.runpill{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--bd);border-radius:999px;background:#0b182aab;color:#c5d8f2;font-size:12px;backdrop-filter:blur(12px)}.dot{width:8px;height:8px;border-radius:50%;background:var(--orange);box-shadow:0 0 0 4px #ffc17a20}.dot.live{background:var(--green);box-shadow:0 0 0 4px #5df0b520}.runmeta{color:var(--mut);padding-left:7px;border-left:1px solid var(--bd)}
.hero{display:grid;grid-template-columns:minmax(270px,1.35fr) repeat(3,minmax(120px,.5fr));gap:10px;padding:16px;margin-bottom:14px;border:1px solid var(--bd);border-radius:18px;background:linear-gradient(110deg,#12355cbb,#16183dbb);box-shadow:0 16px 45px #00000022}.hero-copy{padding:5px 8px}.hero-copy h2{margin:2px 0 4px;font-size:20px;letter-spacing:-.035em}.hero-copy p{max-width:620px;margin:0;color:#b8c8dd;font-size:13px}.hero-stat{padding:10px 12px;border:1px solid #b6d8ff18;border-radius:12px;background:#0713264d}.hero-stat b{display:block;margin-top:4px;color:var(--fg);font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hero-stat span{color:var(--mut);font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.sectionlabel{display:flex;align-items:center;justify-content:space-between;margin:16px 2px 8px;color:var(--mut);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.sectionlabel:after{content:"";height:1px;flex:1;margin-left:10px;background:var(--bd)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}.card{position:relative;overflow:hidden;background:linear-gradient(145deg,#13233aee,#0d1829ee);border:1px solid var(--bd);border-radius:14px;padding:12px;box-shadow:0 8px 26px #00000016}.card:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:linear-gradient(var(--blue),transparent 65%);opacity:.65}.card .k{color:var(--mut);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em}.card .v{font-size:22px;font-weight:750;letter-spacing:-.04em;line-height:1.15;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.settings{margin:14px 0 0}.settings .tag{max-width:100%;white-space:normal}.dashboard{display:grid;grid-template-columns:minmax(420px,1.15fr) repeat(3,minmax(210px,1fr));grid-auto-flow:dense;gap:10px;align-items:start}.mapcard{grid-row:span 3;padding:14px}.mapstack{display:grid;gap:12px}.maplabel{display:flex;justify-content:space-between;gap:8px;color:#c6d8f0;font-size:11px;font-weight:700;margin:2px 0 6px}.mapstack canvas{height:clamp(135px,calc((100vh - 410px)/2),240px)}.chartcard{min-height:128px}.chartcard h2,.mapcard h2{font-size:11px;color:var(--mut);margin:0 0 8px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.chartcard canvas{height:78px}canvas{width:100%;display:block;background:radial-gradient(circle at 50% 0,#142945,#091321);border:1px solid #9cc4ff12;border-radius:9px}.bar{height:7px;background:#06101e;border-radius:999px;overflow:hidden;margin-top:10px}.bar>i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--blue),var(--green));box-shadow:0 0 16px var(--green)}.tag{display:inline-block;padding:3px 7px;border:1px solid #a9caff1c;border-radius:999px;font:10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;background:#091525;color:#adc1dc}.live{color:var(--green)}.dead{color:var(--orange)}
@media (max-width:1250px){.dashboard{grid-template-columns:repeat(2,minmax(260px,1fr))}.mapcard{grid-column:1/-1;grid-row:auto}.chartcard canvas{height:96px}}@media (max-width:760px){.wrap{padding:14px}.topbar{align-items:flex-start;flex-direction:column}.runpill{width:100%;justify-content:center}.hero{grid-template-columns:repeat(2,minmax(0,1fr))}.hero-copy{grid-column:1/-1}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard{grid-template-columns:1fr}.mapcard{grid-column:auto}.mapstack canvas{height:220px}}@media (max-width:420px){.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.hero-copy{grid-column:auto}.brand h1{font-size:20px}}
</style>
<div class=wrap>
<header class=topbar><div class=brand><div class=mark>PT</div><div><p class=eyebrow>LIVE LEARNING LAB</p><h1>PolyTrack AI</h1><div class=sub id=sub>Connecting to the learner…</div></div></div><div class=runpill><i class=dot id=rundot></i><b id=runstate>Starting</b><span class=runmeta id=runclock>—</span></div></header>
<section class=hero><div class=hero-copy><p class=eyebrow>RUN OVERVIEW</p><h2 id=runheadline>Preparing a new driver</h2><p id=runmessage>The dashboard will fill in as the first simulated laps are evaluated.</p></div><div class=hero-stat><span>Learning mode</span><b id=runmode>—</b></div><div class=hero-stat><span>Run started</span><b id=runstarted>—</b></div><div class=hero-stat><span>Run ID</span><b id=runid>—</b></div></section>
<div class=sectionlabel>Live performance</div>
<div class=grid>
<div class=card><div class=k>Current reward</div><div class=v id=currew>-</div></div>
<div class=card><div class=k>Mean reward</div><div class=v id=meanrew>-</div></div>
<div class=card><div class=k>Finishers</div><div class=v id=finishers>-</div></div>
<div class=card><div class=k>Best finish</div><div class=v id=bestfinish>-</div></div>
<div class=card><div class=k>Current fastest lap</div><div class=v id=curfinish>-</div></div>
<div class=card><div class=k>CPU temp</div><div class=v id=cputemp>-</div></div>
<div class=card><div class=k>RAM use</div><div class=v id=ramuse>-</div></div>
<div class=card><div class=k>Generation</div><div class=v id=gen>–</div></div>
<div class=card><div class=k>Best checkpoint</div><div class=v id=cp>–</div><div class=bar><i id=cpbar style=width:0></i></div></div>
<div class=card><div class=k>Best reward</div><div class=v id=rew>–</div></div>
<div class=card><div class=k>Speed</div><div class=v id=spd>–</div></div>
</div>
<div class=dashboard>
<div class="card mapcard"><h2>Driving paths</h2><div class=mapstack>
<div class=mapview><div class=maplabel>Current generation <span class=tag id=currentlapinfo></span></div><canvas id=currentmap width=640 height=240></canvas></div>
<div class=mapview><div class=maplabel>Best so far <span class=tag id=bestlapinfo></span></div><canvas id=bestmap width=640 height=240></canvas></div>
</div></div>
<div class="card chartcard"><h2>Best reward</h2><canvas id=chart width=360 height=110></canvas></div>
<div class="card chartcard"><h2>Current reward</h2><canvas id=currentchart width=360 height=110></canvas></div>
<div class="card chartcard"><h2>Mean reward</h2><canvas id=meanchart width=360 height=110></canvas></div>
<div class="card chartcard"><h2>Reward spread</h2><canvas id=stdchart width=360 height=110></canvas></div>
<div class="card chartcard"><h2>Finishers</h2><canvas id=finisherschart width=360 height=110></canvas></div>
<div class="card chartcard"><h2>Current fastest lap</h2><canvas id=currentfinishchart width=360 height=110></canvas></div>
<div class="card chartcard"><h2>Best finish time</h2><canvas id=finishchart width=360 height=110></canvas></div>
<div class="card chartcard"><h2>Checkpoint reached</h2><canvas id=cpchart width=360 height=110></canvas></div>
<div class="card chartcard"><h2>Training speed</h2><canvas id=speedchart width=360 height=110></canvas></div>
</div>
<div class="card settings"><h2>Training settings</h2><div id=settings class=tag>loading</div></div>
</div>
<script>
const $=id=>document.getElementById(id);
let track=null;
async function j(u){const r=await fetch(u);return r.json()}
function relativeTime(iso){if(!iso)return '—';const d=new Date(iso),s=Math.max(0,Math.round((Date.now()-d)/1000));if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return d.toLocaleDateString();}
function renderRun(m,h){const r=m.run||{};const hasHistory=h.length>0;const running=hasHistory&&r.status!=='completed';const mode=r.mode==='fresh'?'From scratch':r.mode==='resumed'?'Continuing':'New learner';
 $('rundot').className='dot '+(running?'live':'');$('runstate').textContent=running?'Learning live':r.status==='completed'?'Run complete':'Waiting for laps';$('runclock').textContent=r.lastUpdatedAt?relativeTime(r.lastUpdatedAt):r.startedAt?relativeTime(r.startedAt):'—';
 $('runmode').textContent=mode;$('runstarted').textContent=r.startedAt?new Date(r.startedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'—';$('runid').textContent=r.id||'—';
 if(r.status==='completed'){$('runheadline').textContent='This learning run is complete';$('runmessage').textContent='Its best policy and replay remain available to inspect or continue.'}
 else if(r.mode==='fresh'){$('runheadline').textContent=hasHistory?'Learning from a blank slate':'A brand-new driver is warming up';$('runmessage').textContent=hasHistory?'Every chart and path below belongs only to this fresh run—no old policy is being carried forward.':'The policy starts with random weights. The first evaluated generation will appear here shortly.'}
 else if(hasHistory){$('runheadline').textContent='The driver is exploring the track';$('runmessage').textContent='Watch how the policy earns reward, carries its speed, and turns more checkpoints into a complete lap.'}
 else {$('runheadline').textContent='Preparing the learning run';$('runmessage').textContent='Waiting for the trainer to write its first generation.'}}
function drawChart(cv,hist,key,color,max){const x=cv.getContext('2d'),W=cv.width,H=cv.height;x.clearRect(0,0,W,H);if(!hist.length)return;
 const pts=hist.map((h,i)=>({i,v:h[key]})).filter(p=>Number.isFinite(p.v));if(!pts.length)return;
 let mn=Math.min(...pts.map(p=>p.v)),mx=max??Math.max(...pts.map(p=>p.v));if(mx===mn)mx=mn+1;
 x.strokeStyle='#21262d';x.lineWidth=1;for(let i=0;i<=4;i++){const yy=H-10-(H-20)*i/4;x.beginPath();x.moveTo(34,yy);x.lineTo(W-6,yy);x.stroke();}
 x.fillStyle='#8b949e';x.font='10px monospace';x.fillText(mx.toFixed(0),2,14);x.fillText(mn.toFixed(0),2,H-8);
 x.strokeStyle=color;x.lineWidth=2;x.beginPath();pts.forEach((p,i)=>{const px=34+(W-40)*p.i/Math.max(1,hist.length-1);const py=H-10-(H-20)*(p.v-mn)/(mx-mn);i?x.lineTo(px,py):x.moveTo(px,py);});x.stroke();}
function drawMap(id,lap,c0,c1){const cv=$(id),x=cv.getContext('2d'),W=cv.width,H=cv.height;x.clearRect(0,0,W,H);if(!track)return;
 const b=track.bounds,pad=20;const sx=(W-2*pad)/(b.maxX-b.minX),sz=(H-2*pad)/(b.maxZ-b.minZ),s=Math.min(sx,sz);
 const T=(p)=>[pad+(p[0]-b.minX)*s,pad+(p[1]-b.minZ)*s];const Tc=(p)=>[pad+(p.x-b.minX)*s,pad+(p.z-b.minZ)*s];
 x.fillStyle='#1b2230';for(const t of track.tiles){const[px,py]=T(t);x.fillRect(px-2,py-2,4,4);}
 // path
 if(lap&&lap.path.length){x.lineWidth=2.5;x.beginPath();lap.path.forEach((p,i)=>{const[px,py]=T(p);i?x.lineTo(px,py):x.moveTo(px,py);});
   const g=x.createLinearGradient(0,0,W,0);g.addColorStop(0,c0);g.addColorStop(1,c1);x.strokeStyle=g;x.stroke();
   const e=lap.path[lap.path.length-1],[ex,ey]=T(e);x.fillStyle='#f85149';x.beginPath();x.arc(ex,ey,4,0,7);x.fill();}
 // checkpoints + start
 track.checkpoints.forEach(c=>{const[px,py]=Tc(c);x.fillStyle='#d29922';x.beginPath();x.arc(px,py,5,0,7);x.fill();x.fillStyle='#0d1117';x.font='9px monospace';x.fillText(c.order,px-2,py+3);});
 if(track.guide&&track.guide.points&&track.guide.points.length){x.strokeStyle='#39d5d5';x.lineWidth=1.5;x.setLineDash([5,4]);x.beginPath();track.guide.points.forEach((p,i)=>{const[px,py]=Tc(p);i?x.lineTo(px,py):x.moveTo(px,py);});x.stroke();x.setLineDash([]);track.guide.points.forEach(p=>{const[px,py]=Tc(p);x.fillStyle='#39d5d5';x.beginPath();x.arc(px,py,4,0,7);x.fill();x.fillStyle='#071018';x.font='8px monospace';x.fillText(p.order,px-2,py+3);});}
 const[stx,sty]=Tc(track.start);x.fillStyle='#3fb950';x.beginPath();x.arc(stx,sty,5,0,7);x.fill();}
function lapText(lap){if(!lap||lap.missing)return 'waiting for policy';const bits=['cp '+lap.maxCp];if(lap.source)bits.push(lap.source);if(lap.kind)bits.push(lap.kind);if(Number.isFinite(lap.generation))bits.push('gen '+lap.generation);if(Number.isFinite(lap.reward))bits.push('reward '+lap.reward.toFixed(0));if(lap.finish)bits.push((lap.finish/1000).toFixed(3)+'s');if(lap.end)bits.push('ends ('+lap.end.x+','+lap.end.z+')');return bits.join(' | ');}
function renderSettings(m){const r=m.reward||{},t=m.train||{};const rewardBits=Object.keys(r).map(k=>k+'='+r[k]);$('settings').textContent=[
 'track='+m.track,'log='+m.log,'bestPolicy='+m.policy,'currentPolicy='+m.currentPolicy,'bestLap='+m.bestLap,
 t.pop?('pop='+t.pop):null,t.workers?('workers='+t.workers):null,t.maxFrames?('maxFrames='+t.maxFrames):null,
 ...rewardBits
].filter(Boolean).join('  |  ');}
async function tick(){try{
 const m=await j('/api/metrics');const h=m.history;if(!track)track=await j('/api/track');
 renderRun(m,h);
 renderSettings(m);
 const sys=m.system||{};
 $('cputemp').textContent=Number.isFinite(sys.cpuTempC)?sys.cpuTempC.toFixed(1)+'C':'-';
 $('ramuse').textContent=Number.isFinite(sys.memUsedPct)?sys.memUsedPct.toFixed(0)+'% '+sys.memUsedMb.toFixed(0)+'/'+sys.memTotalMb.toFixed(0)+'MB':'-';
 if(h.length){const c=h[h.length-1];const allCp=Math.max(...h.map(x=>x.bestCp));
  const finishes=h.map(x=>x.bestFinish).filter(Number.isFinite);
  const bestFinish=finishes.length?Math.min(...finishes):null;
  const latestFinish=[...h].reverse().find(x=>Number.isFinite(x.finish));
  $('gen').textContent=c.gen;$('currew').textContent=c.currentReward.toFixed(0);$('rew').textContent=c.bestReward.toFixed(0);$('meanrew').textContent=c.meanReward.toFixed(0);
  $('finishers').textContent=c.pop?(c.finishers+' / '+c.pop):String(c.finishers);
  $('bestfinish').textContent=bestFinish!==null?bestFinish.toFixed(3)+'s':'-';
  $('curfinish').textContent=Number.isFinite(c.finish)?c.finish.toFixed(3)+'s':'-';
  $('cp').textContent=c.bestCp+' / '+allCp+' / '+m.nCheckpoints;$('cpbar').style.width=(100*allCp/m.nCheckpoints)+'%';
  $('spd').textContent=c.genPerSec.toFixed(2)+' gen/s';
  const fin=latestFinish;
  $('sub').innerHTML='<span class=live>● LIVE</span> &nbsp; generation '+c.gen+' &nbsp; elapsed '+(c.elapsed/60).toFixed(1)+'m &nbsp; '+(fin?'<b style=color:#5df0b5>FASTEST '+fin.finish.toFixed(3)+'s</b>':'exploring for a first full lap');
  drawChart($('chart'),h,'bestReward','#58a6ff');
  drawChart($('currentchart'),h,'currentReward','#3fb950');
  drawChart($('meanchart'),h,'meanReward','#a5d6ff');
  drawChart($('stdchart'),h,'rewardStd','#bc8cff');
  drawChart($('finisherschart'),h,'finishers','#3fb950',c.pop||undefined);
  drawChart($('currentfinishchart'),h,'finish','#ffab70');
  drawChart($('finishchart'),h,'bestFinish','#f85149');
  drawChart($('cpchart'),h,'bestCp','#d29922',m.nCheckpoints);
  drawChart($('speedchart'),h,'genPerSec','#f78166');}
 if(!h.length){const r=m.run||{};$('sub').textContent=Number.isFinite(r.currentGeneration)?('Evaluating generation '+r.currentGeneration+' • '+((Number(r.evaluationFrames)||0)/1000).toFixed(0)+'s episode budget'):'Connected — waiting for the first learning generation…';}
 const laps=await j('/api/laps');
 $('currentlapinfo').textContent=lapText(laps.current);
 $('bestlapinfo').textContent=lapText(laps.best);
 drawMap('currentmap',laps.current,'#ffab70','#d29922');
 drawMap('bestmap',laps.best,'#58a6ff','#3fb950');
}catch(e){$('sub').textContent='error: '+e}}
tick();setInterval(tick,3000);
</script>`;
