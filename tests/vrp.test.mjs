import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONGESTION, DEFAULTS, DYNAMIC_OPTS, EVENT_TIMES, LATE_PEN, LOAD, PARK, SPEED, STATIC_OPTS, UNLOAD, UNSERVED_PEN,
  alns, checkSolution, clamp, cloneSol, congestion, decodeConfig, emptySolution, encodeConfig, etaStats, evalSeq, exchange, execute,
  hash01, insertCost, insertStops, legNoise, localSearch, makeProblem, mulberry32, nearestNeighbor, newRoute, orOpt, playDay, refresh,
  relocate, savings, segmentHitsBox, solCost, staticStops, summarize, sweep, travelTime, twoOpt, withClosure,
} from "../src/vrp.js";

const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const P = makeProblem({ n: 150, seed: 3 });
const NN = nearestNeighbor(P), SW = sweep(P), SV = savings(P);
const LS = localSearch(P, cloneSol(SV));
const AL = alns(P, LS, { iters: 300, seed: 5 });

// A route on the given vehicle with chosen stops, recomputed.
const routeWith = (v, seq, o = STATIC_OPTS) => refresh(P, Object.assign(newRoute(P, v), { seq }), o);
const vehWhere = (f) => P.veh.findIndex(f);

// --- Randomness and the problem ---------------------------------------------------

test("mulberry32 is deterministic and seed dependent", () => {
  const a = mulberry32(9), b = mulberry32(9), c = mulberry32(10);
  const xs = Array.from({ length: 20 }, a);
  assert.deepEqual(xs, Array.from({ length: 20 }, b));
  assert.notDeepEqual(xs, Array.from({ length: 20 }, c));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});

test("hash01 is a stable uniform in [0, 1)", () => {
  assert.equal(hash01(1, 2, 3), hash01(1, 2, 3));
  assert.notEqual(hash01(1, 2, 3), hash01(1, 3, 2));
  const xs = Array.from({ length: 4000 }, (_, i) => hash01(7, i, 11));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
  close(xs.reduce((s, x) => s + x, 0) / xs.length, 0.5, 0.02);
});

test("the problem is reproducible from the seed", () => {
  const a = makeProblem({ n: 150, seed: 3 }), c = makeProblem({ n: 150, seed: 4 });
  assert.deepEqual([...a.xs], [...P.xs]);
  assert.deepEqual([...a.a], [...P.a]);
  assert.deepEqual(a.veh, P.veh);
  assert.notDeepEqual([...a.xs], [...c.xs]);
});

test("stops, windows, demand, and cold orders are in range", () => {
  let cold = 0;
  for (let i = 1; i < P.N; i++) {
    assert.ok(P.xs[i] >= 0 && P.xs[i] <= 30 && P.ys[i] >= 0 && P.ys[i] <= 30);
    assert.ok(P.a[i] >= 8 * 60 && P.b[i] <= 20 * 60 + 30 && P.b[i] - P.a[i] >= 60, `window ${P.a[i]}-${P.b[i]}`);
    assert.ok(P.dem[i] >= 1 && P.dem[i] <= 8);
    assert.ok(P.svc[i] > 4);
    cold += P.cold[i];
  }
  close(cold / P.total, DEFAULTS.cold / 100, 0.08);
  // Orders placed during the day are released at 11:00 with windows from 13:00.
  for (let i = P.n + 1; i < P.N; i++) { assert.equal(P.release[i], EVENT_TIMES.orders); assert.ok(P.a[i] >= 13 * 60); }
  assert.equal(P.total - P.n, Math.round((150 * DEFAULTS.newPct) / 100));
});

test("the fleet has enough refrigerated space and both shifts", () => {
  let cold = 0;
  for (const s of staticStops(P)) if (P.cold[s]) cold += P.dem[s];
  const reeferCap = P.veh.filter((v) => v.reefer).reduce((s, v) => s + v.cap, 0);
  assert.ok(reeferCap >= cold, `${reeferCap} < ${cold}`);
  assert.ok(P.veh.some((v) => v.shift === "Early") && P.veh.some((v) => v.shift === "Late"));
  for (const v of P.veh) assert.ok(v.end - v.start === 9.5 * 60);
});

