��const{app,BrowserWindow,session,shell,ipcMain}=require("electron"),path=require("path"),fs=require("fs");process.on("uncaughtException",(e=>{const m=String(e&&e.message||e);if(/has been destroyed/i.test(m))return void console.error("[TAS] ignored teardown error:",m);console.error("Uncaught exception:",e),process.exit(1)}));let browserWindow=null;const singleInstanceLockSucessful=app.requestSingleInstanceLock();singleInstanceLockSucessful?app.on("second-instance",(()=>{null!=browserWindow&&!browserWindow.isDestroyed()&&(browserWindow.isMinimized()&&browserWindow.restore(),browserWindow.focus())})):app.quit(),app.on("web-contents-created",((e,n)=>{n.setWindowOpenHandler((({url:e})=>("https://www.kodub.com/"!=e&&"https://opengameart.org/content/sci-fi-theme-1"!=e&&"https://www.kodub.com/terms/polytrack"!=e&&"https://www.kodub.com/privacy/polytrack"!=e&&"https://www.kodub.com/discord/polytrack"!=e||setImmediate((()=>{shell.openExternal(e)})),{action:"deny"}))),n.on("will-navigate",((e,n)=>{e.preventDefault()}))})),ipcMain.on("get-argv",(e=>{e.returnValue=process.argv})),ipcMain.on("log-message",((e,n)=>{console.log(n)})),ipcMain.handle("tas-save-run",((e,name,content)=>{try{const d=path.join(app.getPath("userData"),"tas-runs");fs.mkdirSync(d,{recursive:!0});const nm=String(name||"run").replace(/[^a-zA-Z0-9._-]/g,"_").replace(/\.tas$/,"").slice(0,80)||"run";const f=path.join(d,nm+".tas");fs.writeFileSync(f,String(content||""));return{ok:!0,path:f,name:nm}}catch(err){return{ok:!1,error:String(err)}}})),ipcMain.handle("tas-read-run",((e,name)=>{try{const d=path.join(app.getPath("userData"),"tas-runs");const nm=String(name||"").replace(/[^a-zA-Z0-9._-]/g,"_").replace(/\.tas$/,"");const f=path.join(d,nm+".tas");return{ok:!0,content:fs.readFileSync(f,"utf8")}}catch(err){return{ok:!1,error:String(err)}}})),ipcMain.handle("tas-list-runs",(()=>{try{const d=path.join(app.getPath("userData"),"tas-runs");fs.mkdirSync(d,{recursive:!0});return{ok:!0,files:fs.readdirSync(d).filter((f)=>f.endsWith(".tas")).map((f)=>f.replace(/\.tas$/,""))}}catch(err){return{ok:!1,error:String(err),files:[]}}})),ipcMain.handle("tas-board-fetch",((e,method,url,headers,body)=>new Promise((resolve)=>{try{const https=require("https");const u=new URL(url);const h=Object.assign({},headers||{});if(body!=null)h["Content-Length"]=Buffer.byteLength(body);const req=https.request({method:method||"GET",hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,headers:h},(res)=>{let data="";res.on("data",(c)=>data+=c);res.on("end",()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,text:data}))});req.on("error",(err)=>resolve({ok:!1,status:0,error:String(err)}));req.setTimeout(25e3,()=>{try{req.destroy(new Error("timeout"))}catch(_){}});if(body!=null)req.write(body);req.end()}catch(err){resolve({ok:!1,status:0,error:String(err)})}}))),ipcMain.on("quit",(()=>{app.quit()})),app.on("window-all-closed",(()=>{app.quit()})),app.whenReady().then((()=>{browserWindow=new BrowserWindow({width:1024,height:800,minWidth:320,minHeight:200,fullscreen:!0,useContentSize:!0,autoHideMenuBar:!0,webPreferences:{devTools:!1,preload:path.join(__dirname,"preload.js"),backgroundThrottling:!1}}),browserWindow.removeMenu(),browserWindow.on("closed",(()=>{browserWindow=null})),browserWindow.webContents.on("before-input-event",((e,n)=>{n.isAutoRepeat||"keyDown"!=n.type||("F11"==n.code||n.alt&&"Enter"==n.code)&&browserWindow&&!browserWindow.isDestroyed()&&(browserWindow.setFullScreen(!browserWindow.isFullScreen()),e.preventDefault())})),browserWindow.webContents.on("will-prevent-unload",(e=>{e.preventDefault()})),browserWindow.on("enter-full-screen",(()=>{browserWindow&&!browserWindow.isDestroyed()&&!browserWindow.webContents.isDestroyed()&&browserWindow.webContents.send("fullscreen-change",!0)})),browserWindow.on("leave-full-screen",(()=>{browserWindow&&!browserWindow.isDestroyed()&&!browserWindow.webContents.isDestroyed()&&browserWindow.webContents.send("fullscreen-change",!1)})),ipcMain.on("is-fullscreen",(e=>{e.returnValue=!(!browserWindow||browserWindow.isDestroyed())&&browserWindow.isFullScreen()})),ipcMain.on("set-fullscreen",((e,n)=>{browserWindow&&!browserWindow.isDestroyed()&&browserWindow.setFullScreen(n)})),session.defaultSession.webRequest.onBeforeSendHeaders({urls:["<all_urls>"]},((e,n)=>{e.requestHeaders.Origin="https://app-polytrack-desktop.kodub.com",n({requestHeaders:e.requestHeaders})})),browserWindow.loadFile("index.html")}));

