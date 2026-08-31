);
// Engine-layer tests: boot, wasm determinism, replay determinism,
// snapshot/restore bit-equality, channel stepping equivalence, and the
// game's own Verify oracle plumbing.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const paths = require("../src/paths");
const { HeadlessSim } = require("../src/engine/sim");

const TRACK = fs.readFileSync(path.join(paths.TRACKS_DIR, "official", "summer1.track"), "utf8").trim();

let sim;
test.before(async () => {
  sim = await HeadlessSim.create();
});

function traceHash(sim, script, frames, sampleEvery = 50) {
  const h = crypto.createHash("sha256");
  sim.resetCar();
  const buf = Buffer.alloc(32);
  for (let f = 0; f < frames; f++) {
    const st = sim.stepMask(script(f));
    if (f % sampleEvery === 0 || f === frames - 1) {
      buf.writeFloatLE(st.x, 0); buf.writeFloatLE(st.y, 4); buf.writeFloatLE(st.z, 8);
      buf.writeFloatLE(st.qx, 12); buf.writeFloatLE(st.qy, 16); buf.writeFloatLE(st.qz, 20);
      buf.writeFloatLE(st.speedKmh, 24); buf.writeUInt32LE(st.frames, 28);
      h.update(buf);
    }
  }
  return h.digest("hex");
}

// A little scripted run: throttle, then throttle+steer alternations.
const SCRIPT = (f) => {
  if (f < 800) return 1;            // w
  if (f < 1600) return 1 | 8;       // w+a
  if (f < 2400) return 1 | 2;       // w+d
  if (f < 3000) return (f % 20 < 10) ? 1 : (1 | 2); // tap right
  return 1;
};

test("wasm testDeterminism passes", () => {
  const before = sim.messages.length;
  sim._H.dispatch({ data: { messageType: sim.MessageType.TestDeterminism } });
  const res = sim.messages.slice(before).find((m) => m.messageType === sim.MessageType.DeterminismResult);
  assert.ok(res, "no DeterminismResult");
  assert.strictEqual(res.isDeterminstic, true);
});

test("loads all official tracks and spawns cars", () => {
  const dir = path.join(paths.TRACKS_DIR, "official");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".track"));
  assert.ok(files.length >= 15);
  for (const f of files) {
    const save = fs.readFileSync(path.join(dir, f), "utf8").trim();
    const track = sim.loadTrack(save);
    assert.ok(track.getStartTransform(), f + " has no start");
    const parts = sim.trackParts();
    assert.ok(parts.length > 0, f + " has no parts");
    sim.spawnCar();
    const st = sim.stepMask(1);
    assert.strictEqual(st.frames, 1);
    sim.deleteCar();
  }
});

test("identical inputs give bit-identical trajectories (recreate determinism)", () => {
  sim.loadTrack(TRACK);
  sim.spawnCar();
  const a = traceHash(sim, SCRIPT, 3000);
  const b = traceHash(sim, SCRIPT, 3000);
  assert.strictEqual(a, b);
});

test("snapshot/restore continues bit-identically", () => {
  sim.loadTrack(TRACK);
  sim.resetCar();
  for (let f = 0; f < 1500; f++) sim.stepMask(SCRIPT(f));
  const snap = sim.snapshot();

  const cont = [];
  for (let f = 1500; f < 3200; f++) {
    const st = sim.stepMask(SCRIPT(f));
    if (f % 37 === 0) cont.push(st.x, st.y, st.z, st.qw, st.speedKmh);
  }

  sim.restore(snap);
  assert.strictEqual(sim.car.frames, 1500);
  const cont2 = [];
  for (let f = 1500; f < 3200; f++) {
    const st = sim.stepMask(SCRIPT(f));
    if (f % 37 === 0) cont2.push(st.x, st.y, st.z, st.qw, st.speedKmh);
  }
  assert.deepStrictEqual(cont2, cont);

  // and restoring twice still works
  sim.restore(snap);
  const cont3 = [];
  for (let f = 1500; f < 3200; f++) {
    const st = sim.stepMask(SCRIPT(f));
    if (f % 37 === 0) cont3.push(st.x, st.y, st.z, st.qw, st.speedKmh);
  }
  assert.deepStrictEqual(cont3, cont);
});