// --- Travel time -----------------------------------------------------------------

test("congestion peaks at rush hour and interpolates between hours", () => {
  assert.equal(congestion(3 * 60), 1);
  assert.equal(congestion(17 * 60), CONGESTION[17]);
  assert.ok(congestion(17 * 60) > congestion(13 * 60) && congestion(8 * 60) > congestion(11 * 60));
  close(congestion(8 * 60 + 30), (CONGESTION[8] + CONGESTION[9]) / 2, 1e-9);
  for (let t = 0; t < 24 * 60; t++) assert.ok(Math.abs(congestion(t + 1) - congestion(t)) < 0.02);
});

test("travel time is parking plus distance over speed times congestion", () => {
  const i = 3, j = 17, km = P.D[i * P.N + j];
  close(travelTime(P, i, j, 3 * 60), PARK + (km / SPEED) * 60, 1e-9);
  close(travelTime(P, i, j, 17 * 60), PARK + (km / SPEED) * 60 * CONGESTION[17], 1e-9);
  assert.equal(travelTime(P, i, i, 600), 0);
  close(P.D[i * P.N + j], Math.abs(P.xs[i] - P.xs[j]) + Math.abs(P.ys[i] - P.ys[j]), 1e-12);
});

test("the road closure slows only legs that cross it, and only after it starts", () => {
  const Q = withClosure(P);
  let crossing = -1, clear = -1;
  for (let k = 1; k < P.N && (crossing < 0 || clear < 0); k++) {
    if (P.cross[k] && crossing < 0) crossing = k;
    if (!P.cross[k] && clear < 0) clear = k;
  }
  assert.ok(crossing > 0 && clear > 0);
  const t = Q.closure.from + 10;
  close(travelTime(Q, 0, crossing, t) - PARK, (travelTime(P, 0, crossing, t) - PARK) * Q.closure.factor, 1e-9);
  assert.equal(travelTime(Q, 0, clear, t), travelTime(P, 0, clear, t));
  assert.equal(travelTime(Q, 0, crossing, Q.closure.from - 1), travelTime(P, 0, crossing, Q.closure.from - 1));
});

test("segmentHitsBox", () => {
  const box = { x0: 1, x1: 2, y0: 1, y1: 2 };
  assert.ok(segmentHitsBox(0, 1.5, 3, 1.5, box));
  assert.ok(segmentHitsBox(1.2, 1.2, 1.4, 1.4, box));
  assert.ok(!segmentHitsBox(0, 0, 3, 0.5, box));
  assert.ok(!segmentHitsBox(0, 3, 0.5, 0, box));
});

// --- Route evaluation and feasibility -----------------------------------------------

test("a one-stop route is timed and costed by hand", () => {
  const v = vehWhere((x) => x.reefer && x.shift === "Early");
  const s = staticStops(P).find((k) => P.a[k] >= 12 * 60);
  const r = routeWith(v, [s]);
  const veh = P.veh[v];
  const leave = veh.start + LOAD;
  const at = leave + travelTime(P, 0, s, leave);
  const dep = Math.max(at, P.a[s]) + P.svc[s];
  const end = dep + travelTime(P, s, 0, dep) + UNLOAD;
  close(r.arr[0], at, 1e-9);
  close(r.end, end, 1e-9);
  close(r.km, 2 * P.D[s], 1e-9);
  const expect = veh.fixed + ((end - veh.start) / 60) * veh.perHour + Math.max(0, (end - veh.end) / 60) * veh.perHour * 0.5 + r.km * veh.perKm;
  close(r.cost, expect, 1e-9);
  assert.equal(evalSeq(P, newRoute(P, v), [], STATIC_OPTS).cost, 0, "an unused van costs nothing");
});

test("capacity is a hard limit", () => {
  const v = vehWhere((x) => x.reefer);
  const big = staticStops(P).sort((x, y) => P.dem[y] - P.dem[x]);
  const seq = [];
  let load = 0;
  for (const s of big) { if (load > P.veh[v].cap) break; seq.push(s); load += P.dem[s]; }
  const e = evalSeq(P, newRoute(P, v), seq, { maxLate: 1e9, overtime: 1e9 });
  assert.equal(e.load, load);
  assert.ok(!e.ok, "over capacity");
});

