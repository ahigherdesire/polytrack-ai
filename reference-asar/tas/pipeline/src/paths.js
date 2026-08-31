};
// Central path resolution. The pipeline lives in <game>/tas/pipeline, so the
// game root (main.bundle.js, simulation_worker.bundle.js, models/, lib/, tracks/)
// is two levels up. Override with POLYTRACK_ROOT if the layout ever changes.
"use strict";
const path = require("path");
const fs = require("fs");

const GAME_ROOT = process.env.POLYTRACK_ROOT || path.resolve(__dirname, "..", "..", "..");

function gamePath(...parts) {
  return path.join(GAME_ROOT, ...parts);
}

function mustExist(p, what) {
  if (!fs.existsSync(p)) throw new Error("Missing " + (what || "file") + ": " + p);
  return p;
}

module.exports = {
  GAME_ROOT,
  gamePath,
  mustExist,
  MAIN_BUNDLE: gamePath("main.bundle.js"),
  SIM_WORKER_BUNDLE: gamePath("simulation_worker.bundle.js"),
  PHYSICS_WASM: gamePath("polytrack_physics.wasm"),
  PHYSICS_GLUE: gamePath("lib", "polytrack_physics.js"),
  DRACO_WRAPPER: gamePath("lib", "draco", "draco_wasm_wrapper.js"),
  DRACO_WASM: gamePath("lib", "draco", "draco_decoder.wasm"),
  MODELS_DIR: gamePath("models"),
  TRACKS_DIR: gamePath("tracks"),
  PIPELINE_ROOT: path.resolve(__dirname, ".."),
  CONTEXT_DIR: path.resolve(__dirname, "..", "context"),
  CONTEXT_FILE: path.resolve(__dirname, "..", "context", "init-context.json"),
  GENERATED_DIR: path.resolve(__dirname, "..", "generated"),
  HEADLESS_WORKER: path.resolve(__dirname, "..", "generated", "sim_worker_headless.js"),
