// Replay data/locked_dump.json (mask blocks the solver has locked) through the
// sim and log detailed state, so we can watch exactly what the car hits.
'use strict';
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { buildOccupancy } = require('../sim/track_sensors');
const { Guidance } = require('./guidance');
const { maskToControls } = require('./mcts_solver');

const DEC = 20;

(async () => {
  const p = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'constants.json'), 'utf8'));
  const blocks = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'locked_dump.json'), 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(p.init || p, p.createCar);
  const occ = buildOccupancy(sim._parts, sim._trackPartConfigs);
  const g = new Guidance(sim._parts, sim._trackPartConfigs, occ);
  g.buildPotentials();

  console.log(`replaying ${blocks.length} blocks (${(blocks.length * DEC / 1000).toFixed(2)}s)`);
  sim.reset();
  let s = sim.stepMask(0);
  let f = 0, minSpeedTail = 999, prevx = s.position.x;
  console.log('frame    x      y     z   speed wheels cp   cap   mask');
  for (let bi = 0; bi < blocks.length; bi++) {
    const mask = blocks[bi];
    for (let k = 0; k < DEC; k++) { s = sim.stepMask(mask); f++; if (!s) break; }
    if (!s) { console.log('null at block', bi); break; }
    const x = s.position.x, y = s.position.y, z = s.position.z;
    // log densely in the crash zone (x in [-90,10]) or the last 40 blocks
    const inZone = (x < 10 && x > -90);
    const nearEnd = bi > blocks.length - 40;
    if (inZone || nearEnd) {
      const wheels = s.wheelContact ? s.wheelContact.filter(Boolean).length : '?';
      const cap = g.speedCap(x, y, z, s.nextCheckpointIndex);
      const c = maskToControls(mask);
      console.log(String(f).padStart(5), x.toFixed(1).padStart(6), y.toFixed(1).padStart(6), z.toFixed(1).padStart(5),
        s.speedKmh.toFixed(0).padStart(5), String(wheels).padStart(5), String(s.nextCheckpointIndex).padStart(3), cap.toFixed(0).padStart(5),
        '  ' + ['U', c.right ? 'R' : '.', c.down ? 'D' : '.', c.left ? 'L' : '.'].join(''));
    }
    if (s.finishFrames !== null) { console.log('FINISH', s.finishFrames); break; }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
