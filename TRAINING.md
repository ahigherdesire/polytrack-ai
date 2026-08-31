# Training / solving a lap

The AI finds a lap with a **windowed root-parallel MCTS solver** that searches the
real game physics (this replaced the old Evolution-Strategies trainer, which
stalled — see `train/es_parallel.js`, kept only for reference). It drives on a
geodesic **guidance field** built from the track's road surfaces, locks the moves
it's confident about, slides the window forward, and repeats until the car
finishes.

> TL;DR
> ```bash
> node train/solve_parallel.js 7200 100 12      # <budgetSeconds> <sims/worker> <workers>
> tail -f solve.log                              # watch it   (redirect output yourself)
> cat data/solve_run.json                        # machine-readable status
> # result lap → data/es_lap.json
> ```

---

## 1. Prerequisites

- Node.js (the sim is bundled; no build step).
- A **track payload** at `data/constants.json` — the physics/track capture the
  solver loads. It already holds Summer 1 ("sone"). To solve a different track,
  capture it into its own JSON and point `TRACK=` at it (below).
- Cores: the solver spawns one worker thread per `<workers>`. Use
  **cores − 2** on a desktop; keep it at **3** on the Raspberry Pi 5.

## 2. Run it

```bash
# from the repo root.  args:  <budgetSeconds> <simsPerWorker> <workers>
node train/solve_parallel.js 7200 100 12  > solve.log 2>&1 &
```

| arg | meaning | good default |
|---|---|---|
| `budgetSeconds` | wall-clock cap; stops and writes the best lap when hit | `7200` (2 h) |
| `simsPerWorker` | MCTS rollouts each worker runs per window | `100` |
| `workers` | worker threads (root-parallel; more = stronger consensus, **not** faster wall-clock) | cores − 2 |

Effective search per window = `simsPerWorker × workers`. Wall-time per window is
set by **one** worker's `simsPerWorker` (workers run in parallel), so lowering
`simsPerWorker` makes each window — and each stuck/retry cycle — faster, at the
cost of shakier locks.

Solve a different track:
```bash
TRACK=tracks/mytrack.json node train/solve_parallel.js 7200 100 12 > solve.log 2>&1 &
```
Output then lands in `data/es_lap.<tag>.json` / `data/solve_run.<tag>.json`.

## 3. Watch progress

```bash
tail -f solve.log
```
Each logged window prints, e.g.:
```
w45 t=463s locked=8.42s cp=1 speed=195 pos=(30,0,-4) wheels=4
```
- `locked` — seconds of lap committed so far (this is the real progress metric).
- `cp` — `nextCheckpointIndex`; goes up each time a checkpoint is crossed.
- `pos` / `speed` / `wheels` — car state (wheels = 0 means airborne).
- `STUCK — rewinding …` — hit a hard spot; it rewinds and retries with a fresh
  seed (up to `maxRewinds`).

`data/solve_run.json` mirrors this as JSON: `{ cp, lockedS, bestFinishS, status }`.

## 4. Get the result

When it finishes (or the budget expires) it writes **`data/es_lap.json`**:
```jsonc
{ "kind": "fastestFinish", "finishSeconds": 23.4, "frames": 23400, "actions": [ … ] }
```
`kind: "fastestFinish"` = a real finishing lap; `bestRewardFallback` = best partial
(no finish yet). This is the same format the recording bridge / play / verify tools
consume, so `data/es_lap.json` is ready to replay or submit.

## 5. Seeding (on by default)

Before searching, the guidance **rollout policy drives the easy opening
open-loop** and hands the reliably-driven prefix to MCTS, so search starts near
the first hard feature instead of wasting minutes re-deriving the launch.
- Disable: `SEED=0 node train/solve_parallel.js …`
- Cap how far greedy may drive: `SEED_FRAMES=20000 …` (default 30000).

## 6. Tuning knobs

**`train/solve_parallel.js` → `OPTS`** (top of file):
- `windowMs` / `lockMs` — lookahead vs. how much to commit per window.
- `minVisitFrac` — lock-confidence threshold (rewind is the safety net).
- `stuckWindows` / `maxRewinds` — how quickly to give up on a spot and how many
  fresh-seed retries to spend on it.
- `decimationMs` — action-block granularity (20 ms = coarse/fast).

**`train/guidance.js`** — the driving field:
- `buildSpeedCaps()` — curvature, **elevation/descent**, and overhead-clearance
  speed caps. The descent cap is what lets the car survive the Summer 1 jump;
  tune its `grade > 0.30 → cap` line if a track flings the car off a drop.
- Cell filtering skips undrivable **down-facing** faces and shadowed low **floor**
  cells so the field routes on real road only.
- Change the **reward/score** in `train/mcts_solver.js` `_simulate()`
  (`finishBonus`, `cpBonus`, `slipWeight`, `overspeedWeight`, …).

## 7. Diagnostics (for when a track gets stuck)

All in `train/`, each `node train/<file>.js`:
- `greedy_drive.js` — drive the guidance policy alone; shows where it stalls.
- `trap_drive.js` — detailed per-frame state (x,y,z,speed,wheels) through a region.
- `probe_spot.js` / `route_trace.js` — inspect the field/route/speed-caps at a spot.
- `replay_locked.js` — replay `data/locked_dump.json` frame-by-frame (run the
  solver with `DUMP_LOCKED=1` to produce it) to see exactly what the car hits.

## 8. Fresh start / stopping

- The solver is stateless per run (it rebuilds the field and re-seeds each launch);
  just re-run the command. To wipe the old ES brain/replay, use
  `node train/control_panel.js 7790` → **Start Fresh Learning Run**.
- **Stopping on Windows:** `pkill -f solve_parallel` does **not** reliably kill
  Node. Kill by PID:
  ```powershell
  Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like '*solve_parallel*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  ```
  Stray solvers keep eating cores and slow every other run.

## 9. Known limitation (Summer 1 / sone)

The solver clears checkpoint 0 and the big descent jump, then hits a **physical
wall at x ≈ −64** where a low surface steps up to the main road — it can't finish
sone yet. Vertical walls are filtered out of the road mesh, so the geodesic routes
through them; fixing it needs wall modelling and/or an off-surface penalty in the
MCTS score, not just field tuning. Details in the project memory
(`sone-lower-deck-trap`).
```
