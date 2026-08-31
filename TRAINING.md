# Training / solving a lap — end to end

The AI finds a lap with a **windowed root-parallel MCTS solver** that searches the
real game physics (it replaced the stalled Evolution-Strategies trainer,
`train/es_parallel.js`, kept only for reference). It drives on a geodesic
**guidance field** built from the track's road surfaces, locks the moves it's
confident about, slides the window forward, and repeats until the car finishes.

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

The car's spawn data only exists inside the running game, so grab it from there.
Full clicks are in **[HOWTO Step 1](https://github.com/ahigherdesire/polytrack-ai/blob/master/HOWTO-copy-optimize-play.md#step-1--capture-the-track-browser)**;
the short version:

1. Open **https://app-polytrack.kodub.com/0.6.2/** (Chrome/Edge), **F12** → **Console**.
   The game runs in an `<iframe>` — pick the `app-polytrack.kodub.com` frame in the
   console's context dropdown before pasting.
2. Paste **`bridge/capture_payloads.js`** (or the one-liner from the HOWTO) → it hooks
   `Worker.postMessage`.
3. **Enter the target track** so the car spawns (press **R** to restart if it was
   already open — that re-fires the `Init` + `CreateCar` messages).
4. Run `__polyDump("mytrack")` → downloads `mytrack.json`; you want `CreateCar: true`.
5. Turn the download into a trainable track file (`make-track.js` borrows the shared
   `Init` automatically if the capture only had `createCar`):
   ```bash
   node train/make-track.js "C:/Users/<you>/Downloads/mytrack.json" mytrack
   #   -> wrote tracks/mytrack.json   (solve it with TRACK=tracks/mytrack.json)
   ```

> **Car / physics data.** The shared `Init` — the car and physics constants, identical
> for every 0.6.2 track — lives in `data/constants.json` and is already captured. If
> it's ever missing, re-create it once via **HOWTO Appendix A**.
>
> Community track? Its **trackId** (for §1.4) shows up in the Network tab on the
> `leaderboard` request, or via the browser grabber in the HOWTO.

### 1.3 Method B — use the preloaded track

Summer 1 is already captured at `data/constants.json`. Running the solver with no
`TRACK=` set solves it. Nothing to capture.

### 1.4 Fetch a real world-record lap (for benchmarking / analysis)

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

```bash
# from the repo root.  args:  <budgetSeconds> <simsPerWorker> <workers>
node train/solve_parallel.js 7200 100 12  > solve.log 2>&1 &
```

| arg | meaning | good default |
|---|---|---|
| `budgetSeconds` | wall-clock cap; stops and writes the best lap when hit | `7200` (2 h) |
| `simsPerWorker` | MCTS rollouts each worker runs per window | `100` |
| `workers` | worker threads (root-parallel; more = stronger consensus, **not** faster wall-clock) | cores − 2 (Pi 5: **3**) |

Effective search per window = `simsPerWorker × workers`. Wall-time per window is set
by **one** worker's `simsPerWorker` (workers run in parallel), so lowering
`simsPerWorker` makes each window — and each stuck/retry cycle — faster, at the cost
of shakier locks.

**Solve a captured track:**
```bash
TRACK=tracks/mytrack.json  node train/solve_parallel.js 7200 100 12 > solve.log 2>&1 &
#   output then lands in  data/es_lap.mytrack.json  /  data/solve_run.mytrack.json
```

**Seeding (on by default):** before searching, the guidance rollout policy drives the
easy opening open-loop and hands the reliably-driven prefix to MCTS, so search starts
near the first hard feature instead of re-deriving the launch.
- Disable: `SEED=0 node train/solve_parallel.js …`
- Cap how far greedy may drive: `SEED_FRAMES=20000 …` (default `30000`).

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

When it finishes (or the budget expires) it writes **`data/es_lap.json`**
(`data/es_lap.<track>.json` for a `TRACK=` run):
```jsonc
{ "kind": "fastestFinish", "finishSeconds": 23.4, "frames": 23400, "actions": [ … ] }
```
- `kind: "fastestFinish"` → a real finishing lap.
- `kind: "bestRewardFallback"` → best partial so far (no finish yet).

`actions` is the per-frame input list — the same format the bridge tools consume.

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
  just re-run the command. To wipe the old ES brain/replay, use
  `node train/control_panel.js 7790` → **Start Fresh Learning Run**.
- **Stopping on Windows:** `pkill -f solve_parallel` does **not** reliably kill Node.
  Kill by PID, or stray solvers keep eating cores and slow every other run:
  ```powershell
  Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like '*solve_parallel*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```

---

## 9. Known limitation (Summer 1 / sone)

The solver clears checkpoint 0 and the big descent jump, then hits a **physical wall
at x ≈ −64** where a low surface steps up to the main road — it can't finish sone
yet. Vertical walls are filtered out of the road mesh, so the geodesic routes through
them; the fix needs wall modelling and/or an off-surface penalty in the MCTS score,
not just field tuning. Full write-up in project memory (`sone-lower-deck-trap`).
```
