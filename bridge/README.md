# bridge/ — getting AI laps into the real game

Keyboard replay (pressing OS keys) **can't** reproduce a 1000 fps input sequence —
tiny timing drift compounds and the car hits a curb. The accurate path is the
game's native **recording** format, which plays at full internal 1000 fps with
frame-exact inputs and is exactly what the leaderboard accepts.

## Files

- **`make-recording.js`** — converts an AI lap (`es_lap.<track>.json`) into the
  game's recording string (delta-encoded toggle-frames per key → zlib → URL-safe
  base64).
- **`verify-recording.js`** — builds the recording and runs it through the game's
  **own `Verify`** (the same check the leaderboard server runs) to prove it
  reproduces the exact finish frame. Writes `<lap>.recording.txt`.
- **`play-recording.js`** — browser console hook to **watch the lap play out on the
  real track, frame-perfectly**. It turns your player car into a recording-driven
  car, so the game itself drives + renders the exact lap. (This replaces the
  keyboard lap-player / copier.)
- **`submit-recording.js`** — browser console hook to put the lap on the leaderboard
  (swaps the AI recording into the game's submit). Optional.
- **`grab-recording.js`** — browser console hook to **copy another player's lap from
  the game** (grabs the recording the game fetches when you watch a leaderboard
  replay). No pixel reading.
- **`decode-recording.js`** — turns a recording string back into per-frame inputs
  (`{up,down,left,right,reset}`). Inverse of `make-recording.js`; verified bit-exact.
- **`capture_payloads.js`** — (track capture; see instructions.md).

- **`fetch-recording.js`** — **fully automated** grab+decode straight from the game's
  public API (no browser): trackId → leaderboard → recording → inputs.
- **`optimize-lap.js`** — TAS hill-climber: start from a lap's inputs and search for a
  FASTER finish, keeping only changes that still finish, in fewer frames, verified in
  the headless sim. Outputs a ready `.recording`.

## Workflow — tweak a lap to go faster (TAS)

```bash
# improve a lap; each iteration is a full frame-exact sim (~1s)
node bridge/optimize-lap.js <seed-lap.json> <track.json> [iters] [out.json]
# e.g. keep improving Hollow Dunes from the current best:
node bridge/optimize-lap.js data/grabbed/hollowdunes_best.json tracks/hollowdunes.json 4000 data/grabbed/hollowdunes_best.json
# get the recording string to play/submit:
node -e "console.log(require('./data/grabbed/hollowdunes_best.json').recording)"
```
- seed-lap.json = any lap json with `.actions` (a fetched WR, or a prior optimized
  output — seed from the output to continue improving).
- track.json = the captured track (e.g. `tracks/hollowdunes.json`, built from a browser
  capture via `train/make-track.js`).
- Only verified-faster, still-finishing laps are kept, so the output is always real.
  Proven: shaved a real Hollow Dunes WR from 33.843s to 33.7xx in the sim.

## Workflow — fetch a world record automatically (no browser)

The game's API (`vps.kodub.com/v6`) is reachable directly with the browser
`Origin`/`Referer` headers, so for any track whose **trackId** you know you can grab
+ decode a lap in one command:

```bash
# rank 1 = world record. (Summer 1 trackId shown.)
node bridge/fetch-recording.js 5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038 1 data/grabbed/summer1_wr.json
#   -> youngfella  22.262s (rank 1/3123573) ; out.json has the exact per-frame inputs
```
Verified: the fetched WR recording reproduces its exact finish frame in our headless
sim (`sim/headless062` Verify), so you can also re-run / analyze any record locally.

To get a **community track's** trackId, use the browser grab below (or read it from
the leaderboard request in the Network tab).

## Workflow — copy a player's lap with the browser (any track)

This replaces pixel reading: the game already stores everyone's inputs as
recordings, so grab the real data instead of reading the screen.

1. Open the game, paste **`grab-recording.js`** into the console.
2. Open the track's leaderboard and **watch** the lap(s) you want. Each is captured.
3. `__polyDumpGrabbed("recordings")` → downloads `recordings.json` (recording
   strings + frames + names).
4. On your PC, decode to inputs:
   ```bash
   node bridge/decode-recording.js "<recording string>" <frames> out.json
   ```
   → `out.json` is the exact per-frame inputs that player used. (Verified: encode →
   decode round-trips bit-for-bit.)

## Workflow — watch a lap play out accurately

```bash
# 1. build + validate the recording (game's own Verify proves it's frame-exact)
node bridge/verify-recording.js data/es_lap.haoyuone.json tracks/haoyuone.json
#    -> ✓ VALID recording ... -> data/es_lap.haoyuone.recording.txt
```
2. Open the game (`https://app-polytrack.kodub.com/0.6.2/`), paste the recording
   string into `AI_RECORDING` in **`play-recording.js`**, and paste that whole
   script into the DevTools console (before entering the track).
3. Enter the track and press an arrow key once to start — the car drives the AI lap
   by itself, perfectly. `__polyPlayOff()` to stop and drive normally.

> Why this beats keyboard replay: the recording is applied **by frame number inside
> the game**, not by OS keystrokes, so there's zero timing drift.
>
> Verified: a 9.795 s `haoyuone` lap → a 254-char recording the game's `Verify`
> accepts as a frame-exact finish.
