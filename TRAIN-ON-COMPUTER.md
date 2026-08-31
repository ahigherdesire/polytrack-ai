# Train on your computer — solving a lap end to end

The AI finds a lap with a **windowed root-parallel MCTS solver** that searches the
real game physics (it replaced the stalled Evolution-Strategies trainer,
`train/es_parallel.js`, kept only for reference). It drives on a geodesic
**guidance field** built from the track's road surfaces, locks the moves it's
confident about, slides the window forward, and repeats until the car finishes.

> **Running on a Raspberry Pi instead?** See **`TRAIN-ON-PI.md`** — same solver, but
> you capture on your PC, copy the track to the Pi, and keep it running over SSH.

The whole flow is four stages:

```
 (1) GET TRACK DATA  ──►  (2) SOLVE  ──►  (3) VERIFY  ──►  (4) PLAY / SUBMIT
  capture from game       run the MCTS     game's own       watch it drive /
  → tracks/<t>.json       solver           Verify check     put on leaderboard
                          → data/es_lap.json
```

> Fast path (Summer 1 is already captured at `data/constants.json`):
> ```bash
> node train/solve_parallel.js 7200 100 12  > solve.log 2>&1 &   # solve
> tail -f solve.log                                              # watch
> cat data/solve_run.json                                        # status
> # result lap → data/es_lap.json
> ```

---

## 1. Getting track data

