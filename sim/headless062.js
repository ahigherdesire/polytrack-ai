// Headless harness for the LIVE PolyTrack 0.6.2 worker.
//
// 0.6.2 replaced Ammo with a custom Emscripten engine (lib/polytrack_physics.js)
// and the worker bundles Three.js (so it touches `document`). We:
//   - preload the physics with wasmBinary (no fetch/XHR needed),
//   - run the worker in a clean vm context with worker + minimal-DOM shims,
//   - expose a fake PolyTrackPhysics() resolving the preloaded instance.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { decodeCarStateBuffer } = require('./carstate');

const GAME_DIR = path.resolve(__dirname, '..', 'game', '0.6.2');
const LIB_DIR = path.join(GAME_DIR, 'lib');

const f32 = (a) => (a instanceof Float32Array ? a : Float32Array.from(a));

const MSG = {
  Init: 0, Verify: 1, TestDeterminism: 2, CreateCar: 3, DeleteCar: 4,
  StartCar: 5, ControlCar: 6, PauseCar: 7,
  VerifyResult: 8, DeterminismResult: 9, UpdateResult: 10,
};

function preloadPhysics() {
  // The loader reads self.location.href at startup.
  global.self = global.self || { location: { href: 'https://local/0.6.2/' } };
  const factory = require(path.join(LIB_DIR, 'polytrack_physics.js'));
  const wasmBinary = fs.readFileSync(path.join(LIB_DIR, 'polytrack_physics.wasm'));
  return factory({ wasmBinary });
}

// Minimal DOM stub so Three.js inside the worker doesn't crash on load.
function makeStubElement() {
  const el = {
    style: {}, setAttribute() {}, getAttribute() { return null; },
    appendChild(x) { return x; }, addEventListener() {}, removeEventListener() {},
    getContext() { return null; }, setPointerCapture() {},
  };
  return el;
}

class Headless062 {
  constructor() {
    this.outbox = [];
    this._rafQueue = [];
    this._intervals = [];
    this._listeners = [];
    this._clock = 0;
    this.physics = null;
  }

  async init() {
    this.physics = await preloadPhysics();
    this._buildContext();
    this._runWorkerBundle();
    return this;
  }

  _buildContext() {
    const ctx = {};
    const self = this;

    ctx.self = ctx;
    ctx.globalThis = ctx;
    ctx.console = console;
    ctx.onmessage = null;

    ctx.importScripts = function () {};               // physics preloaded
    ctx.PolyTrackPhysics = new Proxy(function () {}, { // callable + property access
      apply: () => Promise.resolve(self.physics),
      get: (_t, p) => self.physics[p],
      has: (_t, p) => p in self.physics,
    });

    ctx.postMessage = (data /*, opts */) => { self.outbox.push(data); };
    ctx.requestAnimationFrame = (cb) => { self._rafQueue.push(cb); return self._rafQueue.length; };
    ctx.cancelAnimationFrame = () => {};
    ctx.setInterval = (cb) => { self._intervals.push(cb); return self._intervals.length; };
    ctx.clearInterval = () => {};
    ctx.setTimeout = (cb, _m, ...a) => { Promise.resolve().then(() => cb(...a)); return 0; };
    ctx.clearTimeout = () => {};
    ctx.queueMicrotask = (cb) => Promise.resolve().then(cb);
    ctx.performance = { now: () => self._clock };

    ctx.addEventListener = (t, fn) => { if (t === 'message') self._listeners.push(fn); };
    ctx.removeEventListener = () => {};

    // Minimal DOM/web shims for the bundled Three.js.
    ctx.document = {
      createElement: () => makeStubElement(),
      createElementNS: () => makeStubElement(),
      addEventListener() {}, removeEventListener() {},
    };
    ctx.navigator = { userAgent: 'node', hardwareConcurrency: 4 };
    ctx.location = { href: 'https://local/0.6.2/' };
    ctx.URL = URL; ctx.Blob = globalThis.Blob;
    ctx.TextEncoder = TextEncoder; ctx.TextDecoder = TextDecoder;
    ctx.atob = globalThis.atob; ctx.btoa = globalThis.btoa;
    ctx.WebAssembly = WebAssembly; ctx.crypto = globalThis.crypto;
    ctx.fetch = globalThis.fetch;

    this.ctx = vm.createContext(ctx);
  }

  _runWorkerBundle() {
    let src = fs.readFileSync(path.join(GAME_DIR, 'simulation_worker.bundle.js'), 'utf8');
    // Make each fake-clock pump advance exactly one frame (relax strict guard).
    src = src.replace('for(;o>.001;)', 'for(;o>1e-9;)');
    vm.runInContext(src, this.ctx, { filename: 'simulation_worker.bundle.js' });
  }

  send(message) {
    const ev = { data: message };
    if (this.ctx.onmessage) this.ctx.onmessage(ev);
    for (const l of this._listeners) l(ev);
  }

  pumpFrame() {
    const cbs = this._rafQueue; this._rafQueue = [];
    for (const cb of cbs) cb();
  }

  static tick() { return new Promise((r) => setImmediate(r)); }

  // Wait until the worker has finished async init (physics + embedded wasm).
  async waitReady(maxTicks = 200) {
    for (let i = 0; i < maxTicks; i++) await Headless062.tick();
  }

  // ---- High-level single-car driving API (0.6.2) --------------------------
  //
  // constants: the captured Init payload (trackParts, carCollisionShapeVertices,
  //            carMassOffset).  createCar: the captured CreateCar payload
  //            (trackData, mountainVertices, mountainOffset) for the chosen track.
  loadCar(constants, createCar, carId = 1) {
    // Init: rebuild typed arrays (JSON flattened them) and force realtime so the
    // rAF step loop runs one frame per pump.
    const trackParts = constants.trackParts.map((p) => ({
      id: p.id,
      vertices: f32(p.vertices),
      detector: p.detector,      // {type,center[3],size[3]} or null — read by index
      startOffset: p.startOffset, // [3] or null
    }));
    this.send({
      messageType: MSG.Init,
      version: '0.6.2',
      isRealtime: true,
      trackParts,
      carCollisionShapeVertices: f32(constants.carCollisionShapeVertices),
      carMassOffset: constants.carMassOffset,
    });

    this.send({
      messageType: MSG.CreateCar,
      carId,
      trackData: createCar.trackData,
      carRecording: null,        // null => live-controllable car
      mountainVertices: f32(createCar.mountainVertices),
      mountainOffset: createCar.mountainOffset,
    });

    this.send({ messageType: MSG.StartCar, carId, targetSimulationTimeFrames: null });
    this._carId = carId;
    return this;
  }

  // Apply controls and advance exactly one frame; return decoded car state.
  step(controls = {}) {
    // Send ControlCar BEFORE advancing the clock so the worker stamps the input
    // at the current frame (its frame = car.frames + (now - loopTime), and
    // now == loopTime right after the previous pump).
    this.send({
      messageType: MSG.ControlCar,
      carId: this._carId,
      up: !!controls.up, right: !!controls.right, down: !!controls.down,
      left: !!controls.left, reset: !!controls.reset,
    });
    this.outbox.length = 0;
    this._clock += 1;
    this.pumpFrame();
    // Find the UpdateResult and decode the last car-state buffer.
    let buf = null;
    for (const m of this.outbox) {
      if (m && m.messageType === MSG.UpdateResult && m.carStateBuffers && m.carStateBuffers.length) {
        buf = m.carStateBuffers[m.carStateBuffers.length - 1];
      }
    }
    return buf ? decodeCarStateBuffer(buf) : null;
  }
}

module.exports = { Headless062, MSG };
