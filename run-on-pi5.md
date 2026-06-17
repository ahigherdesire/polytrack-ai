# Run training on a Raspberry Pi 5, watch from your computer 🎉

The plan: the **Pi 5 does the training 24/7**, and you open a browser on your
**own computer** to watch the live dashboard over your home network. The Pi has no
screen — everything is headless + SSH.

> First time on a fresh Pi? See `deploy/DEPLOY.md` for wiping/reflashing it. This
> guide assumes the Pi 5 is booted, on your network, and you can `ssh` into it.

---

## 1. Get the project onto the Pi (one time)

From **your computer**, in the folder that contains `polytrack-ai/`:

```bash
rsync -av --exclude '*.log' --exclude node_modules \
  "polytrack-ai/" pi@<pi-ip>:~/polytrack-ai/
```

`<pi-ip>` is your Pi's address (see step 4 to find it). This copies everything,
**including `data/constants.json`** (required — a `git clone` would miss it).

Then set it up on the Pi:

```bash
ssh pi@<pi-ip>
cd ~/polytrack-ai
bash deploy/setup-pi.sh        # installs Node 20, runs the determinism self-test
```

If it prints `isDeterminstic = true`, the real game physics is running on your Pi. ✅

---

## 2. Start training (so it keeps running after you log out)

The Pi 5 has 4 cores — use **3 workers**. Two easy ways:

### Option A — systemd (auto-starts on boot, restarts on crash) — recommended
```bash
sudo cp deploy/polytrack-train.service     /etc/systemd/system/
sudo cp deploy/polytrack-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polytrack-train polytrack-dashboard
```
Training now runs forever (survives reboots), logging to `~/polytrack-ai/train3.log`,
and the dashboard is already up. Check it:
```bash
systemctl status polytrack-train
journalctl -u polytrack-train -f       # live training log
```

### Option B — tmux (simple, manual)
```bash
sudo apt-get install -y tmux
tmux new -s poly
# inside tmux:
node train/es_parallel.js 1000000 24 16000 3 > train3.log 2>&1 &
node train/dashboard.js train3.log 7780
# detach (leaves it running): press  Ctrl-b  then  d
```
Reattach later with `tmux attach -t poly`. (With tmux it does **not** auto-start on
reboot — systemd does.)

---

## 3. See the results on your computer 🖥️

The dashboard listens on all network interfaces, so from **any device on the same
network** just open:

```
http://<pi-ip>:7780
```

That's it — live cards, charts, and the track map with the policy's driving path,
updating every few seconds. Leave the Pi running and check in whenever you like.

> Tip: give the Pi a fixed/reserved IP in your router (DHCP reservation), or use its
> hostname: `http://<hostname>.local:7780` (e.g. `http://polypi.local:7780`).

---

## 4. Finding the Pi's IP

- From your computer: `ping <hostname>.local` (the hostname you set when flashing), or
- Check your router's device list, or
- On the Pi itself: `hostname -I`

---

## 5. Day-to-day

```bash
# is it training?
ssh pi@<pi-ip> "tail -n 3 ~/polytrack-ai/train3.log"

# change the reward, then restart to apply (keeps progress via policy.json):
#   edit train/evaluator.js on your PC, rsync again, then:
sudo systemctl restart polytrack-train

# train a different / custom track instead:
sudo systemctl stop polytrack-train
cd ~/polytrack-ai
TRACK=data/mytrack.json node train/es_parallel.js 1000000 24 16000 3 > train-mytrack.log 2>&1 &
TRACK=data/mytrack.json node train/dashboard.js train-mytrack.log 7780
```

To update the code after you change things on your PC, just rsync again (step 1) and
`sudo systemctl restart polytrack-train polytrack-dashboard`.

---

## 6. Pi 5 tuning + heat ⚠️

- **Workers:** `3` is the sweet spot (4th core for the OS + dashboard). The Pi 5 is
  much faster than a Pi 4, but still far slower than a desktop — expect fewer
  generations/hour. Correctness is identical; it just takes longer.
- **Population:** `24` (8 per worker). Drop to `16` if you're on the 4 GB model and
  memory gets tight.
- **Cooling:** the Pi 5 runs hot under sustained 100% on all cores — use the active
  cooler / a fan, or it will throttle and slow down. Check temp: `vcgencmd measure_temp`.
- **Power:** use the official 5 V/5 A USB-C supply; undervoltage also throttles.

Submitting a finished lap to the leaderboard still happens from a **browser** on your
computer (the game's API), not the Pi — see the main README roadmap.
