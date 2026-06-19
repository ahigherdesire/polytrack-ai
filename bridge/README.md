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
- **`submit-recording.js`** — browser console hook that swaps the AI recording into
  the game's leaderboard submit, so it posts under your account with the right
  token/trackId.
- **`capture_payloads.js`** — (track capture; see instructions.md).

## Workflow

```bash
# 1. validate + emit the recording (proves it's a frame-exact lap)
node bridge/verify-recording.js data/es_lap.haoyuone.json tracks/haoyuone.json
#    -> ✓ VALID recording ... -> data/es_lap.haoyuone.recording.txt

# 2. (just the string, e.g. to paste somewhere)
node bridge/make-recording.js data/es_lap.haoyuone.json
```

To put it on the leaderboard: open the game, paste `submit-recording.js` into the
console (with `AI_RECORDING` + `AI_FRAMES` filled in from step 1), then drive any
finishing lap on that track — the AI lap is submitted instead, and you can "watch"
it back frame-perfect from the leaderboard.

> Verified working: a 9.795 s `haoyuone` lap serializes to a 254-char recording that
> the game's `Verify` accepts as a frame-exact finish.
