# How to Copy, Speed Up, and Play Any PolyTrack Lap

A step-by-step guide. If you can copy-paste, you can do this. No coding needed.

**What you'll be able to do:**
- 📥 Copy any player's exact lap from the game (even the world record).
- ⚡ Optionally make it *faster* (the computer tweaks it and only keeps faster, legal laps).
- ▶️ Watch it play out perfectly on the real track.

It uses the game's **real recording data** (not screen-reading), so everything is
frame-perfect.

---

## ⭐ Easy mode: the control panel

Instead of typing commands to inspect laps, run this once in the terminal:
```powershell
node bridge/ui.js 7800
```
then open **http://localhost:7800** in your browser. It lists every lap you have
(track, driver, time, inputs), shows the live optimizer status, and gives you a
**one-click "copy play script"** for each lap — paste that into the game console and
press a key to watch it. You still capture tracks and fetch laps with the steps
below, but the panel is the easiest way to see everything and grab a lap to play.

---

## 0. Words you'll see (read this once)

- **Terminal** = a black/blue text window where you type commands. On Windows, open
  **PowerShell** (press Start, type "PowerShell", Enter).
- **Console** = the browser's text box for JavaScript. Open it with **F12**, then click
  the **Console** tab.
- **Recording** = the game's short code for a whole lap's button presses (looks like
  random letters: `eJw10T1L...`).
- **Track file** = the track's shape, saved so our simulator knows the track.
- **trackId** = the track's ID number on the server (a long string of letters/numbers).

Whenever this guide says "in the terminal," it means: in your PowerShell window, **in
the project folder**. Set that up once per session by running:

```powershell
cd "C:\Users\LIXINYUAN\interesting stuff\polytrack-ai"
```
(Keep that window open. Every `node ...` command below goes there.)

---

## 1. One-time check

In the terminal, type:
```powershell
node --version
```
- If you see something like `v24.x` → you're good.
- If it says "not recognized" → install Node.js from **nodejs.org** (the big green
  button), then reopen PowerShell.

Also make sure the file **`data/constants.json`** exists in the project (it's the
shared car/physics data, already captured). If it's missing, see **Appendix A**.

---

## 2. The whole thing in 4 steps

1. **Capture the track** (browser) — tells the simulator the track's shape. Once per track.
2. **Get the lap** you want to copy/beat (one command, or browser).
3. **(optional) Make it faster.**
4. **Play it** in the game.

Below, replace `NAME` with a short name for your track (e.g. `hollowdunes`) — same
word every time.

---

## STEP 1 — Capture the track (browser)

You only do this once per track.

1. Open **https://app-polytrack.kodub.com/0.6.2/** in Chrome or Edge. Check the title
   screen says **0.6.2**.
2. Press **F12** → click **Console**.
3. Copy-paste this whole block and press **Enter**:
   ```js
   (()=>{const c=(window.__cap={init:null,createCar:null,all:[]});const safe=o=>JSON.parse(JSON.stringify(o,(k,v)=>ArrayBuffer.isView(v)?Array.from(v):v));const P=Worker.prototype;if(!P.__h){const o=P.postMessage;P.postMessage=function(m,t){try{if(m&&m.messageType===0)c.init=safe(m);if(m&&m.messageType===3)c.createCar=safe(m);if(m&&'messageType'in m)c.all.push(m.messageType);}catch(e){}return o.call(this,m,t)};P.__h=1;}window.__dump=(n='track')=>{const b=new Blob([JSON.stringify(c)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=n+'.json';a.click();console.log('createCar:',!!c.createCar);};return'hooked';})()
   ```
   It should print `hooked`.
4. In the game, click **Play** and **enter your track** so the car appears at the start
   line. (If the track was already open, press **R** to restart.)
5. Back in the console, type this and press Enter (use your short name):
   ```js
   __dump("NAME")
   ```
   It downloads **`NAME.json`** and prints `createCar: true`. ✅ (If it says `false`,
   restart the track with **R** and run `__dump("NAME")` again.)

6. Now in the **terminal**, turn that download into a track file:
   ```powershell
   node train/make-track.js "C:\Users\LIXINYUAN\Downloads\NAME.json" NAME
   ```
   ✅ Success looks like: `wrote ...\tracks\NAME.json`.

---

## STEP 2 — Get the lap you want to copy

You need the lap as a file the tools understand. Two ways — **A is easiest.**

### Way A — One command (needs the track's `trackId`)

If you know the trackId:
```powershell
node bridge/fetch-recording.js TRACKID 1 data/grabbed/NAME_wr.json
```
- `1` means **world record**. Use `2`, `3`, … for 2nd place, 3rd place, etc.
- ✅ Success looks like: `youngfella  22.262s (rank 1/…)` and `wrote …NAME_wr.json`.

**Don't know the trackId?** Get it in 20 seconds:
1. In the game, open your track's **leaderboard**.
2. In the console, paste the **grabber** below and watch any time — it prints
   `[grab] trackId = ...`. Copy that value and use it above.

### Way B — Browser grab (works for any track, no trackId hunting)

