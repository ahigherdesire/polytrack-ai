e.
// Minimal WASM disassembler for polytrack_physics.wasm.
// Parses sections, decodes function signatures + bodies into a readable listing,
// and builds a call graph so we can find simple LEAF functions to port first.
// Not a full validator — just enough to read this module.
const fs = require("fs");
const path = require("path");

function parse(wasmPath) {
  const b = fs.readFileSync(wasmPath || path.join(__dirname, "..", "polytrack_physics.wasm"));
  let o = 8;
  const u8 = () => b[o++];
  function uleb() { let r = 0, s = 0, x; do { x = b[o++]; r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80); return r; }
  function sleb() { let r = 0, s = 0, x; do { x = b[o++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); if (s < 32 && (x & 0x40)) r |= (-1 << s); return r; }
  function nm() { const n = uleb(); const s = b.slice(o, o + n).toString("utf8"); o += n; return s; }
  const VT = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128", 0x70: "funcref", 0x6f: "externref" };

  const sec = {};
  while (o < b.length) { const id = u8(); const len = uleb(); sec[id] = { o, len }; o += len; }

  // types
  const types = [];
  if (sec[1]) { o = sec[1].o; const n = uleb(); for (let i = 0; i < n; i++) { u8(); const np = uleb(); const ps = []; for (let j = 0; j < np; j++) ps.push(VT[u8()]); const nr = uleb(); const rs = []; for (let j = 0; j < nr; j++) rs.push(VT[u8()]); types.push({ params: ps, results: rs }); } }

  // imports (count function imports first — they occupy func index space)
  let importedFuncs = 0; const imports = [];
  if (sec[2]) { o = sec[2].o; const n = uleb(); for (let i = 0; i < n; i++) { const m = nm(), f = nm(); const k = u8(); if (k === 0) { const t = uleb(); imports.push({ m, f, type: t }); importedFuncs++; } else { if (k === 1) { u8(); const fl = u8(); uleb(); if (fl & 1) uleb(); } else if (k === 2) { const fl = u8(); uleb(); if (fl & 1) uleb(); } else if (k === 3) { u8(); u8(); } } } }

  // function section: type index per (non-imported) function
  const funcTypes = [];
  if (sec[3]) { o = sec[3].o; const n = uleb(); for (let i = 0; i < n; i++) funcTypes.push(uleb()); }

  // exports
  const exportsByIndex = {};
  if (sec[7]) { o = sec[7].o; const n = uleb(); for (let i = 0; i < n; i++) { const name = nm(); const k = u8(); const idx = uleb(); if (k === 0) exportsByIndex[idx] = name; } }

  // code section: record each body's [start,end)
  const bodies = [];
  if (sec[10]) { o = sec[10].o; const n = uleb(); for (let i = 0; i < n; i++) { const sz = uleb(); bodies.push({ start: o, end: o + sz }); o += sz; } }

  return { b, sec, types, imports, importedFuncs, funcTypes, exportsByIndex, bodies, uleb, sleb, u8 };
}

// Decode a function body (index = absolute func index incl. imports).
function decodeBody(M, funcIdx) {
  const { b, importedFuncs, funcTypes, types, bodies } = M;
  const bi = funcIdx - importedFuncs;
  if (bi < 0 || bi >= bodies.length) return null;
  let o = bodies[bi].start; const end = bodies[bi].end;
  function uleb() { let r = 0, s = 0, x; do { x = b[o++]; r += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80); return r; }
  function sleb() { let r = 0n, s = 0n, x; do { x = BigInt(b[o++]); r |= (x & 0x7fn) << s; s += 7n; } while (x & 0x80n); if (x & 0x40n) r |= (~0n << s); return r; }
  function f32() { const v = b.readFloatLE(o); o += 4; return v; }
  function f64() { const v = b.readDoubleLE(o); o += 8; return v; }

  // locals
  const locals = []; const nl = uleb();
  const VT = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64" };
  for (let i = 0; i < nl; i++) { const c = uleb(); const t = VT[b[o++]]; for (let j = 0; j < c; j++) locals.push(t); }

  const calls = new Set();
  const lines = [];
  let depth = 1;
  const ind = () => "  ".repeat(Math.max(0, depth));
  // opcode names (core MVP + common). Unknown -> 0xNN.
  while (o < end) {
    const pc = o; const op = b[o++];
    let s = null;
    switch (op) {
      case 0x00: s = "unreachable"; break;
      case 0x01: s = "nop"; break;
      case 0x02: { const t = sleb(); s = "block " + bt(t); depth++; break; }
      case 0x03: { const t = sleb(); s = "loop " + bt(t); depth++; break; }
      case 0x04: { const t = sleb(); s = "if " + bt(t); depth++; break; }
      case 0x05: s = "else"; break;
      case 0x0b: depth--; s = "end"; break;
      case 0x0c: s = "br " + uleb(); break;
      case 0x0d: s = "br_if " + uleb(); break;
      case 0x0e: { const n = uleb(); const ts = []; for (let i = 0; i < n; i++) ts.push(uleb()); const d = uleb(); s = "br_table [" + ts.join(",") + "] " + d; break; }
      case 0x0f: s = "return"; break;
      case 0x10: { const f = uleb(); calls.add(f); s = "call " + f + nameOf(M, f); break; }
      case 0x11: { const t = uleb(); u8s(1); s = "call_indirect type=" + t; break; }
      case 0x1a: s = "drop"; break;
      case 0x1b: s = "select"; break;
      case 0x1c: { const n = uleb(); for (let i = 0; i < n; i++) b[o++]; s = "select t"; break; }
      case 0x20: s = "local.get " + uleb(); break;
      case 0x21: s = "local.set " + uleb(); break;
      case 0x22: s = "local.tee " + uleb(); break;
      case 0x23: s = "global.get " + uleb(); break;
      case 0x24: s = "global.set " + uleb(); break;
      case 0x28: s = "i32.load " + memarg(); break;
      case 0x29: s = "i64.load " + memarg(); break;
      case 0x2a: s = "f32.load " + memarg(); break;
      case 0x2b: s = "f64.load " + memarg(); break;
      case 0x2c: s = "i32.load8_s " + memarg(); break;
      case 0x2d: s = "i32.load8_u " + memarg(); break;
      case 0x2e: s = "i32.load16_s " + memarg(); break;
      case 0x2f: s = "i32.load16_u " + memarg(); break;
      case 0x30: s = "i64.load8_s " + memarg(); break;
      case 0x31: s = "i64.load8_u " + memarg(); break;
      case 0x32: s = "i64.load16_s " + memarg(); break;
      case 0x33: s = "i64.load16_u " + memarg(); break;
      case 0x34: s = "i64.load32_s " + memarg(); break;
      case 0x35: s = "i64.load32_u " + memarg(); break;
      case 0x36: s = "i32.store " + memarg(); break;
      case 0x37: s = "i64.store " + memarg(); break;
      case 0x38: s = "f32.store " + memarg(); break;
      case 0x39: s = "f64.store " + memarg(); break;
      case 0x3a: s = "i32.store8 " + memarg(); break;
      case 0x3b: s = "i32.store16 " + memarg(); break;
      case 0x3c: s = "i64.store8 " + memarg(); break;
      case 0x3d: s = "i64.store16 " + memarg(); break;
      case 0x3e: s = "i64.store32 " + memarg(); break;
      case 0x3f: u8s(1); s = "memory.size"; break;
      case 0x40: u8s(1); s = "memory.grow"; break;
      case 0x41: s = "i32.const " + sleb(); break;
      case 0x42: s = "i64.const " + sleb(); break;
      case 0x43: s = "f32.const " + f32(); break;
      case 0x44: s = "f64.const " + f64(); break;
      case 0xfc: { const sub = uleb(); s = "0xfc:" + sub; if (sub <= 7) { /* trunc_sat */ } else if (sub === 8) { uleb(); u8s(1); s = "memory.init"; } else if (sub === 10) { u8s(2); s = "memory.copy"; } else if (sub === 11) { u8s(1); s = "memory.fill"; } break; }
      default: s = OPN[op] || ("0x" + op.toString(16)); break;
    }
    lines.push(ind() + s);
    function bt(t) { return typeof t === "bigint" ? (t < 0n ? "" : "type" + t) : (t < 0 ? "" : "type" + t); }
    function memarg() { const a = uleb(); const off = uleb(); return "o=" + off + (a ? " a=" + a : ""); }
    function u8s(n) { for (let i = 0; i < n; i++) b[o++]; }
  }
  return { sig: types[funcTypes[bi]], locals, lines, calls: [...calls], byteSize: end - bodies[bi].start };
}

function nameOf(M, idx) { return M.exportsByIndex[idx] ? " <" + M.exportsByIndex[idx] + ">" : (idx < M.importedFuncs ? " <import " + M.imports[idx].m + "." + M.imports[idx].f + ">" : ""); }

// numeric/comparison/conversion opcode names (the bread-and-butter)
const OPN = {
  0x45: "i32.eqz", 0x46: "i32.eq", 0x47: "i32.ne", 0x48: "i32.lt_s", 0x49: "i32.lt_u", 0x4a: "i32.gt_s", 0x4b: "i32.gt_u", 0x4c: "i32.le_s", 0x4d: "i32.le_u", 0x4e: "i32.ge_s", 0x4f: "i32.ge_u",
  0x50: "i64.eqz", 0x51: "i64.eq", 0x52: "i64.ne", 0x53: "i64.lt_s", 0x54: "i64.lt_u", 0x55: "i64.gt_s", 0x56: "i64.gt_u", 0x57: "i64.le_s", 0x58: "i64.le_u", 0x59: "i64.ge_s", 0x5a: "i64.ge_u",
  0x5b: "f32.eq", 0x5c: "f32.ne", 0x5d: "f32.lt", 0x5e: "f32.gt", 0x5f: "f32.le", 0x60: "f32.ge",
  0x61: "f64.eq", 0x62: "f64.ne", 0x63: "f64.lt", 0x64: "f64.gt", 0x65: "f64.le", 0x66: "f64.ge",
  0x67: "i32.clz", 0x68: "i32.ctz", 0x69: "i32.popcnt", 0x6a: "i32.add", 0x6b: "i32.sub", 0x6c: "i32.mul", 0x6d: "i32.div_s", 0x6e: "i32.div_u", 0x6f: "i32.rem_s", 0x70: "i32.rem_u", 0x71: "i32.and", 0x72: "i32.or", 0x73: "i32.xor", 0x74: "i32.shl", 0x75: "i32.shr_s", 0x76: "i32.shr_u", 0x77: "i32.rotl", 0x78: "i32.rotr",
  0x79: "i64.clz", 0x7a: "i64.ctz", 0x7b: "i64.popcnt", 0x7c: "i64.add", 0x7d: "i64.sub", 0x7e: "i64.mul", 0x7f: "i64.div_s", 0x80: "i64.div_u", 0x81: "i64.rem_s", 0x82: "i64.rem_u", 0x83: "i64.and", 0x84: "i64.or", 0x85: "i64.xor", 0x86: "i64.shl", 0x87: "i64.shr_s", 0x88: "i64.shr_u", 0x89: "i64.rotl", 0x8a: "i64.rotr",
  0x8b: "f32.abs", 0x8c: "f32.neg", 0x8d: "f32.ceil", 0x8e: "f32.floor", 0x8f: "f32.trunc", 0x90: "f32.nearest", 0x91: "f32.sqrt", 0x92: "f32.add", 0x93: "f32.sub", 0x94: "f32.mul", 0x95: "f32.div", 0x96: "f32.min", 0x97: "f32.max", 0x98: "f32.copysign",
  0x99: "f64.abs", 0x9a: "f64.neg", 0x9b: "f64.ceil", 0x9c: "f64.floor", 0x9d: "f64.trunc", 0x9e: "f64.nearest", 0x9f: "f64.sqrt", 0xa0: "f64.add", 0xa1: "f64.sub", 0xa2: "f64.mul", 0xa3: "f64.div", 0xa4: "f64.min", 0xa5: "f64.max", 0xa6: "f64.copysign",
  0xa7: "i32.wrap_i64", 0xa8: "i32.trunc_f32_s", 0xa9: "i32.trunc_f32_u", 0xaa: "i32.trunc_f64_s", 0xab: "i32.trunc_f64_u", 0xac: "i64.extend_i32_s", 0xad: "i64.extend_i32_u", 0xae: "i64.trunc_f32_s", 0xaf: "i64.trunc_f32_u", 0xb0: "i64.trunc_f64_s", 0xb1: "i64.trunc_f64_u",
  0xb2: "f32.convert_i32_s", 0xb3: "f32.convert_i32_u", 0xb4: "f32.convert_i64_s", 0xb5: "f32.convert_i64_u", 0xb6: "f32.demote_f64", 0xb7: "f64.convert_i32_s", 0xb8: "f64.convert_i32_u", 0xb9: "f64.convert_i64_s", 0xba: "f64.convert_i64_u", 0xbb: "f64.promote_f32",
  0xbc: "i32.reinterpret_f32", 0xbd: "i64.reinterpret_f64", 0xbe: "f32.reinterpret_i32", 0xbf: "f64.reinterpret_i64",
  0xc0: "i32.extend8_s", 0xc1: "i32.extend16_s", 0xc2: "i64.extend8_s", 0xc3: "i64.extend16_s", 0xc4: "i64.extend32_s"
};

module.exports = { parse, decodeBody, nameOf };

if (require.main === module) {
  const M = parse();
  const total = M.importedFuncs + M.funcTypes.length;
  // call graph + sizes
  const info = [];
  for (let fi = M.importedFuncs; fi < total; fi++) {
    const d = decodeBody(M, fi);
    if (!d) continue;
    info.push({ idx: fi, size: d.byteSize, nLines: d.lines.length, calls: d.calls, sig: d.sig, exp: M.exportsByIndex[fi] });
  }
  const cmd = process.argv[2];
  if (cmd === "map") {
    info.sort((a, b) => a.size - b.size);
    console.log("idx  size  lines  calls  sig");
    for (const f of info.slice(0, 40)) {
      const sig = "(" + (f.sig ? f.sig.params.join(",") : "?") + ")->" + (f.sig && f.sig.results.length ? f.sig.results.join(",") : "void");
      console.log(String(f.idx).padStart(4), String(f.size).padStart(5), String(f.nLines).padStart(5), String(f.calls.length).padStart(5), " ", sig, f.exp ? "<" + f.exp + ">" : "");
    }
    const leaves = info.filter(f => f.calls.length === 0);
    console.log("\nLEAF functions (call nothing):", leaves.length, "of", info.length);
    console.log("smallest leaves:", leaves.sort((a, b) => a.size - b.size).slice(0, 25).map(f => f.idx + "(" + f.size + "b)").join(" "));
  } else if (cmd === "fn") {
    const fi = parseInt(process.argv[3], 10);
    const d = decodeBody(M, fi);
    const sig = "(" + d.sig.params.map((p, i) => "p" + i + ":" + p).join(", ") + ") -> " + (d.sig.results.join(",") || "void");
    console.log("func " + fi + (M.exportsByIndex[fi] ? " <" + M.exportsByIndex[fi] + ">" : "") + " " + sig);
    console.log("locals: " + d.locals.map((t, i) => "L" + (d.sig.params.length + i) + ":" + t).join(", "));
    console.log("size " + d.byteSize + "b, calls: [" + d.calls.join(",") + "]");
    console.log("----");
    console.log(d.lines.join("\n"));
  } else {
    console.log("usage: node disasm.js map        # smallest funcs + leaves");
    console.log("       node disasm.js fn <idx>   # disassemble one function");
  }