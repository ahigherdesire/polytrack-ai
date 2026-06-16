// Tiny MLP policy: observation -> 4 control probabilities (up, down, left, right).
// Weights are a flat Float64Array so Evolution Strategies can perturb them directly.
class Policy {
  constructor(nIn, nH, nOut) {
    this.nIn = nIn; this.nH = nH; this.nOut = nOut;
    this.n = nIn * nH + nH + nH * nOut + nOut;   // W1,b1,W2,b2
    this.w = new Float64Array(this.n);
  }

  setWeights(arr) { this.w.set(arr); return this; }

  forward(x) {
    const { nIn, nH, nOut, w } = this;
    let p = 0;
    const h = new Float64Array(nH);
    for (let j = 0; j < nH; j++) { let s = 0; for (let i = 0; i < nIn; i++) s += w[p++] * x[i]; h[j] = s; }
    for (let j = 0; j < nH; j++) h[j] = Math.tanh(h[j] + w[p++]);
    const out = new Float64Array(nOut);
    for (let k = 0; k < nOut; k++) { let s = 0; for (let j = 0; j < nH; j++) s += w[p++] * h[j]; out[k] = s; }
    for (let k = 0; k < nOut; k++) out[k] = 1 / (1 + Math.exp(-(out[k] + w[p++])));
    return out;
  }

  // Map network outputs to the game's controls.
  act(x) {
    const o = this.forward(x);
    const up = o[0] > 0.5, down = !up && o[1] > 0.5;
    return { up, down, left: o[2] > 0.5, right: o[3] > 0.5, reset: false };
  }
}

module.exports = { Policy };
