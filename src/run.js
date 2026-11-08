// The full evaluation as plain data, shared by the worker and the main-thread fallback.
import { ALGOS, execute, makeProblem, planView, playDay, solveAll } from "./vrp.js";

const strip = (d) => ({ ...d, servedStops: undefined });

export function compute(cfg, post) {
  const P = makeProblem(cfg);
  const all = solveAll(P, P.cfg);
  const algos = {};
  for (const k of Object.keys(ALGOS)) {
    const { sol, ...rest } = all[k];
    algos[k] = { ...rest, plan: planView(P, sol), unservedStops: sol.unserved.slice() };
  }
  const normal = execute(P, all.alns.sol);
  post({ stage: "plan", algos, normal: { eta: normal.eta, onTime: normal.onTime, cost: normal.cost, vans: normal.vans } });
  const day = {};
  for (const k of ["none", "greedy", "reopt"]) day[k] = strip(playDay(P, all.alns.sol, k));
  post({ stage: "day", day });
}
