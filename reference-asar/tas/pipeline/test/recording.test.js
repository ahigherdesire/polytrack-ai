);
// Script parsing / channel conversion / recording codec round-trips —
// including a round-trip through the game's own Recording class.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const rec = require("../src/engine/recording");

test("mask/keys round trip", () => {
  assert.strictEqual(rec.maskFromKeys("w"), 1);
  assert.strictEqual(rec.maskFromKeys("wd"), 3);
  assert.strictEqual(rec.maskFromKeys("wasdr"), 31);
  assert.strictEqual(rec.keysFromMask(rec.maskFromKeys("war")), "wa" + "r");
  assert.strictEqual(rec.maskFromKeys(""), 0);
  assert.throws(() => rec.maskFromKeys("x"));
});

test("parseScript basics + dedupe + comments", () => {
  const entries = rec.parseScript("# hi\n0,w\n\n100,wa # inline\n100,wd\n50,none\n");
  assert.deepStrictEqual(entries, [
    { frame: 0, mask: 1 },
    { frame: 50, mask: 0 },
    { frame: 100, mask: 3 },
  ]);
});

test("tap expansion matches documented semantics", () => {
  // hold w, tap right (wd) 10 on / 5 off between 1500 and 1540
  const entries = rec.parseScript("0,w\ntap 1500 1540 wd 10 5\n2000,w\n");
  // expansion: 1500 wd, 1510 w, 1515 wd, 1525 w, 1530 wd, 1540 (end state = w)
  const at = (f) => rec.stateAt(entries, f);
  assert.strictEqual(at(1499), 1);
  assert.strictEqual(at(1500), 3);
  assert.strictEqual(at(1509), 3);
  assert.strictEqual(at(1510), 1);
  assert.strictEqual(at(1514), 1);
  assert.strictEqual(at(1515), 3);
  assert.strictEqual(at(1540), 1);
  assert.strictEqual(at(3000), 1);
});

test("tap with same keys as held state is a no-op", () => {
  const a = rec.parseScript("0,w\ntap 100 200 w 5 5\n");
  assert.deepStrictEqual(a, [{ frame: 0, mask: 1 }]);
});

test("entries<->channels round trip", () => {
  const entries = [
    { frame: 0, mask: 1 },
    { frame: 100, mask: 3 },
    { frame: 200, mask: 2 },
    { frame: 300, mask: 0 },
    { frame: 400, mask: 17 },
  ];
  const ch = rec.entriesToChannels(entries);
  assert.deepStrictEqual(ch[0], [0, 200, 400]); // up toggles (mask 2 at f200 drops up)
  assert.deepStrictEqual(ch[1], [100, 300]);    // right toggles
  const back = rec.channelsToEntries(ch);
  assert.deepStrictEqual(back, entries);
  for (const f of [0, 50, 100, 150, 250, 350, 450]) {
    assert.strictEqual(rec.maskAtFrame(ch, f), rec.stateAt(entries, f), "frame " + f);
  }
});

test("recording string round-trips through the game's Recording class", async () => {
  const { HeadlessSim } = require("../src/engine/sim");
  const sim = await HeadlessSim.create();
  const entries = rec.parseScript("0,w\n500,wa\n1000,wd\ntap 1500 1800 wds 7 3\n1800,w\n2500,none\n");
  const channels = rec.entriesToChannels(entries);
  const str = rec.channelsToRecordingString(sim, channels);
  assert.ok(typeof str === "string" && str.length > 0);
  assert.ok(!/[+/=]/.test(str), "must be base64url");

  // Decode with the game's class and compare per-frame controls.
  const Rec = sim.Recording;
  const decoded = Rec.deserialize(str);
  assert.ok(decoded);
  for (let f = 0; f <= 2600; f += 13) {
    const c = decoded.getFrame(f);
    const mask = (c.up ? 1 : 0) | (c.right ? 2 : 0) | (c.down ? 4 : 0) | (c.left ? 8 : 0) | (c.reset ? 16 : 0);
    assert.strictEqual(mask, rec.maskAtFrame(channels, f), "frame " + f);
  }

  const back = rec.recordingStringToChannels(sim, str, 3000);
  assert.deepStrictEqual(back, channels);
}