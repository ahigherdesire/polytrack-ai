# Train on a Raspberry Pi — solving a lap, headless, 24/7

Same solver as the desktop guide (`TRAIN-ON-COMPUTER.md`), but arranged for a Pi that
runs with **no screen**: you **capture the track on your PC**, **copy it to the Pi**,
let the Pi **search over SSH** (kept alive so it survives you logging out), then **copy
the finished lap back** and play it on your PC.

```
   YOUR PC (browser + terminal)                 RASPBERRY PI 5 (headless)
 ┌───────────────────────────────┐            ┌───────────────────────────┐
 │ 1. capture track  ─► tracks/  │  scp  ──►   │ 3. ssh in                 │
 │ 5. scp lap back  ◄────────────│  ◄── scp    │ 4. run solver in tmux     │
 │ 6. verify + play in the game  │            │    (3 workers) → es_lap    │
 └───────────────────────────────┘            └───────────────────────────┘
```

Throughout, replace **`rp5user`** with your Pi username and
**`raspberrypi5.local`** with your Pi's hostname or IP.

---

## 0. Prerequisites (once)

- The Pi is flashed, on the network, and reachable by SSH, and the project is copied to
  `~/polytrack-ai` with Node.js installed. If you haven't done that yet, follow
  **`run-on-pi5.md`** (Steps 0–2) first — it ends with the physics self-test printing
  `isDeterminstic = true`. **Do not continue until `ssh rp5user@raspberrypi5.local`
  logs you in** and `~/polytrack-ai` exists on the Pi.
- The Pi 5 has 4 CPU cores → use **3 workers** for the solver (leave one core free).

> `run-on-pi5.md` also describes a systemd auto-start service — note that it runs the
> **old** Evolution-Strategies trainer (`es_parallel.js`), not this MCTS solver. For
> the solver, use the **tmux** method in §4 below.

---

## 1. Capture the track (on your PC)

The track data only exists in the running game, so grab it in a browser on your PC —
exactly as in **`TRAIN-ON-COMPUTER.md` §1.2** (or the friendly
[HOWTO Step 1](https://github.com/ahigherdesire/polytrack-ai/blob/master/HOWTO-copy-optimize-play.md#step-1--capture-the-track-browser)).

The short version: open **https://app-polytrack.kodub.com/0.6.2/**, F12 → Console,
paste the capture script, enter the track, run `__polyDump("mytrack")`, then on your PC:

```powershell
# in your LOCAL project folder on the PC
cd "C:\Users\LIXINYUAN\interesting stuff\polytrack-ai"
node train/make-track.js "C:\Users\LIXINYUAN\Downloads\mytrack.json" mytrack
#   -> wrote tracks/mytrack.json
```

Skip this whole step if you only want **Summer 1 (sone)** — it's already on the Pi at
`data/constants.json`, so jump to §3 and run the solver with no `TRACK=`.

---

## 2. Send the track to the Pi (on your PC)

Copy the one track file over with `scp` (built into Windows 10/11 PowerShell). Make
sure the `tracks/` folder exists on the Pi first, or `scp` fails with `dest open …`:

```powershell
# on your PC (PowerShell)
ssh rp5user@raspberrypi5.local "mkdir -p ~/polytrack-ai/tracks"
scp tracks/mytrack.json rp5user@raspberrypi5.local:~/polytrack-ai/tracks/
```
(If `.local` doesn't resolve, use the Pi's IP: `rp5user@192.168.x.x`.)

---

## 3. SSH into the Pi

```powershell
# on your PC
ssh rp5user@raspberrypi5.local
cd ~/polytrack-ai
```
Everything in §4–§5 runs **on the Pi**, inside this SSH session.

---

## 4. Run the solver so it survives logout (tmux)

A solve takes a long time, so run it inside **tmux** — that keeps it alive after you
disconnect. Install tmux once (`sudo apt-get install -y tmux`), then:

```bash
# on the Pi
tmux new -s solve            # opens a persistent session

# inside tmux — 3 workers on the Pi.  <budgetSeconds> <simsPerWorker> <workers>
node train/solve_parallel.js 14400 100 3  > solve.log 2>&1 &

# for a captured track instead of Summer 1:
#   TRACK=tracks/mytrack.json node train/solve_parallel.js 14400 100 3 > solve.log 2>&1 &

tail -f solve.log            # watch it (Ctrl-C stops watching, NOT the solver)
```

Detach and leave it running: press **Ctrl-b**, then **d**. You can now `exit` the SSH
session and the solve keeps going. To come back later:

```bash
ssh rp5user@raspberrypi5.local
cd ~/polytrack-ai
tmux attach -t solve         # reattach to see live progress
```

**Notes for the Pi:**
- Keep `workers` at **3**. The Pi is much slower per-core than a desktop, so give it a
  **large budget** (e.g. `14400` = 4 h) — each search window takes longer here.
- What the log lines mean, and the startup/`guidance:`/`greedy seed:`/`w<N>` output,
  are documented in **`TRAIN-ON-COMPUTER.md` §2.5 and §3** — identical here.
- Machine-readable status is in `data/solve_run.json`
  (`{ cp, lockedS, bestFinishS, status }`).

---

## 5. Get the result

When it finishes (or the budget runs out) the solver writes the lap to
**`~/polytrack-ai/data/es_lap.json`** (`data/es_lap.mytrack.json` for a `TRACK=` run)
and the log prints either:
```text
*** FINISH (locked) 23.412s
wrote 23.412s lap (23412 frames) -> data/es_lap.json
```
or, if it ran out of time before finishing, `writing partial …`.

Copy the lap back to your PC and play/verify it there (the Pi has no display):

```powershell
# on your PC (PowerShell)
scp rp5user@raspberrypi5.local:~/polytrack-ai/data/es_lap.json data/es_lap.json
```
Then verify + watch it in the game on your PC — see **`TRAIN-ON-COMPUTER.md` §5**
(`bridge/verify-recording.js` → `bridge/play-recording.js`).

---

## 6. Stop / restart

```bash
# on the Pi — stop the solve
tmux attach -t solve
#   Ctrl-C the running command (or:)  pkill -f solve_parallel
#   Ctrl-b d  to detach again, or  exit  to close the session
tmux kill-session -t solve   # remove the tmux session entirely
```
The solver is stateless — just re-run the command in §4 to start over (a bigger
`budgetSeconds` gives it more time to reach a finish).

---

## 7. Known limitation (Summer 1 / sone)

The solver clears checkpoint 0 and the big descent jump, then hits a **physical wall
at x ≈ −64** where a low surface steps up to the main road — it can't finish sone
yet (on the Pi or a desktop). This is a track/algorithm limit, not a Pi issue; full
write-up in `TRAIN-ON-COMPUTER.md` §9 and project memory (`sone-lower-deck-trap`).
