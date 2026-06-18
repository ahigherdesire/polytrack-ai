# Haoyuone Training Reset And JSON Guide

This guide is for the Raspberry Pi copy of the project:

```bash
~/polytrack-ai
```

The track is:

```bash
tracks/haoyuone.json
```

The keyboard replay JSON is:

```bash
data/es_lap.haoyuone.json
```

## 1. Check The Current Lap JSON

Run this on the Raspberry Pi:

```bash
cd ~/polytrack-ai
node -e "const x=require('./data/es_lap.haoyuone.json'); console.log('kind=',x.kind,'finishSeconds=',x.finishSeconds,'frames=',x.frames,'actions=',x.actions?.length,'reward=',x.bestReward)"
```

Good output should look like this:

```text
kind= fastestFinish finishSeconds= 8.xxx frames= ... actions= ... reward= ...
```

If `finishSeconds` is `null`, that JSON is not a finishing keyboard replay.

## 2. Back Up Current Progress

Do this before deleting anything:

```bash
cd ~/polytrack-ai
backup="data/backup-haoyuone-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp data/*haoyuone*.json "$backup"/ 2>/dev/null
echo "Backed up to $backup"
```

## 3. Reset All Haoyuone Progress

Stop training and dashboard first:

```bash
cd ~/polytrack-ai
pkill -f "train/es_parallel.js"
pkill -f "train/dashboard.js"
```

Delete the learned files for this map:

```bash
rm -f data/policy.haoyuone.json
rm -f data/policy.current.haoyuone.json
rm -f data/es_lap.haoyuone.json
```

This resets:

```text
best policy
current generation policy
keyboard replay lap
```

It does not delete the track file:

```bash
tracks/haoyuone.json
```

## 4. Start Fresh Training

Run this on the Raspberry Pi:

```bash
cd ~/polytrack-ai
TRACK=tracks/haoyuone.json node train/es_parallel.js 1000000 24 16000 3 > train-haoyuone.log 2>&1 &
```

Check that it started:

```bash
tail -f train-haoyuone.log
```

Press `Ctrl+C` to stop watching the log. This does not stop training.

## 5. Start The Dashboard

Run this on the Raspberry Pi:

```bash
cd ~/polytrack-ai
TRACK=tracks/haoyuone.json node train/dashboard.js train-haoyuone.log 7780
```

If port `7780` is already used:

```bash
pkill -f "train/dashboard.js"
TRACK=tracks/haoyuone.json node train/dashboard.js train-haoyuone.log 7780
```

## 5A. Start The Click Control UI

The control UI lets you pick a track, start/stop training, start/stop the dashboard,
reset progress, and download the lap JSON from a web page.

The file is:

```bash
~/polytrack-ai/train/control_panel.js
```

Run this on the Raspberry Pi:

```bash
cd ~/polytrack-ai
node train/control_panel.js 7790
```

Then open this on your Windows computer:

```text
http://raspberrypi5.local:7790
```

To keep the control UI running after closing SSH:

```bash
cd ~/polytrack-ai
nohup node train/control_panel.js 7790 > control-panel.log 2>&1 &
disown
```

The training started from this UI runs in the background and should continue even
if the control UI later stops.

The reset button in this UI does the safe reset:

```text
stop training/dashboard
create a backup folder in data/backup-haoyuone-...
delete policy.haoyuone.json
delete policy.current.haoyuone.json
delete es_lap.haoyuone.json
optionally clear train-haoyuone.log
```

## 6. Get The Finished Keyboard JSON Onto Your Windows PC

The finished keyboard replay is this file on the Raspberry Pi:

```bash
~/polytrack-ai/data/es_lap.haoyuone.json
```

Before copying it, check that it is actually a finishing lap:

```bash
cd ~/polytrack-ai
node -e "const x=require('./data/es_lap.haoyuone.json'); console.log('kind=',x.kind,'finishSeconds=',x.finishSeconds,'finishFrames=',x.finishFrames,'actions=',x.actions?.length)"
```

Good output has a real number for `finishSeconds`:

```text
kind= fastestFinish finishSeconds= 8.xxx finishFrames= 8xxx actions= 8xxx
```

Bad output looks like this:

```text
finishSeconds= null
```

If it says `null`, do not use that file as a finished lap. Keep training until a real finish appears.

Run this on your Windows computer, not inside SSH.

Command Prompt version:

```bat
scp rp5user@raspberrypi5.local:~/polytrack-ai/data/es_lap.haoyuone.json "%USERPROFILE%\Downloads\es_lap.haoyuone.json"
```

PowerShell version:

```powershell
scp rp5user@raspberrypi5.local:~/polytrack-ai/data/es_lap.haoyuone.json "$env:USERPROFILE\Downloads\es_lap.haoyuone.json"
```

The file will be here:

```text
C:\Users\LIXINYUAN\Downloads\es_lap.haoyuone.json
```

That downloaded JSON is the one to use with the lap player.

## 7. If raspberrypi5.local Does Not Work

Find the Pi IP address on the Pi:

```bash
hostname -I
```

Then use the IP from Windows:

```bat
scp rp5user@192.168.x.x:~/polytrack-ai/data/es_lap.haoyuone.json "%USERPROFILE%\Downloads\es_lap.haoyuone.json"
```

Replace `192.168.x.x` with the real IP.

## 8. Use The JSON With The Lap Player

After copying the JSON to Downloads, your replay file is:

```text
C:\Users\LIXINYUAN\Downloads\es_lap.haoyuone.json
```

That is the file containing:

```json
"actions": []
```

Those actions are the keyboard moves:

```json
{ "up": true, "down": false, "left": false, "right": true, "reset": false }
```

## 9. Restore From A Backup

If you backed up before resetting, list backups:

```bash
cd ~/polytrack-ai
ls data/backup-haoyuone-*
```

Restore one backup folder:

```bash
cp data/backup-haoyuone-YYYYMMDD-HHMMSS/* data/
```

Replace `YYYYMMDD-HHMMSS` with the real backup folder name.
