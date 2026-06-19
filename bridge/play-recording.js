// Watch an AI lap play out on the real track, frame-perfectly.
//
// Instead of pressing OS keys (which drift), this makes the GAME drive the lap:
// it intercepts the message that creates your player car and turns it into a
// RECORDING-driven car using the AI recording. The game then plays + renders the
// exact lap at full internal 1000 fps. No keyboard, no timing drift.
//
// HOW TO USE (on https://app-polytrack.kodub.com/0.6.2/):
//   1. On your PC, build + verify the recording:
//        node bridge/verify-recording.js <es_lap.json> <track.json>
//      Copy the printed recording string.
//   2. Paste it into AI_RECORDING below, then paste this whole script into the
//      game's DevTools console (before entering the track).
//   3. Enter the SAME track. Press an arrow key once to start the run — the car
//      will drive the AI lap by itself. Watch it.
//   4. To replay again: leave and re-enter the track (the hook stays active), or
//      run __polyPlayOff() to stop and drive normally again.
(() => {
  const AI_RECORDING = 'PASTE_RECORDING_STRING_HERE';
  if (!AI_RECORDING || AI_RECORDING.startsWith('PASTE')) {
    console.error('[play-recording] Set AI_RECORDING to the string from verify-recording.js first.');
    return;
  }

  const ghostIds = new Set();   // car ids we turned into recording players
  let enabled = true;

  const proto = Worker.prototype;
  if (!proto.__playOrig) proto.__playOrig = proto.postMessage;
  const orig = proto.__playOrig;

  proto.postMessage = function (msg, transfer) {
    try {
      if (enabled && msg && typeof msg === 'object') {
        // CreateCar (3) with no recording = the live player car -> make it a
        // recording-driven car so the game plays our lap.
        if (msg.messageType === 3 && msg.carRecording == null) {
          ghostIds.add(msg.carId);
          msg = { ...msg, carRecording: AI_RECORDING };
          console.log('[play-recording] player car', msg.carId, 'is now driving the AI lap');
        }
        // ControlCar (6) for that car would throw ("uncontrollable") — drop it.
        if (msg.messageType === 6 && ghostIds.has(msg.carId)) return undefined;
        // If the car gets deleted, forget it.
        if (msg.messageType === 4 && ghostIds.has(msg.carId)) ghostIds.delete(msg.carId);
      }
    } catch (e) { /* never break the game */ }
    return orig.call(this, msg, transfer);
  };
  proto.__playHooked = true;

  window.__polyPlayOff = () => { enabled = false; proto.postMessage = orig; console.log('[play-recording] off — drive normally now.'); };

  console.log('[play-recording] active. Enter the track and press an arrow key to start; the car drives the AI lap. __polyPlayOff() to stop.');
})();
