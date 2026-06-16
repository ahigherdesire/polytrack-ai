// Milestone 3 check: load a captured track/car payload and drive a car headless.
// Usage: node sim/run_car.js [data/track1.json] [maxFrames]
const fs = require('fs');
const path = require('path');
const { HeadlessSim } = require('./headless');

(async () => {
  const file = process.argv[2] || path.resolve(__dirname, '..', 'data', 'track1.json');
  const maxFrames = parseInt(process.argv[3] || '20000', 10);
  if (!fs.existsSync(file)) {
    console.error('Payload not found:', file,
      '\nCapture one with bridge/capture_payloads.js (see README).');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));

  const sim = await new HeadlessSim().init();
  await HeadlessSim.tick();           // let the worker's handler/loop come up
  await sim.loadCar(payload);

  // Simple policy: hold accelerate. Just to prove the car moves & finishes.
  const t0 = process.hrtime.bigint();
  let last = null, frames = 0;
  for (let f = 0; f < maxFrames; f++) {
    const s = sim.step({ up: true });
    if (!s) break;
    last = s; frames++;
    if (s.finishFrames !== null) break;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (!last) { console.error('No state produced — check payload fields.'); process.exit(1); }
  console.log('frames simulated :', frames);
  console.log('sim wall time    :', ms.toFixed(1), 'ms');
  console.log('throughput       :', (frames / (ms / 1000)).toFixed(0), 'frames/s',
    `(~${(frames / (ms / 1000) / 1000).toFixed(0)}x real-time)`);
  console.log('final speed km/h :', last.speedKmh.toFixed(1));
  console.log('final position   :', last.position.x.toFixed(2), last.position.y.toFixed(2), last.position.z.toFixed(2));
  console.log('next checkpoint  :', last.nextCheckpointIndex);
  console.log('finishFrames     :', last.finishFrames,
    last.finishFrames !== null ? `( ${(last.finishFrames / 1000).toFixed(3)} s )` : '(did not finish)');
})();
