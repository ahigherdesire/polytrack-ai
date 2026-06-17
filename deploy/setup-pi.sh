#!/usr/bin/env bash
# One-time setup for running PolyTrack AI on a Raspberry Pi (Pi OS 64-bit).
# Run from the project root:  bash deploy/setup-pi.sh
set -e

echo "== Installing Node.js 20 LTS (if needed) =="
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 18 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "== No npm dependencies to install (pure Node + built-ins) =="

if [ ! -f data/constants.json ]; then
  echo "!! data/constants.json is MISSING. Copy it from your PC, e.g.:"
  echo "   scp data/constants.json pi@<pi-ip>:~/polytrack-ai/data/"
  exit 1
fi

echo "== Verifying the physics engine runs headless on this Pi =="
node sim/test_determinism062.js

echo
echo "Setup OK. Next:"
echo "  Train:     node train/es_parallel.js 1000000 24 16000 3"
echo "  Dashboard: node train/dashboard.js train3.log 7780   (then http://<pi-ip>:7780)"
echo "  Or install the systemd services in deploy/ to run on boot (see deploy/DEPLOY.md)."
