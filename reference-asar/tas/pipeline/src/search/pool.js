};
// Tiny worker_threads pool with request/response semantics.
"use strict";
const { Worker } = require("worker_threads");
const path = require("path");

class Pool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.pending = new Map();
    this.nextId = 1;
    for (let i = 0; i < size; i++) {
      const w = new Worker(path.join(__dirname, "worker-host.js"));
      w.on("message", (msg) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error("[worker " + p.worker + "] " + msg.error));
        else p.resolve(msg.result);
      });
      w.on("error", (err) => {
        for (const [id, p] of this.pending) {
          if (p.worker === i) { this.pending.delete(id); p.reject(err); }
        }
      });
      this.workers.push(w);
    }
  }

  call(workerIndex, cmd, args) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: workerIndex });
      this.workers[workerIndex].postMessage({ id, cmd, args });
    });
  }

  // Same command on every worker (args may be per-worker via function).
  broadcast(cmd, argsOrFn) {
    return Promise.all(this.workers.map((_, i) =>
      this.call(i, cmd, typeof argsOrFn === "function" ? argsOrFn(i) : argsOrFn)
    ));
  }

  async destroy() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}

module.exports = { Pool 