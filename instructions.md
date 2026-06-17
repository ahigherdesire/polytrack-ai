# PolyTrack AI — What To Do

A practical guide. (For how it works under the hood, see `README.md`.)

---

## TL;DR commands

```bash
# train the default track (Summer 1) across CPU cores
node train/es_parallel.js 1000000 78 16000 13

# watch it  ->  open http://localhost:7780
node train/dashboard.js train3.log 7780

# train a different / custom track
TRACK=data/mytrack.json node train/es_parallel.js 1000000 78 16000 13
TRACK=data/mytrack.json node train/dashboard.js train-mytrack.log 7780
```

> `node train/es_parallel.js <generations> <population> <maxFrames> <workers>`
> On a 14-core PC use `13` workers; on a 4-core/4GB Pi use `3` and population `24`.

---

## 1. Watch training (the dashboard)

```bash
node train/dashboard.js train3.log 7780
```
Open **http://localhost:7780**. You get live cards (generation, best checkpoint,
reward, speed), reward/checkpoint charts, and a top-down **track map with the
current best policy's driving path** — so you can see where the car gets stuck.

If the page won't load, the dashboard process probably isn't running — just run the
command above again. (Run it in its own terminal so it stays up.)

---

## 2. Capture a track (official OR custom)

The AI needs the track's data. You grab it once from the **real game**.

1. Open **https://app-polytrack.kodub.com/0.6.2/** in Chrome/Edge.
   (Use this direct link, not `kodub.com/apps/polytrack` — the console is easier here.)
   Check the title screen says **0.6.2**.
2. Press **F12** → **Console** tab.
3. Paste this and press Enter:
   ```js
   (()=>{const cap=window.__polyCap||(window.__polyCap={createCar:null,init:null,all:[]});const safe=o=>JSON.parse(JSON.stringify(o,(k,v)=>ArrayBuffer.isView(v)?Array.from(v):v));const P=Worker.prototype;if(!P.__ph){const o=P.postMessage;P.postMessage=function(m,t){try{if(m&&m.messageType===0)cap.init=safe(m);if(m&&m.messageType===3)cap.createCar=safe(m);if(m&&'messageType'in m)cap.all.push(m.messageType);}catch(e){}return o.call(this,m,t)};P.__ph=1;}window.__polyDump=(n='track')=>{const b=new Blob([JSON.stringify(cap)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=n+'.json';a.click();console.log('createCar:',!!cap.createCar,'types seen:',cap.all)};return'hooked — load your track, then run __polyDump("name")'})()
   ```
4. **Load and start the track** (official, your editor track, or a community track) so
   the car spawns at the line. If it was already loaded, press **R** to restart.
5. In the console run:
   ```js
   __polyDump("mytrack")
   ```
   It downloads **`mytrack.json`** (console should say `createCar: true`).
6. In your project terminal, convert it:
   ```bash
   node train/make-track.js "C:/Users/LIXINYUAN/Downloads/mytrack.json" mytrack
   ```
   That writes `data/mytrack.json` and prints the train/watch commands.

> The very first time, you also need `data/constants.json` (it holds the shared
> `Init` constants). It's already captured for Summer 1. `make-track.js` borrows
> those constants automatically, so for new tracks you only need `createCar: true`.

---

## 3. Train a track

```bash
TRACK=data/mytrack.json node train/es_parallel.js 1000000 78 16000 13
```
- Each track keeps its **own** files — `data/policy.<name>.json` and
  `data/es_lap.<name>.json` — so tracks never overwrite each other.
- It **resumes automatically** if a policy file for that track already exists.
- Leave it running; it logs to wherever you redirect it. To watch, point the
  dashboard at the same track + log:
  ```bash
  TRACK=data/mytrack.json node train/dashboard.js train-mytrack.log 7780
  ```
  (Default with no `TRACK` is Summer 1: `policy.json` / `es_lap.json` / `train3.log`.)

**Tip:** a simple custom track (a gentle oval with a few checkpoints) is the fastest
way to get a first *complete, finishing* lap and prove the whole thing end-to-end.

---

## 4. What it produces

In `data/`:
- **`policy.<track>.json`** — the trained network (the "driver brain"). Updated every
  generation.
- **`es_lap.<track>.json`** — the best lap's **input sequence** (per-frame controls) +
  its checkpoint progress and finish time. Updated whenever the best reward improves.
  This is the submittable run: replaying these inputs in the real game reproduces the
  lap exactly.

Submitting a finished lap to the leaderboard happens from a **browser** (the game's
API) — that bridge is the next thing to build.

---

## 5. Run it on a Raspberry Pi

See **`deploy/DEPLOY.md`** for the full guide. Short version:
1. Wipe the Pi: reflash with **Raspberry Pi Imager** → *Raspberry Pi OS Lite (64-bit)*,
   enable SSH/Wi-Fi in the gear menu.
2. Copy the project (includes the required `data/constants.json`):
   ```bash
   rsync -av --exclude '*.log' "polytrack-ai/" pi@<pi-ip>:~/polytrack-ai/
   ```
3. On the Pi: `cd ~/polytrack-ai && bash deploy/setup-pi.sh`
4. Train with **3 workers**: `node train/es_parallel.js 1000000 24 16000 3`
5. Dashboard reachable on your network at `http://<pi-ip>:7780`.

There are systemd service files in `deploy/` to auto-run on boot.

---

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| `http://localhost:7780` won't load | The dashboard isn't running — `node train/dashboard.js train3.log 7780` |
| `data/constants.json` missing | Capture it (section 2) or copy it over; the sim can't run without it |
| `createCar: false` in the dump | Restart the track (press **R**) so the game re-sends it, then `__polyDump` again |
| Game isn't version 0.6.2 | Tell me — I'll need to re-pull the new game files so the sim still matches |
| Training feels stuck on a checkpoint | It may be a hard section (e.g. elevation) the sensors don't see yet — ask me to improve it |

---

## 7. Sanity checks

```bash
node sim/test_determinism062.js   # confirms the real physics runs headless (-> isDeterminstic = true)
node sim/run_car062.js            # drives the car (holds accelerate) and prints the result
```
