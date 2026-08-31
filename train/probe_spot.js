// Probe the guidance field around the greedy-driver stall spot.
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

  // checkpoints geometry
  console.log('checkpoints:');
  g.checkpoints.forEach((c,i)=>console.log(`  cp${i} center=(${c.center.map(v=>v.toFixed(0)).join(',')}) half=(${c.half.map(v=>v.toFixed(0)).join(',')})`));
  g.finishes.forEach((c,i)=>console.log(`  finish${i} center=(${c.center.map(v=>v.toFixed(0)).join(',')})`));

  // Probe a grid around the stall spot (28,-13), y~? we saw y not printed; use nearest road y.
  const probe = (x,z,cp)=>{
    // find any road cell near (x,*,z)
    const ps=g.ps;
    let bestY=null;
    for (const c of g.cells){ if(Math.abs((c[0]+.5)*ps-x)<ps && Math.abs((c[2]+.5)*ps-z)<ps){ bestY=(c[1]+.5)*ps; break; } }
    if(bestY==null) return `(${x},${z}) NO ROAD CELL`;
    const pot=g.potential(x,bestY,z,cp);
    const cap=g.speedCap(x,bestY,z,cp);
    const rt=g.routeTarget(x,bestY,z,cp,15);
    return `(${x},${z},y${bestY.toFixed(0)}) cp${cp} pot=${pot.toFixed(0)} cap=${cap.toFixed(0)} routeTarget=${rt?('('+rt.map(v=>v.toFixed(0)).join(',')+')'):'null'}`;
  };
  console.log('\nprobe around stall (cp index 1):');
  for(let dz=-6; dz<=6; dz+=3) for(let dx=-6; dx<=6; dx+=3){
    console.log('  '+probe(28+dx, -13+dz, 1));
  }

  // Is there road under (28,-13)? scan y column
  const ps=g.ps;
  console.log('\nroad cells near x=28,z=-13 (any y):');
  const near=g.cells.filter(c=>Math.abs((c[0]+.5)*ps-28)<6 && Math.abs((c[2]+.5)*ps+13)<6);
  const ys=[...new Set(near.map(c=>Math.round((c[1]+.5)*ps)))].sort((a,b)=>a-b);
  console.log('  count',near.length,'y-levels', ys.join(','));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
