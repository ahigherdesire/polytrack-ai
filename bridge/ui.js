// Lap control panel: scans your lap JSON files and shows everything in one place —
// track, driver, time, inputs, the recording string, and a one-click "copy play
// script". Also shows the optimizer's progress.
//
// Usage: node bridge/ui.js [port]      then open http://localhost:7800
const http = require('http');
const fs = require('fs');
const path = require('path');
const { actionsToRecording } = require('./make-recording');

const ROOT = path.resolve(__dirname, '..');
const DIRS = [path.join(ROOT, 'data', 'grabbed'), path.join(ROOT, 'data')];
const TRACKS = path.join(ROOT, 'tracks');
const OPT_LOG = path.join(ROOT, 'optimize.log');
const PORT = parseInt(process.argv[2] || '7800', 10);
const ORDER = ['up', 'right', 'down', 'left', 'reset'];

function isLap(j) { return j && ((Array.isArray(j.actions) && j.actions.length) || (typeof j.recording === 'string')); }

function recordingOf(j) {
  if (typeof j.recording === 'string' && j.recording.length) return j.recording;
  if (!Array.isArray(j.actions)) return null;
  const prepend = j.finishFrames === (j.actions.length + 1);
  return actionsToRecording(j.actions, { prependNeutral: prepend });
}
function toggleCounts(actions) {
  const t = Object.fromEntries(ORDER.map((k) => [k, 0]));
  let prev = {};
  for (const a of actions) { for (const k of ORDER) { if (!!a[k] !== !!prev[k]) t[k]++; } prev = a; }
  return t;
}
function trackGuess(name) { const m = name.match(/^([a-z0-9]+?)(_wr|_best|\.optimized|\.recording)?$/i); return m ? m[1] : name; }

function scanLaps() {
  const seen = new Set(); const laps = [];
  for (const dir of DIRS) {
    let files = []; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || seen.has(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.size > 12 * 1024 * 1024) continue;        // skip huge files (constants/captures)
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!isLap(j)) continue;
        seen.add(f);
        const frames = j.finishFrames ?? j.frames ?? (Array.isArray(j.actions) ? j.actions.length : 0);
        laps.push({
          file: f, dir: path.basename(dir), name: f.replace(/\.json$/, ''),
          track: trackGuess(f.replace(/\.json$/, '')),
          driver: j.nickname || null, kind: j.kind || (j.recording ? 'recording' : 'lap'),
          frames, seconds: +(frames / 1000).toFixed(3),
          actions: Array.isArray(j.actions) ? j.actions.length : null,
          mtime: st.mtimeMs,
        });
      } catch { /* not a lap / unreadable */ }
    }
  }
  return laps.sort((a, b) => b.mtime - a.mtime);
}

function lapDetail(file) {
  for (const dir of DIRS) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    const rec = recordingOf(j);
    const frames = j.finishFrames ?? j.frames ?? (Array.isArray(j.actions) ? j.actions.length : 0);
    return {
      file, driver: j.nickname || null, kind: j.kind || 'lap',
      frames, seconds: +(frames / 1000).toFixed(3),
      toggles: Array.isArray(j.actions) ? toggleCounts(j.actions) : null,
      recording: rec,
    };
  }
  return null;
}

