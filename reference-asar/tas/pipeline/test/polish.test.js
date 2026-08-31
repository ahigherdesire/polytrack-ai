);
// Polisher tests: evaluation, early-abort split gating, mutation windows,
// masks<->entries round trips.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Polisher, entriesToMasks, masksToEntries } = require("../src/search/polish");

test("entriesToMasks / masksToEntries round trip", () => {
  const entries = [
    { frame: 0, mask: 1 },
    { frame: 100, mask: 3 },
    { frame: 250, mask: 0 },
    { frame: 400, mask: 9 },
  ];
  const masks = entriesToMasks(entries, 500);
  assert.strictEqual(masks[0], 1);
  assert.strictEqual(masks[99], 1);
  assert.strictEqual(masks[100], 3);
  assert.strictEqual(masks[249], 3);
  assert.strictEqual(masks[250], 0);
  assert.strictEqual(masks[499], 9);
  const back = masksToEntries(masks);
  assert.deepStrictEqual(back, entries);
});

test("mutations stay inside the window", () => {
  const p = new Polisher({ /* sim unused for mutate */ }, { seed: 99 });
  const base = new Uint8Array(1000).fill(1);
  for (let i = 0; i < 200; i++) {
    const out = p.mutate(base, 300, 400);
    for (let f = 0; f < 300; f++) assert.strictEqual(out[f], base[f], "mutated before window at " + f);
    for (let f = 400; f < 1000; f++) assert.strictEqual(out[f], base[f], "mutated after window at " + f);
  }
});

test("mutations only touch the 4 driving bits", () => {
  const p = new Polisher({}, { seed: 123 });
  const base = new Uint8Array(500);
  for (let i = 0; i < 100; i++) {
    const out = p.mutate(base, 0, 500);
    for (let f = 0; f < 500; f++) {
      assert.strictEqual(out[f] & ~15, 0, "non-driving bit set at " + f);
    }
  }
}