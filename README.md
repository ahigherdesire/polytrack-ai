# PolyTrack AI

An AI that **learns to drive** [PolyTrack](https://www.kodub.com/apps/polytrack) by running the
game's own physics headless and training a neural-network policy with Evolution
Strategies — aiming at world-record lap times.

<<<<<<< HEAD
---

## Why it's built this way

You can't train a record-beating racing AI inside a live browser. RL/ES for
time-trial racing needs **hundreds of millions of physics steps**; a browser runs
at 60 fps. Every project that has actually beaten human racing records (e.g.
*Linesight* for TrackMania) does the same three things, and so do we:
=======
## The sad thing:

Damn it. I cannot train a record-beating racing AI inside a live browser. RL for time-trial
racing needs hundreds of millions to billions of physics steps; a browser runs at
60 fps. Every project that has actually beaten human racing world records (e.g.
[Linesight](https://github.com/pb4git/linesight-public) for TrackMania) does the
same three things, and so do we:
>>>>>>> de5176b68afbf668d7d6bffc2532ba36b493c76a

1. **Run the game's real physics headless, far faster than real time.**
2. **Train in that fast sim.**
3. **Replay the resulting input sequence in the real game** to validate/submit.

The make-or-break requirement: the headless physics must match the browser
**bit-for-bit**, or the optimal inputs won't reproduce. PolyTrack makes this
possible because its physics is **deterministic** and runs in a **Web Worker** we
can drive independently of rendering.

---

<<<<<<< HEAD
## How it works (the pipeline)
=======
The **live** game (https://www.kodub.com/apps/polytrack) is **0.6.2**, served from
`https://app-polytrack.kodub.com/0.6.2/`. That is our target — its physics is what
produces the current world records. We keep an older `0.5.0` build too (it used
Ammo/Bullet; useful as a cross-check), but **0.6.2 is primary**.

> Physics engine changed between versions: 0.5.0 used **Ammo.js (Bullet)**; 0.6.2
> uses a **custom Emscripten C engine** `lib/polytrack_physics.js` with a clean C
> API (`_createCarModel`, `_updateCarModel`, `_addTrackPartConfiguration`,
> `_testDeterminism`, ...). Both are deterministic, fixed **1 ms/frame (1000 fps)**.

## What is already proven

- **0.6.2 (live):** the custom `polytrack_physics` engine loads headless in Node
  (`npm run probe:physics062`) and the **full worker bundle** (Three.js + engine +
  embedded wasm) boots in a clean `vm` sandbox and **passes the determinism
  self-test**: `npm run test:determinism:062` → `isDeterminstic = true`.
- **0.5.0 (archive):** same approach over Ammo/Bullet; `npm run test:determinism`
  → `true`.
- This is the critical proof that inputs found in our headless sim transfer
  **bit-exact** to the browser — the thing that defeats every screen-capture bot.

## Arch
>>>>>>> de5176b68afbf668d7d6bffc2532ba36b493c76a

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │ 1. HEADLESS SIM  (sim/)                                              │
 │    Run the game's real simulation_worker.bundle.js + polytrack_      │
 │    physics.wasm in Node, inside a vm sandbox with Web-Worker shims.  │
 │    Deterministic, ~tens of thousands of frames/sec, no rendering.    │
 └─────────────────────────────────────────────────────────────────────┘
        │ observation                              ▲ controls (5 inputs)
        ▼                                          │
 ┌─────────────────────────────────────────────────────────────────────┐
 │ 2. POLICY + TRAINING  (train/)                                      │
 │    A tiny MLP maps observations -> controls. Evolution Strategies    │
 │    evolves its weights across all CPU cores, scoring each candidate  │
 │    by a full simulated lap (checkpoints reached, then finish time).  │
 └─────────────────────────────────────────────────────────────────────┘
        │ best policy / best lap                   ▲ live metrics
        ▼                                          │
 ┌──────────────────────────┐          ┌───────────────────────────────┐
 │ 3. OUTPUTS               │          │ 4. DASHBOARD  (train/)        │
 │ data/policy.json (brain) │          │ live charts + track map +     │
 │ data/es_lap.json (inputs)│          │ the policy's driving path     │
 └──────────────────────────┘          └───────────────────────────────┘
        │
        ▼  (next) browser bridge: replay inputs in the real game, submit time
```

<<<<<<< HEAD
### 1. Headless simulation — `sim/`
=======
### WMP  (worker msg prot)
>>>>>>> de5176b68afbf668d7d6bffc2532ba36b493c76a

The live game is **0.6.2** (served from `app-polytrack.kodub.com/0.6.2/`). Its
physics is **Bullet, compiled to a custom Emscripten engine** (`polytrack_physics.wasm`),
driven by `simulation_worker.bundle.js` at a fixed **1 ms / frame (1000 fps)**.

`sim/headless062.js` runs that exact worker in Node:
- The custom physics wasm is preloaded (so Emscripten reads it from disk, not fetch).
- The worker bundle runs in a clean `vm` context with shims for `self`,
  `importScripts`, `postMessage`, `requestAnimationFrame`, a fake monotonic clock,
  and a minimal `document` (the worker bundles Three.js).
- A one-line patch makes each "frame pump" advance **exactly one** physics frame.

It exposes a clean API:
- `loadCar(init, createCar)` — set up the track + a controllable car.
- `step({up,down,left,right,reset})` — advance one frame, return the decoded state.
- `reset()` — restart the car at the line (cheap, no wasm reload).
- `snapshot()` / `restore()` — **bit-exact O(1) branching** (copy the wasm heap +
  car counters). Powers fast search and instant training resets.
- `checkpoints()` — checkpoint waypoints in world coords.

Other sim pieces:
- `sim/carstate.js` — exact port of the game's 227-byte car-state decoder.
- `sim/geom.js` — grid→world (`×5`), quaternion/heading helpers.
- `sim/track_sensors.js` — rasterizes the track into an occupancy grid and casts
  **road-edge sensor rays** (so the policy can "see" walls/road shape ahead).
- `sim/observe.js` — builds the policy's observation vector.

**Determinism is verified:** `node sim/test_determinism062.js` runs the engine's
own bit-exact self-test headless → `isDeterminstic = true`.

### 2. Policy + training — `train/`

- `train/policy.js` — a small MLP: observation (17 features) → 4 control outputs.
- `sim/observe.js` — observation = signed speed, ground contact, direction +
  distance to the next two checkpoints, and 7 road-edge sensor rays.
- `train/evaluator.js` — runs one full lap for a weight vector and scores it:
  `reward = checkpointsReached·3000 − distanceToNextCheckpoint + (finished ? 2e6 − finishFrames : 0)`.
  So progress is always rewarded, finishing dominates, and among finishing laps the
  **fastest** wins.
- `train/es_parallel.js` — **Evolution Strategies** (OpenAI-ES: antithetic,
  rank-normalized). Each generation perturbs the weights into a population, evaluates
  every candidate in parallel across `worker_threads` (one sim per core), and nudges
  the weights toward the better-scoring perturbations. Resumes from `data/policy.json`.

ES is used (instead of backprop RL) because the sim is a fast, deterministic black
box: ES needs no gradients, parallelizes trivially, and optimizes the **whole-lap
outcome**, so the policy learns to brake into corners on its own.

### 3. Outputs — `data/`

- **`data/policy.json`** — the trained network weights (the "driver brain"). Updated
  every generation. Replaying it regenerates a lap deterministically.
- **`data/es_lap.json`** — the **input sequence** (per-frame controls) of the current
  best lap, plus its checkpoint progress and finish time. Updated **whenever the best
  reward improves**. This is the submittable artifact: replaying these inputs in the
  real game reproduces the lap exactly.

### 4. Dashboard — `train/dashboard.js`

A live web UI (default `http://localhost:7780`): generation / best-checkpoint /
reward / speed cards, best-reward and checkpoint charts, and a **top-down track map
showing the current best policy's actual driving path** (so you can see where it gets
stuck). It parses the training log and replays `data/policy.json` on demand.

---

## Run it

```bash
# prove the real physics runs headless & deterministic
node sim/test_determinism062.js

# drive a car on the captured track (holds accelerate)
node sim/run_car062.js

# train  (generations, population, maxFrames, workers)
node train/es_parallel.js 4000 78 16000 13

# watch it  ->  http://localhost:7780
node train/dashboard.js train3.log 7780
```

> Training writes progress to `train3.log`, and updates `data/policy.json` +
> `data/es_lap.json` as it improves.

### Getting the track data (`data/constants.json`)

The sim needs the track + car collision data the game builds from its assets. It's
captured once from the live game with `bridge/capture_payloads.js` (paste into the
browser console, load a track), which dumps the worker's `Init` + `CreateCar`
messages to JSON. See that file's header for the exact steps. *(This file is large
and git-ignored; it must exist in `data/` to run the sim.)*

---

## Repo layout

```
game/0.6.2/   The live game's real code: simulation_worker.bundle.js,
              main.bundle.js, lib/polytrack_physics.{js,wasm}   (physics source)
sim/          Headless sim + decoding + sensors + geometry
train/        policy, evaluator, ES trainers, search solvers, dashboard
bridge/       capture_payloads.js (browser hook to grab track data)
data/         constants.json (captured), policy.json + es_lap.json (produced)
```

Also present: `game/` (root) holds the older **0.5.0** build (Ammo/Bullet) used as a
cross-check; `train/beam_search.js` etc. are heuristic finishing solvers kept for
reference (they clear the first corners but can't speed-control like the learned
policy).

---

## Status & roadmap

- [x] Headless 0.6.2 physics in Node, bit-exact (determinism self-test passes)
- [x] Real car drives a real track; state decode; checkpoint geometry; snapshot/restore
- [x] Road-edge sensors; Evolution Strategies trainer (parallel) + live dashboard
- [x] Learned policy clears the corners heuristic search couldn't
- [ ] A full finishing lap of Summer 1 (in progress — currently ~2/3 checkpoints)
- [ ] **TAS refinement:** CMA-ES over the input sequence to minimize lap time
- [ ] **Browser bridge:** serialize inputs to the game's recording format, replay in
      the real game to confirm the time matches to the millisecond, submit to leaderboard

**Honest expectation:** first comes a lap that *finishes*; reaching *world-record*
time needs the refinement pass and more compute — the engine for it (fast
snapshot-based input search) is built, but WR-level time isn't guaranteed in a fixed
window. Leaderboard submission must go through a browser (the API is on a port this
environment can't reach).

Game assets are © Kodub; included only to run the physics locally for AI research.
```
