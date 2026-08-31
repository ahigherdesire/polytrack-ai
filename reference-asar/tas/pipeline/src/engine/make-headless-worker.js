);
// Generates generated/sim_worker_headless.js — a copy of the game's
// simulation_worker.bundle.js with one appended statement that exposes the
// worker's internals on `self.__HEADLESS`. The insertion point is the same
// closure the existing `__tasBfSnap` savestate/bruteforce patches live in,
// so every internal we need is in scope:
//   t  = the Emscripten physics module (ccall, HEAPU8, HEAPF32, _updateCarModel…)
//   i  = the 227-byte CarState scratch pointer (malloc'd once)
//   e  = the worker's own car array (used by its realtime/flat loops — we
//        manage our own cars and leave this empty)
//   Ko = Track class    (fromSaveString / getBounds / getStartTransform / forEachPart)
//   Qa = Recording      (deserialize / serialize / maxFrames)
//   tr = RecordingControls, jo = user-controls stub, Ki = messageType enum
//   R  = Vector3, Xo = "finished" flag reader
//   s  = createCar(carId, mountainVertices, offsetVec3, track, startTransform)
//   n  = step(car, controls) -> 227-byte state copy
//   r  = the worker's message dispatcher (Init / Verify / CreateCar / …)
//
// The generator is deliberately strict: it fails loudly if the anchor is not
// found exactly once, and the host verifies the hook actually boots.
"use strict";
const fs = require("fs");
const path = require("path");
const paths = require("../paths");

const ANCHOR = "$o.length=0,onmessage=r;";

const HOOK =
  "self.__HEADLESS={module:t,scratchPtr:i,cars:e,Track:Ko,Recording:Qa," +
  "RecordingControls:tr,UserControls:jo,MessageType:Ki,Vector3:R,readFinished:Xo," +
  "createCarModel:s,stepCar:n,dispatch:r};" +
  "typeof self.__HEADLESS_READY==='function'&&self.__HEADLESS_READY(self.__HEADLESS);";

function makeHeadlessWorker({ force = false } = {}) {
  const src = fs.readFileSync(paths.SIM_WORKER_BUNDLE, "utf8");
  const out = paths.HEADLESS_WORKER;
  if (!force && fs.existsSync(out)) {
    const existing = fs.readFileSync(out, "utf8");
    if (existing.includes(HOOK) && existing.length === src.length + HOOK.length) {
      return out; // up to date
    }
  }
  const first = src.indexOf(ANCHOR);
  if (first < 0) {
    throw new Error(
      "Headless anchor not found in simulation_worker.bundle.js — the game " +
      "bundle changed; update ANCHOR/HOOK in make-headless-worker.js"
    );
  }
  if (src.indexOf(ANCHOR, first + 1) !== -1) {
    throw new Error("Headless anchor is not unique in simulation_worker.bundle.js");
  }
  const patched = src.slice(0, first + ANCHOR.length) + HOOK + src.slice(first + ANCHOR.length);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, patched);
  return out;
}

module.exports = { makeHeadlessWorker, ANCHOR, HOOK };

if (require.main === module) {
  console.log("Wrote " + makeHeadlessWorker({ force: true }));