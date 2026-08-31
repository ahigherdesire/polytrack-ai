};
// Input-timeline handling: TAS script text <-> control entries <-> 5-channel
// toggle arrays <-> the game's recording string.
//
// Control mask bits (same order as the CarState controlByte and the wasm
// updateCarModel args): 1=up(w) 2=right(d) 4=down(s) 8=left(a) 16=reset(r).
// Channel order in recordings: [up, right, down, left, reset].
// Physics runs at 1000 fps, so frame numbers are milliseconds.
"use strict";

const KEY_TO_BIT = { w: 1, d: 2, s: 4, a: 8, r: 16 };
const BIT_TO_KEY = ["w", "d", "s", "a", "r"];

function maskFromKeys(keys) {
  let m = 0;
  for (const ch of (keys || "").toLowerCase()) {
    const b = KEY_TO_BIT[ch];
    if (b == null) {
      if (ch === " " || ch === "\t") continue;
      throw new Error("Unknown key letter: " + ch);
    }
    m |= b;
  }
  return m;
}

function keysFromMask(mask) {
  let s = "";
  for (let i = 0; i < 5; i++) if (mask & (1 << i)) s += BIT_TO_KEY[i];
  return s;
}

// ---- script text -> entries -------------------------------------------------
// Format (state-based; see tas/README.md):
//   frame,keys        hold exactly `keys` from frame on ("" or "none" = none)
//   tap S E KEYS ON OFF   between S and E alternate KEYS for ON frames and the
//                         previous state for OFF frames
//   # comment
function parseScript(text) {
  const plain = [];
  const taps = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    let line = lines[ln].trim();
    if (!line || line.startsWith("#")) continue;
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash).trim();
    if (!line) continue;
    if (/^tap\s/i.test(line)) {
      const p = line.split(/\s+/);
      if (p.length !== 6) throw new Error("Bad tap line " + (ln + 1) + ": " + line);
      const start = Number(p[1]), end = Number(p[2]);
      const keys = p[3] === "none" ? "" : p[3];
      const on = Number(p[4]), off = Number(p[5]);
      if (!(start >= 0 && end > start && on > 0 && off >= 0)) {
        throw new Error("Bad tap parameters line " + (ln + 1) + ": " + line);
      }
      taps.push({ start, end, mask: maskFromKeys(keys), on, off });
      continue;
    }
    const m = line.match(/^(\d+)\s*,\s*([wasdr]*|none)$/i);
    if (!m) throw new Error("Bad script line " + (ln + 1) + ": " + line);
    plain.push({ frame: Number(m[1]), mask: m[2].toLowerCase() === "none" ? 0 : maskFromKeys(m[2]) });
  }
  plain.sort((a, b) => a.frame - b.frame);
  // Dedupe same-frame entries (last wins, like the game tool).
  const entries = [];
  for (const e of plain) {
    if (entries.length && entries[entries.length - 1].frame === e.frame) entries[entries.length - 1].mask = e.mask;
    else entries.push({ frame: e.frame, mask: e.mask });
  }
  // Pass 2: expand taps against the plain-state timeline.
  for (const t of taps) {
    const prev = stateAt(entries, t.start - 1);
    if (t.mask === prev) continue; // tapped keys must differ from held state
    const period = t.on + t.off;
    const toAdd = [];
    for (let f = t.start; f < t.end; f += period) {
      toAdd.push({ frame: f, mask: t.mask });
      const offAt = f + t.on;
      if (offAt < t.end) toAdd.push({ frame: offAt, mask: prev });
    }
    const endState = stateAt(entries, t.end);
    for (const e of toAdd) insertEntry(entries, e.frame, e.mask);
    insertEntry(entries, t.end, endState);
  }
  return entries;
}

function stateAt(entries, frame) {
  let s = 0;
  for (const e of entries) {
    if (e.frame > frame) break;
    s = e.mask;
  }
  return s;
}

function insertEntry(entries, frame, mask) {
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].frame < frame) lo = mid + 1;
    else hi = mid;
  }
  if (lo < entries.length && entries[lo].frame === frame) entries[lo].mask = mask;
  else entries.splice(lo, 0, { frame, mask });
}

// ---- entries <-> channels ---------------------------------------------------
function entriesToChannels(entries) {
  const ch = [[], [], [], [], []];
  let cur = 0;
  for (const e of entries) {
    const diff = cur ^ e.mask;
    if (!diff) continue;
    for (let b = 0; b < 5; b++) {
      if (diff & (1 << b)) ch[b].push(e.frame);
    }
    cur = e.mask;
  }
  return ch;
}

function channelsToEntries(channels) {
  const events = new Map();
  for (let b = 0; b < 5; b++) {
    for (const f of channels[b] || []) {
      events.set(f, (events.get(f) || 0) | (1 << b));
    }
  }
  const frames = Array.from(events.keys()).sort((a, b) => a - b);
  const entries = [];
  let cur = 0;
  for (const f of frames) {
    cur ^= events.get(f);
    entries.push({ frame: f, mask: cur });
  }
  return entries;
}

// Mask held at `frame` given toggle channels.
function maskAtFrame(channels, frame) {
  let m = 0;
  for (let b = 0; b < 5; b++) {
    const a = channels[b] || [];
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= frame) lo = mid + 1;
      else hi = mid;
    }
    if (lo & 1) m |= 1 << b;
  }
  return m;
}

// ---- entries -> script text -------------------------------------------------
function entriesToScript(entries, header) {
  const out = [];
  if (header) out.push("# " + header);
  for (const e of entries) out.push(e.frame + "," + keysFromMask(e.mask));
  return out.join("\n") + "\n";
}

// ---- recording strings (via the worker's own Recording class) --------------
function channelsToRecordingString(sim, channels) {
  const Rec = sim.Recording;
  const rec = new Rec({
    up: (channels[0] || []).slice(),
    right: (channels[1] || []).slice(),
    down: (channels[2] || []).slice(),
    left: (channels[3] || []).slice(),
    reset: (channels[4] || []).slice(),
  });
  return rec.serialize();
}

function recordingStringToChannels(sim, str, maxFrame) {
  const Rec = sim.Recording;
  const rec = Rec.deserialize(str);
  if (!rec) throw new Error("Recording.deserialize failed");
  const ch = [[], [], [], [], []];
  let prev = [false, false, false, false, false];
  const names = ["up", "right", "down", "left", "reset"];
  const limit = maxFrame != null ? maxFrame : 120000;
  for (let f = 0; f <= limit; f++) {
    const c = rec.getFrame(f);
    for (let b = 0; b < 5; b++) {
      const v = !!c[names[b]];
      if (v !== prev[b]) { ch[b].push(f); prev[b] = v; }
    }
  }
  return ch;
}

module.exports = {
  KEY_TO_BIT, BIT_TO_KEY,
  maskFromKeys, keysFromMask,
  parseScript, stateAt, insertEntry,
  entriesToChannels, channelsToEntries, maskAtFrame,
  entriesToScript,
  channelsToRecordingString, recordingStringToChannels,
