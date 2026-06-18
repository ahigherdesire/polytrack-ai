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
const PORT = parseInt(process.argv[3] || '7780', 10);

const LINE = /^gen\s+(\d+)\s+(.+?)\s+\((\d+)s,\s+([\d.]+)\s+gen\/s\)/gm;
const TRAIN_LINE = /spawning\s+(\d+)\s+workers,\s+pop\s+(\d+),\s+maxFrames\s+(\d+)/;
const num = (v, fallback = null) => (v === undefined ? fallback : Number(String(v).replace(/s$/, '')));
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
  const { cps, start, occ } = setupTrack(sim);

  // Static track map: unique downsampled tile points + checkpoints + bounds.
  const seen = new Set(); const tiles = [];
  for (const p of sim._parts) { const x = p[0] * 5, z = p[2] * 5; const k = `${x},${z}`; if (!seen.has(k)) { seen.add(k); tiles.push([x, z]); } }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of tiles) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const trackMap = { tiles, checkpoints: cps.map((c, i) => ({ x: c.x, z: c.z, order: i })), start: { x: start.x, z: start.z }, bounds: { minX, maxX, minZ, maxZ } };

  // Replay policy files -> paths (throttled).
  const policy = new Policy(observe.SIZE, 16, 4);
  const tgt = (i) => (i < cps.length ? cps[i] : start);
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
    for (let f = 0; f < 16000; f++) {
      const s0 = last || sim.step({ up: false });
      const idx = s0.nextCheckpointIndex;
      const s = sim.step(policy.act(observe(s0, [tgt(idx), tgt(idx + 1)], occ)));
      if (!s) break; last = s;
      if (f % 12 === 0) pathPts.push([+s.position.x.toFixed(1), +s.position.z.toFixed(1), +s.speedKmh.toFixed(0)]);
      if (s.nextCheckpointIndex > maxCp) { maxCp = s.nextCheckpointIndex; stuck = 0; }
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
    let last = sim.step({ up: false });
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
    if (req.url === '/api/metrics') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...parseLog(), nCheckpoints: cps.length, reward: REWARD, system: readSystemStats(), track: path.basename(TRACK), policy: path.basename(BEST_POLICY_FILE), currentPolicy: path.basename(CURRENT_POLICY_FILE), bestLap: path.basename(BEST_LAP_FILE), log: path.basename(LOG) })); return; }
    if (req.url === '/api/track') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(trackMap)); return; }
    if (req.url === '/api/laps') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ current: replayPolicy(CURRENT_POLICY_FILE, 'current'), best: replaySavedLap(BEST_LAP_FILE, BEST_POLICY_FILE) })); return; }
    if (req.url === '/api/lap') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(replayPolicy(BEST_POLICY_FILE, 'best'))); return; }
    res.writeHead(404); res.end('not found');
  });
  server.listen(PORT, () => console.log(`dashboard at http://localhost:${PORT}  (log: ${path.basename(LOG)})`));
})().catch((e) => { console.error(e); process.exit(1); });

