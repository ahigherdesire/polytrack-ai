# PolyTrack AI — What To Do (training on the Raspberry Pi 5)

All training runs on the **Raspberry Pi 5** (24/7, headless). Your **Windows PC** is
used only to (a) capture tracks from the game and (b) watch the live dashboard in a
browser. (For how it works under the hood, see `README.md`. For first-time Pi setup,
see `run-on-pi5.md`.)

### Who does what

| Task | Where | How |
|---|---|---|
| Capture a track | **PC** (browser) | DevTools console on the real game |
| Send track to Pi | **PC** (PowerShell) | `scp` |
| Train | **Pi** (SSH) | `node train/es_parallel.js …` |
| Watch progress | **PC** (browser) | `http://<pi>:7780` |
| Change the reward | **Pi** (SSH) | edit `train/evaluator.js` |
| Get the result back | **PC** (PowerShell) | `scp` from the Pi |

Throughout, replace **`rp5user`** with your Pi username and **`raspberrypi5.local`**
with your Pi hostname or IP.

---

## 0. First-time setup (once)

Done in `run-on-pi5.md`, recap:
1. Flash the Pi with Raspberry Pi OS Lite (64-bit), SSH enabled.
2. From your PC: `scp -r polytrack-ai rp5user@raspberrypi5.local:~/`
3. On the Pi: `cd ~/polytrack-ai && bash deploy/setup-pi.sh` → should print
   `isDeterminstic = true`.
4. (Recommended) install the systemd services so training + dashboard auto-run on
   boot — see `run-on-pi5.md` Step 3, Option A.

After that, you rarely re-copy the whole project — you just send individual track
files and pull back results.

---

## 1. Get onto the Pi

Everything in the "Pi" sections below assumes you've SSH'd in first. **On your PC
(PowerShell):**
```powershell
ssh rp5user@raspberrypi5.local
cd ~/polytrack-ai
```
You stay in this SSH session for all the Pi commands. (Open a *second* PowerShell
window if you also want to run PC-side `scp` commands at the same time.)

---

## 2. Start / check training (on the Pi)

The Pi 5 has 4 cores → use **3 workers**, population **24**.

**If you installed the systemd services** (recommended) training is already running.
Check it:
```bash
systemctl status polytrack-train          # "active (running)" = good
tail -n 5 ~/polytrack-ai/train3.log        # latest generations
journalctl -u polytrack-train -f           # live log (Ctrl-C to stop watching)
```
Stop / start / restart:
```bash
sudo systemctl stop polytrack-train
sudo systemctl start polytrack-train
sudo systemctl restart polytrack-train     # use after changing the reward
```

**If you're NOT using systemd**, start it manually inside `tmux` so it survives you
logging out:
```bash
sudo apt-get install -y tmux        # once
tmux new -s poly
# inside tmux:
node train/es_parallel.js 1000000 24 30000 3 > train3.log 2>&1 &
node train/dashboard.js train3.log 7780
# detach (leaves it running):  Ctrl-b  then  d        (reattach: tmux attach -t poly)
```

> Command shape: `node train/es_parallel.js <generations> <population> <maxFrames> <workers>`
> On the Pi 5 keep `<workers>` at `3`.

### Start a genuinely new learner

The normal start command resumes the previous saved brain. To make the AI learn
from a random policy again, use the control panel instead — it keeps a timestamped
backup, removes the old brain/replay/history, then starts both training and the
live dashboard in one action:

```bash
node train/control_panel.js 7790
```

Open `http://raspberrypi5.local:7790`, choose the track, then click **Start Fresh
Learning Run** and confirm. The learning dashboard will be available at port 7780.

For a manual fresh start (this removes the current files without making a backup):

```bash
TRACK=tracks/haoyuone.json node train/es_parallel.js 1000000 24 30000 3 --fresh > train-haoyuone.log 2>&1 &
TRACK=tracks/haoyuone.json node train/dashboard.js train-haoyuone.log 7780
```

---

## 3. Watch it from your PC 🖥️

