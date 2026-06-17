// Live training dashboard. Parses the ES training log and renders metrics + a
// top-down track map with the current best policy's driving path.
//
// Usage: node train/dashboard.js [logfile] [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { setupTrack } = require('./evaluator');
const { observe } = require('../sim/observe');
const { Policy } = require('./policy');

const DATA = path.resolve(__dirname, '..', 'data');
const LOG = process.argv[2] || path.join(__dirname, '..', 'train3.log');
// Track to visualize (match the TRACK you trained). Default = Summer 1.
const TRACK = process.env.TRACK ? path.resolve(process.env.TRACK) : path.join(DATA, 'constants.json');
const TAG = path.basename(TRACK, '.json');
const POLICY_FILE = path.join(DATA, TAG === 'constants' ? 'policy.json' : `policy.${TAG}.json`);
const PORT = parseInt(process.argv[3] || '7780', 10);

const LINE = /gen\s+(\d+)\s+bestCp=(\d+)\s+bestReward=([-\d.]+)(?:\s+FINISH=([\d.]+)s)?\s+\((\d+)s,\s+([\d.]+)\s+gen\/s\)/g;
function parseLog() {
  let txt = ''; try { txt = fs.readFileSync(LOG, 'utf8'); } catch { return { history: [] }; }
  const history = []; let m;
  LINE.lastIndex = 0;
  while ((m = LINE.exec(txt))) history.push({ gen: +m[1], bestCp: +m[2], bestReward: +m[3], finish: m[4] ? +m[4] : null, elapsed: +m[5], genPerSec: +m[6] });
  return { history };
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

  // Replay current best policy -> path (throttled).
  const policy = new Policy(observe.SIZE, 16, 4);
  const tgt = (i) => (i < cps.length ? cps[i] : start);
  let lapCache = { t: 0, data: null };
  function replayBest() {
    if (Date.now() - lapCache.t < 2500 && lapCache.data) return lapCache.data;
    let weights = null;
    try { weights = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')).weights; } catch { }
    if (!weights || weights.length !== policy.n) { lapCache = { t: Date.now(), data: { path: [], maxCp: 0, finish: null } }; return lapCache.data; }
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
    lapCache = { t: Date.now(), data: { path: pathPts, maxCp, finish, end: last ? { x: +last.position.x.toFixed(0), z: +last.position.z.toFixed(0) } : null } };
    return lapCache.data;
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return; }
    if (req.url === '/api/metrics') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...parseLog(), nCheckpoints: cps.length })); return; }
    if (req.url === '/api/track') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(trackMap)); return; }
    if (req.url === '/api/lap') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(replayBest())); return; }
    res.writeHead(404); res.end('not found');
  });
  server.listen(PORT, () => console.log(`dashboard at http://localhost:${PORT}  (log: ${path.basename(LOG)})`));
})().catch((e) => { console.error(e); process.exit(1); });