1. In the game console, paste this **grabber** and press Enter:
   ```js
   (()=>{const g=(window.__grab=window.__grab||[]);const m=u=>/recordings|leaderboard/.test(String(u));function h(url,text){const tm=String(url).match(/[?&]trackId=([0-9a-fA-F]+)/);if(tm){window.__trackId=tm[1];console.log('[grab] trackId =',tm[1]);}let d;try{d=JSON.parse(text)}catch{return}(function w(o,c){if(!o||typeof o!='object')return;if(Array.isArray(o)){for(const x of o)w(x,c);return}const n={frames:o.frames??c.frames,name:o.name??o.nickname??c.name};if(typeof o.recording=='string'&&o.recording.length>20&&!g.some(x=>x.recording===o.recording)){g.push({recording:o.recording,...n});console.log('[grab]',n.name,'frames='+n.frames,'len='+o.recording.length);}for(const k in o)w(o[k],n);})(d,{})}const of=window.fetch;window.fetch=function(u){const url=String((u&&u.url)||u);const p=of.apply(this,arguments);if(m(url))p.then(r=>{try{r.clone().text().then(t=>h(url,t))}catch(e){}});return p};const op=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(a,u){this.__u=u;return op.apply(this,arguments)};const sd=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){if(m(this.__u))this.addEventListener('load',()=>{try{h(this.__u,this.responseText)}catch(e){}});return sd.apply(this,arguments)};window.__dumpRec=(n='rec')=>{const b=new Blob([JSON.stringify(g)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=n+'.json';a.click();console.log('dumped',g.length)};return'grabber active'})()
   ```
2. Open your track's **leaderboard** and **WATCH** the lap you want (click the entry →
   Watch). The console prints `[grab] NAME frames=… len=…`.
3. Type `__dumpRec("rec")` → downloads **`rec.json`**.
4. Open `rec.json` (double-click it / open in Notepad). Find the long `"recording"`
   text and the `"frames"` number. Then in the **terminal**:
   ```powershell
   node bridge/decode-recording.js "PASTE_THE_RECORDING_STRING" FRAMES data/grabbed/NAME_wr.json
   ```

Either way, you now have **`data/grabbed/NAME_wr.json`** — the lap to copy.

---

## STEP 3 — (Optional) Make it faster

Skip this if you just want to copy the lap as-is. To try to **beat** it:
```powershell
node bridge/optimize-lap.js data/grabbed/NAME_wr.json tracks/NAME.json 8000 data/grabbed/NAME_best.json
```
- It tries 8000 small tweaks, keeping only laps that **finish faster and still finish**.
- It prints `improved -> 33741 (33.741s)` each time it finds a better lap, and **saves
  after every improvement** to `NAME_best.json`.
- Each tweak takes ~1 second, so 8000 tries ≈ 2+ hours. You can stop it anytime with
  **Ctrl+C** — the best so far is already saved.
- To keep improving later, run it again with `NAME_best.json` as BOTH the input and output.

If you skip this step, just use `NAME_wr.json` in Step 4 instead of `NAME_best.json`.

---

## STEP 4 — Play it out in the game ▶️

1. Get the recording text. In the **terminal**:
   ```powershell
   node -e "console.log(require('./data/grabbed/NAME_best.json').recording)"
   ```
   (Use `NAME_wr.json` if you skipped Step 3.) Copy the long line it prints.
2. In the game, go to **your track** (don't start driving yet). Open the **Console** (F12).
3. Paste this, but first replace `PASTE_RECORDING_HERE` with the line you copied:
   ```js
   (() => {
     const REC = 'PASTE_RECORDING_HERE';
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
   })();
   ```
4. **Enter the track** (play mode) and **press an arrow key once**. The car drives the
   lap by itself, perfectly. 🏁
5. To drive normally again, type `__playOff()` (or just refresh the page).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `node : not recognized` | Install Node.js from nodejs.org, reopen PowerShell. |
| `cd` says path not found | Check the project folder path; keep the quotes. |
| Step 1 `createCar: false` | Press **R** in the game to restart the track, then `__dump` again. |
| `make-track` can't find the file | Check the path/filename matches what's in your Downloads. |
| `fetch-recording` says HTTP 403 / error | Your network may block it — use **Way B** (browser grab) instead. |
| Step 4: car doesn't move | Make sure you saw `[play] driving the lap` in the console, then pressed an arrow key. If it printed but the car's still, tell the helper. |
| Wrong track | The recording only works on the track it was made for. Use the matching track. |
| Game isn't 0.6.2 | The tools target 0.6.2; if the game updates, the data won't match. |

---

## Quick cheat sheet

```powershell
cd "C:\Users\LIXINYUAN\interesting stuff\polytrack-ai"

# 1. (after capturing NAME.json in the browser)
node train/make-track.js "C:\Users\LIXINYUAN\Downloads\NAME.json" NAME

# 2. get the world record lap (needs trackId)
node bridge/fetch-recording.js TRACKID 1 data/grabbed/NAME_wr.json

# 3. (optional) make it faster
node bridge/optimize-lap.js data/grabbed/NAME_wr.json tracks/NAME.json 8000 data/grabbed/NAME_best.json

# 4. print the recording to paste into the play script
node -e "console.log(require('./data/grabbed/NAME_best.json').recording)"
```

---

## Appendix A — if `data/constants.json` is missing

It holds the shared car/physics data (same for every 0.6.2 track). Capture it once:
do **Step 1** on any track, but when you run `__dump`, the file's `init` may be `false`.
To get `init`, do Step 1 with a **fresh page reload**: paste the Step-1 hook the
instant the page loads (before the menu finishes), then enter a track and `__dump`.
Rename the download to `constants.json` and put it in the `data/` folder. (You only
ever need to do this once.)