test("time windows: late is infeasible when planning and penalized when re-planning", () => {
  const v = vehWhere((x) => x.reefer && x.shift === "Late");
  const s = staticStops(P).find((k) => P.b[k] <= 11 * 60 + 30 + 30); // closes before a late van can get there
  assert.ok(s, "found an early window");
  const r = newRoute(P, v);
  const e0 = evalSeq(P, r, [s], STATIC_OPTS);
  assert.ok(!e0.ok);
  const e1 = evalSeq(P, r, [s], { maxLate: 1e9, overtime: 0 });
  assert.ok(e1.ok && e1.late > 0);
  const e2 = evalSeq(P, r, [s], { maxLate: 1e9, overtime: 0 }, true);
  close(e2.lateAt[0], e2.arr[0] - P.b[s], 1e-9);
  assert.ok(e1.cost - e1.late * LATE_PEN > 0);
});

test("cold orders need a refrigerated van", () => {
  const s = staticStops(P).find((k) => P.cold[k]);
  const amb = vehWhere((x) => !x.reefer), ref = vehWhere((x) => x.reefer && x.shift === P.veh[amb].shift);
  assert.ok(!evalSeq(P, newRoute(P, amb), [s], DYNAMIC_OPTS).ok);
  assert.equal(insertCost(P, routeWith(amb, []), s, 0, STATIC_OPTS), Infinity);
  assert.ok(evalSeq(P, newRoute(P, ref), [s], { maxLate: 1e9, overtime: 1e9 }).ok);
});

test("shift length: a van must be back by the end of its shift", () => {
  const v = vehWhere((x) => x.shift === "Early" && x.reefer);
  const lateStop = staticStops(P).find((k) => P.a[k] >= 19 * 60);
  const e = evalSeq(P, newRoute(P, v), [lateStop], { maxLate: 0, overtime: 0 });
  assert.ok(!e.ok, "an early shift van cannot serve a 19:00 window");
  assert.ok(e.end > P.veh[v].end);
  assert.ok(evalSeq(P, newRoute(P, v), [lateStop], { maxLate: 0, overtime: 10 * 60 }).ok);
});

test("checkSolution catches missing and duplicated stops", () => {
  const sol = cloneSol(LS);
  assert.ok(checkSolution(P, sol).ok);
  const r = sol.routes.find((x) => x.seq.length > 1);
  const dropped = r.seq[0];
  r.seq = r.seq.slice(1);
  assert.ok(checkSolution(P, sol).errors.some((e) => e.includes(`stop ${dropped} appears 0`)));
  r.seq = [dropped, dropped].concat(r.seq);
  assert.ok(!checkSolution(P, sol).ok);
});

test("fast insertion cost equals the difference of full evaluations", () => {
  const rng = mulberry32(4);
  let checked = 0;
  for (const o of [STATIC_OPTS, DYNAMIC_OPTS]) {
    for (let k = 0; k < 400; k++) {
      const r = refresh(P, { ...AL.routes[Math.floor(rng() * AL.routes.length)] }, o);
      const s = 1 + Math.floor(rng() * P.n);
      if (r.seq.includes(s)) continue;
      const p = Math.floor(rng() * (r.seq.length + 1));
      const fast = insertCost(P, r, s, p, o);
      const e = evalSeq(P, r, r.seq.slice(0, p).concat([s], r.seq.slice(p)), o);
      if (!e.ok) { assert.equal(fast, Infinity); continue; }
      close(fast, e.cost - r.cost, 1e-6);
      checked++;
    }
  }
  assert.ok(checked > 50, `checked ${checked}`);
});

// --- Construction ------------------------------------------------------------------

for (const [name, sol] of [["nearest neighbor", NN], ["sweep", SW], ["savings", SV]]) {
  test(`${name} builds feasible routes that serve each stop once`, () => {
    const c = checkSolution(P, sol);
    assert.ok(c.ok, c.errors.slice(0, 3).join("; "));
    assert.ok(sol.unserved.length < P.n * 0.2, `${sol.unserved.length} unserved`);
    for (const r of sol.routes) assert.ok(r.ok);
  });
}

