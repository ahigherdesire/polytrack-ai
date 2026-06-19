// Browser console hook to submit an AI lap to the PolyTrack leaderboard.
//
// A recording IS a leaderboard submission. Rather than reverse-engineer your
// account token / trackId / car style, this hooks the game's OWN submit request
// and swaps in the AI recording + frame count — so it goes up under your account
// with everything else correct.
//
// HOW TO USE (on https://app-polytrack.kodub.com/0.6.2/):
//   1. Build + verify the recording on your PC:
//        node bridge/verify-recording.js <es_lap.json> <track.json>
//      Copy the printed recording string and the finishFrames.
//   2. Paste AI_RECORDING + AI_FRAMES below, then paste this whole script into
//      the game's DevTools console.
//   3. Load the SAME track and drive ANY finishing lap (slow is fine). When the
//      game submits it, this replaces it with the AI lap. The server re-validates
//      the recording, so the time it posts is the AI's, not your slow drive.
//   4. Open the track leaderboard → you'll see the AI time; "watch" plays it back
//      frame-perfect (it's a real recording).
(() => {
  const AI_RECORDING = 'PASTE_RECORDING_STRING_HERE';
  const AI_FRAMES = 0; // e.g. 9795

  if (!AI_RECORDING || AI_RECORDING.startsWith('PASTE') || !AI_FRAMES) {
    console.error('[submit-hook] Set AI_RECORDING and AI_FRAMES first.');
    return;
  }
  const patch = (body) => {
    if (typeof body !== 'string' || !body.includes('recording=')) return body;
    const before = body;
    body = body.replace(/([?&]recording=)[^&]*/, '$1' + AI_RECORDING)
               .replace(/([?&]frames=)[^&]*/, '$1' + AI_FRAMES);
    if (body !== before) console.log('[submit-hook] swapped in AI recording (frames=' + AI_FRAMES + ')');
    return body;
  };

  // Hook XMLHttpRequest
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return open.apply(this, arguments); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__u && /leaderboard/.test(this.__u)) b = patch(b);
    return send.call(this, b);
  };

  // Hook fetch (in case the game uses it)
  const of = window.fetch;
  window.fetch = function (u, opts) {
    if (opts && opts.body && /leaderboard/.test(String(u))) opts = { ...opts, body: patch(String(opts.body)) };
    return of.call(this, u, opts);
  };

  console.log('[submit-hook] active. Now drive ANY finishing lap on this track; the AI lap will be submitted instead.');
})();
