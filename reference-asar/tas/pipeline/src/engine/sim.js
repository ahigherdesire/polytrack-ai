};
// HeadlessSim — Phase 1 of the TAS pipeline.
//
// Hosts the game's REAL simulation worker bundle (with the tiny __HEADLESS
// hook appended by make-headless-worker.js) inside a Node `vm` context with
// browser-worker shims, then drives the physics directly:
//
//   setState -> stepPhysics(inputs) -> getState
//
// with zero message passing, zero graphics and zero allocation in the hot
// loop. The wasm module, track parser, car factory and CarState layout are
// all the game's own code, so trajectories are bit-identical to the game.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");
const paths = require("../paths");
const { makeHeadlessWorker } = require("./make-headless-worker");
const { createMountainVertices } = require("./mountains");
const { readFast, readFull, newFastState } = require("./state");

const MAX_FRAMES = 5999999;

function loadContextFile(contextOrPath) {
  if (contextOrPath && typeof contextOrPath === "object" && contextOrPath.trackParts) {
    return contextOrPath;
  }
  const p = typeof contextOrPath === "string" ? contextOrPath : paths.CONTEXT_FILE;
  if (!fs.existsSync(p)) {
    throw new Error(
      "Init context not found at " + p +
      " — run `node src/extract/build-context.js` first."
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function b64ToF32(b64) {
  const buf = Buffer.from(b64, "base64");
  // Copy to guarantee 4-byte alignment.
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

class HeadlessSim {
  constructor() {
    this._ctx = null;          // vm context
    this._H = null;            // the __HEADLESS hook
    this._mod = null;          // Emscripten module
    this._scratch = 0;         // CarState scratch pointer
    this._dv = null;           // DataView over the wasm heap
    this._heapU8 = null;       // cached heap ref for growth detection
    this.messages = [];        // postMessage collector (Verify results etc.)
    this.car = null;           // { id, frames, finished }
    this.track = null;
    this.context = null;
    this._fast = newFastState();
    this._initialized = false;
    this._carIdCounter = 1;
  }

  static async create(opts = {}) {
    const sim = new HeadlessSim();
    await sim._boot(opts);
    if (!opts.skipInit) sim.init(opts.context);
    return sim;
  }

  async _boot(opts = {}) {
    const workerPath = makeHeadlessWorker();
    const workerSrc = fs.readFileSync(workerPath, "utf8");
    const wasmBinary = fs.readFileSync(paths.PHYSICS_WASM);

    const capturedIntervals = [];
    let readyResolve, readyReject;
    const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

    const sandbox = {
      console,
      performance,
      setTimeout, clearTimeout,
      setInterval: (fn, ms) => { capturedIntervals.push({ fn, ms }); return capturedIntervals.length; },
      clearInterval: () => {},
      atob: (s) => Buffer.from(s, "base64").toString("binary"),
      btoa: (s) => Buffer.from(s, "binary").toString("base64"),
      TextDecoder, TextEncoder, URL,
      location: { href: pathToFileURL(path.join(paths.GAME_ROOT, "simulation_worker.bundle.js")).href },
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: (msg) => { this.messages.push(msg); },
      navigator: { userAgent: "node-headless", hardwareConcurrency: 1 },
      __HEADLESS_READY: (H) => readyResolve(H),
      importScripts: (rel) => {
        const p = path.join(paths.GAME_ROOT, rel);
        const src = fs.readFileSync(p, "utf8");
        vm.runInContext(src, ctx, { filename: p });
        // The Emscripten glue was just defined — wrap it so the wasm binary
        // is injected directly (no fetch/XHR in the vm context).
        if (rel.includes("polytrack_physics") && typeof ctx.PolyTrackPhysics === "function") {
          const orig = ctx.PolyTrackPhysics;
          ctx.PolyTrackPhysics = function (cfg) {
            cfg = cfg || {};
            cfg.wasmBinary = wasmBinary;
            return orig(cfg);
          };
        }
      },
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    this._ctx = ctx;
    this._capturedIntervals = capturedIntervals;

    const timeout = setTimeout(
      () => readyReject(new Error("Headless worker did not become ready within 30s")),
      30000
    );
    try {
      vm.runInContext(workerSrc, ctx, { filename: workerPath });
      this._H = await ready;
    } finally {
      clearTimeout(timeout);
    }

    this._mod = this._H.module;
    this._scratch = this._H.scratchPtr;
    this._refreshHeapViews();
    if (typeof this._mod._updateCarModel !== "function") {
      throw new Error("Physics module missing _updateCarModel export");
    }
  }

  _refreshHeapViews() {
    this._heapU8 = this._mod.HEAPU8;
    this._dv = new DataView(this._heapU8.buffer);
  }

  _checkHeap() {
    if (this._mod.HEAPU8 !== this._heapU8) this._refreshHeapViews();
  }

  // ---- Init (track parts + car collision shape into the wasm) ------------
  init(contextOrPath) {
    if (this._initialized) throw new Error("Already initialized");
    const context = loadContextFile(contextOrPath);
    if (!context.allChecksumsOk) {
      throw new Error("Init context has failed checksums — refusing to run non-game-identical physics");
    }
    this.context = context;
    const msg = {
      messageType: this._H.MessageType.Init,
      version: context.gameVersion,
      isRealtime: false,
      carMassOffset: context.carMassOffset,
      carCollisionShapeVertices: b64ToF32(context.carCollisionShapeVertices),
      trackParts: context.trackParts.map((p) => ({
        id: p.id,
        vertices: b64ToF32(p.vertices),
        detector: p.detector
          ? { type: p.detector.type, center: p.detector.center, size: p.detector.size }
          : null,
        startOffset: p.startOffset || null,
      })),
    };
    this._H.dispatch({ data: msg });
    this._initialized = true;
    this._checkHeap();
  }

  // ---- track loading ------------------------------------------------------
  loadTrack(saveString) {
    saveString = String(saveString).trim();
    let track = this._H.Track.fromSaveString(saveString);
    this.trackMetadata = null;
    if (!track && typeof this._H.Track.fromExportString === "function") {
      // .track files / share codes carry a metadata wrapper (name, author).
      const exp = this._H.Track.fromExportString(saveString);
      if (exp && exp.trackData) {
        track = exp.trackData;
        this.trackMetadata = exp.trackMetadata || null;
      }
    }
    if (!track) throw new Error("Track parse failed — bad save/export string");
    const start = track.getStartTransform();
    if (!start) throw new Error("Track has no starting point");
    this.track = track;
    // Canonical save string (what the game's main thread would send the
    // worker) — regenerated so metadata wrappers never leak into physics.
    this._trackSaveString = track.toSaveString();
    const bounds = track.getBounds();
    this._mountains = createMountainVertices(
      { min: { x: bounds.min.x, y: bounds.min.y }, max: { x: bounds.max.x, y: bounds.max.y } },
      this.context
    );
    return track;
  }

  // World-space info about every placed part (for search guidance).
  trackParts() {
    if (!this.track) throw new Error("No track loaded");
    const out = [];
    this.track.forEachPart((x, y, z, partId, rotation, rotationAxis, color, order) => {
      out.push({ x, y, z, partId, rotation, rotationAxis, order: order == null ? -1 : order });
    });
    return out;
  }

  // ---- car lifecycle ------------------------------------------------------
  spawnCar() {
    if (!this.track) throw new Error("No track loaded");
    if (this.car) this.deleteCar();
    const id = this._carIdCounter++;
    const H = this._H;
    const off = this._mountains.offset;
    const start = this.track.getStartTransform();
    H.createCarModel(id, this._mountains.vertices, new H.Vector3(off.x, off.y, off.z), this.track, start);
    this.car = { id, frames: 0, finished: false };
    this._checkHeap();
    return this.car;
  }

  deleteCar() {
    if (!this.car) return;
    try {
      this._mod.ccall("deleteCarModel", "void", ["number"], [this.car.id]);
    } catch (e) { /* car may already be gone after a restore */ }
    this.car = null;
  }

  // Recreate the car from scratch (frame 0). Equivalent to a fresh run.
  resetCar() {
    this.deleteCar();
    return this.spawnCar();
  }

  // ---- stepping ------------------------------------------------------------
  // mask bits: 1=up, 2=right, 4=down, 8=left, 16=reset (controlByte order).
  stepMask(mask) {
    const car = this.car;
    this._mod._updateCarModel(
      car.id,
      mask & 1, (mask >> 1) & 1, (mask >> 2) & 1, (mask >> 3) & 1, (mask >> 4) & 1,
      this._scratch
    );
    this._checkHeap();
    car.frames++;
    return readFast(this._dv, this._scratch, this._fast);
  }

  // Step `n` frames under one mask with a single state read at the end.
  // (The finish flag latches inside the wasm, so none is missed.)
  stepMaskN(mask, n) {
    const car = this.car;
    const mod = this._mod;
    const id = car.id;
    const ptr = this._scratch;
    const up = mask & 1, right = (mask >> 1) & 1, down = (mask >> 2) & 1,
      left = (mask >> 3) & 1, reset = (mask >> 4) & 1;
    for (let i = 0; i < n; i++) {
      mod._updateCarModel(id, up, right, down, left, reset, ptr);
    }
    this._checkHeap();
    car.frames += n;
    return readFast(this._dv, this._scratch, this._fast);
  }

  step(controls) {
    const car = this.car;
    this._mod._updateCarModel(
      car.id,
      controls.up ? 1 : 0, controls.right ? 1 : 0, controls.down ? 1 : 0,
      controls.left ? 1 : 0, controls.reset ? 1 : 0,
      this._scratch
    );
    this._checkHeap();
    car.frames++;
    return readFast(this._dv, this._scratch, this._fast);
  }

  // Last state written to the scratch buffer (valid after a step).
  fastState() {
    return readFast(this._dv, this._scratch, this._fast);
  }

  fullState() {
    return readFull(this._dv, this._scratch);
  }

  // ---- snapshots ------------------------------------------------------------
  // Full wasm-heap snapshot — the proven-safe baseline (same approach as the
  // in-game bruteforce snapshot patch). ~20 MB per snapshot. Pass a previous
  // snapshot as `into` to reuse its buffer (no allocation, no GC pressure).
  snapshot(into) {
    const heap = this._mod.HEAPU8;
    if (into && into.heap && into.heap.length === heap.length) {
      into.heap.set(heap);
      into.frames = this.car ? this.car.frames : 0;
      into.carId = this.car ? this.car.id : null;
      into.finished = this.car ? this.car.finished : false;
      return into;
    }
    return {
      heap: heap.slice(),
      frames: this.car ? this.car.frames : 0,
      carId: this.car ? this.car.id : null,
      finished: this.car ? this.car.finished : false,
    };
  }

  restore(snap) {
    const heap = this._mod.HEAPU8;
    if (snap.heap.length !== heap.length) {
      // Heap grew since the snapshot; restore prefix and zero the rest.
      if (snap.heap.length > heap.length) {
        throw new Error("Snapshot larger than current heap — cannot restore");
      }
      heap.set(snap.heap);
      heap.fill(0, snap.heap.length);
    } else {
      heap.set(snap.heap);
    }
    this._checkHeap();
    if (snap.carId != null) {
      this.car = { id: snap.carId, frames: snap.frames, finished: snap.finished };
    }
  }

  // ---- recording / script simulation ----------------------------------------
  // channels: 5 ascending toggle-frame arrays [up, right, down, left, reset].
  // Simulates from the car's current frame to `toFrame` (exclusive).
  // onFrame(state, frame) optional per-tick callback.
  runChannels(channels, toFrame, onFrame) {
    const ptr = [0, 0, 0, 0, 0];
    const car = this.car;
    // Fast-forward channel pointers to the car's current frame.
    for (let k = 0; k < 5; k++) {
      const a = channels[k] || [];
      while (ptr[k] < a.length && a[ptr[k]] <= car.frames - 1) ptr[k]++;
      // ptr parity below is recomputed per frame anyway; this positions us.
    }
    let st = null;
    while (car.frames < toFrame && car.frames < MAX_FRAMES) {
      const f = car.frames;
      let mask = 0;
      for (let k = 0; k < 5; k++) {
        const a = channels[k] || [];
        while (ptr[k] < a.length && a[ptr[k]] <= f) ptr[k]++;
        if (ptr[k] & 1) mask |= 1 << k;
      }
      st = this.stepMask(mask);
      car.finished = st.finished;
      if (onFrame) onFrame(st, f);
    }
    return st;
  }

  // The game's own Verify path — the final oracle for a finished TAS:
  // returns true iff the recording finishes at exactly `targetFrames`.
  verifyRecording(recordingString, targetFrames) {
    const H = this._H;
    const before = this.messages.length;
    H.dispatch({
      data: {
        messageType: H.MessageType.Verify,
        trackData: this._trackSaveString,
        carId: 999999,
        carRecording: recordingString,
        targetFrames,
        mountainVertices: this._mountains.vertices,
        mountainOffset: this._mountains.offset,
      },
    });
    const msgs = this.messages.slice(before);
    const res = msgs.find((m) => m && m.messageType === H.MessageType.VerifyResult);
    if (!res) throw new Error("Verify produced no result");
    this._checkHeap();
    return !!res.result;
  }

  // Serialize toggle channels into the game's recording format using the
  // worker's own Recording class when it exposes sync serialize.
  get Recording() { return this._H.Recording; }
  get MessageType() { return this._H.MessageType; }
  get module() { return this._mod; }

  heapSize() { return this._mod.HEAPU8.length; }
}

module.exports = { HeadlessSim, loadContextFile, b64ToF32, MAX_FRAMES 