// Pure-pursuit finishing driver: steer toward the next checkpoint (world coords
// = grid*5), accelerate, ease off in sharp turns. Auto-calibrates the car's
// forward axis and steering sign from short test runs. Produces a finishing
// input sequence if it gets around.
//
// Usage: node train/pursuit_driver.js [data/constants.json] [maxFrames]
const fs = require('fs');
const path = require('path');
const { Headless062 } = require('../sim/headless062');
const { gridToWorld, horizForward } = require('../sim/geom');

const sub = (a, b) => ({ x: a.x - b.x, z: a.z - b.z });
const norm = (v) => { const n = Math.hypot(v.x, v.z) || 1; return { x: v.x / n, z: v.z / n }; };
const cross = (a, b) => a.x * b.z - a.z * b.x;   // y-component of a x b
const dot = (a, b) => a.x * b.x + a.z * b.z;

(async () => {
  const file = process.argv[2] || path.resolve(__dirname, '..', 'data', 'constants.json');
  const maxFrames = parseInt(process.argv[3] || '40000', 10);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init, payload.createCar);

  const cps = sim.checkpoints().map((c) => ({ ...c, world: gridToWorld(c.grid) }));
  const startWorld = sim.rollout([{ up: false }]).last.position;
  console.log('checkpoints (world):', cps.map((c) => `#${c.order}(${c.world.x},${c.world.y},${c.world.z})`).join(' '));

  // --- Calibrate local forward axis: drive straight, see which axis matches motion.
  const cand = [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }];
  let traj = sim.rollout(Array.from({ length: 150 }, () => ({ up: true })));
  const q0 = traj.last.quaternion;
  const motion = norm(sub(traj.last.position, startWorld));   // world direction travelled
  let localFwd = cand[0], bestDot = -2;
  for (const c of cand) { const f = horizForward(q0, c); const d = dot(f, motion); if (d > bestDot) { bestDot = d; localFwd = c; } }
  console.log('calibrated localFwd =', JSON.stringify(localFwd), 'matchDot=', bestDot.toFixed(2));

  // --- Calibrate steering sign: does 'left' input rotate forward toward +cross or -cross?
  const fb = horizForward(traj.last.quaternion, localFwd);
  const tl = sim.rollout(Array.from({ length: 150 }, (_, i) => (i < 150 ? { up: true } : {})).concat(
    Array.from({ length: 120 }, () => ({ up: true, left: true }))));
  const fa = horizForward(tl.last.quaternion, localFwd);
  const leftSign = Math.sign(cross(fb, fa)) || 1;   // sign of cross when pressing 'left'
  console.log('leftSign =', leftSign);

  // --- Pure-pursuit drive.
  sim.reset();
  const actions = [];
  let finishFrames = null, lastCp = 0;
  for (let f = 0; f < maxFrames; f++) {
    const s = f === 0 ? sim.step({ up: true }) : sim.step(actions[actions.length - 1] || { up: true });
    if (!s) break;
    const idx = s.nextCheckpointIndex;
    const target = idx < cps.length ? cps[idx].world : startWorld;     // after last cp, head to finish line (start)
    const fwd = horizForward(s.quaternion, localFwd);
    const toT = norm(sub(target, s.position));
    const turn = cross(fwd, toT);                 // >0 or <0 => need to rotate that way
    const align = dot(fwd, toT);

    const act = {};
    // steer toward target: press the input whose leftSign matches the needed turn
    if (Math.abs(turn) > 0.05) {
      const wantLeft = Math.sign(turn) === leftSign;
      if (wantLeft) act.left = true; else act.right = true;
    }
    // throttle: accelerate when roughly aligned; brake/reorient when facing away
    if (align > -0.2) act.up = true; else act.down = true;
    actions.push(act);

    if (s.nextCheckpointIndex > lastCp) { lastCp = s.nextCheckpointIndex; console.log(`  passed checkpoint -> next=${lastCp} at frame ${s.frames} pos=(${s.position.x.toFixed(0)},${s.position.z.toFixed(0)})`); }
    if (f % 1000 === 0) console.log(`f=${String(f).padStart(5)} cp=${idx} pos=(${s.position.x.toFixed(0)},${s.position.z.toFixed(0)}) v=${s.speedKmh.toFixed(0)} align=${align.toFixed(2)} turn=${turn.toFixed(2)}`);
    if (s.finishFrames !== null) { finishFrames = s.finishFrames; break; }
  }

  console.log('\n--- result ---');
  console.log('checkpoints reached:', lastCp, '/', cps.length);
  console.log('finishFrames:', finishFrames, finishFrames !== null ? `( ${(finishFrames / 1000).toFixed(3)} s )` : '(did not finish)');
  if (finishFrames !== null) {
    const out = path.resolve(__dirname, '..', 'data', 'summer1_pursuit.json');
    fs.writeFileSync(out, JSON.stringify({ finishFrames, actions }));
    console.log('saved ->', out);
  }
})().catch((e) => { console.error(e); process.exit(1); });
