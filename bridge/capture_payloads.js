// PolyTrack payload capture — paste into the browser DevTools console with the
// game open (https://www.kodub.com/apps/polytrack). Works even if the sim
// worker already exists, because it patches Worker.prototype.postMessage
// (catches existing + future workers). After pasting, just (re)load the target
// track so the game sends Init + CreateCar, then run __polyDump("track1").
//
// Note: the game runs inside an <iframe> from app-polytrack.kodub.com. Open
// DevTools, then in the console's top-left context dropdown select that iframe
// before pasting (otherwise window.Worker is the wrong frame's).
(() => {
  const captured = { version: location.href, init: null, createCar: null, all: [] };

  function safe(o) {
    return JSON.parse(JSON.stringify(o, (k, v) =>
      ArrayBuffer.isView(v) ? Array.from(v) : v));
  }
  function record(msg) {
    try {
      if (msg && typeof msg === 'object' && 'messageType' in msg) {
        if (msg.messageType === 0) captured.init = safe(msg);        // Init (trackParts)
        if (msg.messageType === 3) captured.createCar = safe(msg);   // CreateCar
        captured.all.push(msg.messageType);
      }
    } catch (e) { /* ignore */ }
  }

  // Patch the prototype so ALL Worker instances (incl. already-created) are hooked.
  const proto = Worker.prototype;
  if (!proto.__polyHooked) {
    const orig = proto.postMessage;
    proto.postMessage = function (msg, transfer) {
      record(msg);
      return orig.call(this, msg, transfer);
    };
    proto.__polyHooked = true;
  }

  window.__polyCaptured = captured;
  window.__polyDump = function (name = 'polytrack_payload') {
    if (!captured.createCar) {
      console.warn('No CreateCar captured yet. (Re)load the track first. Seen types:', captured.all);
    }
    const blob = new Blob([JSON.stringify(captured)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.json';
    a.click();
    console.log('Dumped. Init:', !!captured.init, 'CreateCar:', !!captured.createCar,
      'types seen:', captured.all);
  };

  console.log('[polytrack-capture] hooked Worker.postMessage. Now (re)load a track, then run __polyDump("track1").');
})();
