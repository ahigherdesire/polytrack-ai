};
// Verify JS ports of polytrack_physics.wasm functions are BIT-IDENTICAL to the
// real wasm, by adding temporary exports for the internal functions and calling
// both over many inputs. The production wasm is never modified.
const fs = require("fs");
const path = require("path");
const { fn26_sindf, fn27_cosdf, fn58_scalbn } = require("./ports.js");

// ---------- add temporary exports for the internal funcs we want to test ----------
function addExports(bytes, add /* [{name,index}] */) {
  let o = 8; const sec = [];
  function uleb() { let r = 0, s = 0, x; do { x = bytes[o++]; r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80); return r; }
  while (o < bytes.length) { const id = bytes[o++]; const start = o; const len = uleb(); const bodyStart = o; sec.push({ id, start, len, bodyStart, bodyEnd: o + len }); o += len; }
  const ex = sec.find(s => s.id === 7);
  // read current export entries (raw) + count
  let p = ex.bodyStart; const rd = () => { let r = 0, s = 0, x; do { x = bytes[p++]; r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80); return r; };
  const count = rd();
  const rawEntries = bytes.slice(p, ex.bodyEnd); // all existing entries, untouched
  function encU(n) { const a = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; a.push(b); } while (n); return a; }
  // build new export body: new count + old entries + new entries
  const newBody = [];
  encU(count + add.length).forEach(b => newBody.push(b));
  for (const b of rawEntries) newBody.push(b);
  for (const a of add) {
    const nm = Buffer.from(a.name, "utf8");
    encU(nm.length).forEach(b => newBody.push(b));
    for (const b of nm) newBody.push(b);
    newBody.push(0x00); // kind=func
    encU(a.index).forEach(b => newBody.push(b));
  }
  // reassemble: everything before ex section body's length, new length, new body, rest
  const out = [];
  for (const b of bytes.slice(0, ex.start)) out.push(b);      // up to & incl section id
  encU(newBody.length).forEach(b => out.push(b));             // new section length
  for (const b of newBody) out.push(b);                       // new body
  for (const b of bytes.slice(ex.bodyEnd)) out.push(b);       // remaining sections
  return Uint8Array.from(out);
}

function instantiate(bytes) {
  let inst;
  const imports = { a: { a: () => { throw 0; }, b: () => { throw 0; }, c: () => {}, d: () => 0, e: () => { throw 0; }, f: (req) => { const m = inst.exports.j; const need = Math.ceil((req - m.buffer.byteLength) / 65536); if (need > 0) try { m.grow(need); } catch (e) { return 0; } return 1; }, g: () => 0, h: () => 0, i: () => { throw 0; } } };
  inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
  if (inst.exports.k) inst.exports.k();
  return inst;
}

// ---------- run ----------
const orig = fs.readFileSync(path.join(__dirname, "..", "polytrack_physics.wasm"));
const tweaked = addExports(orig, [{ name: "T_fn26", index: 26 }, { name: "T_fn27", index: 27 }, { name: "T_fn58", index: 58 }]);
const inst = instantiate(tweaked);
const w26 = inst.exports.T_fn26, w27 = inst.exports.T_fn27, w58 = inst.exports.T_fn58;

function f32bits(v) { const a = new Float32Array(1); a[0] = v; return new Uint32Array(a.buffer)[0]; }
function f64bits(v) { const a = new Float64Array(1); a[0] = v; return new BigUint64Array(a.buffer)[0]; }

let fail = 0, tested = 0;
function checkF32(name, wfn, jsfn, x) { tested++; const a = wfn(x), b = jsfn(x); if (f32bits(a) !== f32bits(b)) { if (fail < 8) console.log("  MISMATCH " + name + "(" + x + ") wasm=" + a + " js=" + b); fail++; } }
function checkF64(name, wfn, jsfn, x, n) { tested++; const a = wfn(x, n), b = jsfn(x, n); if (f64bits(a) !== f64bits(b)) { if (fail < 8) console.log("  MISMATCH " + name + "(" + x + "," + n + ") wasm=" + a + " js=" + b); fail++; } }

// sine/cosine kernels are used on the reduced range ~[-pi/4, pi/4]; test that + extremes.
for (let i = 0; i < 20000; i++) {
  const x = (Math.random() * 2 - 1) * (Math.PI / 4);
  checkF32("fn26_sin", w26, fn26_sindf, x);
  checkF32("fn27_cos", w27, fn27_cosdf, x);
}
[0, -0, 1e-20, 0.7853981633974483, -0.7853981633974483, 0.5, -0.5, 1e-300].forEach(x => { checkF32("fn26_sin", w26, fn26_sindf, x); checkF32("fn27_cos", w27, fn27_cosdf, x); });

// scalbn: many magnitudes of x and a wide range of n (incl. overflow/underflow staging)
for (let i = 0; i < 20000; i++) {
  const x = (Math.random() * 2 - 1) * Math.pow(2, (Math.random() * 200 - 100) | 0);
  const n = (Math.random() * 8000 - 4000) | 0;
  checkF64("fn58_scalbn", w58, fn58_scalbn, x, n);
}
[[1, 0], [1, 1023], [1, 1024], [1, 2046], [1, 3069], [1, 5000], [1, -1022], [1, -1023], [1, -1074], [1, -2000], [1, -5000], [1.5, 1100], [3, -1100], [0, 500], [-0, 500]].forEach(([x, n]) => checkF64("fn58_scalbn", w58, fn58_scalbn, x, n));

console.log("tested " + tested + " calls, mismatches: " + fail);
console.log(fail === 0 ? "✅ ALL PORTS BIT-IDENTICAL to the wasm" : "❌ " + fail + " mismatches");
process.exit(fail === 0 ? 0 : 1