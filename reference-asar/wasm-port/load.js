
}
// Node loader for polytrack_physics.wasm — instantiates the REAL module with
// minimal stub imports so ported functions can be verified 1-to-1 against it.
// The physics + libm are entirely inside the wasm (imports are only Emscripten
// runtime), so results here match the browser exactly (deterministic).
const fs = require("fs");
const path = require("path");

function loadPhysics(wasmPath) {
  wasmPath = wasmPath || path.join(__dirname, "..", "polytrack_physics.wasm");
  const bytes = fs.readFileSync(wasmPath);
  const mod = new WebAssembly.Module(bytes);

  let inst = null;
  const memGrow = (delta) => { try { return exportsMem().grow(delta); } catch (e) { return -1; } };
  function exportsMem() { return inst.exports.j; } // exported memory is "j"

  // Mirror the glue's `a` import object (Emscripten env), stubbed.
  const imports = {
    a: {
      a: (t, r, e) => { throw new Error("wasm exception " + t); }, // __cxa_throw
      b: (code) => { throw new Error("exit(" + code + ")"); },     // exit
      c: () => {},                                                  // noExit clear
      d: (id, ms) => 0,                                             // setTimeout
      e: () => { throw new Error("abort()"); },                     // abort
      f: (requested) => {                                           // emscripten_resize_heap
        const mem = exportsMem();
        const cur = mem.buffer.byteLength;
        if (requested <= cur) return 1;
        const need = Math.ceil((requested - cur) / 65536);
        try { mem.grow(need); return 1; } catch (e) { return 0; }
      },
      g: (fd, iov, iovcnt, pnum) => 0,                              // fd_write
      h: () => 0,                                                   // Date.now (unused by physics)
      i: (msg, file, line, fn) => { throw new Error("assert fail"); }
    }
  };

  inst = new WebAssembly.Instance(mod, imports);
  const ex = inst.exports;
  // run __wasm_call_ctors (export "k")
  if (typeof ex.k === "function") ex.k();

  // Named view matching the glue's mapping
  return {
    instance: inst,
    exports: ex,
    mem: ex.j,
    HEAPU8: () => new Uint8Array(ex.j.buffer),
    HEAPF32: () => new Float32Array(ex.j.buffer),
    HEAPF64: () => new Float64Array(ex.j.buffer),
    HEAP32: () => new Int32Array(ex.j.buffer),
    malloc: ex.l,
    free: ex.m,
    initializeCarCollisionShape: ex.n,
    addTrackPartConfiguration: ex.o,
    createCarModel: ex.p,
    deleteCarModel: ex.q,
    updateCarModel: ex.r,
    testDeterminism: ex.s,
    table: ex.__indirect_function_table
  };
}

module.exports = { loadPhysics };

if (require.main === module) {
  const P = loadPhysics();
  const exNames = Object.keys(P.exports);
  console.log("instantiated OK. exports:", exNames.join(", "));
  console.log("memory bytes:", P.mem.buffer.byteLength);
  console.log("table length:", P.table ? P.table.length : "n/a");
  // sanity: testDeterminism is self-contained (no track needed). Try calling it.
  try {
    const r = P.testDeterminism ? P.testDeterminism() : "(no export)";
    console.log("testDeterminism() ->", r);
  } catch (e) { console.log("testDeterminism threw:", e.message); }