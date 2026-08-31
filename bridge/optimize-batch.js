// Batch-optimize: run the TAS hill-climber on every track's WR in a map, one after
// another, saving <name>_best.json each. Prints a summary of gains vs each WR.
//
// Usage: node bridge/optimize-batch.js data/summer_tracks.json [itersEach=2000]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const mapFile = process.argv[2] || 'data/summer_tracks.json';
const iters = process.argv[3] || '2000';
const names = Object.keys(JSON.parse(fs.readFileSync(mapFile, 'utf8')));

function run(name) {
  return new Promise((res) => {
    const wr = path.join('data', 'grabbed', name + '_wr.json');
    const track = path.join('tracks', name + '.json');
    const best = path.join('data', 'grabbed', name + '_best.json');
    if (!fs.existsSync(wr) || !fs.existsSync(track)) { console.log(`${name}: missing wr/track, skip`); return res(); }
    console.log(`\n===== optimizing ${name} (${iters} iters) =====`);
    const p = spawn(process.execPath, ['bridge/optimize-lap.js', wr, track, iters, best], { stdio: 'inherit' });
    p.on('exit', () => res());
  });
}

(async () => {
  for (const n of names) await run(n);
  console.log('\n================ SUMMARY ================');
  for (const n of names) {
    const wrP = path.join('data', 'grabbed', n + '_wr.json');
    const bestP = path.join('data', 'grabbed', n + '_best.json');
    if (!fs.existsSync(wrP) || !fs.existsSync(bestP)) continue;
    const w = JSON.parse(fs.readFileSync(wrP)).finishFrames;
    const b = JSON.parse(fs.readFileSync(bestP)).finishFrames;
    const d = w - b;
    console.log(`${n.padEnd(7)} WR ${(w / 1000).toFixed(3)}s -> best ${(b / 1000).toFixed(3)}s  ${d > 0 ? `(-${(d / 1000).toFixed(3)}s beat WR!)` : '(no gain)'}`);
  }
  process.exit(0);
})();
