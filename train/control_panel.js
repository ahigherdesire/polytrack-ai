// Pi-side control panel for choosing a track, starting/stopping training, and
// downloading the latest keyboard replay JSON.
//
// Usage: node train/control_panel.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const TRACKS = path.join(ROOT, 'tracks');
const STATE_FILE = path.join(DATA, 'control_panel_state.json');
const PORT = Number(process.argv[2] || process.env.PORT || 7790);

const DEFAULT_STATE = {
  track: 'tracks/haoyuone.json',
  generations: 1000000,
  population: 48,
  maxFrames: 30000,
  workers: 4,
  dashboardPort: 7780,
  lastBackup: null,
  lastReset: null,
  lastRun: null,
  trainingPid: null,
  dashboardPid: null,
};

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

function loadState() {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(next) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
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

function filesForTrack(track) {
  const tag = tagForTrack(track);
  const base = tag === 'constants' ? '' : `.${tag}`;
  return {
    tag,
    trackAbs: path.join(ROOT, track),
    trainLog: path.join(ROOT, tag === 'constants' ? 'train3.log' : `train-${tag}.log`),
    dashboardLog: path.join(ROOT, tag === 'constants' ? 'dashboard.log' : `dashboard-${tag}.log`),
    policy: path.join(DATA, `policy${base}.json`),
    currentPolicy: path.join(DATA, `policy.current${base}.json`),
    lap: path.join(DATA, `es_lap${base}.json`),
    run: path.join(DATA, `learning_run${base}.json`),
  };
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function backupTrackProgress(track, includeLog) {
  const files = filesForTrack(track);
  const dir = path.join(DATA, `backup-${files.tag}-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const file of [files.policy, files.currentPolicy, files.lap, files.run, ...(includeLog ? [files.trainLog] : [])]) {
    if (!fs.existsSync(file)) continue;
    const dest = path.join(dir, path.basename(file));
    fs.copyFileSync(file, dest);
    copied.push(path.basename(file));
  }
  return { dir, rel: rel(dir), copied };
}

function listBackups(tag) {
  try {
    return fs.readdirSync(DATA, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`backup-${tag}-`))
      .map((entry) => {
        const full = path.join(DATA, entry.name);
        const st = fs.statSync(full);
        return { name: entry.name, path: rel(full), mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 8);
  } catch {
    return [];
  }
}

function fileInfo(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, size: st.size, mtime: st.mtime.toISOString(), name: path.basename(file) };
  } catch {
    return { exists: false, size: 0, mtime: null, name: path.basename(file) };
  }
}

function tail(file, bytes = 22000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).slice(-90).join('\n');
  } catch {
    return '';
  }
}

function readLap(file) {
  try {
    const lap = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      exists: true,
      kind: lap.kind || null,
      finishSeconds: lap.finishSeconds ?? null,
      finishFrames: lap.finishFrames ?? null,
      maxCheckpoint: lap.maxCheckpoint ?? null,
      actions: Array.isArray(lap.actions) ? lap.actions.length : 0,
      bestReward: lap.bestReward ?? null,
    };
  } catch {
    return { exists: false };
  }
}

function readSystem() {
  const stats = { cpuTempC: null, memUsedPct: null, memUsedMb: null, memTotalMb: null };
  try {
    const raw = Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim());
    if (Number.isFinite(raw)) stats.cpuTempC = raw > 1000 ? raw / 1000 : raw;
  } catch { }
  try {
    const vals = {};
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) vals[m[1]] = Number(m[2]);
    }
    const available = vals.MemAvailable || vals.MemFree;
    if (vals.MemTotal && available) {
      const used = vals.MemTotal - available;
      stats.memTotalMb = vals.MemTotal / 1024;
      stats.memUsedMb = used / 1024;
      stats.memUsedPct = (used / vals.MemTotal) * 100;
    }
  } catch { }
  return stats;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && err.code, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function pgrep(pattern) {
  const r = await run('pgrep', ['-af', pattern]);
  return r.ok ? r.stdout.trim().split('\n').filter(Boolean) : [];
}

async function pkill(pattern) {
  await run('pkill', ['-f', pattern]);
}

function pidIsRunning(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function stopManagedProcess(pattern, stateKey) {
  const state = loadState();
  const pid = Number(state[stateKey]);
  if (pidIsRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { }
  }
  // On the Pi, also stop manually launched trainers from an older control-panel
  // session. Windows has no pgrep/pkill, so the saved PID above is intentional.
  if (process.platform !== 'win32') await pkill(pattern);
}

async function stopTraining() {
  await stopManagedProcess('train/es_parallel.js', 'trainingPid');
}

async function stopDashboard() {
  await stopManagedProcess('train/dashboard.js', 'dashboardPid');
}

function startDetached(script, args, env, logFile, append) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, append ? 'a' : 'w');
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

async function statePayload() {
  const state = loadState();
  const tracks = listTracks();
  if (!tracks.some((t) => t.path === state.track) && tracks[0]) state.track = tracks[0].path;
  const files = filesForTrack(state.track);
  const [training, dashboard] = await Promise.all([
    pgrep('train/es_parallel.js'),
    pgrep('train/dashboard.js'),
  ]);
  const managedTraining = pidIsRunning(state.trainingPid) ? [`${state.trainingPid} (managed)`] : [];
  const managedDashboard = pidIsRunning(state.dashboardPid) ? [`${state.dashboardPid} (managed)`] : [];
  const trainingProcesses = [...new Set([...training, ...managedTraining])];
  const dashboardProcesses = [...new Set([...dashboard, ...managedDashboard])];
  return {
    state,
    tracks,
    files: {
      trainLog: fileInfo(files.trainLog),
      dashboardLog: fileInfo(files.dashboardLog),
      policy: fileInfo(files.policy),
      currentPolicy: fileInfo(files.currentPolicy),
      lap: fileInfo(files.lap),
      run: fileInfo(files.run),
    },
    backups: listBackups(files.tag),
    lap: readLap(files.lap),
    training: { running: trainingProcesses.length > 0, processes: trainingProcesses },
    dashboard: { running: dashboardProcesses.length > 0, processes: dashboardProcesses, urlPath: `:${state.dashboardPort}` },
    system: readSystem(),
    logTail: tail(files.trainLog),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
}

function updateSettings(body) {
  const prev = loadState();
  const next = {
    ...prev,
    track: safeTrack(body.track ?? prev.track),
    generations: Math.max(1, Number(body.generations ?? prev.generations) || DEFAULT_STATE.generations),
    population: Math.max(2, Number(body.population ?? prev.population) || DEFAULT_STATE.population),
    maxFrames: Math.max(1000, Number(body.maxFrames ?? prev.maxFrames) || DEFAULT_STATE.maxFrames),
    workers: Math.max(1, Number(body.workers ?? prev.workers) || DEFAULT_STATE.workers),
    dashboardPort: Math.max(1024, Number(body.dashboardPort ?? prev.dashboardPort) || DEFAULT_STATE.dashboardPort),
  };
  if (next.population % 2 !== 0) next.population += 1;
  saveState(next);
  return next;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, await statePayload());

    if (req.method === 'POST' && url.pathname === '/api/select-track') {
      updateSettings(await readBody(req));
      return sendJson(res, 200, await statePayload());
    }

    if (req.method === 'POST' && url.pathname === '/api/train/start') {
      const body = await readBody(req);
      const next = updateSettings(body);
      const files = filesForTrack(next.track);
      await stopTraining();
      const pid = startDetached('train/es_parallel.js', [
        String(next.generations), String(next.population), String(next.maxFrames), String(next.workers),
      ], { TRACK: next.track }, files.trainLog, !body.resetLog);
      saveState({ ...next, trainingPid: pid });
      return sendJson(res, 200, { ok: true, pid, state: await statePayload() });
    }

    if (req.method === 'POST' && url.pathname === '/api/run/fresh') {
      const body = await readBody(req);
      const next = updateSettings(body);
      const files = filesForTrack(next.track);
      await stopTraining();
      await stopDashboard();
      let backup = null;
      if (body.backup !== false) backup = backupTrackProgress(next.track, true);
      for (const file of [files.policy, files.currentPolicy, files.lap, files.run, files.trainLog]) {
        try { fs.unlinkSync(file); } catch { }
      }
      const trainPid = startDetached('train/es_parallel.js', [
        String(next.generations), String(next.population), String(next.maxFrames), String(next.workers), '--fresh',
      ], { TRACK: next.track, FRESH: '1' }, files.trainLog, false);
      const dashboardPid = startDetached('train/dashboard.js', [
        rel(files.trainLog), String(next.dashboardPort),
      ], { TRACK: next.track }, files.dashboardLog, false);
      saveState({ ...next, trainingPid: trainPid, dashboardPid, lastBackup: backup ? backup.rel : next.lastBackup, lastReset: new Date().toISOString(), lastRun: 'fresh' });
      return sendJson(res, 200, { ok: true, trainPid, dashboardPid, backup, state: await statePayload() });
    }

    if (req.method === 'POST' && url.pathname === '/api/train/stop') {
      await stopTraining();
      saveState({ ...loadState(), trainingPid: null });
      return sendJson(res, 200, await statePayload());
    }

    if (req.method === 'POST' && url.pathname === '/api/dashboard/start') {
      const body = await readBody(req);
      const next = updateSettings(body);
      const files = filesForTrack(next.track);
      await stopDashboard();
      const pid = startDetached('train/dashboard.js', [
        rel(files.trainLog), String(next.dashboardPort),
      ], { TRACK: next.track }, files.dashboardLog, false);
      saveState({ ...next, dashboardPid: pid });
      return sendJson(res, 200, { ok: true, pid, state: await statePayload() });
    }

    if (req.method === 'POST' && url.pathname === '/api/dashboard/stop') {
      await stopDashboard();
      saveState({ ...loadState(), dashboardPid: null });
      return sendJson(res, 200, await statePayload());
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      const body = await readBody(req);
      const next = updateSettings(body);
      if (body.confirm !== true) throw new Error('Reset requires confirm=true');
      await stopTraining();
      await stopDashboard();
      const files = filesForTrack(next.track);
      let backup = null;
      if (body.backup !== false) backup = backupTrackProgress(next.track, !!body.resetLog);
      for (const file of [files.policy, files.currentPolicy, files.lap, files.run]) {
        try { fs.unlinkSync(file); } catch { }
      }
      if (body.resetLog) {
        try { fs.unlinkSync(files.trainLog); } catch { }
      }
      saveState({ ...next, trainingPid: null, dashboardPid: null, lastBackup: backup ? backup.rel : next.lastBackup, lastReset: new Date().toISOString() });
      return sendJson(res, 200, { ok: true, backup, state: await statePayload() });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 400, { error: String(e.message || e) });
  }
}

function downloadLap(res, track) {
  const files = filesForTrack(safeTrack(track || loadState().track));
  if (!fs.existsSync(files.lap)) return sendText(res, 404, 'No lap JSON yet.');
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="${path.basename(files.lap)}"`,
  });
  fs.createReadStream(files.lap).pipe(res);
}

const HTML = `<!doctype html>
<html lang=en>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>PolyTrack Control</title>
<style>
:root{--bg:#0b0f14;--panel:#151a21;--panel2:#10151c;--bd:#2c3440;--fg:#e8edf3;--mut:#91a0b3;--ok:#35c46a;--warn:#d6a531;--bad:#ff5c5c;--blue:#5aa7ff;--line:#222a35}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Arial,sans-serif}
.wrap{max-width:1480px;margin:0 auto;padding:14px}.top{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:12px}
h1{font-size:20px;margin:0}.sub{color:var(--mut);font-size:12px}.layout{display:grid;grid-template-columns:360px 1fr;gap:12px}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:8px;padding:12px}.card h2{font-size:13px;margin:0 0 10px;color:var(--mut);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.stack{display:grid;gap:10px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
label{display:grid;gap:5px;color:var(--mut);font-size:12px}select,input{width:100%;border:1px solid var(--bd);border-radius:6px;background:var(--panel2);color:var(--fg);padding:9px 10px;font:inherit}
input[type=checkbox]{width:auto}.check{display:flex;align-items:center;gap:8px}.btn{border:1px solid var(--bd);border-radius:6px;background:#202733;color:var(--fg);padding:9px 10px;font:700 13px system-ui;cursor:pointer}.btn:hover{border-color:#506174}.btn.primary{background:#174f87;border-color:#296da9}.btn.good{background:#1c6337;border-color:#2f8d51}.btn.bad{background:#6e2525;border-color:#9d3535}.btn.warn{background:#664b18;border-color:#92712b}.btn:disabled{opacity:.55;cursor:not-allowed}
.metric{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;min-height:64px}.k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.v{font-size:20px;font-weight:800;line-height:1.2;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.files{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.file{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:9px;min-width:0}.file b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.file span{color:var(--mut);font-size:12px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;max-height:430px;overflow:auto;background:#080b10;border:1px solid var(--line);border-radius:8px;padding:10px;color:#c9d7e8;font:12px/1.45 ui-monospace,Consolas,monospace}
a{color:#8ec5ff;text-decoration:none}.hint{color:var(--mut);font-size:12px}.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--bd);border-radius:999px;padding:3px 8px;background:var(--panel2);font-size:12px;color:var(--mut)}
@media (max-width:980px){.layout{grid-template-columns:1fr}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.files{grid-template-columns:repeat(2,minmax(0,1fr))}.top{align-items:start;flex-direction:column}}
@media (max-width:560px){.wrap{padding:10px}.grid,.files,.actions{grid-template-columns:1fr}.v{font-size:18px}}
</style>
<div class=wrap>
  <div class=top>
    <div><h1>PolyTrack Control</h1><div class=sub id=subtitle>loading</div></div>
    <div class=pill id=clock>--</div>
  </div>
  <div class=layout>
    <section class=stack>
      <div class=card>
        <h2>Track</h2>
        <label>Track file<select id=track></select></label>
        <div class=actions style="margin-top:10px">
          <button class="btn primary" id=loadTrack>Load Track</button>
          <button class=btn id=openDash>Open Dashboard</button>
        </div>
      </div>
      <div class=card>
        <h2>Training</h2>
        <div class=stack>
          <label>Generations<input id=generations type=number min=1 step=1000></label>
          <div class=grid style="grid-template-columns:repeat(2,minmax(0,1fr))">
            <label>Population<input id=population type=number min=2 step=2></label>
            <label>Workers<input id=workers type=number min=1 step=1></label>
          </div>
          <label>Max frames<input id=maxFrames type=number min=1000 step=1000></label>
          <label>Dashboard port<input id=dashboardPort type=number min=1024 step=1></label>
          <button class="btn good" id=startFresh>Start Fresh Learning Run</button>
          <div class=hint>This makes a timestamped backup, clears the selected track's old brain, lap and history, then starts a brand-new random policy and its dashboard.</div>
          <label class=check><input id=resetLog type=checkbox> Clear training log when continuing/resetting</label>
          <label class=check><input id=backupReset type=checkbox checked> Back up progress before reset</label>
          <div class=actions>
            <button class="btn good" id=startTrain>Start Training</button>
            <button class="btn bad" id=stopTrain>Stop Training</button>
            <button class="btn primary" id=startDash>Start Dashboard</button>
            <button class="btn warn" id=stopDash>Stop Dashboard</button>
          </div>
          <button class="btn bad" id=resetProgress>Backup And Reset Track</button>
          <div class=hint>Reset stops training/dashboard, backs up JSON progress, then removes policy/current/lap files for the selected track.</div>
        </div>
      </div>
    </section>
    <section class=stack>
      <div class=grid>
        <div class=metric><div class=k>Training</div><div class=v id=training>-</div></div>
        <div class=metric><div class=k>Dashboard</div><div class=v id=dashboard>-</div></div>
        <div class=metric><div class=k>Best Lap</div><div class=v id=lap>-</div></div>
        <div class=metric><div class=k>Pi</div><div class=v id=pi>-</div></div>
      </div>
      <div class=card>
        <h2>Files</h2>
        <div class=files id=files></div>
        <div class=hint id=lastAction style="margin-top:8px"></div>
        <div class=hint id=backups style="margin-top:6px"></div>
        <div class=actions style="margin-top:10px">
          <button class=btn id=downloadLap>Download Lap JSON</button>
          <button class=btn id=refresh>Refresh</button>
        </div>
      </div>
      <div class=card>
        <h2>Training Log</h2>
        <pre id=log></pre>
      </div>
    </section>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
let current=null;
let trackOptionsKey='';
async function api(path, body){
  const opt=body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{};
  const r=await fetch(path,opt); const j=await r.json();
  if(!r.ok||j.error) throw new Error(j.error||r.statusText);
  return j.state||j;
}
function settings(){
  return {
    track:$('track').value,
    generations:Number($('generations').value),
    population:Number($('population').value),
    maxFrames:Number($('maxFrames').value),
    workers:Number($('workers').value),
    dashboardPort:Number($('dashboardPort').value),
    resetLog:$('resetLog').checked,
    backup:$('backupReset').checked,
  };
}
function fmtSize(n){if(!n)return '-'; if(n>1024*1024)return (n/1024/1024).toFixed(1)+' MB'; if(n>1024)return (n/1024).toFixed(1)+' KB'; return n+' B'}
function setStatus(el,on){el.textContent=on?'Running':'Stopped';el.className='v '+(on?'ok':'bad')}
function render(s){
  current=s;
  $('clock').textContent=new Date().toLocaleTimeString();
  $('subtitle').textContent=s.state.track+'  |  '+s.tracks.length+' track(s)  |  log '+s.files.trainLog.name;
  const nextTrackOptionsKey=s.tracks.map(t=>t.path).join('|');
  if(document.activeElement!==$('track') && nextTrackOptionsKey!==trackOptionsKey){
    const previous=$('track').value;
    $('track').innerHTML=s.tracks.map(t=>'<option value="'+t.path+'">'+t.name+' - '+t.path+'</option>').join('');
    $('track').value=previous||s.state.track;
    trackOptionsKey=nextTrackOptionsKey;
  } else if(document.activeElement!==$('track') && !$('track').value) {
    $('track').value=s.state.track;
  }
  for(const k of ['generations','population','maxFrames','workers','dashboardPort']) $(k).value=s.state[k];
  setStatus($('training'),s.training.running);
  setStatus($('dashboard'),s.dashboard.running);
  const lap=s.lap||{};
  $('lap').textContent=lap.exists?(lap.finishSeconds!==null&&lap.finishSeconds!==undefined?Number(lap.finishSeconds).toFixed(3)+'s':('cp '+(lap.maxCheckpoint??'-'))):'None';
  $('lap').className='v '+(lap.finishSeconds?'ok':'warn');
  const sys=s.system||{};
  $('pi').textContent=(Number.isFinite(sys.cpuTempC)?sys.cpuTempC.toFixed(1)+'C':'-')+' / '+(Number.isFinite(sys.memUsedPct)?sys.memUsedPct.toFixed(0)+'% RAM':'-');
  $('files').innerHTML=Object.entries(s.files).map(([k,f])=>'<div class=file><b>'+k+'</b><span>'+f.name+'</span><br><span>'+(f.exists?fmtSize(f.size)+'  '+new Date(f.mtime).toLocaleTimeString():'missing')+'</span></div>').join('');
  $('lastAction').textContent=(s.state.lastBackup?'Last backup: '+s.state.lastBackup:'No backup yet')+(s.state.lastReset?'  |  Last reset: '+new Date(s.state.lastReset).toLocaleString():'');
  $('backups').textContent=s.backups&&s.backups.length?('Backups: '+s.backups.map(b=>b.path).join('  | ')):'Backups: none for this track';
  $('log').textContent=s.logTail||'No log yet.';
}
async function refresh(){try{render(await api('/api/state'))}catch(e){$('log').textContent=e.message}}
async function post(path, extra={}){try{render(await api(path,{...settings(),...extra}))}catch(e){alert(e.message); await refresh()}}
$('loadTrack').onclick=()=>post('/api/dashboard/start');
$('track').onchange=()=>post('/api/select-track');
$('startFresh').onclick=()=>{const msg='Start a NEW learning run for '+$('track').value+'?\n\nThe old brain, replay and history will be backed up '+($('backupReset').checked?'before clearing.':'is NOT being backed up.');if(confirm(msg))post('/api/run/fresh',{backup:$('backupReset').checked})};
$('startTrain').onclick=()=>post('/api/train/start');
$('stopTrain').onclick=()=>post('/api/train/stop');
$('startDash').onclick=()=>post('/api/dashboard/start');
$('stopDash').onclick=()=>post('/api/dashboard/stop');
$('resetProgress').onclick=()=>{const msg='Reset progress for '+$('track').value+'?\\n\\nThis stops training/dashboard, '+($('backupReset').checked?'creates a backup, ':'does NOT create a backup, ')+'then deletes policy/current/lap files.';if(confirm(msg))post('/api/reset',{confirm:true,resetLog:$('resetLog').checked,backup:$('backupReset').checked})};
$('refresh').onclick=refresh;
$('openDash').onclick=()=>{const p=$('dashboardPort').value||7780; window.open(location.protocol+'//'+location.hostname+':'+p,'_blank')};
$('downloadLap').onclick=()=>{location.href='/download/lap?track='+encodeURIComponent($('track').value)};
refresh(); setInterval(refresh,4000);
</script>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/') return sendText(res, 200, HTML, 'text/html');
  if (url.pathname === '/download/lap') {
    try { return downloadLap(res, url.searchParams.get('track')); }
    catch (e) { return sendText(res, 400, String(e.message || e)); }
  }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return sendText(res, 404, 'not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`control panel at http://localhost:${PORT}`);
});
