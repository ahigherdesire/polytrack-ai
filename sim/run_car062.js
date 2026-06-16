// Drive a real 0.6.2 car headless on a captured track (default: Summer 1).
// Usage: node sim/run_car062.js [data/constants.json] [maxFrames]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('./headless062');

(async () => {
  const file = process.argv[2] || path.resolve(__dirname, '..', 'data', 'constants.json');
  const maxFrames = parseInt(process.argv[3] || '60000', 10);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!payload.init || !payload.createCar) {
    console.error('Need a capture with both init and createCar:', file);
    process.exit(1);
  }

  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init, payload.createCar);

  const t0 = process.hrtime.bigint();
  let last = null, frames = 0;
  const samples = [];
  for (let fnum = 0; fnum < maxFrames; fnum++) {
    const s = sim.step({ up: true });          // hold accelerate
    if (!s) break;
    last = s; frames++;
    if (frames <= 5 || frames % 500 === 0) samples.push(s);
    if (s.finishFrames !== null) break;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (!last) { console.error('No state produced — payload/decoue issue.'); process.exit(1); }

  console.log('--- trajectory (holding accelerate) ---');
  for (const s of samples) {
    console.log(
      `f=${String(s.frames).padStart(5)}  ` +
      `pos=(${s.position.x.toFixed(2)}, ${s.position.y.toFixed(2)}, ${s.position.z.toFixed(2)})  ` +
      `v=${s.speedKmh.toFixed(1)}km/h  cp=${s.nextCheckpointIndex}  ` +
      `wheels=${s.wheelContact.filter(Boolean).length}/4`);
  }
  console.log('--- summary ---');
  console.log('frames simulated :', frames);
  console.log('wall time        :', ms.toFixed(1), 'ms');
  console.log('throughput       :', (frames / (ms / 1000)).toFixed(0), 'frames/s',
    `(~${(frames / (ms / 1000) / 1000).toFixed(1)}x real-time)`);
  console.log('finishFrames     :', last.finishFrames,
    last.finishFrames !== null ? `( ${(last.finishFrames / 1000).toFixed(3)} s )` : '(did not finish)');
})();