test("snapshot/restore trajectory equals uninterrupted run", () => {
  sim.loadTrack(TRACK);
  const straight = traceHash(sim, SCRIPT, 3200, 37);

  sim.resetCar();
  const h = crypto.createHash("sha256");
  const buf = Buffer.alloc(32);
  const record = (st, f) => {
    if (f % 37 === 0 || f === 3199) {
      buf.writeFloatLE(st.x, 0); buf.writeFloatLE(st.y, 4); buf.writeFloatLE(st.z, 8);
      buf.writeFloatLE(st.qx, 12); buf.writeFloatLE(st.qy, 16); buf.writeFloatLE(st.qz, 20);
      buf.writeFloatLE(st.speedKmh, 24); buf.writeUInt32LE(st.frames, 28);
      h.update(buf);
    }
  };
  for (let f = 0; f < 1000; f++) record(sim.stepMask(SCRIPT(f)), f);
  const snap = sim.snapshot();
  sim.restore(snap); // immediate restore must be a no-op for the trajectory
  for (let f = 1000; f < 3200; f++) record(sim.stepMask(SCRIPT(f)), f);
  assert.strictEqual(h.digest("hex"), straight);
});

test("runChannels equals manual mask stepping", () => {
  const { parseScript, entriesToChannels } = require("../src/engine/recording");
  const scriptText = "0,w\n800,wa\n1600,wd\ntap 2400 3000 wd 10 10\n3000,w\n";
  const entries = parseScript(scriptText);
  const channels = entriesToChannels(entries);

  sim.loadTrack(TRACK);
  sim.resetCar();
  const states1 = [];
  sim.runChannels(channels, 3500, (st, f) => { if (f % 100 === 0) states1.push(st.x, st.z, st.speedKmh); });

  sim.resetCar();
  const { maskAtFrame } = require("../src/engine/recording");
  const states2 = [];
  for (let f = 0; f < 3500; f++) {
    const st = sim.stepMask(maskAtFrame(channels, f));
    if (f % 100 === 0) states2.push(st.x, st.z, st.speedKmh);
  }
  assert.deepStrictEqual(states1, states2);
});

test("reset without a passed checkpoint is a physics no-op (full restarts live above the wasm)", () => {
  sim.loadTrack(TRACK);
  sim.resetCar();
  const st0 = sim.stepMask(0);
  const x0 = st0.x, z0 = st0.z;
  for (let f = 0; f < 2000; f++) sim.stepMask(1);
  const moved = sim.fastState();
  assert.ok(Math.abs(moved.x - x0) + Math.abs(moved.z - z0) > 1, "car did not move");
  assert.strictEqual(moved.hasCheckpointToRespawnAt || false, false);
  // Reset only teleports to a checkpoint the car has passed; with none, the
  // car keeps rolling. (In-game "restart" deletes + recreates the car, which
  // is HeadlessSim.resetCar().)
  const before = sim.fastState().frames;
  for (let f = 0; f < 20; f++) sim.stepMask(16);
  const st = sim.stepMask(0);
  assert.strictEqual(st.frames, before + 21, "physics kept stepping through reset");
  assert.ok(Math.abs(st.x - x0) + Math.abs(st.z - z0) > 1, "car should NOT teleport to start");
});

test("mountain generation is deterministic and plausible", () => {
  const { createMountainVertices } = require("../src/engine/mountains");
  const ctx = sim.context;
  const bounds = { min: { x: -10, y: -10 }, max: { x: 10, y: 10 } };
  const a = createMountainVertices(bounds, ctx);
  const b = createMountainVertices(bounds, ctx);
  assert.deepStrictEqual(a, b);
  assert.ok(a.vertices.length > 1000);
  assert.strictEqual(a.vertices.length % 9, 0, "vertices not whole triangles");
  // Every ring triangle sits at radius >= n(=200 for small bounds) - epsilon
  assert.strictEqual(a.offset.x, 0);
  // Giant track => no mountains (game behavior)
  const huge = createMountainVertices({ min: { x: -2000, y: -2000 }, max: { x: 2000, y: 2000 } }, ctx);
  assert.deepStrictEqual(huge.vertices, []);
}