In your PC's browser, open:
```
http://raspberrypi5.local:7780
```
(or `http://<pi-ip>:7780` if the name doesn't resolve). You get a run overview that
shows whether the policy is starting from scratch, live cards (generation, best
checkpoint, reward, speed), reward/checkpoint charts, and a
**top-down track map with the policy's current driving path** — so you can see where
the car gets stuck. Refreshes every few seconds; leave it open.

If the page won't load, the dashboard isn't running on the Pi — start it:
`sudo systemctl start polytrack-dashboard` (or the tmux dashboard line above).

---

## 4. Capture a new / custom track (on your PC)

The AI needs the track's data, grabbed once from the **real game**.

1. Open **https://app-polytrack.kodub.com/0.6.2/** in Chrome/Edge.
   (Use this direct link, not `kodub.com/apps/polytrack` — the console is easier here.)
   Confirm the title screen says **0.6.2**.
2. Press **F12** → **Console** tab.
3. Paste this and press Enter:
   ```js
   (()=>{const cap=window.__polyCap||(window.__polyCap={createCar:null,init:null,all:[]});const safe=o=>JSON.parse(JSON.stringify(o,(k,v)=>ArrayBuffer.isView(v)?Array.from(v):v));const P=Worker.prototype;if(!P.__ph){const o=P.postMessage;P.postMessage=function(m,t){try{if(m&&m.messageType===0)cap.init=safe(m);if(m&&m.messageType===3)cap.createCar=safe(m);if(m&&'messageType'in m)cap.all.push(m.messageType);}catch(e){}return o.call(this,m,t)};P.__ph=1;}window.__polyDump=(n='track')=>{const b=new Blob([JSON.stringify(cap)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=n+'.json';a.click();console.log('createCar:',!!cap.createCar,'init:',!!cap.init,'types seen:',cap.all)};return'hooked — load your track, then run __polyDump("name")'})()
   ```
4. **Load and start the track** so the car spawns at the line. If it was already
   loaded before you pasted, press **R** to restart (that re-fires the data).
5. In the console run:
   ```js
   __polyDump("haoyuone")
   ```
   It downloads **`haoyuone.json`** to your Downloads. The console should say
   `createCar: true` (and ideally `init: true`).
6. Put it in the project's **`tracks/`** folder (where all track files live):
   - **If it printed `init: true` AND `createCar: true`** → it's complete. Move
     `haoyuone.json` into `polytrack-ai\tracks\`.
   - **If only `createCar: true`** → complete it with make-track (it borrows the
     shared `Init` and writes into `tracks/`):
     ```powershell
     cd "C:\Users\LIXINYUAN\interesting stuff\polytrack-ai"
     node train/make-track.js "C:/Users/LIXINYUAN/Downloads/haoyuone.json" haoyuone
     ```

> All track input files live in **`tracks/`**. The shared `Init` constants live in
> `data/constants.json`; `make-track.js` borrows them automatically.

---

## 5. Send the track to the Pi (on your PC)

**On your PC (PowerShell).** First make sure the `tracks/` folder exists on the Pi
(scp fails with `dest open … Failure` if it doesn't), then copy the file:
```powershell
ssh rp5user@raspberrypi5.local "mkdir -p ~/polytrack-ai/tracks"
scp polytrack-ai/tracks/haoyuone.json rp5user@raspberrypi5.local:~/polytrack-ai/tracks/
```
Each asks for your Pi password. The copy is tiny/instant.

---

## 6. Train that track (on the Pi)

Stop the default Summer 1 training first so they don't fight for cores, then start
the new track:
```bash
sudo systemctl stop polytrack-train polytrack-dashboard      # if using systemd
cd ~/polytrack-ai
TRACK=tracks/haoyuone.json node train/es_parallel.js 1000000 24 30000 3 > train-haoyuone.log 2>&1 &
TRACK=tracks/haoyuone.json node train/dashboard.js train-haoyuone.log 7780
```
- Each track keeps its **own** output files: `data/policy.haoyuone.json` and
  `data/es_lap.haoyuone.json` — it never overwrites Summer 1.
- It **resumes automatically** if `data/policy.haoyuone.json` already exists.
- Watch it the same way: `http://raspberrypi5.local:7780`.

To go back to the default Summer 1 training: `sudo systemctl start polytrack-train
polytrack-dashboard` (and stop the manual one with `kill %1` or close the tmux pane).

---

## 6.5 Guide-assisted training (browser tools on the Pi)

When pure training gets **stuck** on a hard section (a tight or elevated corner the
policy can't figure out), you can hand it a racing line. Two browser tools help:

**Control panel** — pick a track, start/stop training, reset a track's progress, and
download the latest replay, all from a browser:
```bash
node train/control_panel.js 7790      # then open http://raspberrypi5.local:7790
```

**Map / guide editor** — renders the real **3D track mesh** and lets you click to
place **guide waypoints** (your racing line). Use *Snap Y* / *Snap all Y* to drop the
points onto the track surface, then save:
```bash
node train/map_loader.js 7792         # then open http://raspberrypi5.local:7792
```
Saving writes `data/guide.<track>.json` (a list of `points` + a `radius`).

**How it helps:** if `data/guide.<track>.json` exists, the trainer automatically
rewards the car for following your waypoints (`perGuidePoint` / `guideDistanceWeight`
in the REWARD block) and penalizes leaving the driveable mesh (`offTrackPenalty`).
So the workflow for a stuck track is: **draw the line in the map editor → train**.

**Reading the result:** `data/es_lap.<track>.json` has a `kind` field —
`fastestFinish` (a real finishing lap; has `finishSeconds`) or `bestRewardFallback`
(best non-finishing attempt). Check it:
```bash
node -e "const x=require('./data/es_lap.haoyuone.json'); console.log(x.kind, x.finishSeconds, x.frames, x.actions?.length)"
```
(See `HAOYUONE_RESET_AND_JSON_GUIDE.md` for the full check / back-up / reset routine.)

---

## 7. Change the reward (on the Pi)

All the reward "knobs" are one labeled block at the top of **`train/evaluator.js`**.
Edit them right on the Pi, then restart training (it keeps your progress).

```bash
cd ~/polytrack-ai
nano train/evaluator.js     # edit the REWARD block near the top, Ctrl-O, Enter, Ctrl-X
```
```js
const REWARD = {
  perCheckpoint: 3000,      // reward per checkpoint passed
  distanceWeight: 2,        // pull toward the next checkpoint
  perGuidePoint: 450,       // reward per guide waypoint reached (if a guide exists)
  guideDistanceWeight: 1.5, // pull toward the active guide point
  finishBonus: 5e6,         // reward for completing the lap
  finishTimeWeight: 50,     // ↑ this to reward FASTER laps (record times)
  stuckFrames: 700,         // give up on a dead run after this long
  stuckSpeed: 8,            // "stopped" threshold (km/h)
  offTrackPenalty: 20000,   // penalty for leaving the driveable track mesh
};
```
Apply it:
```bash
sudo systemctl restart polytrack-train      # systemd
# or (manual): stop the running node, then start it again
```
Common tweaks: raise **`finishTimeWeight`** (e.g. `5`) to chase faster laps once it's
finishing; raise **`distanceWeight`** (e.g. `2`) to push harder toward a checkpoint
it's stuck before. (Mutation/learning-rate knobs `SIGMA`/`LR` and pop/frames live in
`train/es_parallel.js`.)

> Restarting re-reads the reward but **resumes the policy**, so progress is kept.
> Delete `data/policy.<track>.json` first if you want a clean restart.

---

## 8. What it produces + getting results back

On the Pi, in `data/`:
- **`policy.<track>.json`** — the trained network (the "driver brain"), updated every
  generation.
- **`es_lap.<track>.json`** — the best lap's **input sequence** (per-frame controls) +
  checkpoint progress and finish time, updated whenever the best reward improves. This
  is the submittable run: replaying these inputs in the real game reproduces the lap
  exactly.

Pull a result back to your PC to inspect/submit later. **On your PC (PowerShell):**
```powershell
cd "C:\Users\LIXINYUAN\interesting stuff\polytrack-ai"
scp rp5user@raspberrypi5.local:~/polytrack-ai/data/es_lap.haoyuone.json data/
scp rp5user@raspberrypi5.local:~/polytrack-ai/data/policy.haoyuone.json data/
```
(For Summer 1 the files are just `es_lap.json` / `policy.json`.)

---

## 8.5 Replay / submit an AI lap accurately (recording bridge)

Pressing OS keys to replay a lap **drifts** (a 1000 fps input sequence can't be
reproduced by keyboard). The accurate path is the game's native **recording**
format — it plays at full internal 1000 fps with frame-exact inputs and is what the
leaderboard accepts.

```bash
# build the recording and prove it reproduces the exact finish (game's own check):
node bridge/verify-recording.js data/es_lap.haoyuone.json tracks/haoyuone.json
#   -> ✓ VALID recording ... -> data/es_lap.haoyuone.recording.txt
```

To **watch it play out on the track**: paste `bridge/play-recording.js` into the
game's console (with the recording string from above), enter the track, and press an
arrow key once — the game drives the AI lap itself, frame-perfectly. (Optional:
`bridge/submit-recording.js` puts it on the leaderboard instead.) See
`bridge/README.md` for the full workflow.

---

## 9. Cheat sheet

**On the Pi (SSH):**
```bash
systemctl status polytrack-train                 # is it training?
tail -n 5 train3.log                             # latest gens (default track)
sudo systemctl restart polytrack-train           # apply a reward change
TRACK=tracks/X.json node train/es_parallel.js 1000000 24 30000 3 > train-X.log 2>&1 &
TRACK=tracks/X.json node train/dashboard.js train-X.log 7780
node sim/test_determinism062.js                  # physics self-test (-> true)
vcgencmd measure_temp                            # Pi temperature
node train/control_panel.js 7790                 # browser control panel (:7790)
node train/map_loader.js 7792                    # 3D map + guide-waypoint editor (:7792)
```
**On your PC (PowerShell):**
```powershell
ssh rp5user@raspberrypi5.local                                   # log in
ssh rp5user@raspberrypi5.local "mkdir -p ~/polytrack-ai/tracks"  # ensure folder exists (once)
scp polytrack-ai/tracks/X.json rp5user@raspberrypi5.local:~/polytrack-ai/tracks/   # send a track
scp rp5user@raspberrypi5.local:~/polytrack-ai/data/es_lap.X.json polytrack-ai/data/            # pull a result
# watch:  http://raspberrypi5.local:7780
```

---

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `http://…:7780` won't load | Dashboard not running on the Pi — `sudo systemctl start polytrack-dashboard` (or the tmux line). |
| `ssh`/`scp`: host key "REMOTE HOST IDENTIFICATION HAS CHANGED" | You reflashed the Pi (new key). On your PC: `ssh-keygen -R raspberrypi5.local`, then reconnect and type `yes`. |
| `Could not resolve hostname` | `.local` not resolving — use the Pi IP: `rp5user@192.168.x.x` (find it: on the Pi `hostname -I`). |
| `Connection refused` | SSH not enabled on the Pi — enable via `sudo raspi-config` → Interface Options → SSH. |
| `node: command not found` on the Pi | Run `bash deploy/setup-pi.sh`. |
| `data/constants.json` missing | Re-copy it: `scp polytrack-ai/data/constants.json "rp5user@host:~/polytrack-ai/data/"`. |
| `createCar: false` in the dump | Restart the track in-game (press **R**), then `__polyDump` again. |
| Game isn't version 0.6.2 | Tell me — I'll re-pull the new game files so the sim still matches. |
| Pi slow / throttling | Check `vcgencmd measure_temp` (add a fan) and `vcgencmd get_throttled` (`0x0` = OK; else power supply). |
| `scp: dest open … Failure` | The `tracks/` folder doesn't exist on the Pi yet — create it first: `ssh rp5user@host "mkdir -p ~/polytrack-ai/tracks"`, then retry. |

---

## 11. Sanity checks (on the Pi)

```bash
node sim/test_determinism062.js   # confirms the real physics runs (-> isDeterminstic = true)
node sim/run_car062.js            # drives the default car (holds accelerate) and prints the result
```
