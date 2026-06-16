// Milestone 0: confirm the game's Ammo/Bullet WASM loads in pure Node.
// ammo.wasm.js is an Emscripten MODULARIZE build -> require() yields a factory.
// Loaded with NO worker globals present, so Emscripten detects Node and reads
// ammo.wasm.wasm from disk via fs (its own __dirname).
const path = require('path');
const ammoPath = path.resolve(__dirname, '..', 'game', 'lib', 'ammo.wasm.js');
const AmmoFactory = require(ammoPath);

console.log('typeof factory:', typeof AmmoFactory);

const libDir = path.resolve(__dirname, '..', 'game', 'lib');
AmmoFactory({
  // Emscripten embeds the wasm path as "lib/ammo.wasm.wasm" relative to the
  // page root; in Node the script dir is already .../game/lib, so resolve by basename.
  locateFile: (f) => path.join(libDir, path.basename(f)),
}).then((Ammo) => {
  // Build a couple of objects to prove the physics core is alive.
  const v = new Ammo.btVector3(1, 2, 3);
  console.log('btVector3:', v.x(), v.y(), v.z());
  const cfg = new Ammo.btDefaultCollisionConfiguration();
  const disp = new Ammo.btCollisionDispatcher(cfg);
  const broad = new Ammo.btDbvtBroadphase();
  const solver = new Ammo.btSequentialImpulseConstraintSolver();
  const world = new Ammo.btDiscreteDynamicsWorld(disp, broad, solver, cfg);
  world.setGravity(new Ammo.btVector3(0, -10, 0));
  console.log('Dynamics world created OK. Ammo/Bullet runs headless in Node. ✓');
}).catch((e) => {
  console.error('Ammo failed to load:', e);
  process.exit(1);
});