/* ==== TAS Auto-pipeline bridge (tas/pipeline) ====================
 * Spawns the autonomous TAS pipeline (tas/pipeline/src/cli/run.js) as a
 * background Node process, streams its log lines to the renderer, and hands
 * back the artifacts (final.tas / meta.json / partials) when it exits.
 * One run at a time.
 *
 * Runner choice: a system `node` from PATH is PREFERRED — packaged Electron
 * builds commonly ship with the RunAsNode fuse disabled, in which case
 * ELECTRON_RUN_AS_NODE is silently ignored (or the exe can't be respawned at
 * all: `spawn ... ENOENT`). The exe fallback is only used when no node is
 * installed. */
const { spawn: tasSpawn, spawnSync: tasSpawnSync } = require("child_process");
let tasAuto = null;
function tasAutoSend(ch, msg) {
  try {
    if (browserWindow && !browserWindow.isDestroyed() && !browserWindow.webContents.isDestroyed()) {
      browserWindow.webContents.send(ch, msg);
    }
  } catch (e) {}
}
let tasNodeCmd; // cached: "node" | null (null => use process.execPath + ELECTRON_RUN_AS_NODE)
function tasPickRunner() {
  if (tasNodeCmd !== undefined) return tasNodeCmd;
  try {
    const r = tasSpawnSync("node", ["-v"], { windowsHide: true, timeout: 5000 });
    tasNodeCmd = (r.status === 0 && !r.error) ? "node" : null;
  } catch (e) { tasNodeCmd = null; }
  return tasNodeCmd;
}
// The app may be packaged as app.asar — the MAIN process reads through it
// transparently, but a spawned Node child CANNOT. Stage everything the
// pipeline needs into a real directory under userData and run from there.
// (Also used unpacked: keeps one uniform code path, and the copy is ~5 MB.)
function tasStagePipeline() {
  const appRoot = path.join(__dirname, "..");
  const srcPipeline = path.join(appRoot, "tas", "pipeline");
  if (!fs.existsSync(path.join(srcPipeline, "src", "cli", "run.js"))) {
    throw new Error("pipeline not found at " + srcPipeline);
  }
  if (!fs.existsSync(path.join(srcPipeline, "context", "init-context.json"))) {
    throw new Error("pipeline context missing — run `node src/extract/build-context.js` inside tas/pipeline once and re-package");
  }
  const stage = path.join(app.getPath("userData"), "tas-pipeline");
  const gameDst = path.join(stage, "game");
  const copyDir = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, ent.name), dp = path.join(d, ent.name);
      if (ent.isDirectory()) copyDir(sp, dp);
      else fs.writeFileSync(dp, fs.readFileSync(sp));
    }
  };
  copyDir(path.join(srcPipeline, "src"), path.join(stage, "src"));
  fs.mkdirSync(path.join(stage, "context"), { recursive: true });
  fs.writeFileSync(path.join(stage, "context", "init-context.json"),
    fs.readFileSync(path.join(srcPipeline, "context", "init-context.json")));
  // Game files the headless engine loads at runtime:
  fs.mkdirSync(path.join(gameDst, "lib"), { recursive: true });
  for (const f of ["simulation_worker.bundle.js", "polytrack_physics.wasm"]) {
    fs.writeFileSync(path.join(gameDst, f), fs.readFileSync(path.join(appRoot, f)));
  }
  fs.writeFileSync(path.join(gameDst, "lib", "polytrack_physics.js"),
    fs.readFileSync(path.join(appRoot, "lib", "polytrack_physics.js")));
  return { stage, gameRoot: gameDst };
}
function tasAutoFinish(code, extraLog) {
  if (!tasAuto) return;
  const { outDir, runId } = tasAuto;
  tasAuto = null;
  if (extraLog) tasAutoSend("tas-auto-log", extraLog);
  const res = { code, runId, outDir, artifacts: {} };
  for (const f of ["final.tas", "final.recording.txt", "meta.json", "phase3.tas", "phase3-partial.tas", "phase2-ghost.tas"]) {
    try { res.artifacts[f] = fs.readFileSync(path.join(outDir, f), "utf8"); } catch (err) {}
  }
  tasAutoSend("tas-auto-done", res);
}
ipcMain.handle("tas-auto-start", (e, opts) => {
  try {
    if (tasAuto) return { ok: false, error: "an Auto-TAS run is already in progress" };
    opts = opts || {};
    const trackData = String(opts.trackData || "");
    if (!trackData) return { ok: false, error: "no track data" };
    let staged;
    try { staged = tasStagePipeline(); }
    catch (err) { return { ok: false, error: String(err && err.message || err) }; }
    const runJs = path.join(staged.stage, "src", "cli", "run.js");
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(app.getPath("userData"), "tas-auto", runId);
    fs.mkdirSync(outDir, { recursive: true });
    const trackFile = path.join(outDir, "track.track");
    fs.writeFileSync(trackFile, trackData);

    const workers = Math.max(1, Math.min(32, (opts.workers | 0) || Math.max(2, require("os").cpus().length - 2)));
    const args = [runJs, trackFile, "--out", outDir,
      "--workers", String(workers),
      "--rrt-budget", String(Math.max(0, opts.rrtBudget | 0)),
      "--sims", String(Math.max(50, (opts.sims | 0) || 200)),
      "--mcts-budget", String(Math.max(60, (opts.mctsBudget | 0) || 3600)),
      "--polish-budget", String(Math.max(0, (opts.polishBudget | 0) || 600)),
      "--polish-rounds", String(Math.max(1, (opts.polishRounds | 0) || 200))];
    if (opts.seed) args.push("--seed", String(opts.seed | 0));

    const nodeCmd = tasPickRunner();
    const cmd = nodeCmd || process.execPath;
    const env = Object.assign({}, process.env, {
      TAS_GATECAP: "0",
      POLYTRACK_ROOT: staged.gameRoot, // staged copies of worker bundle + wasm + glue
    });
    if (!nodeCmd) env.ELECTRON_RUN_AS_NODE = "1";
    tasAutoSend("tas-auto-log", "[bridge] runner: " + (nodeCmd ? "system node" : cmd + " (RUN_AS_NODE)") + " · workers=" + workers + " · staged at " + staged.stage);
    const child = tasSpawn(cmd, args, {
      cwd: outDir,                    // a real, writable dir (never inside an asar)
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // Below-normal CPU priority: the search happily saturates every core it
    // gets; this keeps the game smooth while it grinds in the background.
    try { if (child.pid) require("os").setPriority(child.pid, 10); } catch (e) {}
    tasAuto = { child, outDir, runId };
    let lineBuf = "";
    const onData = (d) => {
      lineBuf += d.toString();
      let i;
      while ((i = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, i).replace(/\r$/, "");
        lineBuf = lineBuf.slice(i + 1);
        if (line) tasAutoSend("tas-auto-log", line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    // 'error' (e.g. spawn ENOENT) may fire WITHOUT a later 'exit' — both paths
    // must clean up, or the bridge wedges in "already running" and Stop no-ops.
    child.on("error", (err) => {
      tasAutoFinish(-1, "[spawn error] " + String(err) + (nodeCmd ? "" : " — install Node.js (nodejs.org) so the bridge can use it, then restart the game"));
    });
    child.on("exit", (code) => {
      if (lineBuf.trim()) tasAutoSend("tas-auto-log", lineBuf.trim());
      tasAutoFinish(code, null);
    });
    return { ok: true, runId, outDir, runner: nodeCmd || "electron" };
  } catch (err) {
    tasAuto = null;
    return { ok: false, error: String(err) };
  }
});
ipcMain.handle("tas-auto-stop", () => {
  try {
    if (!tasAuto) return { ok: false, error: "not running" };
    const child = tasAuto.child;
    try { child.kill(); } catch (e) {}
    // Belt & braces on Windows: TERM can be ignored; escalate shortly after,
    // and if no 'exit' ever arrives (dead handle), force-finish the bridge.
    setTimeout(() => { try { if (tasAuto && tasAuto.child === child) child.kill("SIGKILL"); } catch (e) {} }, 1500);
    setTimeout(() => {
      if (tasAuto && tasAuto.child === child) {
        if (process.platform === "win32" && child.pid) {
          try { tasSpawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }); } catch (e) {}
        }
        tasAutoFinish(-2, "[bridge] force-stopped");
      }
    }, 3500);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle("tas-auto-status", () => ({ running: !!tasAuto, runId: tasAuto ? tasAuto.runId : null, outDir: tasAuto ? tasAuto.outDir : null }));
app.on("before-quit", (() => { try { if (tasAuto) tasAuto.child.kill(); } catch (e) {} }