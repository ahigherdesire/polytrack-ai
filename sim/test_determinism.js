// Milestone 1: run the game's own determinism self-test headless.
// This builds a full raycast-vehicle world inside the worker and checks the
// Bullet results are bit-exact. If it passes, our headless physics matches the
// browser and sim->real input transfer is sound.
const { HeadlessSim, MSG } = require('./headless');

(async () => {
  const sim = await new HeadlessSim().init();
  // Let Ammo().then(...) install the real onmessage handler.
  await HeadlessSim.tick();

  sim.send({ messageType: MSG.TestDeterminism });
  await HeadlessSim.tick();

  const result = sim.outbox.find(
    (m) => m && m.messageType === MSG.DeterminismResult
  );

  if (!result) {
    console.error('No DeterminismResult received. Outbox:', sim.outbox);
    process.exit(1);
  }
  console.log('DeterminismResult.isDeterminstic =', result.isDeterminstic);
  if (result.isDeterminstic === true) {
    console.log('✓ Headless physics is deterministic and matches the game.');
    process.exit(0);
  } else {
    console.error('✗ Determinism check failed.');
    process.exit(1);
  }
})();
