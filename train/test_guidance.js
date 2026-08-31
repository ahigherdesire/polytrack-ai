// Quick sanity check for the geodesic guidance field.
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { buildOccupancy } = require('../sim/track_sensors');
const { Guidance } = require('./guidance');

(async () => {
  const file = process.env.TRACK ? path.resolve(process.env.TRACK) : path.resolve(__dirname, '..', 'data', 'constants.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const init = payload.init || payload;
  const createCar = payload.createCar;
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(init, createCar);
  const start = sim.rollout([{ up: false }]).last.position;
  const occ = buildOccupancy(sim._parts, sim._trackPartConfigs, { baseY: start.y });

  const t0 = Date.now();
  const g = new Guidance(sim._parts, sim._trackPartConfigs, occ);
  g.buildPotentials();
  const buildMs = Date.now() - t0;

  console.log('cells:', g.cells.length, 'checkpoints:', g.checkpointCount, 'finishes:', g.finishes.length);
  console.log('build time:', buildMs, 'ms');
  console.log('potentialChain:', Array.from(g.potentialChain).map((x) => x.toFixed(0)));

  // Drive straight (hold accelerate) and watch the potential fall.
  sim.reset();
  let s = sim.step({ up: false });
  console.log('\nframe  cp   pot     cap  speed   pos');
  for (let f = 0; f < 4000; f++) {
    s = sim.step({ up: true });
    if (!s) break;
    if (f % 400 === 0) {
      const pot = g.potential(s.position.x, s.position.y, s.position.z, s.nextCheckpointIndex);
      const cap = g.speedCap(s.position.x, s.position.y, s.position.z, s.nextCheckpointIndex);
      console.log(
        String(f).padStart(5),
        String(s.nextCheckpointIndex).padStart(3),
        pot.toFixed(1).padStart(7),
        cap.toFixed(0).padStart(4),
        s.speedKmh.toFixed(0).padStart(5),
        `(${s.position.x.toFixed(0)}, ${s.position.y.toFixed(0)}, ${s.position.z.toFixed(0)})`,
      );
    }
    if (s.finishFrames !== null) { console.log('FINISHED at', s.finishFrames); break; }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
