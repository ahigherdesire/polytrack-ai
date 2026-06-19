// Validate that a recording built from an AI lap reproduces the exact finish,
// using the GAME'S OWN Verify (the same check the leaderboard runs).
//
// Usage: node bridge/verify-recording.js <es_lap.json> <track.json> [out.txt]
//   defaults: track = tracks/haoyuone.json
const fs = require('fs');
const path = require('path');
const { Headless062, MSG } = require('../sim/headless062');
const { actionsToRecording } = require('./make-recording');

const f32 = (a) => Float32Array.from(a);

(async () => {
  const lapFile = process.argv[2];
  const trackFile = process.argv[3] || path.resolve(__dirname, '..', 'tracks', 'haoyuone.json');
  if (!lapFile) { console.error('usage: node bridge/verify-recording.js <es_lap.json> [track.json] [out.txt]'); process.exit(1); }
  const lap = JSON.parse(fs.readFileSync(lapFile, 'utf8'));
  const track = JSON.parse(fs.readFileSync(trackFile, 'utf8'));
  const init = track.init, cc = track.createCar;
  console.log(`lap: kind=${lap.kind} finishFrames=${lap.finishFrames} actions=${lap.actions.length}`);

  const sim = await new Headless062().init();
  await sim.waitReady();

  // Init: register track parts + car collision shape (needed by Verify).
  sim.send({
    messageType: MSG.Init, version: '0.6.2', isRealtime: false,
    trackParts: init.trackParts.map((p) => ({ id: p.id, vertices: f32(p.vertices), detector: p.detector, startOffset: p.startOffset })),
    carCollisionShapeVertices: f32(init.carCollisionShapeVertices),
    carMassOffset: init.carMassOffset,
  });
  await Headless062.tick();

  const verify = (recording, targetFrames, carId) => {
    sim.outbox.length = 0;
    sim.send({
      messageType: MSG.Verify, carId,
      trackData: cc.trackData, carRecording: recording,
      mountainVertices: f32(cc.mountainVertices), mountainOffset: cc.mountainOffset,
      targetFrames,
    });
    const r = sim.outbox.find((m) => m && m.messageType === MSG.VerifyResult);
    return r ? r.result : undefined;
  };

  // Try the natural interpretation and the "missing neutral frame" fixup.
  const candidates = [
    { label: 'prependNeutral=false @finishFrames', prepend: false, target: lap.finishFrames },
    { label: 'prependNeutral=true  @finishFrames', prepend: true, target: lap.finishFrames },
  ];
  let good = null, carId = 1;
  for (const c of candidates) {
    const rec = actionsToRecording(lap.actions, { prependNeutral: c.prepend });
    const res = verify(rec, c.target, carId++);
    console.log(`  ${c.label}: Verify -> ${res}`);
    if (res === true && !good) good = { ...c, rec };
  }

  if (good) {
    console.log(`\n✓ VALID recording (${good.label}). The game accepts it as a frame-exact ${(lap.finishFrames / 1000).toFixed(3)}s lap.`);
    const out = process.argv[4] || lapFile.replace(/\.json$/, '') + '.recording.txt';
    fs.writeFileSync(out, good.rec);
    console.log(`recording (${good.rec.length} chars) -> ${out}`);
  } else {
    console.log('\n✗ No candidate verified. The lap/track may not match, or the frame offset differs.');
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
