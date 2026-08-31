
}
// Verified JS ports of polytrack_physics.wasm internal functions.
// Each is traced from the wasm stack machine in the SAME floating-point eval
// order, so it is BIT-IDENTICAL to the wasm (proven in verify.js — run it).
//
// Status legend: "verified" = passes bit-exact check; "wip" = in progress.
const F = Math.fround;

const _b64 = new ArrayBuffer(8), _u64 = new BigUint64Array(_b64), _f64 = new Float64Array(_b64);
function bitsToF64(bi) { _u64[0] = bi; return _f64[0]; }

// fn 27 : __cosdf — single-precision cosine kernel.  (f64)->f32
function fn27_cosdf(x) {
  const C0 = 0.00002439044879627741, C1 = -0.001388676377460993, C2 = 0.04166662332373906, C3 = -0.499999997251031;
  const z = x * x, w = z * z;
  const A = (z * w) * (z * C0 + C1);
  const t1 = z * C3 + 1;
  const t2 = w * C2 + t1;
  return F(A + t2);
}

// fn 26 : __sindf — single-precision sine kernel.  (f64)->f32
function fn26_sindf(x) {
  const S1 = -0.16666666641626524, S2 = 0.008333329385889463, S3 = -0.00019839334836096632, S4 = 0.000002718311493989822;
  const z = x * x;
  const s = x * z;        // x^3
  const w = z * z;
  const B = (s * w) * (z * S4 + S3);
  const inner = s * (z * S2 + S1);
  return F(B + (inner + x));
}

// fn 58 : scalbn(x, n) = x * 2^n (musl overflow/underflow staging).  (f64,i32)->f64
function fn58_scalbn(x, n) {
  const P1023 = 8.98846567431158e+307;     // 0x1p1023
  const Pm969 = 2.004168360008973e-292;    // 0x1p-969
  n = n | 0;
  if ((n | 0) >= 1024) {
    x = x * P1023;
    if ((n >>> 0) < 2047) { n = (n - 1023) | 0; }
    else { x = x * P1023; const sel = ((n >>> 0) >= 3069) ? 3069 : n; n = (sel - 2046) | 0; }
  } else if (!((n | 0) > -1023)) {
    x = x * Pm969;
    if ((n >>> 0) > (-1992 >>> 0)) { n = (n + 969) | 0; }
    else { x = x * Pm969; const sel2 = ((n >>> 0) <= (-2960 >>> 0)) ? -2960 : n; n = (sel2 + 1938) | 0; }
  }
  return x * bitsToF64(BigInt((n + 1023) >>> 0) << 52n);
}

// Registry: wasm func index -> { name, fn, sig, status }
const PORTS = {
  26: { name: "__sindf", fn: fn26_sindf, sig: "(f64)->f32", status: "verified" },
  27: { name: "__cosdf", fn: fn27_cosdf, sig: "(f64)->f32", status: "verified" },
  58: { name: "scalbn", fn: fn58_scalbn, sig: "(f64,i32)->f64", status: "verified" }
};

module.exports = { PORTS, fn26_sindf, fn27_cosdf, fn58_scalbn 