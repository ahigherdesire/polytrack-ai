// ES worker: loads its own headless sim once, then evaluates batches of
// candidate weight vectors sent by the main process.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { Headless062 } = require('../sim/headless062');
const { setupTrack, makeEvaluate } = require('./evaluator');

(async () => {
  const payload = JSON.parse(fs.readFileSync(workerData.constants, 'utf8'));
  const sim = await new Headless062().init();
  await sim.waitReady();
  sim.loadCar(payload.init, payload.createCar);
  const { cps, start, occ, guide } = setupTrack(sim, { track: workerData.constants });
  const evaluate = makeEvaluate(sim, cps, start, occ, guide);

  parentPort.postMessage({ type: 'ready', cps: cps.length, guidePoints: guide ? guide.points.length : 0 });

  parentPort.on('message', (msg) => {
    if (msg.type === 'eval') {
      const results = msg.batch.map(({ id, weights, maxf }) => {
        const r = evaluate(Float64Array.from(weights), maxf, false);
        return { id, reward: r.reward, maxCp: r.maxCp, finish: r.finish };
      });
      parentPort.postMessage({ type: 'result', results });
    } else if (msg.type === 'record') {
      // Re-run a single weight vector and return the full action sequence.
      const r = evaluate(Float64Array.from(msg.weights), msg.maxf, true);
      parentPort.postMessage({ type: 'recorded', maxCp: r.maxCp, finish: r.finish, actions: r.actions });
    }
  });
})().catch((e) => { parentPort.postMessage({ type: 'error', error: String(e) }); });
