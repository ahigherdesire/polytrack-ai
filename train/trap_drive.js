// Physically drive the greedy policy and log detailed state through the trap
// region (x in [-10, 95]) to see what actually happens: launch, fall, wall.
'use strict';
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { buildOccupancy } = require('../sim/track_sensors');
const { Guidance } = require('./guidance');
const { WindowedMcts } = require('./mcts_solver');

(async () => {
  const p = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'constants.json'), 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(p.init || p, p.createCar);
  const occ = buildOccupancy(sim._parts, sim._trackPartConfigs);
  const g = new Guidance(sim._parts, sim._trackPartConfigs, occ);
  g.buildPotentials();
  const mcts = new WindowedMcts(sim, g, {});

  sim.reset();
  let s = sim.stepMask(0);
  let px = s.position.x, pz = s.position.z;
  console.log('frame    x     y     z   speed  wheels  cp   cap   mask');
  let inTrap = false, logged = 0;
  for (let f = 0; f < 20000; f++) {
    const st = mcts._flat(s);
    const mask = mcts._steerMask(st, px, pz);
    px = s.position.x; pz = s.position.z;
    s = sim.stepMask(mask);
    if (!s) { console.log('null at', f); break; }
    const x = s.position.x, y = s.position.y, z = s.position.z;
    const near = x < 95 && x > -15;
    if (near) inTrap = true;
    if (inTrap && f % 60 === 0 && logged < 120) {
      const wheels = s.wheelContact ? s.wheelContact.filter(Boolean).length : '?';
      const cap = g.speedCap(x, y, z, s.nextCheckpointIndex);
      console.log(String(f).padStart(5), x.toFixed(0).padStart(5), y.toFixed(1).padStart(6), z.toFixed(0).padStart(5),
        s.speedKmh.toFixed(0).padStart(6), String(wheels).padStart(5), String(s.nextCheckpointIndex).padStart(4), cap.toFixed(0).padStart(5),
        '  '+['U',mask&2?'R':'.',mask&4?'D':'.',mask&8?'L':'.'].join(''));
      logged++;
    }
    if (s.finishFrames !== null) { console.log('FINISH', s.finishFrames); break; }
    if (x < -20) { console.log('passed trap westward, x<-20 at frame', f); break; }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
