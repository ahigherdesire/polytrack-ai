// Grab a player's lap recording straight from the game (no pixel reading).
// The game fetches recordings from its API when you watch a leaderboard replay;
// this hooks the network and harvests the recording string + frames + name.
// Decode it to inputs with bridge/decode-recording.js.
//
// HOW TO USE (on https://app-polytrack.kodub.com/0.6.2/):
//   1. Paste this whole script into the DevTools console.
//   2. Open the track's leaderboard and WATCH the lap(s) you want to copy
//      (e.g. the world record). Each one gets captured.
//   3. Run __polyDumpGrabbed("recordings")  -> downloads recordings.json
//   4. On your PC: node bridge/decode-recording.js <recording> <frames> out.json
//      (recording string + frames are both in the dumped json)
(() => {
  const grabbed = (window.__polyGrabbed = window.__polyGrabbed || []);
  const match = (u) => /recordings|leaderboard/.test(String(u));

  function harvest(url, text) {
    let data; try { data = JSON.parse(text); } catch { return; }
    const out = [];
    (function walk(o, ctx) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { for (const x of o) walk(x, ctx); return; }
      const nctx = {
        frames: o.frames ?? ctx.frames,
        time: o.time ?? ctx.time,
        name: o.name ?? o.nickname ?? ctx.name,
        recordingId: o.recordingId ?? o.id ?? ctx.recordingId,
        trackId: o.trackId ?? ctx.trackId,
      };
      if (typeof o.recording === 'string' && o.recording.length > 20) out.push({ recording: o.recording, ...nctx });
      for (const k in o) walk(o[k], nctx);
    })(data, {});
    for (const f of out) {
      if (!grabbed.some((g) => g.recording === f.recording)) {
        grabbed.push({ ...f, url });
        console.log(`[grab] "${f.name ?? '?'}"  frames=${f.frames ?? '?'}  recLen=${f.recording.length}`);
      }
    }
  }

  const of = window.fetch;
  window.fetch = function (u) {
    const url = String((u && u.url) || u);
    const p = of.apply(this, arguments);
    if (match(url)) p.then((r) => { try { r.clone().text().then((t) => harvest(url, t)).catch(() => {}); } catch (e) {} });
    return p;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return open.apply(this, arguments); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (match(this.__u)) this.addEventListener('load', () => { try { harvest(this.__u, this.responseText); } catch (e) {} });
    return send.apply(this, arguments);
  };

  window.__polyDumpGrabbed = (name = 'recordings') => {
    if (!grabbed.length) { console.warn('[grab] nothing captured yet — watch a replay first.'); return; }
    const blob = new Blob([JSON.stringify(grabbed)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '.json'; a.click();
    console.log('[grab] dumped', grabbed.length, 'recording(s)');
  };

  console.log('[grab] active. Open a track leaderboard and WATCH the lap(s) you want, then run __polyDumpGrabbed().');
})();
