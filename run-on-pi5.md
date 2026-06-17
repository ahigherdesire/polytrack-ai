# Run training on a Raspberry Pi 5, watch from your computer 🎉

The plan: the **Pi 5 trains 24/7** (no screen needed), and you open a browser on
**your Windows PC** to watch the live dashboard over your home network.

Everything below is run from **PowerShell on your PC**, or over **SSH on the Pi** —
each block says which. Replace `rp5user` with **your** Pi username and
`raspberrypi5.local` with **your** Pi hostname or IP everywhere.

> Fresh Pi? Reflash it first — see `deploy/DEPLOY.md` (use *Raspberry Pi OS Lite
> 64-bit*, and tick **Enable SSH** + set username/password/Wi-Fi in the gear menu).

---

## Step 0 — Connect to the Pi (do this first)

The SSH/SCP address is always **`username@host`** — username first. (A common
mistake is writing it backwards, e.g. `raspberrypi5@rp5user` — that's wrong; it
should be `rp5user@raspberrypi5.local`.)

**On your PC (PowerShell):**
```powershell
ssh rp5user@raspberrypi5.local
```

What you might see:
- **Asks for a password and logs in** ✅ — you've got the right address. Type `exit`
  to come back to your PC. Use this same `rp5user@raspberrypi5.local` everywhere below.
- **`Could not resolve hostname`** — the `.local` name isn't resolving. Use the Pi's
  **IP** instead. Find it by either:
  - plugging a keyboard/monitor in once and running `hostname -I`, or
  - checking your router's "connected devices" list, or
  - `ping raspberrypi5.local` from PowerShell (if it replies, note the IP).

  Then use `rp5user@192.168.x.x` everywhere instead.
- **`Connection refused`** — SSH isn't enabled on the Pi. Re-flash with SSH ticked, or
  attach a monitor and run `sudo raspi-config` → *Interface Options* → *SSH* → enable.
- **`Permission denied`** — wrong username or password. The username is whatever you
  set when flashing the SD card.

Don't continue until `ssh` logs you in. Everything else depends on it.

---

## Step 1 — Copy the project to the Pi

The whole project is ~25 MB, so a plain copy is fine. **Windows doesn't have `rsync`,
so use `scp`** (built into Windows 10/11).

**On your PC (PowerShell):**
```powershell
cd "C:\Users\LIXINYUAN\interesting stuff"
scp -r polytrack-ai rp5user@raspberrypi5.local:~/
```
- Run it from the **parent** folder (`interesting stuff`), so `polytrack-ai` is the
  thing being copied.
- It asks for your Pi password, then copies everything — **including the required
  `data/constants.json`** — to `~/polytrack-ai` on the Pi.
- Takes a few seconds. (Yes, this copies `.git` and logs too; at 25 MB, who cares.)

If `.local` didn't resolve in Step 0, use the IP form:
`scp -r polytrack-ai rp5user@192.168.x.x:~/`

---

## Step 2 — Set up the Pi (one time)

**On the Pi (SSH in first):**
```bash
ssh rp5user@raspberrypi5.local      # from your PC
cd ~/polytrack-ai
bash deploy/setup-pi.sh
```
This installs **Node.js 20** and runs the physics self-test. When you see
`isDeterminstic = true`, the real game physics is running on your Pi. ✅

