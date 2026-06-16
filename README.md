# PolyTrack AI

Goal: an AI that **learns** to drive [PolyTrack](https://app.polytrack.com) and pushes toward **world-record** times.

## The honest reality (read this first)

You cannot train a record-beating racing AI inside a live browser. RL for time-trial
racing needs hundreds of millions to billions of physics steps; a browser runs at
60 fps. Every project that has actually beaten human racing world records (e.g.
[Linesight](https://github.com/pb4git/linesight-public) for TrackMania) does the
same three things, and so do we:

1. **Run the game's real physics headless, far faster than real time.**
2. **Train RL in that fast sim**, then refine the best run with TAS-style search.
3. **Replay the resulting input sequence in the real game** to validate/submit.

The make-or-break requirement is that the headless physics matches the browser
**bit-for-bit**, or the optimal inputs won't reproduce. PolyTrack makes this
achievable because its physics is **deterministic** (it ships a determinism
self-test) and runs in a **separate worker** we can drive independently of
rendering.

## What is already proven (✓)

- PolyTrack's physics is **Ammo.js (Bullet) compiled to WASM**, driven by
  `simulation_worker.bundle.js` at a **fixed 1 ms / frame (1000 fps of game time)**.
- We load the game's **exact** `ammo.wasm` + simulation worker **headless in Node**
  (`sim/headless.js`) by shimming the Web Worker environment in a clean `vm`
  context (no `process`/`Buffer`, so bundled libs take their browser code paths).
- The game's own **determinism self-test passes headless**:
  `npm run test:determinism` → `isDeterminstic = true`. This is the critical proof
  that inputs found here will transfer bit-exact to the browser.

## Architecture

```
RL trainer  --input seq-->  Headless sim (Node)         Browser bridge
(Python/JS)  <--state--     simulation_worker + Ammo  -> replay + submit to
 N parallel envs            1000s x real-time            vps.kodub.com leaderboard
```

### Worker message protocol (reverse-engineered)

`postMessage({ messageType, ... })`, enum:

| # | Type | Purpose |
|---|------|---------|
| 0 | Init | `{ isRealtime, trackParts }` |
| 1 | Verify | run a recording to `targetFrames`, returns exact-finish bool |
| 2 | TestDeterminism | bit-exact physics self-check |
| 3 | CreateCar | `{ trackData, carRecording?, carId, mountainVertices, mountainOffset, carCollisionShapeVertices, carMassOffset }` |
| 5 | StartCar | begin sim for a car |
| 6 | ControlCar | `{ carId, up, right, down, left, reset }` (the 5 inputs) |
| 8/9/10 | *Result | VerifyResult / DeterminismResult / UpdateResult |

Car state is read each frame via the worker's `flattenState` (position,
quaternion, speedKmh, per-wheel contact/suspension, nextCheckpointIndex,
finishFrames, ...).

### Public API (`https://vps.kodub.com:43273/`, version token = game version)

- `leaderboard?version=&trackId=&skip=&amount=&onlyVerified=` → ranked entries.
- `recordings?version=&recordingIds=a,b,c` → the actual **input recordings** (incl. WRs).
- `tracks/official/<id>` → official track data.

This lets us pull the **current world-record recording** for a track, run it
through the headless `Verify` to confirm our sim reproduces its exact time, and
use that as the target to beat.

## Repo layout

```
game/    The game's real physics (downloaded): simulation_worker.bundle.js,
         main.bundle.js, lib/ammo.wasm.{js,wasm}, manifest.json
sim/     Headless harness. headless.js (worker shim), test_determinism.js, ammo_probe.js
bridge/  capture_payloads.js (browser console hook to grab real CreateCar/Init payloads)
train/   RL environment + training (next)
data/    Captured/ fetched track + car payloads, recordings
```

## Roadmap / status

- [x] Load Ammo/Bullet WASM headless in Node
- [x] Run the real simulation worker headless; pass determinism self-test
- [ ] Get a real `CreateCar` payload (browser via `bridge/capture_payloads.js`,
      or fetch official track + WR recording from the API)
- [ ] Closed-loop single-car stepping: ControlCar + 1 frame + read state, at max speed
- [ ] Gym env (obs = state vs. track centerline + lookahead; action = 5 inputs;
      reward = progress/time) with many parallel processes
- [ ] Train PPO/SAC to finish + minimize frames; TAS/CMA-ES refinement toward WR
- [ ] Browser replay/submit bridge: validate exact time, submit to leaderboard

**Compute reality:** reaching WR-competitive times is days-to-weeks of training
even with everything above in place. This repo builds the engine that makes that
possible and proves the hardest, most uncertain part (bit-exact headless physics)
already works.

## Run

```bash
npm run test:determinism   # -> isDeterminstic = true
```

Game files are the property of Kodub; included here only to run the physics
locally for AI research.
