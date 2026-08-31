fRH# polytrack_physics.wasm → JS port (incremental, verified 1-to-1)

Goal: slowly rewrite the physics WASM into readable JS, **one function at a time**,
proving each port is **bit-identical** to the real wasm before moving on. If a port
ever fails to match, we keep the wasm — nothing in the game changes until a port is
proven. The production `polytrack_physics.wasm` is **never modified**.

Backups: `../polytrack_physics.wasm.orig.bak`, `../lib/polytrack_physics.js.orig.bak`.

## Why this is feasible
- The wasm is **self-contained + deterministic**: its 9 imports are only Emscripten
  runtime (exceptions/abort/timer/console/heap-grow) — **the libm is inside the wasm**.
  So running it in Node gives the exact same bits as the browser.
- Node can instantiate the wasm → we get a **perfect verification oracle** locally.

## The toolkit
- `load.js` — instantiate the real wasm in Node with stub imports. `node load.js` self-test.
- `disasm.js` — minimal wasm disassembler + call graph.
  - `node disasm.js map` — smallest funcs + list of leaf functions (call nothing).
  - `node disasm.js fn <idx>` — disassemble one function (stack-machine listing).
- `ports.js` — the accumulating set of **verified** JS ports (registry by func index).
- `verify.js` — adds temporary exports for the ported indices, runs wasm vs JS over
  tens of thousands of inputs, asserts **bit-equality** (f32/f64 bit patterns). `node verify.js`.

## Module facts
- 549 internal functions (+9 imported), 376 KB code, 17.7 KB data.
- Exports (glue `lib/polytrack_physics.js`): `l`=malloc `m`=free `n`=initializeCarCollisionShape
  `o`=addTrackPartConfiguration `p`=createCarModel `q`=deleteCarModel `r`=updateCarModel
  `s`=testDeterminism `k`=__wasm_call_ctors, memory=`j`. **273 functions are leaves.**
- Only 4 functions pass `f64` across the call boundary — the physics is mostly `f32`/inlined.

## Verified so far  ✅ (bit-identical, see `node verify.js`)
| idx | name | sig | what |
|----:|------|-----|------|
| 26 | `__sindf` | (f64)->f32 | single-precision **sine** kernel (musl polynomial) |
| 27 | `__cosdf` | (f64)->f32 | single-precision **cosine** kernel |
| 58 | `scalbn`  | (f64,i32)->f64 | x·2ⁿ with overflow/underflow staging |

## Workflow to port the next function
1. `node disasm.js map` → pick a small **leaf** (no calls) to start; build up to callers.
2. `node disasm.js fn <idx>` → read the stack-machine listing.
3. Hand-translate to JS in `ports.js`, **preserving the exact float eval order**
   (WASM stack order = the parenthesization; FP is not associative, so order = bits).
   - `local.tee N` sets local N and leaves the value on the stack.
   - `f32.demote_f64` = `Math.fround(...)`. unsigned compares = `(x >>> 0)`.
   - `select` pops `[val1, val2, cond]` → `cond ? val1 : val2`.
4. Add `{idx:{name,fn,sig,status:"verified"}}` to `PORTS` and a test in `verify.js`.
5. `node verify.js` must print **0 mismatches** before committing the port.

## Notes / next targets
- The transcendentals' **range reduction** (the code that maps any angle into
  [-π/4,π/4] before calling fn26/27) is the next meaningful piece — find the callers
  of 26/27 with `disasm.js` (grep the `map` output / call lists).
- Eventually: a pure-JS `updateCarModel` is the end goal, assembled from verified leaves
  upward. Expect it to be **correct, not faster** — wasm beats JS for hot numeric loops;
  the value here is readability + the ability to modify the physics. Keep the wasm as the
  ground truth and fall back to it any tim