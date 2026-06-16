// Headless PolyTrack simulation harness.
//
// Runs the game's real simulation_worker.bundle.js inside Node by shimming the
// Web Worker globals it expects. Because it is the game's own deterministic
// code + Ammo/Bullet WASM, any input sequence produced here reproduces
// bit-exact in the browser.
//
// Strategy for clean Ammo loading: we preload the Ammo instance in pure Node
// FIRST (no worker globals present, so Emscripten detects Node and reads the
// wasm via fs). Then we expose a fake `Ammo()` that resolves the preloaded
// instance, so the worker bundle never re-runs Emscripten environment
// detection against our shimmed `self`/`importScripts`.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAME_DIR = path.resolve(__dirname, '..', 'game');
const LIB_DIR = path.join(GAME_DIR, 'lib');

// Message types (from the bundle's enum m_).
const MSG = {
  Init: 0, Verify: 1, TestDeterminism: 2, CreateCar: 3, DeleteCar: 4,
  StartCar: 5, ControlCar: 6, PauseCar: 7,
  VerifyResult: 8, DeterminismResult: 9, UpdateResult: 10,
};

async function preloadAmmo() {
  const AmmoFactory = require(path.join(LIB_DIR, 'ammo.wasm.js'));
  return AmmoFactory({
    locateFile: (f) => path.join(LIB_DIR, path.basename(f)),
  });
}

class HeadlessSim {
  constructor() {
    this.outbox = [];          // messages the worker posts back to "main"
    this._rafQueue = [];       // requestAnimationFrame callbacks (we drive these)
    this._intervals = [];      // setInterval callbacks (non-realtime loop)
    this._listeners = [];      // addEventListener('message') handlers
    this.ammo = null;
  }

  async init() {
    this.ammo = await preloadAmmo();
    this._clock = 0; // fake monotonic ms clock for the worker's step loop
    this._buildContext();
    this._runWorkerBundle();
    return this;
  }

  _buildContext() {
    // A clean realm with NO process/Buffer/require/module, so bundled libs
    // (e.g. js-sha256) take their browser code paths instead of node ones.
    const ctx = {};
    const self = this;

    ctx.self = ctx;
    ctx.globalThis = ctx;
    ctx.onmessage = null;       // predefine so strict-mode assignment works
    ctx.console = console;

    ctx.importScripts = function () {}; // no-op: Ammo preloaded
    // The bundle uses both `Ammo()` (-> promise of the module) and global
    // `Ammo.btXxx` (constructors). Expose a proxy that satisfies both.
    ctx.Ammo = new Proxy(function () {}, {
      apply: () => Promise.resolve(self.ammo),
      get: (_t, p) => self.ammo[p],
      has: (_t, p) => p in self.ammo,
    });

    ctx.postMessage = (data /*, transfer */) => { self.outbox.push(data); };
    ctx.requestAnimationFrame = (cb) => { self._rafQueue.push(cb); return self._rafQueue.length; };
    ctx.cancelAnimationFrame = () => {};
    ctx.setInterval = (cb) => { self._intervals.push(cb); return self._intervals.length; };
    ctx.clearInterval = () => {};
    ctx.setTimeout = (cb, _ms, ...a) => { Promise.resolve().then(() => cb(...a)); return 0; };
    ctx.clearTimeout = () => {};
    ctx.queueMicrotask = (cb) => Promise.resolve().then(cb);

    ctx.performance = { now: () => self._clock };

    ctx.addEventListener = (type, fn) => { if (type === 'message') self._listeners.push(fn); };
    ctx.removeEventListener = () => {};

    // Web APIs the bundle may touch (all exist as Node globals).
    ctx.URL = URL; ctx.Blob = globalThis.Blob; ctx.crypto = globalThis.crypto;
    ctx.TextEncoder = TextEncoder; ctx.TextDecoder = TextDecoder;
    ctx.atob = globalThis.atob; ctx.btoa = globalThis.btoa;
    ctx.fetch = globalThis.fetch;

    this.ctx = vm.createContext(ctx);
  }

  _runWorkerBundle() {
    let src = fs.readFileSync(path.join(GAME_DIR, 'simulation_worker.bundle.js'), 'utf8');
    // Realtime loop guard is `for (; o > .001; )`. With our fake 1ms-per-pump
    // clock, o reaches exactly .001 and the strict `>` would never step.
    // Relax the guard to 1e-9 so each pumpFrame() advances exactly one frame.
    src = src.replace('for (; o > .001; )', 'for (; o > 1e-9; )');
    vm.runInContext(src, this.ctx, { filename: 'simulation_worker.bundle.js' });
  }

  // Deliver a message into the worker.
  send(message) {
    const ev = { data: message };
    if (this.ctx.onmessage) this.ctx.onmessage(ev);
    for (const l of this._listeners) l(ev);
  }

  // Drain one rAF tick (the worker re-schedules itself, so we pop fresh each time).
  pumpFrame() {
    const cbs = this._rafQueue;
    this._rafQueue = [];
    for (const cb of cbs) cb();
  }

  // Wait for queued microtasks (e.g. Ammo().then) to flush.
  static tick() { return new Promise((r) => setImmediate(r)); }

  // ---- High-level single-car driving API ----------------------------------
  //
  // payload: the captured CreateCar message (msg 3) plus the Init trackParts.
  // We accept the object dumped by bridge/capture_payloads.js: { init, createCar }.

  // Must be called once after init(), AFTER the Ammo().then microtask flushed
  // (so the worker's handler + step loop exist). Sets up the track + one
  // controllable car and starts it at frame 0.
  async loadCar(payload, carId = 1) {
    const init = payload.init;
    const cc = payload.createCar;
    if (!init || !cc) throw new Error('payload needs { init, createCar }');

    this.send({ messageType: MSG.Init, isRealtime: true, trackParts: init.trackParts });

    this.send({
      messageType: MSG.CreateCar,
      carId,
      trackData: cc.trackData,
      carRecording: null,            // null => live-controllable car
      mountainVertices: cc.mountainVertices,
      mountainOffset: cc.mountainOffset,
      carCollisionShapeVertices: cc.carCollisionShapeVertices,
      carMassOffset: cc.carMassOffset,
    });

    this.send({ messageType: MSG.StartCar, carId, targetSimulationTimeFrames: null });
    this._carId = carId;
    return this;
  }

  // Apply controls and advance exactly one frame; return the decoded state.
  step(controls = {}) {
    const c = {
      messageType: MSG.ControlCar,
      carId: this._carId,
      up: !!controls.up, right: !!controls.right, down: !!controls.down,
      left: !!controls.left, reset: !!controls.reset,
    };
    this.send(c);
    this.outbox.length = 0;
    this._clock += 1;           // advance fake clock 1ms => one 1000Hz frame
    this.pumpFrame();           // run the worker's rAF step once
    // The realtime loop beams the latest state as a raw Float32Array buffer.
    const buf = this.outbox.find((m) => m instanceof ArrayBuffer);
    if (!buf) return null;      // car not stepping (finished / not started)
    return this.ctx.reconstructStates(new Float32Array(buf));
  }
}

module.exports = { HeadlessSim, MSG };
