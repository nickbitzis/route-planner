// Runs the solvers and the dynamic day off the main thread.
import { compute } from "./run.js";

self.onmessage = (e) => {
  const { id, cfg } = e.data;
  compute(cfg, (msg) => self.postMessage({ id, ...msg }));
};
