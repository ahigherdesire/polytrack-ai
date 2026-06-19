// Decode a PolyTrack 0.6.2 recording string back into per-frame inputs.
// This is how you "copy" any player's lap WITHOUT reading the screen: the game
// stores every leaderboard time as a recording (the exact inputs). Grab the
// recording string (see grab-recording.js) and decode it here -> frame-exact
// {up,down,left,right,reset} per frame. Inverse of make-recording.js.
const zlib = require('zlib');

const ORDER = ['up', 'right', 'down', 'left', 'reset'];

// recording: the base64url string. frames (optional): pad the output to this many
// frames (e.g. the leaderboard 'frames'); otherwise stops after the last toggle.
function recordingToActions(recording, { frames } = {}) {
  let b64 = recording.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const raw = zlib.inflateSync(Buffer.from(b64, 'base64'));   // zlib (pako Deflate)

  // Parse 5 channels: [count:uint24 LE][delta:uint24 LE]*count, delta-encoded
  // absolute toggle-frames (state flips at each listed frame, starting released).
  const channels = {}; let off = 0;
  for (const k of ORDER) {
    if (off + 3 > raw.length) throw new Error('recording truncated');
    const count = raw[off] | (raw[off + 1] << 8) | (raw[off + 2] << 16); off += 3;
    const list = new Array(count); let prev = 0;
    for (let i = 0; i < count; i++) {
      const d = raw[off] | (raw[off + 1] << 8) | (raw[off + 2] << 16); off += 3;
      prev = i === 0 ? d : prev + d;
      list[i] = prev;
    }
    channels[k] = list;
  }

  let maxF = 0;
  for (const k of ORDER) { const l = channels[k]; if (l.length) maxF = Math.max(maxF, l[l.length - 1]); }
  const N = frames || (maxF + 1);

  const idx = {}, state = {};
  for (const k of ORDER) { idx[k] = 0; state[k] = false; }
  const actions = new Array(N);
  for (let f = 0; f < N; f++) {
    for (const k of ORDER) {
      while (idx[k] < channels[k].length && channels[k][idx[k]] <= f) { state[k] = !state[k]; idx[k]++; }
    }
    actions[f] = { up: state.up, down: state.down, left: state.left, right: state.right, reset: state.reset };
  }
  return { actions, toggles: channels, frames: N };
}

module.exports = { recordingToActions, ORDER };

// CLI: node bridge/decode-recording.js <recording.txt|string> [frames] [out.json]
if (require.main === module) {
  const fs = require('fs');
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node bridge/decode-recording.js <recording.txt|string> [frames] [out.json]'); process.exit(1); }
  const rec = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg;
  const frames = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
  const { actions, toggles } = recordingToActions(rec, { frames });
  console.error(`decoded ${actions.length} frames; toggles per key:`, Object.fromEntries(ORDER.map((k) => [k, toggles[k].length])));
  const out = process.argv[4];
  const payload = { kind: 'decodedRecording', frames: actions.length, actions };
  if (out) { fs.writeFileSync(out, JSON.stringify(payload)); console.error('wrote', out); }
  else process.stdout.write(JSON.stringify(payload));
}
