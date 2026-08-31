// Trace the geodesic route the guidance wants for the cp0->cp1 leg (potential
// map index 1) from the car's actual stall region to the goal, printing the
// elevation profile so we can see if the field tunnels up a wall.
'use strict';
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { buildOccupancy } = require('../sim/track_sensors');
const { Guidance } = require('./guidance');

(async () => {
  const file = path.resolve(__dirname, '..', 'data', 'constants.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init || payload, payload.createCar);
  const occ = buildOccupancy(sim._parts, sim._trackPartConfigs);
  const g = new Guidance(sim._parts, sim._trackPartConfigs, occ);
  g.buildPotentials();
  const ps = g.ps;
  const MAP = 1; // cp0 -> cp1 leg
  const dist = g.potentialMaps[MAP].dist;

  // start cell: nearest to the region the car reached (~x=73) heading to cp1
  const startCell = g._nearestCell(73, 0, -7);
  console.log('CELL size', ps.toFixed(2));
  console.log('trace geodesic descent (map=cp0->cp1) from ~(73,?,-7):\n');
  let cell = startCell, steps = 0;
  let prev = null;
  console.log(' step   x     y     z    dist   dλ(y)');
  while (steps < 400) {
    const c = g.cells[cell];
    const x = (c[0]+0.5)*ps, y = (c[1]+0.5)*ps, z = (c[2]+0.5)*ps;
    const dy = prev ? (y - prev.y) : 0;
    if (steps % 3 === 0 || Math.abs(dy) > ps*0.9)
      console.log(String(steps).padStart(5), x.toFixed(0).padStart(5), y.toFixed(1).padStart(6), z.toFixed(0).padStart(5), dist[cell].toFixed(0).padStart(6), (dy>0?'+':'')+dy.toFixed(1));
    prev = { x, y, z };
    // descend to min-dist neighbour
    const list = g._nbr[cell];
    let best = -1, bestD = dist[cell];
    for (let i = 0; i < list.length; i += 3) { const j = list[i]; if (dist[j] < bestD) { bestD = dist[j]; best = j; } }
    if (best < 0) { console.log('  (no downhill neighbour — reached goal or dead end)'); break; }
    // report big vertical steps as suspicious
    cell = best; steps++;
    if (dist[cell] === 0) { console.log('  reached cp1 box at step', steps); break; }
  }

  // Also: is there a drivable neighbour link that climbs >1 cell here? list them near the stall.
  console.log('\nvertical links (dy>=2 cells) among road cells with x in [0,90], z in [-30,10]:');
  let count = 0;
  for (let i = 0; i < g.cells.length && count < 25; i++) {
    const c = g.cells[i];
    const x=(c[0]+0.5)*ps, z=(c[2]+0.5)*ps;
    if (x<0||x>90||z<-30||z>10) continue;
    const list = g._nbr[i];
    for (let k = 0; k < list.length; k += 3) {
      const dyCells = list[k+2];
      if (dyCells >= 2) {
        const j = list[k]; const d = g.cells[j];
        console.log(`  (${x.toFixed(0)},${(c[1]+0.5)*ps},${z.toFixed(0)}) -> (${(d[0]+0.5)*ps},${(d[1]+0.5)*ps},${(d[2]+0.5)*ps})  dyCells=${dyCells}`);
        count++;
      }
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
