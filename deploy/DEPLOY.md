# Deploying PolyTrack AI to a Raspberry Pi (4 GB)

Good news: the project is **pure Node.js with zero dependencies**, and the physics
is **WebAssembly (architecture-independent)** — so it runs on the Pi's ARM CPU with
no recompiling. The only real constraint is horsepower: a 4-core Pi is ~10–20× slower
than a desktop, so training is slower (correctness is identical).

---

## A. Wipe the Pi first (clean slate)

The cleanest "wipe everything" is to **reflash the storage** with a fresh OS. Do this
from your PC with **Raspberry Pi Imager** (https://www.raspberrypi.com/software/):

1. ⚠️ Back up anything on the Pi you want to keep — reflashing erases it all.
2. Plug the Pi's SD card (or SSD) into your PC.
3. Open Raspberry Pi Imager →
   - **Device:** your Pi model
   - **OS:** *Raspberry Pi OS Lite (64-bit)* — "Lite" has no desktop, leaving more of
     your 4 GB for training.
   - **Storage:** the Pi's card/SSD.
4. Click the **gear / Edit Settings** before writing:
   - set hostname, enable **SSH**, set username `pi` + password, configure Wi‑Fi.
5. **Write.** When done, boot the Pi from it. It comes up headless; SSH in:
   `ssh pi@<pi-ip>` (find the IP from your router, or `ping <hostname>.local`).

(64-bit OS matters — Node's WASM works best there.)

---

## B. Copy the project to the Pi

From your PC, in the parent of the project folder. Pick one:

**rsync (recommended — skips junk):**
```bash
rsync -av --exclude node_modules --exclude '*.log' \
  "polytrack-ai/" pi@<pi-ip>:~/polytrack-ai/
```

**or scp the folder:**
```bash
scp -r polytrack-ai pi@<pi-ip>:~/
```

> IMPORTANT: `data/constants.json` (~14 MB) is required and is **git-ignored**, so a
> `git clone` would NOT include it. rsync/scp of the folder above DOES include it.
> If you cloned instead, copy it separately:
> `scp polytrack-ai/data/constants.json pi@<pi-ip>:~/polytrack-ai/data/`

You can also bring `data/policy.json` to continue training where the desktop left off.

---

## C. Install + verify on the Pi

```bash
ssh pi@<pi-ip>
cd ~/polytrack-ai
bash deploy/setup-pi.sh      # installs Node 20, then runs the determinism self-test
```
If it prints `isDeterminstic = true`, the real physics is running on your Pi. 🎉

---

## D. Run it

Manual (quick test):
```bash
# train — 3 workers + population 24 suits a 4-core / 4 GB Pi
node train/es_parallel.js 1000000 24 16000 3

# in another shell: dashboard, reachable on your LAN
node train/dashboard.js train3.log 7780
# then open http://<pi-ip>:7780 from any device on your network
```

Run on boot (systemd — survives reboots/crashes):
```bash
sudo cp deploy/polytrack-train.service     /etc/systemd/system/
sudo cp deploy/polytrack-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polytrack-train polytrack-dashboard
# logs:
journalctl -u polytrack-train -f
```
(The service files assume the project is at `/home/pi/polytrack-ai` and user `pi`.
Edit them if yours differ.)

---

## E. Tuning for 4 GB / 4 cores

- **Workers:** use `3` (4th core for the OS + dashboard). More workers = more RAM and
  context-switching, not faster on 4 cores.
- **Population:** `24` (8 per worker) is a good balance; lower it to `16` if RAM is tight.
- **Memory:** each worker holds a ~24 MB physics heap + the worker bundle; 3 workers +
  dashboard sit comfortably under ~1.5 GB. The train service caps at 2.5 GB as a guard.
- **Heat:** sustained 100% on all cores — make sure the Pi has a heatsink/fan.
- **Speed:** expect far fewer generations/hour than the desktop. It still converges to
  the same policy; it just takes longer. Leave it running (systemd handles reboots).

Submitting a finished lap to the leaderboard still happens from a **browser** (the
game's API), not the Pi — see the main README's roadmap.
