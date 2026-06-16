// PolyTrack payload capture — paste into the browser DevTools console while
// the game is open (app.polytrack.com / the local copy), BEFORE loading a track.
//
// It hooks the Worker message channel and records the exact data the main
// thread sends to simulation_worker.bundle.js: the Init (trackParts) and
// CreateCar (trackData, carCollisionShapeVertices, carMassOffset,
// mountainVertices/offset) payloads. Drive one lap of the target track, then
// call __polyDump() to download a JSON the headless sim can replay bit-exact.
(() => {
  const captured = { init: null, createCar: null, all: [] };

  const OrigWorker = window.Worker;
  window.Worker = function (url, opts) {
    const w = new OrigWorker(url, opts);
    const origPost = w.postMessage.bind(w);
    w.postMessage = function (msg, transfer) {
      try {
        // messageType enum: Init=0, Verify=1, CreateCar=3 ...
        if (msg && typeof msg === 'object') {
          if (msg.messageType === 0) captured.init = structuredCloneSafe(msg);
          if (msg.messageType === 3) captured.createCar = structuredCloneSafe(msg);
          captured.all.push(msg.messageType);
        }
      } catch (e) { /* ignore */ }
      return origPost(msg, transfer);
    };
    return w;
  };
  window.Worker.prototype = OrigWorker.prototype;

  function structuredCloneSafe(o) {
    // Typed arrays -> plain arrays so they survive JSON.
    return JSON.parse(JSON.stringify(o, (k, v) =>
      ArrayBuffer.isView(v) ? Array.from(v) : v));
  }

  window.__polyDump = function (name = 'polytrack_payload') {
    const blob = new Blob([JSON.stringify(captured, null, 0)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.json';
    a.click();
    console.log('Dumped. Init:', !!captured.init, 'CreateCar:', !!captured.createCar);
  };

  console.log('[polytrack-capture] hooked. Load a track, then run __polyDump("track1").');
})();
