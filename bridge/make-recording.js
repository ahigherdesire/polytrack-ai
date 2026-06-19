// Convert an AI lap (es_lap.<track>.json: per-frame {up,down,left,right,reset})
// into PolyTrack 0.6.2's native RECORDING string.
//
// A recording plays at the game's full internal 1000 fps with frame-exact
// inputs — no keyboard, no OS timing drift. It's the same format the game
// stores/validates/submits, so this is the accurate replacement for keyboard
// replay. Validate one with bridge/verify-recording.js before using it.
//
// Format (reverse-engineered from the worker's serialize/deserialize):
//   5 channels in order [up, right, down, left, reset]; each channel is a
//   delta-encoded list of the frames where that key TOGGLES (starting from
//   released): [count: uint24 LE][delta: uint24 LE] * count.
//   Concatenate the 5 channels, zlib-deflate, URL-safe base64 (strip '=').
const zlib = require('zlib');

const ORDER = ['up', 'right', 'down', 'left', 'reset'];

// actions: array of {up,down,left,right,reset}. If the lap's finishFrames is one
// MORE than actions.length, the trainer dropped the initial neutral frame — pass
// prependNeutral:true to insert it (verify-recording figures this out for you).
function actionsToRecording(actions, { prependNeutral = false } = {}) {
  const eff = prependNeutral ? [{}].concat(actions) : actions;
  const channels = Object.fromEntries(ORDER.map((k) => [k, []]));
  const prev = Object.fromEntries(ORDER.map((k) => [k, false]));
  for (let f = 0; f < eff.length; f++) {
    const a = eff[f] || {};
    for (const k of ORDER) {
      const v = !!a[k];
      if (v !== prev[k]) { channels[k].push(f); prev[k] = v; }
    }
  }
  const encChannel = (list) => {
    const buf = Buffer.alloc(3 + 3 * list.length);
    buf[0] = list.length & 255; buf[1] = (list.length >>> 8) & 255; buf[2] = (list.length >>> 16) & 255;
    for (let i = 0; i < list.length; i++) {
      const d = i === 0 ? list[0] : list[i] - list[i - 1];
      buf[3 + 3 * i] = d & 255; buf[3 + 3 * i + 1] = (d >>> 8) & 255; buf[3 + 3 * i + 2] = (d >>> 16) & 255;
    }
    return buf;
  };
  const raw = Buffer.concat(ORDER.map((k) => encChannel(channels[k])));
  const deflated = zlib.deflateSync(raw);            // zlib-wrapped (pako Inflate default)
  return deflated.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

module.exports = { actionsToRecording, ORDER };

// CLI: node bridge/make-recording.js <es_lap.json> [out.txt]
if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) { console.error('usage: node bridge/make-recording.js <es_lap.json> [out.txt]'); process.exit(1); }
  const lap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const prependNeutral = lap.finishFrames === (lap.actions.length + 1);
  const rec = actionsToRecording(lap.actions, { prependNeutral });
  if (process.argv[3]) { fs.writeFileSync(process.argv[3], rec); console.log('wrote', process.argv[3], `(${rec.length} chars, prependNeutral=${prependNeutral})`); }
  else console.log(rec);
}