(No other dependencies — the project is pure Node, and the physics is WebAssembly,
which runs on the Pi's ARM chip with nothing to compile.)

---

## Step 3 — Start training so it keeps running

The Pi 5 has 4 cores → use **3 workers**, population **24**. Pick ONE option.

### Option A — systemd (auto-starts on boot, auto-restarts on crash) ✅ recommended

The service files in `deploy/` are templates assuming username `pi`; they must be
copied into `/etc/systemd/system` before systemd knows about them. This fills in
**your** username, home path, and the real `node` location automatically. **On the
Pi:**
```bash
cd ~/polytrack-ai
which node || bash deploy/setup-pi.sh        # ensure Node is installed first
NODE=$(which node)
sed "s#/home/pi/polytrack-ai#$HOME/polytrack-ai#g; s#User=pi#User=$USER#g; s#/usr/bin/node#$NODE#g" \
  deploy/polytrack-train.service | sudo tee /etc/systemd/system/polytrack-train.service >/dev/null
sed "s#/home/pi/polytrack-ai#$HOME/polytrack-ai#g; s#User=pi#User=$USER#g; s#/usr/bin/node#$NODE#g" \
  deploy/polytrack-dashboard.service | sudo tee /etc/systemd/system/polytrack-dashboard.service >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now polytrack-train polytrack-dashboard
```

> If `systemctl status polytrack-train` says *"Unit could not be found"*, you haven't
> run the block above yet — the `.service` files only become real services after the
> `sudo tee … /etc/systemd/system/` + `daemon-reload`.
Now training runs forever (survives reboots + crashes), logging to
`~/polytrack-ai/train3.log`, and the dashboard is already up.

Check it:
```bash
systemctl status polytrack-train        # should say "active (running)"
journalctl -u polytrack-train -f         # live log (Ctrl-C to stop watching)
tail -n 3 ~/polytrack-ai/train3.log      # latest generations
```

### Option B — tmux (simple, manual; does NOT auto-start on reboot)
```bash
sudo apt-get install -y tmux
tmux new -s poly
# inside tmux, start training in the background then the dashboard:
node train/es_parallel.js 1000000 24 16000 3 > train3.log 2>&1 &
node train/dashboard.js train3.log 7780
# detach (leaves both running):  press Ctrl-b, release, then press d
```
Reattach later: `tmux attach -t poly`.

---

## Step 4 — Watch it from your computer 🖥️

The dashboard listens on the network, so from **your PC's browser** open:
```
http://raspberrypi5.local:7780
```
(or `http://<pi-ip>:7780` if the name doesn't resolve).

You'll see live cards (generation, best checkpoint, reward, speed), the reward +
checkpoint charts, and the **track map with the policy's driving path**, refreshing
every few seconds. Leave the Pi running and check in whenever.

> Make this easy: give the Pi a **reserved IP** in your router (DHCP reservation) so
> the address never changes, then bookmark `http://<that-ip>:7780`.

---

## Step 5 — Day-to-day

**Check progress (from your PC):**
```powershell
ssh rp5user@raspberrypi5.local "tail -n 3 ~/polytrack-ai/train3.log"
```

**Change the reward**, then apply it: edit `train/evaluator.js` on your PC (the
`REWARD` block — see `instructions.md`), re-copy, and restart:
```powershell
# on your PC:
cd "C:\Users\LIXINYUAN\interesting stuff"
scp polytrack-ai\train\evaluator.js rp5user@raspberrypi5.local:~/polytrack-ai/train/
```
```bash
# on the Pi (restart keeps your progress via policy.json):
sudo systemctl restart polytrack-train
```

**Update everything after PC-side changes:** re-run the Step 1 `scp -r`, then
`sudo systemctl restart polytrack-train polytrack-dashboard`.

**Train a different / custom track.** Track files live in the **`track data/`** folder
(quote the path — it has a space). First send the track file from your PC:
```powershell
# on your PC (note the quotes around the spaced paths):
cd "C:\Users\LIXINYUAN\interesting stuff"
scp "polytrack-ai/track data/mytrack.json" "rp5user@raspberrypi5.local:~/polytrack-ai/track data/"
```
Then on the Pi (stop the default service first so they don't fight for cores):
```bash
sudo systemctl stop polytrack-train polytrack-dashboard
cd ~/polytrack-ai
TRACK="track data/mytrack.json" node train/es_parallel.js 1000000 24 16000 3 > train-mytrack.log 2>&1 &
TRACK="track data/mytrack.json" node train/dashboard.js train-mytrack.log 7780
```
(See `instructions.md` for how to capture a track into `track data/`.)

**Stop / start training:**
```bash
sudo systemctl stop polytrack-train
sudo systemctl start polytrack-train
```

---

## Pi 5 tuning + heat ⚠️

- **Workers:** `3` is the sweet spot — the 4th core handles the OS + dashboard. More
  workers won't go faster on 4 cores and use more RAM.
- **Population:** `24` (8 per worker). On the 4 GB model, drop to `16` if memory is tight.
- **Speed:** the Pi 5 is much faster than a Pi 4 but still far slower than a desktop —
  expect fewer generations/hour. Same correctness; it just takes longer. That's fine —
  it's meant to grind 24/7.
- **Cooling (important):** sustained 100% on all 4 cores makes the Pi 5 hot. Use the
  **official active cooler / a fan**, or it throttles and slows down.
  Check temperature: `vcgencmd measure_temp` (keep it under ~80 °C).
- **Power:** use the official **5 V / 5 A USB-C** supply — undervoltage also throttles.
  Check for issues: `vcgencmd get_throttled` (`0x0` means all good).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `rsync: command not found` / `'rsync' is not recognized` | Windows has no rsync — use the `scp` command in Step 1 instead. |
| `Could not resolve hostname` | `.local` isn't resolving — use the Pi's IP: `rp5user@192.168.x.x`. |
| `Connection refused` (ssh/scp) | SSH not enabled on the Pi — enable it (Step 0). |
| `Permission denied (publickey,password)` | Wrong username or password. Username = what you set when flashing. |
| `scp` copies into `~/polytrack-ai/polytrack-ai` | You ran it from inside the project. Run from the **parent** folder. |
| `http://...:7780` won't load | Dashboard not running: `sudo systemctl start polytrack-dashboard` (or the tmux command). Confirm with `systemctl status polytrack-dashboard`. |
| `data/constants.json` missing on the Pi | The `scp -r` includes it; if you copied selectively, send it: `scp polytrack-ai\data\constants.json rp5user@host:~/polytrack-ai/data/`. |
| `node: command not found` on the Pi | Run `bash deploy/setup-pi.sh` (Step 2) to install Node 20. |
| Service won't start | `journalctl -u polytrack-train -n 50` to see the error; usually a wrong path/username in the `.service` file (the `sed` in Step 3 fixes that). |

---

Submitting a finished lap to the leaderboard still happens from a **browser on your
PC** (the game's API), not the Pi — see the main README roadmap.
