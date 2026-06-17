// Turn a browser capture into a trainable track file.
// A new track only needs its CreateCar (track-specific); the Init constants are
// the same for every 0.6.2 track, so we borrow them from data/constants.json
// if your capture didn't include them.
//
// Usage: node train/make-track.js <captured.json> <name>
//   e.g. node train/make-track.js "C:/Users/you/Downloads/mytrack.json" mytrack
//   -> writes data/mytrack.json, ready to train with TRACK=data/mytrack.json
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '..', 'data');           // constants.json + outputs
const TRACKS = path.resolve(__dirname, '..', 'track data');   // track input files
const [, , capPath, name] = process.argv;
if (!capPath || !name) { console.error('usage: node train/make-track.js <captured.json> <name>'); process.exit(1); }

const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
// Accept either the dump shape {createCar, init} or a raw CreateCar message.
const createCar = cap.createCar || (cap.messageType === 3 ? cap : null);
if (!createCar || !createCar.trackData) {
  console.error('No CreateCar (messageType 3) found in the capture.');
  console.error('Load the track so the car spawns at the line, then run __polyDump again.');
  process.exit(1);
}

let init = cap.init;
if (!init) {
  const c = path.join(DATA, 'constants.json');
  if (!fs.existsSync(c)) { console.error('Capture has no Init and data/constants.json is missing to borrow it from.'); process.exit(1); }
  init = JSON.parse(fs.readFileSync(c, 'utf8')).init;
  console.log('borrowed Init constants from data/constants.json (same for all 0.6.2 tracks)');
}

fs.mkdirSync(TRACKS, { recursive: true });
const out = path.join(TRACKS, name + '.json');
fs.writeFileSync(out, JSON.stringify({ init, createCar }));
console.log(`wrote ${out}`);
console.log(`train:  TRACK="track data/${name}.json" node train/es_parallel.js 1000000 78 16000 13`);
console.log(`watch:  TRACK="track data/${name}.json" node train/dashboard.js train-${name}.log 7780`);
