// Batch-fetch the rank-1 (world record) recording for many tracks at once.
// For each { trackName: trackId } it: fetches the WR, decodes it, simulates it on
// tracks/<name>.json to confirm it finishes + find the exact finish frame, and writes
// data/grabbed/<name>_wr.json (ready to play / optimize).
//
// Usage: node bridge/fetch-batch.js data/summer_tracks.json
const fs = require('fs');
const path = require('path');
const { fetchByTrack } = require('./fetch-recording');
const { Headless062 } = require('../sim/headless062');

(async () => {
  const mapFile = process.argv[2] || 'data/summer_tracks.json';
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  fs.mkdirSync('data/grabbed', { recursive: true });

  for (const [name, trackId] of Object.entries(map)) {
    const trackPath = path.join('tracks', name + '.json');
    if (!trackId || /paste/i.test(trackId)) { console.log(`${name.padEnd(7)} - no trackId, skip`); continue; }
    if (!fs.existsSync(trackPath)) { console.log(`${name.padEnd(7)} - no track file ${trackPath}, skip`); continue; }

    let r;
    try { r = await fetchByTrack(trackId, 1); }
    catch (e) { console.log(`${name.padEnd(7)} - fetch ERROR: ${e.message}`); continue; }

    // simulate on the matching track to confirm it finishes + get the exact finish frame
    const track = JSON.parse(fs.readFileSync(trackPath, 'utf8'));
    const sim = await new Headless062().init(); await sim.waitReady();
    sim.loadCar(track.init, track.createCar); sim.reset();
    let fin = null;
    for (let f = 0; f < r.actions.length; f++) { const s = sim.step(r.actions[f]); if (!s) break; if (s.finishFrames !== null) { fin = s.finishFrames; break; } }
    const ff = fin || r.frames;

    const out = { kind: 'fetchedRecording', nickname: r.nickname, finishFrames: ff, finishSeconds: ff / 1000, frames: r.frames, recordingId: r.recordingId, recording: r.recording, actions: r.actions };
    const outPath = path.join('data', 'grabbed', name + '_wr.json');
    fs.writeFileSync(outPath, JSON.stringify(out));
    console.log(`${name.padEnd(7)} ${String(r.nickname).padEnd(16)} ${(ff / 1000).toFixed(3)}s  ${fin ? 'finish OK' : 'NO-FINISH ✗'}  -> ${name}_wr.json`);
  }
  console.log('\ndone.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
