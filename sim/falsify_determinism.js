// Falsification test: prove testDeterminism actually depends on the real
// simulation by corrupting the wasm and showing the result is NO LONGER `true`.
// If a clean binary returns true and a tampered binary returns false/throws,
// then the `true` is meaningful (the engine really computed the reference run).
const fs = require('fs');
const path = require('path');

const LIB = path.resolve(__dirname, '..', 'game', '0.6.2', 'lib');
global.self = global.self || { location: { href: 'https://local/0.6.2/' } };
const factory = require(path.join(LIB, 'polytrack_physics.js'));
const clean = fs.readFileSync(path.join(LIB, 'polytrack_physics.wasm'));

async function run(bin, label) {
  try {
    const M = await factory({ wasmBinary: bin, printErr: () => {}, print: () => {} });
    const r = M.ccall('testDeterminism', 'boolean', [], []);
    console.log(`${label}: testDeterminism -> ${r}`);
    return r;
  } catch (e) {
    console.log(`${label}: threw -> ${String(e).slice(0, 80)}`);
    return 'error';
  }
}

(async () => {
  const cleanResult = await run(clean, 'clean      ');

  // Flip bytes in the data region (latter half) to perturb constants/logic
  // without (hopefully) breaking wasm validation outright.
  let flippedAny = false;
  for (const frac of [0.6, 0.7, 0.8, 0.85, 0.9]) {
    const bad = Buffer.from(clean);
    const off = Math.floor(bad.length * frac);
    for (let k = 0; k < 32; k++) bad[off + k] ^= 0xff; // smash 32 bytes
    const r = await run(bad, `corrupt@${frac}`);
    if (r !== true) flippedAny = true;
  }

  console.log('\n--- verdict ---');
  console.log('clean returns true            :', cleanResult === true);
  console.log('corruption breaks the result  :', flippedAny);
  if (cleanResult === true && flippedAny) {
    console.log('=> testDeterminism is a REAL simulation check, not a constant. ✓');
  } else {
    console.log('=> inconclusive / suspicious.');
  }
})();