function optStatus() {
  let txt = ''; try { txt = fs.readFileSync(OPT_LOG, 'utf8'); } catch { return { running: false, history: [] }; }
  const hist = [...txt.matchAll(/improved -> (\d+)/g)].map((m) => +m[1]);
  const seedM = txt.match(/seed finishes at (\d+)/); const seed = seedM ? +seedM[1] : null;
  const done = /^done\./m.test(txt);
  let mtime = null; try { mtime = fs.statSync(OPT_LOG).mtimeMs; } catch {}
  return { running: !done, seed, history: hist, best: hist.length ? hist[hist.length - 1] : seed, recentlyActive: mtime && (Date.now() - mtime < 120000) };
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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return; }
    if (u.pathname === '/api/laps') return send({ laps: scanLaps(), tracks: (() => { try { return fs.readdirSync(TRACKS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')); } catch { return []; } })(), opt: optStatus() });
    if (u.pathname === '/api/lap') { const d = lapDetail(u.searchParams.get('file')); return d ? send({ ...d, playScript: d.recording ? playScript(d.recording) : null }) : (res.writeHead(404), res.end('{}')); }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
server.listen(PORT, () => console.log(`lap UI at http://localhost:${PORT}`));

const HTML = `<!doctype html><meta charset=utf8><title>PolyTrack Lap Panel</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#3fb950;--acc2:#58a6ff;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
.wrap{max-width:1080px;margin:0 auto;padding:20px}h1{font-size:18px;margin:0 0 2px}.sub{color:var(--mut);font-size:12px;margin-bottom:14px}
.opt{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px;margin-bottom:14px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.opt b{color:var(--acc)}.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--bd);font-size:13px}th{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
tr:last-child td{border-bottom:none}tr:hover{background:#1b2230}.t{color:var(--acc2);font-weight:600}
button{background:#21262d;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px}
button:hover{border-color:var(--acc2)}.ok{color:var(--acc)}
.panel{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:16px;margin-top:14px;display:none}
.panel.show{display:block}.row{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:10px}.k{color:var(--mut);font-size:11px;text-transform:uppercase}.v{font-size:20px;font-weight:600}
textarea{width:100%;height:120px;background:#0a0d12;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:8px;font:inherit;font-size:11px;white-space:pre}
.bar{display:flex;gap:8px;margin:6px 0}.bar span{background:#21262d;border-radius:4px;padding:2px 8px;font-size:12px}
.muted{color:var(--mut)}
</style>
<div class=wrap>
<h1>🏁 PolyTrack Lap Panel</h1><div class=sub id=sub>scanning…</div>
<div class=opt id=opt></div>
<table><thead><tr><th>Track</th><th>Driver / source</th><th>Time</th><th>Frames</th><th>Inputs (toggles)</th><th></th></tr></thead><tbody id=rows></tbody></table>
<div class=panel id=panel></div>
</div>
<script>
const $=id=>document.getElementById(id);
async function j(u){return (await fetch(u)).json()}
function copy(t,btn){navigator.clipboard.writeText(t).then(()=>{const o=btn.textContent;btn.textContent='copied!';btn.classList.add('ok');setTimeout(()=>{btn.textContent=o;btn.classList.remove('ok')},1200)})}
async function showLap(file){const d=await j('/api/lap?file='+encodeURIComponent(file));const p=$('panel');p.classList.add('show');
 const tg=d.toggles?Object.entries(d.toggles).filter(([k])=>k!=='reset').map(([k,v])=>'<span>'+k+': '+v+'</span>').join(''):'';
 p.innerHTML='<div class=row><div><div class=k>File</div><div class=v style=font-size:15px>'+d.file+'</div></div>'
  +'<div><div class=k>Time</div><div class=v style=color:#3fb950>'+d.seconds+'s</div></div>'
  +'<div><div class=k>Frames</div><div class=v>'+d.frames+'</div></div>'
  +(d.driver?'<div><div class=k>Driver</div><div class=v>'+d.driver+'</div></div>':'')+'</div>'
  +'<div class=bar>'+tg+'</div>'
  +'<div class=k style=margin-top:10px>Recording string <button onclick="copy(this.dataset.r,this)" data-r="'+(d.recording||'')+'">copy</button></div>'
  +'<textarea readonly>'+(d.recording||'(none)')+'</textarea>'
  +(d.playScript?'<div class=k style=margin-top:10px>Ready-to-paste PLAY script <button onclick="copy(this.dataset.s,this)" data-s="'+d.playScript.replace(/"/g,'&quot;')+'">copy</button></div><textarea readonly>'+d.playScript.replace(/</g,'&lt;')+'</textarea><div class=muted style=margin-top:6px>Open the track in the game, F12 → Console, paste this, press an arrow key.</div>':'');
 p.scrollIntoView({behavior:'smooth'});
}
async function tick(){try{const d=await j('/api/laps');
 $('sub').textContent=d.laps.length+' laps · tracks: '+(d.tracks.join(', ')||'none captured');
 const o=d.opt;const live=o.recentlyActive&&o.running;
 $('opt').innerHTML='<span><span class=dot style=background:'+(live?'#3fb950':'#8b949e')+'></span>'+(live?'optimizer running':'optimizer idle')+'</span>'
  +(o.seed?'<span class=muted>seed '+(o.seed/1000).toFixed(3)+'s</span>':'')
  +(o.best?'<span>best <b>'+(o.best/1000).toFixed(3)+'s</b></span>':'')
  +(o.history.length>1?'<span class=muted>'+o.history.length+' improvements</span>':'');
 $('rows').innerHTML=d.laps.map(l=>'<tr><td class=t>'+l.track+'</td><td>'+(l.driver||l.kind)+'</td><td style=color:#3fb950>'+l.seconds+'s</td><td class=muted>'+l.frames+'</td><td class=muted>'+(l.actions?'~'+l.actions+'f':'')+'</td><td><button onclick="showLap(\\''+l.file+'\\')">details ▸</button></td></tr>').join('')||'<tr><td colspan=6 class=muted>No laps yet. Fetch or grab one (see HOWTO-copy-optimize-play.md).</td></tr>';
}catch(e){$('sub').textContent='error: '+e}}
tick();setInterval(tick,3000);
</script>`;
