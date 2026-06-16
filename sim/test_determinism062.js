// Boot the LIVE 0.6.2 worker headless and pass its determinism self-test.
const { Headless062, MSG } = require('./headless062');

(async () => {
  const sim = await new Headless062().init();
  await sim.waitReady();             // physics + embedded wasm + handler install

  sim.send({ messageType: MSG.TestDeterminism });

  // Result may post after a few async hops.
  let result = null;
  for (let i = 0; i < 200 && !result; i++) {
    await Headless062.tick();
    result = sim.outbox.find((m) => m && m.messageType === MSG.DeterminismResult);
  }

  if (!result) { console.error('No DeterminismResult. Outbox:', sim.outbox); process.exit(1); }
  const ok = result.isDeterminstic === true;
  console.log('0.6.2 worker DeterminismResult.isDeterminstic =', result.isDeterminstic);
  console.log(ok ? '✓ Live 0.6.2 physics runs deterministically headless.'
                 : '✗ Determinism failed.');
  process.exit(ok ? 0 : 1);
})();