const HTML = `<!doctype html><meta charset=utf8><title>PolyTrack AI — Training</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#3fb950;--acc2:#58a6ff;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
h1{font-size:18px;margin:0 0 2px}.sub{color:var(--mut);font-size:12px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:14px}
.card .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.card .v{font-size:24px;font-weight:600;margin-top:4px}
.row{display:grid;grid-template-columns:1.2fr 1fr;gap:12px}
canvas{width:100%;display:block;background:#0a0d12;border-radius:6px}
.bar{height:10px;background:#21262d;border-radius:5px;overflow:hidden;margin-top:8px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--acc2),var(--acc))}
.tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:#21262d;color:var(--mut)}
.live{color:var(--acc)}.dead{color:var(--warn)}
h2{font-size:13px;color:var(--mut);margin:0 0 8px;font-weight:600}
</style>
<div class=wrap>
<h1>🏎️ PolyTrack AI — Evolution Strategies</h1>
<div class=sub id=sub>connecting…</div>
<div class=grid>
<div class=card><div class=k>Generation</div><div class=v id=gen>–</div></div>
<div class=card><div class=k>Best checkpoint</div><div class=v id=cp>–</div><div class=bar><i id=cpbar style=width:0></i></div></div>
<div class=card><div class=k>Best reward</div><div class=v id=rew>–</div></div>
<div class=card><div class=k>Speed</div><div class=v id=spd>–</div></div>
</div>
<div class=row>
<div class=card><h2>Best policy — driving path <span class=tag id=lapinfo></span></h2><canvas id=map width=640 height=420></canvas></div>
<div class=card><h2>Best reward / generation</h2><canvas id=chart width=420 height=190></canvas>
<h2 style=margin-top:14px>Checkpoint reached / generation</h2><canvas id=cpchart width=420 height=150></canvas></div>
</div></div>
<script>
const $=id=>document.getElementById(id);
let track=null;
async function j(u){const r=await fetch(u);return r.json()}
function drawChart(cv,hist,key,color,max){const x=cv.getContext('2d'),W=cv.width,H=cv.height;x.clearRect(0,0,W,H);if(!hist.length)return;
 const ys=hist.map(h=>h[key]).filter(v=>isFinite(v));let mn=Math.min(...ys),mx=max??Math.max(...ys);if(mx===mn)mx=mn+1;
 x.strokeStyle='#21262d';x.lineWidth=1;for(let i=0;i<=4;i++){const yy=H-10-(H-20)*i/4;x.beginPath();x.moveTo(34,yy);x.lineTo(W-6,yy);x.stroke();}
 x.fillStyle='#8b949e';x.font='10px monospace';x.fillText(mx.toFixed(0),2,14);x.fillText(mn.toFixed(0),2,H-8);
 x.strokeStyle=color;x.lineWidth=2;x.beginPath();hist.forEach((h,i)=>{const v=h[key];const px=34+(W-40)*i/Math.max(1,hist.length-1);const py=H-10-(H-20)*(v-mn)/(mx-mn);i?x.lineTo(px,py):x.moveTo(px,py);});x.stroke();}
function drawMap(lap){const cv=$('map'),x=cv.getContext('2d'),W=cv.width,H=cv.height;x.clearRect(0,0,W,H);if(!track)return;
 const b=track.bounds,pad=20;const sx=(W-2*pad)/(b.maxX-b.minX),sz=(H-2*pad)/(b.maxZ-b.minZ),s=Math.min(sx,sz);
 const T=(p)=>[pad+(p[0]-b.minX)*s,pad+(p[1]-b.minZ)*s];const Tc=(p)=>[pad+(p.x-b.minX)*s,pad+(p.z-b.minZ)*s];
 x.fillStyle='#1b2230';for(const t of track.tiles){const[px,py]=T(t);x.fillRect(px-2,py-2,4,4);}
 // path
 if(lap&&lap.path.length){x.lineWidth=2.5;x.beginPath();lap.path.forEach((p,i)=>{const[px,py]=T(p);i?x.lineTo(px,py):x.moveTo(px,py);});
   const g=x.createLinearGradient(0,0,W,0);g.addColorStop(0,'#58a6ff');g.addColorStop(1,'#3fb950');x.strokeStyle=g;x.stroke();
   const e=lap.path[lap.path.length-1],[ex,ey]=T(e);x.fillStyle='#f85149';x.beginPath();x.arc(ex,ey,4,0,7);x.fill();}
 // checkpoints + start
 track.checkpoints.forEach(c=>{const[px,py]=Tc(c);x.fillStyle='#d29922';x.beginPath();x.arc(px,py,5,0,7);x.fill();x.fillStyle='#0d1117';x.font='9px monospace';x.fillText(c.order,px-2,py+3);});
 const[stx,sty]=Tc(track.start);x.fillStyle='#3fb950';x.beginPath();x.arc(stx,sty,5,0,7);x.fill();}
async function tick(){try{
 const m=await j('/api/metrics');const h=m.history;if(!track)track=await j('/api/track');
 if(h.length){const c=h[h.length-1];const allCp=Math.max(...h.map(x=>x.bestCp));
  $('gen').textContent=c.gen;$('rew').textContent=c.bestReward.toFixed(0);
  $('cp').textContent=allCp+' / '+m.nCheckpoints;$('cpbar').style.width=(100*allCp/m.nCheckpoints)+'%';
  $('spd').textContent=c.genPerSec.toFixed(2)+' gen/s';
  const fin=h.find(x=>x.finish);
  $('sub').innerHTML=(Date.now()/1000-(c._t||0)<999?'<span class=live>● training</span>':'')+' &nbsp; elapsed '+(c.elapsed/60).toFixed(1)+'m &nbsp; '+(fin?'<b style=color:#3fb950>FINISH '+fin.finish.toFixed(3)+'s</b>':'no full lap yet');
  drawChart($('chart'),h,'bestReward','#58a6ff');drawChart($('cpchart'),h,'bestCp','#d29922',m.nCheckpoints);}
 const lap=await j('/api/lap');$('lapinfo').textContent='cp '+lap.maxCp+(lap.finish?(' · '+(lap.finish/1000).toFixed(3)+'s'):'')+(lap.end?(' · ends ('+lap.end.x+','+lap.end.z+')'):'');
 drawMap(lap);
}catch(e){$('sub').textContent='error: '+e}}
tick();setInterval(tick,3000);
</script>`;