test("construction is deterministic", () => {
  assert.deepEqual(nearestNeighbor(P).routes.map((r) => r.seq), NN.routes.map((r) => r.seq));
  assert.deepEqual(savings(P).routes.map((r) => r.seq), SV.routes.map((r) => r.seq));
  assert.deepEqual(sweep(P).routes.map((r) => r.seq), SW.routes.map((r) => r.seq));
});

test("greedy and regret insertion build feasible solutions from scratch", () => {
  for (const mode of ["greedy", "regret"]) {
    const sol = insertStops(P, emptySolution(P), staticStops(P), mode);
    assert.ok(checkSolution(P, sol).ok, mode);
    assert.ok(sol.unserved.length < P.n * 0.35, `${mode}: ${sol.unserved.length}`);
  }
});

// --- Improvement -----------------------------------------------------------------

for (const [name, fn] of [["2-opt", twoOpt], ["or-opt", orOpt], ["relocate", relocate], ["exchange", exchange]]) {
  test(`${name} never increases cost and keeps routes feasible`, () => {
    for (const start of [NN, SW, SV]) {
      const sol = cloneSol(start);
      const before = solCost(sol), routeCost = sol.routes.map((r) => r.cost);
      const moves = fn(P, sol);
      const after = solCost(sol);
      assert.ok(after <= before + 1e-6, `${after} > ${before}`);
      if (name === "2-opt" || name === "or-opt") sol.routes.forEach((r, i) => assert.ok(r.cost <= routeCost[i] + 1e-6));
      assert.ok(checkSolution(P, sol).ok);
      if (moves) assert.ok(after < before);
    }
  });
}

test("local search improves savings and stays feasible", () => {
  assert.ok(solCost(LS) < solCost(SV));
  assert.ok(checkSolution(P, LS).ok);
});

test("ALNS improves on the best construction and is deterministic", () => {
  const best = Math.min(solCost(NN), solCost(SW), solCost(SV), solCost(LS));
  assert.ok(solCost(AL) < best * 0.95, `${solCost(AL)} vs ${best}`);
  assert.ok(checkSolution(P, AL).ok);
  const again = alns(P, LS, { iters: 300, seed: 5 });
  assert.equal(solCost(again), solCost(AL));
  assert.ok(AL.trace.every((p, i) => i === 0 || p.best <= AL.trace[i - 1].best + 1e-9), "best never gets worse");
});

test("summary metrics add up", () => {
  const s = summarize(P, AL);
  assert.equal(s.stops + s.unserved, P.n);
  close(s.km, AL.routes.reduce((x, r) => x + r.km, 0), 1e-9);
  close(s.cost, AL.routes.reduce((x, r) => x + r.cost, 0) + AL.unserved.length * UNSERVED_PEN, 1e-6);
  assert.equal(s.onTime, 1, "a static plan is on time by construction");
  assert.ok(s.capUtil > 0 && s.capUtil <= 1 && s.timeUtil > 0 && s.timeUtil <= 1);
  assert.equal(s.vans, AL.routes.filter((r) => r.seq.length).length);
});

// --- Execution and ETA ---------------------------------------------------------------

test("with no noise, execution matches the plan exactly", () => {
  const ex = execute(P, AL, 0);
  assert.equal(ex.eta.n, P.n - AL.unserved.length);
  close(ex.eta.mae, 0, 1e-9);
  close(ex.cost, solCost(AL), 1e-6);
  assert.equal(ex.onTime, 1);
});

test("noise is deterministic, mean one, and makes ETAs drift with stop position", () => {
  const xs = [];
  for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) if (i !== j) xs.push(legNoise(P, i, j, 0.15));
  close(xs.reduce((s, x) => s + x, 0) / xs.length, 1, 0.02);
  assert.equal(legNoise(P, 4, 9, 0.15), legNoise(P, 4, 9, 0.15));
  const a = execute(P, AL, 0.15), b = execute(P, AL, 0.15);
  assert.deepEqual(a.eta, b.eta);
  assert.ok(a.eta.mae > 0);
  const [first, , , last] = a.eta.byPos;
  if (last.n >= 5) assert.ok(last.mae > first.mae, `late stops ${last.mae} vs first ${first.mae}`);
});

