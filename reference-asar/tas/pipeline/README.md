m.
# PolyTrack Autonomous TAS Pipeline

A fully automated, deterministic TAS pipeline for **PolyTrack 0.6.2** built as a
4-phase **simulation-backed heuristic search**, exactly following the
architecture spec in [../AGENTS.md](../AGENTS.md) (tas folder):

| Phase | Component | What it does |
|------:|-----------|--------------|
| 1 | **Headless Wasm Snapshot Engine** | Runs the game's real `simulation_worker.bundle.js` + `polytrack_physics.wasm` inside Node (`vm` + worker shims). Direct `setState → stepPhysics(inputs) → getState` at ~12 µs/tick, full wasm-heap snapshots, bit-exact vs the game. |
| 2 | **Kinematic RRT** | Grows a tree of *physically simulated* states with a weighted inertial pseudometric (momentum alignment + kinetic-energy deficit — never raw Euclidean). Output: a driveable finishing "ghost" input script. |
| 3 | **Windowed MCTS** | UCT over the 16 discrete input combos, **10 ms action decimation**, 500 ms sliding window, lock-&-slide. Root-parallel across a worker pool (visit-trie merging). Fitness: geodesic track progress + exit velocity − airtime − slip. Runs with or without a Phase-2 ghost. |
| 4 | **(1+λ) Micro-polisher** | Native 1 ms resolution, ~100 ms windows over the whole run. Mutants must not lose any checkpoint split and must strictly improve the finish frame. Parallel proposal rounds. |

The result is verified with the game's **own `Verify` handler** (the same code
path the game uses to validate leaderboard submissions) before being written
out.

## Why the physics is provably game-identical

- The physics wasm is **the game's binary, byte-for-byte**, hosted headlessly.
- All simulation logic (track parsing, car creation, checkpoint/finish
  detection, recording decode) is the game's own worker bundle — the headless
  copy only *appends* one statement exposing internals (`generated/`).
- The Init payload (track-part collision meshes, car collision shape) is
  extracted offline from the game's GLBs using the game's own Draco decoder and
  **verified against the SHA-256 checksums baked into `main.bundle.js`**
  (187/187 must pass or the engine refuses to run).
- Mountain geometry is an exact port of `createMountainVertices`, including the
  baked 128-entry random table and the deterministic table-interpolated
  sin/cos both bundles install (extracted verbatim from the bundle).
- Engine tests assert: wasm `testDeterminism`, bit-identical trajectories on
  replay, and bit-identical continuation after snapshot/restore.

## Setup

```bash
cd tas/pipeline
node src/extract/build-context.js   # one-time per game version; verifies all checksums
node --test test/                   # full test suite
```

## Running from the in-game GUI

The TAS panel (F9, replay viewer) has an **Auto-TAS** section that runs this
pipeline on the track you're viewing: set Workers / MCTS budget, hit Start,
watch the live log, and the resulting script is loaded into the editor when it
finishes (best partial if the budget runs out — Apply → replay to inspect).
It spawns `src/cli/run.js` as a background process using your system `node`
(falling back to the game exe + `ELECTRON_RUN_AS_NODE` only if Node isn't
installed — packaged builds often disable that fuse, so having Node on PATH
is the reliable path). Artifacts are kept under `userData/tas-auto/<runId>/`.
One-time setup: build the context (below) and restart the game once after the
`electron/` bridge files change.

## Producing a TAS (CLI)

```bash
node src/cli/run.js ../../tracks/official/summer1.track \
  --workers 10 --rrt-budget 180 --sims 400 --mcts-budget 2400 --polish-budget 900
```

Artifacts land in `runs/<track>/`:

- `final.tas` — editor-ready script (`frame,keys` lines) for the in-game TAS tool
- `final.recording.txt` — game-codec recording string
- `phase2-ghost.tas`, `phase3.tas`, `meta.json` — intermediate stages + report

`meta.json.verify` is the game's own Verify verdict for the exact finish time.

## Tuning

- `--sims` × `--workers` is the per-window MCTS budget. Locking depth is
  confidence-gated (visit threshold), so more sims = longer locks = faster
  wall-clock progress *and* better lines.
- `--rrt-budget 0` skips Phase 2; MCTS then drives purely on the geodesic
  potential field (Dijkstra over the occupied track-cell graph, gap-tolerant
  for jumps, de-quantized with per-cell downhill gradients).
- Search knobs live in the DEFAULTS blocks of `src/search/{rrt,mcts,polish}.js`.

## Layout

```
src/paths.js               path resolution (POLYTRACK_ROOT override)
src/extract/               offline context extraction (GLB+Draco+bundle data)
src/engine/                headless engine: vm host, state reader, snapshots,
                           mountains port, recording/script IO
src/search/                guidance (waypoints + potential field), RRT, MCTS,
                           polisher, worker pool
src/cli/run.js             4-phase orchestrator
src/cli/bench.js           engine benchmark + dirty-heap diagnostics
test/                      node:test suite (checksums, determinism, snapshots,
                           codec round-trips, search mechanics)
context/init-context.json  generated, checksum-verified physics context
generated/                 the hooked headless worker copy (auto-generated)
```

## Notes & caveats

- The engine snapshot is the **full wasm heap** (~20 MB) — the proven-safe
  approach (same as the in-game bruteforce snapshot patch). Buffer reuse keeps
  GC pressure flat; restore ≈ 0.8 ms.
- `reset` (checkpoint respawn) is deliberately excluded from the search action
  set; full restarts are handled above the physics by the game.
- Wall-clock cost is dominated by `updateCarModel` (~12 µs). A 30 s track at
  Phase-3 quality settings is roughly 20–40 min on 10 cores; Phase 4 polish
  adds minutes per improvement round.
- Outputs are TAS scripts for the in-game editor (`tas/tas.js`); anything this
  pipeline produces is `edited`-category by definition — never upload it to the
  official leaderboar