const HTML = `<!doctype html><meta charset=utf8><title>PolyTrack AI — Training</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#3fb950;--acc2:#58a6ff;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
.wrap{max-width:1760px;margin:0 auto;padding:12px}
h1{font-size:18px;margin:0 0 2px}.sub{color:var(--mut);font-size:12px;margin-bottom:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;margin-bottom:10px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:8px}
.card .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.card .v{font-size:20px;font-weight:600;line-height:1.15;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.settings{margin:10px 0 0}.settings .tag{max-width:100%;white-space:normal}
.dashboard{display:grid;grid-template-columns:minmax(430px,1.15fr) repeat(3,minmax(210px,1fr));grid-auto-flow:dense;gap:10px;align-items:start}
.mapcard,.dashboard>.card:first-child{grid-row:span 3}
.mapstack{display:grid;gap:8px}
.maplabel{color:var(--mut);font-size:11px;margin-bottom:4px}
.mapstack canvas{height:clamp(125px,calc((100vh - 370px)/2),235px)}
.chartcard canvas{height:76px}
canvas{width:100%;display:block;background:#0a0d12;border-radius:6px}
.bar{height:10px;background:#21262d;border-radius:5px;overflow:hidden;margin-top:8px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--acc2),var(--acc))}
.tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:#21262d;color:var(--mut)}
.live{color:var(--acc)}.dead{color:var(--warn)}
h2{font-size:12px;color:var(--mut);margin:0 0 6px;font-weight:600}
@media (max-width:1250px){.dashboard{grid-template-columns:repeat(2,minmax(260px,1fr))}.mapcard,.dashboard>.card:first-child{grid-column:1/-1;grid-row:auto}.chartcard canvas{height:96px}}
@media (max-width:720px){.wrap{padding:10px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard{grid-template-columns:1fr}.mapcard,.dashboard>.card:first-child{grid-column:auto}.mapstack canvas{height:220px}}
</style>
<div class=wrap>
<h1>🏎️ PolyTrack AI — Evolution Strategies</h1>
<div class=sub id=sub>connecting…</div>
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
 const[stx,sty]=Tc(track.start);x.fillStyle='#3fb950';x.beginPath();x.arc(stx,sty,5,0,7);x.fill();}
function lapText(lap){if(!lap||lap.missing)return 'waiting for policy';const bits=['cp '+lap.maxCp];if(lap.source)bits.push(lap.source);if(lap.kind)bits.push(lap.kind);if(Number.isFinite(lap.generation))bits.push('gen '+lap.generation);if(Number.isFinite(lap.reward))bits.push('reward '+lap.reward.toFixed(0));if(lap.finish)bits.push((lap.finish/1000).toFixed(3)+'s');if(lap.end)bits.push('ends ('+lap.end.x+','+lap.end.z+')');return bits.join(' | ');}
function renderSettings(m){const r=m.reward||{},t=m.train||{};$('settings').textContent=[
 'track='+m.track,'log='+m.log,'bestPolicy='+m.policy,'currentPolicy='+m.currentPolicy,'bestLap='+m.bestLap,
 t.pop?('pop='+t.pop):null,t.workers?('workers='+t.workers):null,t.maxFrames?('maxFrames='+t.maxFrames):null,
 'perCheckpoint='+r.perCheckpoint,'distanceWeight='+r.distanceWeight,'finishBonus='+r.finishBonus,
 'finishTimeWeight='+r.finishTimeWeight,'stuckFrames='+r.stuckFrames,'stuckSpeed='+r.stuckSpeed
].filter(Boolean).join('  |  ');}
async function tick(){try{
 const m=await j('/api/metrics');const h=m.history;if(!track)track=await j('/api/track');
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
  $('sub').innerHTML=(Date.now()/1000-(c._t||0)<999?'<span class=live>● training</span>':'')+' &nbsp; elapsed '+(c.elapsed/60).toFixed(1)+'m &nbsp; '+(fin?'<b style=color:#3fb950>FINISH '+fin.finish.toFixed(3)+'s</b>':'no full lap yet');
  drawChart($('chart'),h,'bestReward','#58a6ff');
  drawChart($('currentchart'),h,'currentReward','#3fb950');
  drawChart($('meanchart'),h,'meanReward','#a5d6ff');
  drawChart($('stdchart'),h,'rewardStd','#bc8cff');
  drawChart($('finisherschart'),h,'finishers','#3fb950',c.pop||undefined);
  drawChart($('currentfinishchart'),h,'finish','#ffab70');
  drawChart($('finishchart'),h,'bestFinish','#f85149');
  drawChart($('cpchart'),h,'bestCp','#d29922',m.nCheckpoints);
  drawChart($('speedchart'),h,'genPerSec','#f78166');}
 const laps=await j('/api/laps');
 $('currentlapinfo').textContent=lapText(laps.current);
 $('bestlapinfo').textContent=lapText(laps.best);
 drawMap('currentmap',laps.current,'#ffab70','#d29922');
 drawMap('bestmap',laps.best,'#58a6ff','#3fb950');
}catch(e){$('sub').textContent='error: '+e}}
tick();setInterval(tick,3000);
</script>`;
