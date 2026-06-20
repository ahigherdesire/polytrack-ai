// Fully automated: fetch a track's leaderboard, grab a player's recording, and
// decode it to per-frame inputs — no browser, no pixels. Uses the game's public
// API (vps.kodub.com/v6) with the browser Origin/Referer it expects.
//
// Usage:
//   node bridge/fetch-recording.js <trackId> [rank] [out.json]
//     rank 1 = world record (default). e.g.:
//     node bridge/fetch-recording.js 5803f9e9...f1fa038 1 data/grabbed/summer1_wr.json
//   node bridge/fetch-recording.js --recording <recordingId> [out.json]
const fs = require('fs');
const { recordingToActions } = require('./decode-recording');

const BASE = 'https://vps.kodub.com/v6/';
const VERSION = '0.6.2';
const HEADERS = {
  Origin: 'https://app-polytrack.kodub.com',
  Referer: 'https://app-polytrack.kodub.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36',
};

async function api(path) {
  const r = await fetch(BASE + path, { headers: HEADERS });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}
const leaderboard = (trackId, skip = 0, amount = 10, onlyVerified = false) =>
  api(`leaderboard?version=${VERSION}&trackId=${trackId}&skip=${skip}&amount=${amount}&onlyVerified=${onlyVerified}`);
const recording = (id) => api(`recordings?version=${VERSION}&ids=${id}`).then((a) => a[0]);

async function fetchByRecordingId(id, frames) {
  const rec = await recording(id);
  if (!rec || !rec.recording) throw new Error('no recording for id ' + id);
  const { actions } = recordingToActions(rec.recording, { frames: frames ?? rec.frames });
  return { recordingId: id, frames: rec.frames, recording: rec.recording, actions };
}

async function fetchByTrack(trackId, rank = 1) {
  const lb = await leaderboard(trackId, rank - 1, 1, false);
  const e = lb.entries && lb.entries[0];
  if (!e) throw new Error('no leaderboard entry at rank ' + rank);
  const out = await fetchByRecordingId(e.id, e.frames);
  return { ...out, nickname: e.nickname, time: e.frames / 1000, total: lb.total, rank };
}

module.exports = { leaderboard, recording, fetchByRecordingId, fetchByTrack };

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    let result, out;
    if (a[0] === '--recording') { result = await fetchByRecordingId(a[1]); out = a[2]; }
    else { result = await fetchByTrack(a[0], parseInt(a[1] || '1', 10)); out = a[2]; }
    const ORDER = ['up', 'right', 'down', 'left', 'reset'];
    const tog = Object.fromEntries(ORDER.map((k) => [k, 0]));
    let prev = {}; for (const f of result.actions) for (const k of ORDER) { if (!!f[k] !== !!prev[k]) tog[k]++; } prev = result.actions[result.actions.length - 1];
    console.error(`${result.nickname ?? '(by id)'}  ${(result.frames / 1000).toFixed(3)}s  (rank ${result.rank ?? '?'}/${result.total ?? '?'})  frames=${result.frames}`);
    console.error('toggles:', tog);
    const payload = { kind: 'fetchedRecording', nickname: result.nickname, frames: result.frames, recordingId: result.recordingId, recording: result.recording, actions: result.actions };
    if (out) { fs.mkdirSync(require('path').dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(payload)); console.error('wrote', out); }
    else console.log(result.recording);
  })().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