test("ETA error accounting on a hand-built set", () => {
  const served = new Map([
    [1, { arr: 610, pred: 600, pos: 1 }], [2, { arr: 595, pred: 600, pos: 2 }],
    [3, { arr: 640, pred: 600, pos: 9 }], [4, { arr: 600, pred: 600, pos: 14 }],
  ]);
  const s = etaStats(served);
  assert.equal(s.n, 4);
  close(s.mean, (10 - 5 + 40 + 0) / 4, 1e-12);
  close(s.mae, (10 + 5 + 40 + 0) / 4, 1e-12);
  assert.equal(s.within10, 0.75);
  assert.equal(s.bins.reduce((x, b) => x + b.n, 0), 4);
  assert.equal(s.bins.find((b) => b.lo === 40).n, 1);
  assert.equal(s.byPos[0].n, 2);
  close(s.byPos[0].mae, 7.5, 1e-12);
});

// --- Dynamic day -------------------------------------------------------------------

const DAY = Object.fromEntries(["none", "greedy", "reopt"].map((k) => [k, playDay(P, AL, k, { iters: 150 })]));

test("re-planning keeps committed stops: the morning is the same under every strategy", () => {
  const T = EVENT_TIMES.orders;
  const morning = (d) => d.vans.map((v) => v.visits.filter((x) => x.arr < T).map((x) => x.s));
  assert.deepEqual(morning(DAY.greedy), morning(DAY.none));
  assert.deepEqual(morning(DAY.reopt), morning(DAY.none));
  // Every van starts on its morning route: its visits before 11:00 are a prefix of the plan.
  DAY.reopt.vans.forEach((v, i) => {
    const before = v.visits.filter((x) => x.arr < T && x.s > 0).map((x) => x.s);
    assert.deepEqual(before, AL.routes[i].seq.slice(0, before.length));
  });
});

test("each stop is served at most once and the books balance", () => {
  for (const d of Object.values(DAY)) {
    const seen = new Set();
    for (const v of d.vans) for (const x of v.visits) if (x.s > 0) { assert.ok(!seen.has(x.s), `stop ${x.s} twice`); seen.add(x.s); }
    assert.equal(seen.size, d.served);
    assert.equal(d.served + d.unserved, P.total);
  }
});

test("the broken van stops at the breakdown and its stops move", () => {
  const d = DAY.reopt;
  assert.ok(d.broken);
  const v = d.vans.find((x) => x.v === d.broken.v);
  assert.ok(v.broken);
  for (const x of v.visits) assert.ok(x.arr <= d.broken.t + 1e-9);
  assert.equal(DAY.none.lostToBreakdown, DAY.none.broken.orphans);
});

test("re-planning serves the new orders; no re-plan refuses them", () => {
  assert.equal(DAY.none.newServed, 0);
  assert.equal(DAY.none.refused, P.total - P.n);
  assert.ok(DAY.greedy.newServed > 0.3 * DAY.greedy.newOrders);
  assert.ok(DAY.reopt.newServed >= DAY.greedy.newServed - 1);
  assert.ok(DAY.reopt.cost < DAY.none.cost);
  assert.ok(DAY.reopt.cost <= DAY.greedy.cost + 1e-6, `${DAY.reopt.cost} vs ${DAY.greedy.cost}`);
});

test("the dynamic day is deterministic", () => {
  const again = playDay(P, AL, "reopt", { iters: 150 });
  assert.equal(again.cost, DAY.reopt.cost);
  assert.deepEqual(again.servedStops, DAY.reopt.servedStops);
});

// --- Config -----------------------------------------------------------------------

test("config clamping and URL round trip", () => {
  const c = clamp({ n: 9999, tight: "nope", fleet: "small", seed: "12", extra: 1 });
  assert.equal(c.n, 400);
  assert.equal(c.tight, DEFAULTS.tight);
  assert.equal(c.fleet, "small");
  assert.equal(c.seed, 12);
  assert.ok(!("extra" in c));
  assert.equal(encodeConfig(DEFAULTS), "");
  assert.deepEqual(decodeConfig(`#${encodeConfig(c)}`), c);
});
