// Probe the 0.6.2 custom physics engine (polytrack_physics, Emscripten C) in Node.
// We bypass fetch/XHR by passing wasmBinary directly, and shim `self.location`
// which the loader reads at startup.
const fs = require('fs');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'game', '0.6.2', 'lib');

// Minimal worker-ish global the loader touches before wasm is ready.
global.self = global.self || { location: { href: 'https://local/0.6.2/' } };

const PolyTrackPhysics = require(path.join(LIB, 'polytrack_physics.js'));
const wasmBinary = fs.readFileSync(path.join(LIB, 'polytrack_physics.wasm'));

(async () => {
  const M = await PolyTrackPhysics({ wasmBinary });
  console.log('module loaded. exports of interest:');
  for (const k of ['_malloc', '_free', '_initializeCarCollisionShape',
    '_addTrackPartConfiguration', '_createCarModel', '_deleteCarModel',
    '_updateCarModel', '_testDeterminism']) {
    console.log('  ', k, typeof M[k]);
  }
  // _testDeterminism: run the engine's built-in bit-exact self check.
  const r = M.ccall('testDeterminism', 'number', [], []);
  console.log('testDeterminism ->', r, r ? '✓ deterministic' : '✗ FAILED');
  process.exit(r ? 0 : 1);
})().catch((e) => { console.error('load failed:', e); process.exit(1); });
