// Lap control panel: scans your lap JSON files, shows everything, and RUNS the
// tools for you with buttons (optimize / stop) — spawning processes with arg
// arrays so paths with spaces just work. One-click copy of the play script.
//
// Usage: node bridge/ui.js [port]      then open http://localhost:7800
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { actionsToRecording } = require('./make-recording');

const ROOT = path.resolve(__dirname, '..');
const GRABBED = path.join(ROOT, 'data', 'grabbed');
const DIRS = [GRABBED, path.join(ROOT, 'data')];
const TRACKS = path.join(ROOT, 'tracks');
const PORT = parseInt(process.argv[2] || '7800', 10);
const ORDER = ['up', 'right', 'down', 'left', 'reset'];

const isLap = (j) => j && ((Array.isArray(j.actions) && j.actions.length) || typeof j.recording === 'string');
function recordingOf(j) {
  if (typeof j.recording === 'string' && j.recording.length) return j.recording;
  if (!Array.isArray(j.actions)) return null;
  return actionsToRecording(j.actions, { prependNeutral: j.finishFrames === j.actions.length + 1 });
}
function toggleCounts(actions) {
  const t = Object.fromEntries(ORDER.map((k) => [k, 0])); let prev = {};
  for (const a of actions) { for (const k of ORDER) if (!!a[k] !== !!prev[k]) t[k]++; prev = a; }
  return t;
}
const baseName = (n) => n.replace(/\.json$/, '').replace(/(_wr|_best|\.optimized|\.recording)$/i, '');
const findLap = (file) => DIRS.map((d) => path.join(d, file)).find((p) => fs.existsSync(p));
const listTracks = () => { try { return fs.readdirSync(TRACKS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')); } catch { return []; } };

function scanLaps() {
  const seen = new Set(); const laps = [];
  for (const dir of DIRS) {
    let files = []; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || seen.has(f)) continue;
      try {
        const st = fs.statSync(path.join(dir, f)); if (st.size > 12 * 1024 * 1024) continue;
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (!isLap(j)) continue;
        seen.add(f);
        const frames = j.finishFrames ?? j.frames ?? (j.actions ? j.actions.length : 0);
        laps.push({ file: f, name: f.replace(/\.json$/, ''), track: baseName(f), driver: j.nickname || null, kind: j.kind || (j.recording ? 'recording' : 'lap'), frames, seconds: +(frames / 1000).toFixed(3), actions: j.actions ? j.actions.length : null, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return laps.sort((a, b) => b.mtime - a.mtime);
}
function lapDetail(file) {
  const full = findLap(file); if (!full) return null;
  const j = JSON.parse(fs.readFileSync(full, 'utf8'));
  const rec = recordingOf(j);
  const frames = j.finishFrames ?? j.frames ?? (j.actions ? j.actions.length : 0);
  return { file, driver: j.nickname || null, kind: j.kind || 'lap', frames, seconds: +(frames / 1000).toFixed(3), toggles: j.actions ? toggleCounts(j.actions) : null, recording: rec };
}

// ---- one job at a time (optimize OR randomize) ----
let job = null;
function startJob(lapFile, track, iters, mode) {
  if (job && !job.done) return { error: 'A job is already running. Stop it first.' };
  const lapPath = findLap(lapFile); if (!lapPath) return { error: 'lap not found' };
  const trackPath = path.join(TRACKS, track.endsWith('.json') ? track : track + '.json');
  if (!fs.existsSync(trackPath)) return { error: 'track not found: ' + track };
  const random = mode === 'random';
  const out = path.join(GRABBED, baseName(lapFile) + (random ? '_random.json' : '_best.json'));
  const script = path.join(__dirname, random ? 'randomize-lap.js' : 'optimize-lap.js');
  const args = random ? [script, lapPath, trackPath, String(iters), out, '2'] : [script, lapPath, trackPath, String(iters), out];
  fs.mkdirSync(GRABBED, { recursive: true });
  const proc = spawn(process.execPath, args, { cwd: ROOT });
  job = { lap: lapFile, track, mode: random ? 'randomize' : 'optimize', out: path.basename(out), iters, startedAt: Date.now(), log: [], best: null, seed: null, time: null, diverged: null, done: false, proc };
  const onData = (d) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue; job.log.push(line); if (job.log.length > 12) job.log.shift();
      let m = line.match(/seed (?:finishes at |)(\d+)/); if (m && !job.seed) { job.seed = +m[1]; job.best = +m[1]; }
      m = line.match(/improved -> (\d+)/); if (m) job.best = +m[1];
      m = line.match(/time=([\d.]+)s/); if (m) job.time = +m[1];
      m = line.match(/diverged \d+\/?\d* frames \((\d+)%/); if (m) job.diverged = +m[1];
    }
  };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  proc.on('exit', (code) => { job.done = true; job.exit = code; });
  return { ok: true };
}
function jobStatus() {
  if (!job) return null;
  return { lap: job.lap, track: job.track, mode: job.mode, out: job.out, iters: job.iters, running: !job.done, seed: job.seed, best: job.best, time: job.time, diverged: job.diverged, secs: ((Date.now() - job.startedAt) / 1000) | 0, log: job.log.slice(-4) };
}

function playScript(rec) {
  return `(() => {
  const REC = '${rec}';
  const ids = new Set(); let on = true;
  const P = Worker.prototype; if (!P.__o) P.__o = P.postMessage; const o = P.__o;
  P.postMessage = function (m, t) {
    try { if (on && m && typeof m === 'object') {
      if (m.messageType === 3 && m.carRecording == null) { ids.add(m.carId); m = { ...m, carRecording: REC }; console.log('[play] driving the lap'); }
      if (m.messageType === 6 && ids.has(m.carId)) return undefined;
      if (m.messageType === 4) ids.delete(m.carId);
    } } catch (e) {}
    return o.call(this, m, t);
  };
  window.__playOff = () => { on = false; P.postMessage = o; console.log('[play] off'); };
  console.log('[play] active — enter the track and press an arrow key.');
})();`;
}

function body(req) { return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return; }
    if (u.pathname === '/api/laps') return send({ laps: scanLaps(), tracks: listTracks(), job: jobStatus() });
    if (u.pathname === '/api/lap') { const d = lapDetail(u.searchParams.get('file')); return d ? send({ ...d, playScript: d.recording ? playScript(d.recording) : null }) : send({}, 404); }
    if (u.pathname === '/api/optimize' && req.method === 'POST') { const b = await body(req); const r = startJob(b.lap, b.track, Math.max(100, parseInt(b.iters || '8000', 10)), b.mode); return send(r, r.error ? 400 : 200); }
    if (u.pathname === '/api/stop' && req.method === 'POST') { if (job && job.proc && !job.done) { job.proc.kill(); } return send({ ok: true }); }
    send('not found', 404);
  } catch (e) { send(String(e), 500); }
});
server.listen(PORT, () => console.log(`lap UI at http://localhost:${PORT}`));

const HTML = `<!doctype html><meta charset=utf8><title>PolyTrack Lap Panel</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#3fb950;--acc2:#58a6ff;--warn:#d29922;--red:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
.wrap{max-width:1080px;margin:0 auto;padding:20px}h1{font-size:18px;margin:0 0 2px}.sub{color:var(--mut);font-size:12px;margin-bottom:14px}
.job{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px;margin-bottom:14px;display:none}.job.show{display:block}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--bd);font-size:13px}th{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
tr:last-child td{border-bottom:none}tr:hover{background:#1b2230}.t{color:var(--acc2);font-weight:600}
button{background:#21262d;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px}
button:hover{border-color:var(--acc2)}.ok{color:var(--acc)}.go{background:#1f6f3f;border-color:#2ea043}.stop{background:#6a1f1f;border-color:#b34}
select,input{background:#0a0d12;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:4px 8px;font:inherit;font-size:12px}
.panel{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:16px;margin-top:14px;display:none}.panel.show{display:block}
.row{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:10px;align-items:flex-end}.k{color:var(--mut);font-size:11px;text-transform:uppercase}.v{font-size:20px;font-weight:600}
textarea{width:100%;height:110px;background:#0a0d12;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:8px;font:inherit;font-size:11px;white-space:pre}
.bar span{background:#21262d;border-radius:4px;padding:2px 8px;font-size:12px;margin-right:8px}.muted{color:var(--mut)}.act{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0;padding:10px;background:#0e131a;border:1px solid var(--bd);border-radius:6px}
</style>
<div class=wrap>
<h1>🏁 PolyTrack Lap Panel</h1><div class=sub id=sub>scanning…</div>
<div class=job id=job></div>
<table><thead><tr><th>Track</th><th>Driver / source</th><th>Time</th><th>Frames</th><th>Inputs</th><th></th></tr></thead><tbody id=rows></tbody></table>
<div class=panel id=panel></div>
</div>
<script>
const $=id=>document.getElementById(id);let TRACKS=[];
async function j(u,o){return (await fetch(u,o)).json()}
function copy(t,btn){navigator.clipboard.writeText(t).then(()=>{const o=btn.textContent;btn.textContent='copied!';btn.classList.add('ok');setTimeout(()=>{btn.textContent=o;btn.classList.remove('ok')},1200)})}
async function optimize(lap,mode){const track=$('tsel').value;const iters=$('iters').value||(mode==='random'?2000:8000);const r=await j('/api/optimize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lap,track,iters,mode})});if(r.error)alert(r.error);else tick();}
async function stop(){await j('/api/stop',{method:'POST'});tick();}
async function showLap(file){const d=await j('/api/lap?file='+encodeURIComponent(file));const p=$('panel');p.classList.add('show');
 const tg=d.toggles?Object.entries(d.toggles).filter(([k])=>k!=='reset').map(([k,v])=>'<span>'+k+': '+v+'</span>').join(''):'';
 const opts=TRACKS.map(t=>'<option>'+t+'</option>').join('');
 p.innerHTML='<div class=row><div><div class=k>File</div><div class=v style=font-size:15px>'+d.file+'</div></div>'
  +'<div><div class=k>Time</div><div class=v style=color:#3fb950>'+d.seconds+'s</div></div>'
  +'<div><div class=k>Frames</div><div class=v>'+d.frames+'</div></div>'
  +(d.driver?'<div><div class=k>Driver</div><div class=v>'+d.driver+'</div></div>':'')+'</div>'
  +'<div class=bar>'+tg+'</div>'
  +'<div class=act><b>Run on</b> track <select id=tsel>'+opts+'</select> iters <input id=iters value=4000 size=6 style=width:70px> '
  +'<button class=go onclick="optimize(\\''+d.file+'\\',\\'optimize\\')">⚡ Optimize (faster)</button> '
  +'<button class=go onclick="optimize(\\''+d.file+'\\',\\'random\\')">🎲 Randomize (different)</button> '
  +'<span class=muted>optimize → faster · randomize → different inputs, still finishes</span></div>'
  +'<div class=k style=margin-top:6px>Recording <button onclick="copy(this.dataset.r,this)" data-r="'+(d.recording||'')+'">copy</button></div><textarea readonly>'+(d.recording||'(none)')+'</textarea>'
  +(d.playScript?'<div class=k style=margin-top:10px>▶️ Play script (paste in game console) <button onclick="copy(this.dataset.s,this)" data-s="'+d.playScript.replace(/"/g,'&quot;')+'">copy</button></div><textarea readonly>'+d.playScript.replace(/</g,'&lt;')+'</textarea>':'');
 p.scrollIntoView({behavior:'smooth'});
}
async function tick(){try{const d=await j('/api/laps');TRACKS=d.tracks;
 $('sub').textContent=d.laps.length+' laps · tracks: '+(d.tracks.join(', ')||'none');
 const job=d.job;const jb=$('job');
 if(job){jb.classList.add('show');const rand=job.mode==='randomize';
   const metric=rand?((job.time?job.time.toFixed(3)+'s':'…')+(job.diverged!=null?'  <b style=color:#58a6ff>'+job.diverged+'% different</b>':'')):((job.seed?'seed '+(job.seed/1000).toFixed(3)+'s → ':'')+(job.best?'<b style=color:#3fb950>best '+(job.best/1000).toFixed(3)+'s</b>':'…'));
   jb.innerHTML='<span class=dot style=background:'+(job.running?'#3fb950':'#8b949e')+'></span><b>'+(job.mode||'optimize')+'</b> '+job.lap+' on '+job.track+'  —  '+metric+'  <span class=muted>'+job.secs+'s</span>  '
   +(job.running?'<button class=stop onclick=stop()>Stop</button>':'<span class=muted>(done — saved to '+job.out+')</span>')
   +'<div class=muted style=font-size:11px;margin-top:6px>'+(job.log||[]).join('<br>')+'</div>';}
 else jb.classList.remove('show');
 $('rows').innerHTML=d.laps.map(l=>'<tr><td class=t>'+l.track+'</td><td>'+(l.driver||l.kind)+'</td><td style=color:#3fb950>'+l.seconds+'s</td><td class=muted>'+l.frames+'</td><td class=muted>'+(l.actions?'~'+l.actions+'f':'')+'</td><td><button onclick="showLap(\\''+l.file+'\\')">details ▸</button></td></tr>').join('')||'<tr><td colspan=6 class=muted>No laps yet.</td></tr>';
}catch(e){$('sub').textContent='error: '+e}}
tick();setInterval(tick,2500);
</script>`;