> **New to this?** The friendly, copy-paste, **no-coding walkthrough** for capturing
> a track, grabbing a lap, and playing it back lives in
> **[`HOWTO-copy-optimize-play.md`](https://github.com/ahigherdesire/polytrack-ai/blob/master/HOWTO-copy-optimize-play.md)**
> — start there if you just want the exact clicks. It also covers the shared **car /
> physics data** (`data/constants.json`) in its **Appendix A**. This section is the
> training-focused summary of the same steps.

### 1.1 What the solver actually needs

A **track file** is a JSON object with two fields, exactly as the game sends them
to its own physics worker:

```jsonc
{
  "init":      { "messageType": 0, "trackParts": [ … ], … },  // the track geometry
  "createCar": { "messageType": 3, "trackData": [ … ], … }    // where the car spawns
}
```

- `init` (message type **0**) carries `trackParts` — the placed track pieces. It is
  **identical for every 0.6.2 track**, so it can be borrowed from an existing capture.
- `createCar` (message type **3**) is **track-specific** — it encodes the actual
  layout and the start line. This is the part you must capture per track.

Where these files live:

| Path | What it is |
|---|---|
| `data/constants.json` | The **default** track the solver loads (currently Summer 1 / "sone"). |
| `tracks/<name>.json`  | Any other captured track. Point the solver at it with `TRACK=`. |
| `data/es_lap.json` / `data/es_lap.<name>.json` | The solver's **output** lap. |
| `data/grabbed/*.json` | Fetched real player/WR laps (for benchmarking). |

You get a track file one of two ways.

### 1.2 Method A — capture a track from the real game (browser, once per track)

The car's spawn data only exists inside the running game, so we grab it from there.
Follow this exactly — no coding needed, just copy-paste. (A friendlier version with
pictures-in-words is [HOWTO Step 1](https://github.com/ahigherdesire/polytrack-ai/blob/master/HOWTO-copy-optimize-play.md#step-1--capture-the-track-browser).)

**Step 1 — Open the game.**
Go to **https://app-polytrack.kodub.com/0.6.2/** in **Chrome or Edge**. Check the
title screen says **0.6.2** in the corner.

**Step 2 — Open the developer Console.**
Press **F12** on your keyboard. A panel opens. Click the tab named **Console**.
(That's the box where you can type/paste code.)

> The game runs inside an embedded frame. Above the console's typing area there is a
> small dropdown that usually says `top`. Click it and choose the entry that contains
> **`app-polytrack.kodub.com`**. If you don't see such an entry, `top` is fine — just
> continue. (This makes sure the next step hooks the right window.)

**Step 3 — Paste the capture code.**
Click into the Console, paste this **entire block**, and press **Enter**:
```js
(() => {
  const captured = { version: location.href, init: null, createCar: null, all: [] };
  const safe = (o) => JSON.parse(JSON.stringify(o, (k, v) =>
    ArrayBuffer.isView(v) ? Array.from(v) : v));
  function record(msg) {
    try {
      if (msg && typeof msg === 'object' && 'messageType' in msg) {
        if (msg.messageType === 0) captured.init = safe(msg);      // Init (track geometry)
        if (msg.messageType === 3) captured.createCar = safe(msg); // CreateCar (this track)
        captured.all.push(msg.messageType);
      }
    } catch (e) {}
  }
  const proto = Worker.prototype;
  if (!proto.__polyHooked) {
    const orig = proto.postMessage;
    proto.postMessage = function (msg, transfer) { record(msg); return orig.call(this, msg, transfer); };
    proto.__polyHooked = true;
  }
  window.__polyCaptured = captured;
  window.__polyDump = function (name = 'track') {
    if (!captured.createCar) console.warn('No CreateCar yet — (re)load the track first. Seen:', captured.all);
    const blob = new Blob([JSON.stringify(captured)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name + '.json'; a.click();
    console.log('Dumped. Init:', !!captured.init, 'CreateCar:', !!captured.createCar, 'types seen:', captured.all);
  };
  console.log('[capture] ready — now enter your track, then run  __polyDump("mytrack")');
})();
```
It should print **`[capture] ready …`**. If it prints an error instead, make sure you
copied the whole block (from the first `(` to the last `)`), and try again.

**Step 4 — Load the track.**
In the game, click **Play** and **enter the track you want** so the car appears at the
start line. If the track was already open before Step 3, press **R** to restart it —
that makes the game re-send the data we need.

**Step 5 — Download the track file.**
Back in the Console, type this (replace `mytrack` with a short name, no spaces — use
the **same** name every time for this track) and press **Enter**:
```js
__polyDump("mytrack")
```
- It downloads **`mytrack.json`** to your Downloads folder.
- The console should say **`CreateCar: true`**. ✅
- If it says **`CreateCar: false`**, you didn't load the track yet — press **R** in the
  game, wait for the car to appear, then run `__polyDump("mytrack")` again.

**Step 6 — Turn the download into a track file (in the terminal).**
In your terminal, in the project folder, run (fix the path to point at the file you
just downloaded):
```bash
node train/make-track.js "C:/Users/<you>/Downloads/mytrack.json" mytrack
```
✅ Success looks like: **`wrote tracks/mytrack.json`**. That file is now ready to solve
with `TRACK=tracks/mytrack.json` (see §2). `make-track.js` automatically fills in the
shared car/physics data if your capture didn't include it.

Done — you never have to repeat this for that track again.

---

### 1.3 Getting the car / physics data (`data/constants.json`)

`data/constants.json` holds the **shared car + physics constants** — they're the
**same for every 0.6.2 track**, and this file is **already in the project**, so
normally you do nothing here.

You only need this if `data/constants.json` is **missing**. To rebuild it once:

1. Do **§1.2 Steps 1–4** on *any* track, but paste the capture code **the instant the
   page finishes loading** (before you click into a track). This is what lets it catch
   the one-time `Init` message that carries the car/physics constants.
2. Run `__polyDump("constants")` and check the console says **`Init: true`**. (If it
   says `Init: false`, reload the page and try again, pasting the code sooner.)
3. Move the downloaded **`constants.json`** into the project's **`data/`** folder,
   replacing nothing else.

> Tip: the track's **trackId** (needed to fetch a world record in §1.5) appears in the
> browser's **Network** tab on the `leaderboard` request, or via the browser grabber
> in [HOWTO Step 2](https://github.com/ahigherdesire/polytrack-ai/blob/master/HOWTO-copy-optimize-play.md#step-2--get-the-lap-you-want-to-copy).

### 1.4 Method B — use the preloaded track

Summer 1 is already captured at `data/constants.json`. Running the solver with no
`TRACK=` set solves it. Nothing to capture.

### 1.5 Fetch a real world-record lap (for benchmarking / analysis)

You don't need this to train, but it's how you compare the AI's lap to the best
humans, and it works with **no browser** — straight off the game's public API:

```bash
# <trackId> <rank>  (rank 1 = world record). Summer 1's trackId shown:
node bridge/fetch-recording.js 5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038 1 data/grabbed/summer1_wr.json
#   -> youngfella  22.262s (rank 1/…) ; out.json holds the exact per-frame inputs
```

The fetched recording is verified to reproduce its exact finish frame in our headless
sim, so you can replay or analyse any record locally. For the browser-grab route
(and finding a `trackId`), see
**[HOWTO Step 2](https://github.com/ahigherdesire/polytrack-ai/blob/master/HOWTO-copy-optimize-play.md#step-2--get-the-lap-you-want-to-copy)**
or `bridge/README.md`.

---

## 2. Solve (run the search)

### 2.1 Where to run it

In a **terminal**, from the **project's root folder** (the folder that contains the
`train/` and `data/` directories). Open the terminal there first:

```powershell
# Windows PowerShell
cd "C:\Users\LIXINYUAN\interesting stuff\polytrack-ai"
```
```bash
# macOS / Linux / Git Bash
cd ~/polytrack-ai
```
Every `node train/...` command below is run from there. You need **Node.js
installed** (`node --version` should print something like `v20+`).

### 2.2 The command

```bash
#            <budgetSeconds> <simsPerWorker> <workers>
node train/solve_parallel.js 7200 100 12
```

| arg | meaning | good default |
|---|---|---|
| `budgetSeconds` | wall-clock cap; stops and writes the best lap when hit | `7200` (2 h) |
| `simsPerWorker` | MCTS rollouts each worker runs per window | `100` |
| `workers` | worker threads (root-parallel; more = stronger consensus, **not** faster wall-clock) | **CPU cores − 2** |

Effective search per window = `simsPerWorker × workers`. Wall-time per window is set
by **one** worker's `simsPerWorker` (workers run in parallel), so lowering
`simsPerWorker` makes each window — and each stuck/retry cycle — faster, at the cost
of shakier locks. Set `workers` to your core count minus 2 (leave headroom); more than
that just fights for cores. (Find your core count: PowerShell `echo $env:NUMBER_OF_PROCESSORS`,
or `node -e "console.log(require('os').cpus().length)"`.)

### 2.3 Which track it solves

`solve_parallel.js` takes **no track argument** — the three numbers are budget/sims/
workers. It solves whatever the **`TRACK` environment variable** points at, and with
`TRACK` unset it defaults to **`data/constants.json`** (currently Summer 1 / "sone").

```powershell
# PowerShell — solve a captured track (note the separate $env: line)
$env:TRACK = "tracks/mytrack.json"
node train/solve_parallel.js 7200 100 12
$env:TRACK = ""     # clear it again when done
```
```bash
# Git Bash / macOS / Linux — inline
TRACK=tracks/mytrack.json  node train/solve_parallel.js 7200 100 12
```
Output for a `TRACK=` run lands in `data/es_lap.<name>.json` / `data/solve_run.<name>.json`
instead of the plain `es_lap.json`.

### 2.4 Run it in the background (optional)

The solver runs for a long time, so you usually want it logging to a file while you do
other things:

```bash
# Git Bash / macOS / Linux — run detached, all output to solve.log
node train/solve_parallel.js 7200 100 12  > solve.log 2>&1 &
```
```powershell
# Windows PowerShell — run detached, output to solve.log
Start-Process node -ArgumentList "train/solve_parallel.js","7200","100","12" `
  -RedirectStandardOutput solve.log -RedirectStandardError solve.err -NoNewWindow
```
Or just run the plain command in §2.2 and leave the terminal window open — it prints
progress live. Stopping it is in §8 (on Windows, kill by PID — `Ctrl+C` in a
foreground window also works).

### 2.5 What you should see

Startup takes ~**30–60 s** (each worker boots its own physics engine + builds the
guidance field), then windows begin. A healthy run looks like this:

```text
solving constants.json  budget=7200s  workers=12  sims/worker=100  (effective 1200/window)
initializing workers 1/12...  ...  12/12...
guidance: 6795 cells, 3 checkpoints, 1 finish
greedy seed: drove 12.60s (maxCp=1); locked 8.96s -> search resumes at cp=1 speed=173
w0  t=13s  locked=9.06s  cp=1 speed=179 pos=(44,3,3)  wheels=4
w5  t=77s  locked=9.56s  cp=1 speed=202 pos=(17,0,3)  wheels=4
w10 t=139s locked=10.06s cp=1 speed=227 pos=(-12,0,3) wheels=4
...
```
- The **`guidance:`** line confirms the track loaded (cells + checkpoints + finish).
- The **`greedy seed:`** line shows the easy opening was auto-driven (see §2.6).
- Each **`w<N>`** line is one search window (logged every 5). `locked` = seconds of
  lap committed so far — **this number going up is progress.** How to read the rest is
  in §3.

**Timing expectations:** each window is roughly **9–20 s** and commits ~0.1–0.5 s of
lap, so a full ~25 s lap is a few hundred windows — think **tens of minutes to a
couple of hours**, and it may legitimately run the whole budget. It's normal for
`speed` to swing and for occasional `STUCK — rewinding` lines (a hard corner being
re-attempted). See §9 for the one track (sone) that currently can't finish.

### 2.6 Seeding (on by default)

Before searching, the guidance rollout policy drives the easy opening open-loop and
hands the reliably-driven prefix to MCTS, so search starts near the first hard feature
instead of wasting minutes re-deriving the launch (that's the `greedy seed:` line).
- Disable: set `SEED=0` (PowerShell: `$env:SEED="0"`).
- Cap how far greedy may drive: `SEED_FRAMES=20000` (default `30000`).

---

## 3. Watch progress

```bash
tail -f solve.log
```
Each logged window prints, e.g.:
```
w45 t=463s locked=8.42s cp=1 speed=195 pos=(30,0,-4) wheels=4
```
- `locked` — seconds of lap committed so far (the real progress metric).
- `cp` — `nextCheckpointIndex`; increments each time a checkpoint is crossed.
- `pos` / `speed` / `wheels` — car state (`wheels=0` = airborne).
- `STUCK — rewinding …` — hit a hard spot; it rewinds and retries with a fresh seed.

`data/solve_run.json` mirrors this as JSON: `{ cp, lockedS, bestFinishS, status }`.
Set `DUMP_LOCKED=1` to also write `data/locked_dump.json` every few windows for
frame-by-frame replay (see §7).

---

## 4. Get the result

The run ends one of two ways, and prints which. **A finish:**
```text
*** FINISH (locked) 23.412s
wrote 23.412s lap (23412 frames) -> data/es_lap.json
```
**Or the budget/horizon ran out before a finish** (a partial best-effort lap):
```text
budget/horizon reached — no finish, writing partial
wrote partial (11060 frames) -> data/es_lap.json
```

Either way it writes **`data/es_lap.json`** (`data/es_lap.<track>.json` for a `TRACK=`
run):
```jsonc
{ "kind": "fastestFinish", "finishSeconds": 23.4, "frames": 23400, "actions": [ … ] }
```
- `kind: "fastestFinish"` → a **real finishing lap** — go to §5 to verify & play it.
- `kind: "bestRewardFallback"` → **best partial so far** (no finish yet). Re-running
  with a bigger `budgetSeconds`, or fixing the blocking feature (§7, §9), is the way
  forward.

`actions` is the per-frame input list — the same format the bridge tools consume.
`data/solve_run.json` also records the final `status` (`done`) and `bestFinishS`.

---

## 5. Verify & play the lap in the real game

The output lap is proven the same way the leaderboard proves a submission — with the
game's **own `Verify`** — then you can watch it drive the real track.

```bash
# 1. build + validate the recording (frame-exact finish, game's own check)
node bridge/verify-recording.js data/es_lap.json data/constants.json
#    -> ✓ VALID recording … -> data/es_lap.recording.txt
```
2. Open the game (`https://app-polytrack.kodub.com/0.6.2/`), paste the recording
   string into `AI_RECORDING` in **`bridge/play-recording.js`**, paste that whole
   script into the console **before** entering the track, then enter and tap an arrow
   key once — the car drives the AI lap by itself, frame-perfectly.
3. Optional: put it on the leaderboard with **`bridge/submit-recording.js`**.

> Why the recording, not keyboard replay: it's applied by **frame number inside the
> game** (1000 fps), so there's zero timing drift. The click-by-click play steps are
> in **[HOWTO Step 4](https://github.com/ahigherdesire/polytrack-ai/blob/master/HOWTO-copy-optimize-play.md#step-4--play-it-out-in-the-game-️)**;
> see also `bridge/README.md`.

**Squeeze it faster (TAS):** `bridge/optimize-lap.js` hill-climbs an existing lap,
keeping only verified-faster, still-finishing edits:
```bash
node bridge/optimize-lap.js data/es_lap.json data/constants.json 4000 data/es_lap.json
```
(The lap and the track must match — a recording is button presses for **one** track.)

---

## 6. Tuning knobs

**`train/solve_parallel.js` → `OPTS`** (top of file):
- `windowMs` / `lockMs` — lookahead vs. how much to commit per window.
- `minVisitFrac` — lock-confidence threshold (rewind is the safety net).
- `stuckWindows` / `maxRewinds` — how fast to give up on a spot, and how many
  fresh-seed retries to spend on it.
- `decimationMs` — action-block granularity (20 ms = coarse/fast).

**`train/guidance.js`** — the driving field:
- `buildSpeedCaps()` — curvature, **elevation/descent**, and overhead-clearance
  speed caps. The descent cap is what lets the car survive the Summer 1 jump; tune
  its `grade > 0.30 → cap` line if a track flings the car off a drop.
- Cell filtering skips undrivable **down-facing** faces and shadowed low **floor**
  cells so the field routes on real road only.

**`train/mcts_solver.js` → `_simulate()`** — the reward/score
(`finishBonus`, `cpBonus`, `slipWeight`, `overspeedWeight`, `speedWeight`, …).

---

## 7. Diagnostics (when a track gets stuck)

All in `train/`, run as `node train/<file>.js`:
- `greedy_drive.js` — drive the guidance policy alone; shows where it stalls.
- `trap_drive.js` — detailed per-frame state (x,y,z,speed,wheels) through a region.
- `probe_spot.js` / `route_trace.js` — inspect the field / route / speed-caps at a spot.
- `test_guidance.js` — sanity-check the field builds and the potential falls forward.
- `replay_locked.js` — replay `data/locked_dump.json` (run the solver with
  `DUMP_LOCKED=1`) frame-by-frame to see exactly what the car hits.

---

## 8. Stopping / fresh start

- The solver is stateless per run (it rebuilds the field and re-seeds each launch) —
  just re-run the command. `Ctrl+C` in a foreground terminal stops it.
- **Stopping a background run on Windows:** `pkill -f solve_parallel` does **not**
  reliably kill Node. Kill by PID, or stray solvers keep eating cores and slow every
  other run:
  ```powershell
  Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like '*solve_parallel*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```
- On macOS/Linux: `pkill -f solve_parallel` works.

---

## 9. Known limitation (Summer 1 / sone)

The solver clears checkpoint 0 and the big descent jump, then hits a **physical wall
at x ≈ −64** where a low surface steps up to the main road — it can't finish sone
yet. Vertical walls are filtered out of the road mesh, so the geodesic routes through
them; the fix needs wall modelling and/or an off-surface penalty in the MCTS score,
not just field tuning. Full write-up in project memory (`sone-lower-deck-trap`).
