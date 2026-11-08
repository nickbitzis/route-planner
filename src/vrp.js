// Last-mile vehicle routing with time windows, capacities, refrigerated stops, and shifts.
// Pure logic, no DOM. Every random draw comes from the seed, so a config always gives the same day.
//
// Times are minutes after midnight. Distances are road km on a city grid (Manhattan distance).

// ---------------------------------------------------------------------------
// Constants

export const SPEED = 30; // km/h in free flow
export const PARK = 2; // minutes per leg to park and walk to the door
export const LOAD = 15; // minutes to load at the depot before the first trip
export const RELOAD = 20; // minutes to reload at the depot mid-shift
export const UNLOAD = 5; // minutes to check in at the depot at the end
export const LATE_PEN = 1.5; // $ per minute late
export const UNSERVED_PEN = 150; // $ per order not delivered (refund and credit)
export const OT_PREMIUM = 0.5; // overtime is paid at 1.5x
export const TOW_COST = 150; // $ for a broken-down van
export const CITY = 30; // km, the city is CITY x CITY

export const VAN_TYPES = {
  van: { label: "Ambient van", cap: 60, reefer: false, perHour: 30, perKm: 0.32, fixed: 45 },
  reefer: { label: "Refrigerated van", cap: 50, reefer: true, perHour: 34, perKm: 0.41, fixed: 60 },
  truck: { label: "Box truck", cap: 110, reefer: false, perHour: 42, perKm: 0.58, fixed: 75 },
  small: { label: "Small van", cap: 36, reefer: false, perHour: 28, perKm: 0.26, fixed: 35 },
  smallReefer: { label: "Small refrigerated van", cap: 30, reefer: true, perHour: 31, perKm: 0.33, fixed: 45 },
};

export const FLEETS = {
  balanced: { label: "Balanced", note: "40% refrigerated vans, 45% ambient vans, 15% box trucks", mix: [["reefer", 0.4], ["van", 0.45], ["truck", 0.15]] },
  reefer: { label: "Refrigerated heavy", note: "Most vans refrigerated, so any van can take any order", mix: [["reefer", 0.75], ["van", 0.25]] },
  small: { label: "Small vans", note: "Many small vans, 40% refrigerated: cheap per km, more vans on the road", mix: [["smallReefer", 0.4], ["small", 0.6]] },
};

export const TIGHTNESS = {
  tight: { label: "Tight (1 to 2 h)", widths: [60, 60, 60, 120] },
  normal: { label: "Normal (1 to 3 h)", widths: [60, 120, 120, 180] },
  loose: { label: "Loose (2 to 4 h)", widths: [120, 180, 240, 240] },
};

export const SHIFTS = [
  { label: "Early", start: 7 * 60, end: 16 * 60 + 30 },
  { label: "Late", start: 11 * 60 + 30, end: 21 * 60 },
];

export const HOODS = [
  { name: "Old Town", x: 14, y: 15, r: 2.2, w: 1.4, dense: true },
  { name: "Riverside", x: 9, y: 11, r: 2.0, w: 1.1, dense: true },
  { name: "Northgate", x: 16, y: 24, r: 2.6, w: 1.0 },
  { name: "Elm Park", x: 22, y: 19, r: 2.4, w: 1.0 },
  { name: "Harbor", x: 5, y: 20, r: 2.3, w: 0.8 },
  { name: "Westfield", x: 6, y: 5, r: 2.8, w: 0.8 },
  { name: "Kingsbridge", x: 24, y: 8, r: 2.6, w: 0.9 },
  { name: "Mill Hill", x: 17, y: 5, r: 2.2, w: 0.7 },
  { name: "Southvale", x: 26, y: 27, r: 2.5, w: 0.6 },
];

export const DEPOT = { x: 13, y: 12 };

// Hourly congestion multipliers on free-flow travel time, 00:00 to 24:00.
export const CONGESTION = [1, 1, 1, 1, 1, 1, 1.05, 1.35, 1.55, 1.3, 1.1, 1.1, 1.15, 1.15, 1.1, 1.15, 1.35, 1.6, 1.5, 1.25, 1.1, 1.05, 1, 1, 1];

export const EVENT_TIMES = { orders: 11 * 60, closure: 12 * 60 + 30, breakdown: 13 * 60 + 30 };

export const DEFAULTS = { n: 240, seed: 7, tight: "normal", fleet: "balanced", cold: 30, iters: 1500, replanIters: 400, noise: 15, newPct: 12 };
const LIMITS = { n: [150, 400, 0], seed: [1, 99999, 0], cold: [0, 60, 0], iters: [100, 5000, 0], replanIters: [0, 2000, 0], noise: [0, 40, 0], newPct: [0, 30, 0] };

// ---------------------------------------------------------------------------
// Randomness

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// A uniform in [0, 1) from integers, so noise for a leg is the same for every strategy.
export function hash01(a, b, c) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hashGauss(a, b, c) {
  const u = Math.max(hash01(a, b, c), 1e-12), v = hash01(a + 7919, b, c);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Config

export function clamp(cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!TIGHTNESS[c.tight]) c.tight = DEFAULTS.tight;
  if (!FLEETS[c.fleet]) c.fleet = DEFAULTS.fleet;
  for (const [k, [lo, hi, dp]] of Object.entries(LIMITS)) {
    let v = Number(c[k]);
    if (!Number.isFinite(v)) v = DEFAULTS[k];
    const f = 10 ** dp;
    c[k] = Math.round(Math.min(hi, Math.max(lo, v)) * f) / f;
  }
  for (const k of Object.keys(c)) if (!(k in DEFAULTS)) delete c[k];
  return c;
}

export function encodeConfig(cfg) {
  const p = new URLSearchParams();
  for (const k of Object.keys(DEFAULTS)) if (cfg[k] !== DEFAULTS[k]) p.set(k, String(cfg[k]));
  return p.toString();
}

export function decodeConfig(hash) {
  const p = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const over = {};
  for (const k of Object.keys(DEFAULTS)) if (p.has(k)) over[k] = p.get(k);
  return clamp(over);
}

// ---------------------------------------------------------------------------
// Travel time

const CONG_MIN = new Float64Array(24 * 60 + 1);
for (let m = 0; m <= 24 * 60; m++) {
  const h = Math.min(23, Math.floor(m / 60)), f = (m - h * 60) / 60;
  CONG_MIN[m] = CONGESTION[h] * (1 - f) + CONGESTION[h + 1] * f;
}

export function congestion(t) {
  const m = Math.max(0, Math.min(24 * 60, Math.floor(t)));
  return CONG_MIN[m];
}

export const roadKm = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);

// Travel time in minutes from node i to node j, leaving at time t.
export function travelTime(P, i, j, t) {
  if (i === j) return 0;
  const k = i * P.N + j;
  let m = P.base[k] * congestion(t);
  if (P.closure && t >= P.closure.from && P.cross[k]) m *= P.closure.factor;
  return PARK + m;
}

// Does the segment (x1,y1)-(x2,y2) pass through the box? Liang-Barsky clipping.
export function segmentHitsBox(x1, y1, x2, y2, box) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy], q = [x1 - box.x0, box.x1 - x1, y1 - box.y0, box.y1 - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Problem

function pickWeighted(rng, items, w) {
  let r = rng() * items.reduce((s, x) => s + w(x), 0);
  for (const x of items) { r -= w(x); if (r <= 0) return x; }
  return items[items.length - 1];
}

function windowFor(rng, widths) {
  const w = widths[Math.floor(rng() * widths.length)];
  // Evening slots are the most popular for grocery delivery.
  const evening = rng() < 0.3;
  const lo = evening ? 17 * 60 : 8 * 60, hi = 20 * 60 + 30 - w;
  const steps = Math.max(0, Math.floor((hi - lo) / 30));
  const a = lo + 30 * Math.floor(rng() * (steps + 1));
  return [a, a + w];
}

export function makeProblem(cfgIn = {}) {
  const cfg = clamp(cfgIn);
  const rng = mulberry32(cfg.seed * 2654435761);
  const n = cfg.n, extra = Math.round((n * cfg.newPct) / 100);
  const total = n + extra, N = total + 1;
  const xs = new Float64Array(N), ys = new Float64Array(N), a = new Float64Array(N), b = new Float64Array(N);
  const svc = new Float64Array(N), dem = new Int32Array(N), cold = new Uint8Array(N), hood = new Int16Array(N), release = new Float64Array(N);
  xs[0] = DEPOT.x; ys[0] = DEPOT.y; a[0] = 0; b[0] = 24 * 60; hood[0] = -1;
  const widths = TIGHTNESS[cfg.tight].widths;
  for (let i = 1; i < N; i++) {
    const h = pickWeighted(rng, HOODS, (x) => x.w);
    const hi = HOODS.indexOf(h);
    let x, y;
    if (rng() < 0.12) { x = 1 + rng() * (CITY - 2); y = 1 + rng() * (CITY - 2); hood[i] = -1; } else {
      x = h.x + gauss(rng) * h.r; y = h.y + gauss(rng) * h.r; hood[i] = hi;
    }
    // Rounded to 1 m so that last-digit differences in Math.log or Math.cos between
    // JavaScript engines cannot change the problem (ALNS would amplify them).
    xs[i] = Math.round(Math.min(CITY - 0.5, Math.max(0.5, x)) * 1000) / 1000;
    ys[i] = Math.round(Math.min(CITY - 0.5, Math.max(0.5, y)) * 1000) / 1000;
    dem[i] = Math.min(8, 1 + Math.floor(-Math.log(Math.max(rng(), 1e-9)) * 2));
    cold[i] = rng() < cfg.cold / 100 ? 1 : 0;
    svc[i] = 4 + 1.5 * dem[i] + (hood[i] >= 0 && HOODS[hood[i]].dense ? 3 : 0);
    if (i > n) {
      // Orders placed during the day: released at 11:00, windows from 13:00.
      const w = widths[Math.floor(rng() * widths.length)];
      const steps = Math.floor((20 * 60 + 30 - w - 13 * 60) / 30);
      a[i] = 13 * 60 + 30 * Math.floor(rng() * (steps + 1)); b[i] = a[i] + w;
      release[i] = EVENT_TIMES.orders;
    } else {
      [a[i], b[i]] = windowFor(rng, widths);
    }
  }
  const D = new Float64Array(N * N), base = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const d = roadKm(xs[i], ys[i], xs[j], ys[j]);
    D[i * N + j] = d; base[i * N + j] = (d / SPEED) * 60;
  }
  // Fleet: enough vans for time and for capacity, with enough refrigerated space for cold orders.
  let demAll = 0, demCold = 0;
  for (let i = 1; i <= n; i++) { demAll += dem[i]; if (cold[i]) demCold += dem[i]; }
  const mix = FLEETS[cfg.fleet].mix;
  const avgCap = mix.reduce((s, [t, f]) => s + VAN_TYPES[t].cap * f, 0);
  const count = Math.ceil(Math.max(n / 12, demAll / avgCap / 0.8) * 1.25) + 1;
  const counts = mix.map(([t, f]) => [t, Math.max(1, Math.round(count * f))]);
  const reeferType = counts.find(([t]) => VAN_TYPES[t].reefer);
  const needReefer = Math.ceil(demCold / VAN_TYPES[reeferType[0]].cap / 0.7);
  if (reeferType[1] < needReefer) reeferType[1] = needReefer;
  const veh = [];
  for (const [t, c] of counts) for (let k = 0; k < c; k++) veh.push({ type: t, ...VAN_TYPES[t] });
  veh.forEach((v, i) => {
    const s = SHIFTS[i % 2];
    v.id = i; v.start = s.start; v.end = s.end; v.shift = s.label;
    v.name = `${v.reefer ? "R" : v.type === "truck" ? "T" : "V"}${String(i + 1).padStart(2, "0")}`;
  });
  // Closure: the main bridge between Riverside and Old Town, a box on the river.
  const box = { x0: 10.6, x1: 12.2, y0: 9, y1: 17 };
  const cross = new Uint8Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i !== j && segmentHitsBox(xs[i], ys[i], xs[j], ys[j], box)) cross[i * N + j] = 1;
  }
  // k nearest stops for each stop, for granular local search.
  const K = 15, knn = [];
  for (let i = 0; i < N; i++) {
    if (i === 0) { knn.push([]); continue; }
    const c = [];
    for (let j = 1; j < N; j++) if (j !== i) c.push(j);
    c.sort((p, q) => D[i * N + p] - D[i * N + q]);
    knn.push(c.slice(0, K));
  }
  return {
    cfg, n, total, N, xs, ys, a, b, svc, dem, cold, hood, release, D, base, veh, knn, cross,
    closure: null, closureDef: { ...box, from: EVENT_TIMES.closure, factor: 2.5, label: "Bridge closure between Riverside and Old Town" },
  };
}

// The same problem with the road closure known to the planner (and to the world).
export const withClosure = (P) => ({ ...P, closure: P.closureDef });

// ---------------------------------------------------------------------------
// Routes and solutions
//
// A route: { v, seq, n0, t0, paidFrom, fixedDue, inField, onboard, ri }.
// seq holds stop indices; 0 in seq is a reload at the depot (only in re-planning).
// onboard: stops already on the van (must come before the reload), or null.

export const STATIC_OPTS = { maxLate: 0, overtime: 0 };
export const DYNAMIC_OPTS = { maxLate: 60, overtime: 60 };

export function newRoute(P, v) {
  const veh = P.veh[v];
  return { v, seq: [], n0: 0, t0: veh.start + LOAD, paidFrom: veh.start, fixedDue: true, inField: false, onboard: null, ri: -1, cost: 0, end: veh.start, km: 0, late: 0, load: 0, ok: true, arr: [], dep: [], lateAt: [] };
}

export function emptySolution(P, o = STATIC_OPTS) {
  return { routes: P.veh.map((_, v) => newRoute(P, v)), unserved: [], o };
}

function otCost(veh, end) {
  return (Math.max(0, end - veh.end) / 60) * veh.perHour * OT_PREMIUM;
}

// Evaluate a sequence for a route. Returns cost and feasibility; with fill, also per-stop times.
export function evalSeq(P, r, seq, o, fill = false) {
  const veh = P.veh[r.v], N = P.N;
  const L = seq.length;
  const realEnd = L > 0 && seq[L - 1] === 0 ? L - 1 : L; // a trailing reload is just the return
  if (realEnd === 0 && !r.inField) {
    const res = { cost: 0, km: 0, end: r.paidFrom, late: 0, load: 0, ok: true, used: false };
    if (fill) Object.assign(res, { arr: [], dep: [], lateAt: [], beg: [] });
    return res;
  }
  let node = r.n0, t = r.t0, km = 0, late = 0, ok = true, load = 0, maxLoad = 0, worst = 0;
  const arr = fill ? new Array(L) : null, dep = fill ? new Array(L) : null, lateAt = fill ? new Array(L) : null, beg = fill ? new Array(L) : null;
  for (let k = 0; k < realEnd; k++) {
    const j = seq[k];
    const tt = travelTime(P, node, j, t);
    km += P.D[node * N + j];
    const at = t + tt;
    if (j === 0) {
      t = at + RELOAD;
      if (load > maxLoad) maxLoad = load;
      load = 0;
      if (fill) { arr[k] = at; beg[k] = at; dep[k] = t; lateAt[k] = 0; }
      node = 0;
      continue;
    }
    const lt = at > P.b[j] ? at - P.b[j] : 0;
    if (lt > o.maxLate) ok = false;
    if (lt > worst) worst = lt;
    late += lt;
    const bg = at > P.a[j] ? at : P.a[j];
    t = bg + P.svc[j];
    load += P.dem[j];
    if (P.cold[j] && !veh.reefer) ok = false;
    if (fill) { arr[k] = at; beg[k] = bg; dep[k] = t; lateAt[k] = lt; }
    node = j;
  }
  if (load > maxLoad) maxLoad = load;
  if (r.onboard && r.ri >= 0) {
    // The first trip starts with the onboard crates already loaded.
    let first = 0;
    for (let k = 0; k < Math.min(r.ri, realEnd); k++) first += P.dem[seq[k]];
    if (first > veh.cap) ok = false;
  }
  if (maxLoad > veh.cap) ok = false;
  const back = travelTime(P, node, 0, t);
  km += P.D[node * N];
  const end = t + back + UNLOAD;
  if (end > veh.end + o.overtime) ok = false;
  const cost = (r.fixedDue ? veh.fixed : 0) + ((end - r.paidFrom) / 60) * veh.perHour + otCost(veh, end) + km * veh.perKm + late * LATE_PEN;
  const res = { cost, km, end, late, load: maxLoad, ok, used: true, worst };
  if (fill) Object.assign(res, { arr, dep, lateAt, beg });
  return res;
}

export function refresh(P, r, o) {
  const e = evalSeq(P, r, r.seq, o, true);
  r.cost = e.cost; r.km = e.km; r.end = e.end; r.late = e.late; r.load = e.load; r.ok = e.ok;
  r.arr = e.arr; r.dep = e.dep; r.lateAt = e.lateAt; r.beg = e.beg;
  return r;
}

export function solCost(sol) {
  let c = 0;
  for (const r of sol.routes) c += r.cost;
  return c + sol.unserved.length * UNSERVED_PEN;
}

export function cloneSol(sol) {
  return { routes: sol.routes.map((r) => ({ ...r })), unserved: sol.unserved.slice(), o: sol.o };
}

// Positions where stop s may be inserted in route r: [lo, hi] inclusive.
function allowed(r, s) {
  if (r.ri < 0) return [0, r.seq.length];
  return r.onboard.has(s) ? [0, r.ri] : [r.ri + 1, r.seq.length];
}

// Cost of inserting stop s before position p of route r, or Infinity if infeasible.
// Static routes use cached times and stop early once the schedule is unchanged.
export function insertCost(P, r, s, p, o) {
  const veh = P.veh[r.v];
  if (P.cold[s] && !veh.reefer) return Infinity;
  if (r.ri >= 0) {
    const seq = r.seq.slice(0, p).concat([s], r.seq.slice(p));
    const e = evalSeq(P, r, seq, o);
    return e.ok ? e.cost - r.cost : Infinity;
  }
  if (r.load + P.dem[s] > veh.cap) return Infinity;
  const seq = r.seq, L = seq.length, N = P.N;
  const prev = p === 0 ? r.n0 : seq[p - 1];
  const next = p === L ? 0 : seq[p];
  let t = p === 0 ? r.t0 : r.dep[p - 1];
  let at = t + travelTime(P, prev, s, t);
  if (at > P.b[s] + o.maxLate) return Infinity;
  let dLate = at > P.b[s] ? at - P.b[s] : 0;
  t = (at > P.a[s] ? at : P.a[s]) + P.svc[s];
  const dkm = P.D[prev * N + s] + P.D[s * N + next] - P.D[prev * N + next];
  let node = s, end = -1;
  for (let k = p; k < L; k++) {
    const j = seq[k];
    at = t + travelTime(P, node, j, t);
    if (at > P.b[j] + o.maxLate) return Infinity;
    const lt = at > P.b[j] ? at - P.b[j] : 0;
    const nd = (at > P.a[j] ? at : P.a[j]) + P.svc[j];
    dLate += lt - r.lateAt[k];
    if (nd === r.dep[k]) { end = r.end; break; }
    t = nd; node = j;
  }
  if (end < 0) {
    end = t + travelTime(P, node, 0, t) + UNLOAD;
    if (end > veh.end + o.overtime) return Infinity;
  }
  const used = L > 0 || r.inField;
  const oldEnd = used ? r.end : r.paidFrom;
  return (used || !r.fixedDue ? 0 : veh.fixed) + ((end - oldEnd) / 60) * veh.perHour + otCost(veh, end) - (used ? otCost(veh, oldEnd) : 0)
    + dkm * veh.perKm + dLate * LATE_PEN;
}

export function bestInsertion(P, r, s, o) {
  const [lo, hi] = allowed(r, s);
  let best = Infinity, pos = -1;
  for (let p = lo; p <= hi; p++) {
    const c = insertCost(P, r, s, p, o);
    if (c < best) { best = c; pos = p; }
  }
  return [best, pos];
}

export function insertAt(P, r, s, p, o) {
  r.seq = r.seq.slice(0, p).concat([s], r.seq.slice(p));
  if (r.ri >= 0 && p <= r.ri) r.ri++;
  refresh(P, r, o);
}

export function removeStop(P, r, s, o) {
  const k = r.seq.indexOf(s);
  if (k < 0) return false;
  r.seq = r.seq.slice(0, k).concat(r.seq.slice(k + 1));
  if (r.ri >= 0 && k < r.ri) r.ri--;
  refresh(P, r, o);
  return true;
}

// Insert stops one at a time: greedy (cheapest first) or regret-2 (most to lose first).
// A stop whose best insertion costs more than leaving it unserved stays unserved.
export function insertStops(P, sol, stops, mode = "greedy") {
  const o = sol.o, R = sol.routes.length;
  const pend = stops.slice();
  const Q = pend.length;
  const cost = new Float64Array(Q * R), pos = new Int32Array(Q * R);
  const col = (ri) => {
    const r = sol.routes[ri];
    for (let q = 0; q < Q; q++) {
      if (pend[q] < 0) continue;
      const [c, p] = bestInsertion(P, r, pend[q], o);
      cost[q * R + ri] = c; pos[q * R + ri] = p;
    }
  };
  for (let ri = 0; ri < R; ri++) col(ri);
  let left = Q;
  while (left > 0) {
    let pick = -1, pickRoute = -1, pickScore = -Infinity, pickCost = Infinity;
    for (let q = 0; q < Q; q++) {
      if (pend[q] < 0) continue;
      let b1 = Infinity, b2 = Infinity, br = -1;
      for (let ri = 0; ri < R; ri++) {
        const c = cost[q * R + ri];
        if (c < b1) { b2 = b1; b1 = c; br = ri; } else if (c < b2) b2 = c;
      }
      if (br < 0 || b1 >= UNSERVED_PEN) continue;
      const score = mode === "regret" ? Math.min(b2, UNSERVED_PEN * 2) - b1 : -b1;
      if (score > pickScore + 1e-9 || (Math.abs(score - pickScore) <= 1e-9 && b1 < pickCost)) { pick = q; pickRoute = br; pickScore = score; pickCost = b1; }
    }
    if (pick < 0) break;
    insertAt(P, sol.routes[pickRoute], pend[pick], pos[pick * R + pickRoute], o);
    pend[pick] = -1; left--;
    col(pickRoute);
  }
  for (let q = 0; q < Q; q++) if (pend[q] >= 0) sol.unserved.push(pend[q]);
  return sol;
}

export function staticStops(P) {
  return Array.from({ length: P.n }, (_, i) => i + 1);
}

// ---------------------------------------------------------------------------
// Construction heuristics

// Time-oriented nearest neighbor: each van takes the closest feasible stop next,
// scored on travel time, waiting, and how close the window is to closing.
export function nearestNeighbor(P, o = STATIC_OPTS) {
  const sol = emptySolution(P, o);
  const left = new Set(staticStops(P));
  const order = sol.routes.map((_, v) => v).sort((x, y) => P.veh[x].start - P.veh[y].start || Number(P.veh[y].reefer) - Number(P.veh[x].reefer) || x - y);
  for (const v of order) {
    const r = sol.routes[v];
    for (;;) {
      let best = -1, bestScore = Infinity;
      const p = r.seq.length;
      const node = p === 0 ? r.n0 : r.seq[p - 1], t = p === 0 ? r.t0 : r.dep[p - 1];
      for (const s of left) {
        if (!Number.isFinite(insertCost(P, r, s, p, o))) continue;
        const tt = travelTime(P, node, s, t), at = t + tt;
        const score = tt + 0.5 * Math.max(0, P.a[s] - at) + 0.15 * (P.b[s] - at);
        if (score < bestScore) { bestScore = score; best = s; }
      }
      if (best < 0) break;
      insertAt(P, r, best, p, o);
      left.delete(best);
    }
  }
  sol.unserved = [...left];
  return sol;
}

// Sweep: sort stops by angle around the depot and fill vans in that order with cheapest insertion.
export function sweep(P, o = STATIC_OPTS) {
  const sol = emptySolution(P, o);
  const ang = (i) => Math.atan2(P.ys[i] - P.ys[0], P.xs[i] - P.xs[0]);
  let pool = staticStops(P).sort((x, y) => ang(x) - ang(y) || x - y);
  const order = sol.routes.map((_, v) => v).sort((x, y) => Number(P.veh[x].reefer) - Number(P.veh[y].reefer) || P.veh[x].start - P.veh[y].start || x - y);
  for (const v of order) {
    const r = sol.routes[v];
    let fails = 0;
    const keep = [];
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (fails >= 12) { keep.push(s); continue; }
      const [c, p] = bestInsertion(P, r, s, o);
      if (Number.isFinite(c)) { insertAt(P, r, s, p, o); fails = 0; } else { keep.push(s); if (r.seq.length && (!P.cold[s] || P.veh[v].reefer)) fails++; }
    }
    pool = keep;
  }
  sol.unserved = pool;
  return sol;
}

// Clarke and Wright savings (parallel version) with time windows and capacity.
// Merges are checked against every vehicle class; routes get vehicles at the end.
export function savings(P, o = STATIC_OPTS) {
  const N = P.N;
  const classes = [];
  P.veh.forEach((v, i) => { if (!classes.some((c) => P.veh[c].type === v.type && P.veh[c].start === v.start)) classes.push(i); });
  const feasibleFor = (seq) => classes.filter((v) => evalSeq(P, newRoute(P, v), seq, o).ok);
  const routes = new Map(); // id -> { seq, cls }
  const of = new Int32Array(N).fill(-1);
  const unserved = [];
  for (const s of staticStops(P)) {
    const cls = feasibleFor([s]);
    if (!cls.length) { unserved.push(s); continue; }
    routes.set(s, { seq: [s], cls }); of[s] = s;
  }
  const pairs = [];
  for (const i of routes.keys()) for (const j of P.knn[i]) {
    if (j > P.n || !routes.has(j)) continue;
    const sv = P.D[i * N] + P.D[j] - P.D[i * N + j];
    if (sv > 0) pairs.push([sv, i, j]);
  }
  pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
  for (const [, i, j] of pairs) {
    const ri = of[i], rj = of[j];
    if (ri < 0 || rj < 0 || ri === rj) continue;
    const A = routes.get(ri), B = routes.get(rj);
    if (A.seq[A.seq.length - 1] !== i || B.seq[0] !== j) continue;
    const seq = A.seq.concat(B.seq);
    const cls = A.cls.filter((c) => B.cls.includes(c) && evalSeq(P, newRoute(P, c), seq, o).ok);
    if (!cls.length) continue;
    routes.set(ri, { seq, cls });
    routes.delete(rj);
    for (const s of B.seq) of[s] = ri;
  }
  // Assign routes to vehicles: biggest loads first, cheapest feasible van.
  const sol = emptySolution(P, o);
  const list = [...routes.values()].map((x) => ({ ...x, load: x.seq.reduce((s, k) => s + P.dem[k], 0) })).sort((x, y) => y.load - x.load || y.seq.length - x.seq.length || x.seq[0] - y.seq[0]);
  const free = new Set(P.veh.map((_, i) => i));
  const orphans = [];
  for (const x of list) {
    let best = -1, bc = Infinity;
    for (const v of free) {
      const e = evalSeq(P, sol.routes[v], x.seq, o);
      if (e.ok && e.cost < bc) { bc = e.cost; best = v; }
    }
    if (best < 0) { orphans.push(...x.seq); continue; }
    sol.routes[best].seq = x.seq;
    refresh(P, sol.routes[best], o);
    free.delete(best);
  }
  insertStops(P, sol, orphans.concat(unserved), "regret");
  return sol;
}

// ---------------------------------------------------------------------------
// Local search. Every move is accepted only if it is feasible and lowers the cost.

const EPS = 1e-6;

function tryRoute(P, r, seq, o) {
  const e = evalSeq(P, r, seq, o);
  return e.ok && e.cost < r.cost - EPS ? e : null;
}

export function twoOpt(P, sol) {
  const o = sol.o;
  let moves = 0;
  for (const r of sol.routes) {
    if (r.ri >= 0) continue;
    let improved = true;
    while (improved) {
      improved = false;
      const L = r.seq.length;
      for (let i = 0; i < L - 1 && !improved; i++) {
        for (let j = i + 1; j < L && !improved; j++) {
          const seq = r.seq.slice(0, i).concat(r.seq.slice(i, j + 1).reverse(), r.seq.slice(j + 1));
          if (tryRoute(P, r, seq, o)) { r.seq = seq; refresh(P, r, o); improved = true; moves++; }
        }
      }
    }
  }
  return moves;
}

export function orOpt(P, sol) {
  const o = sol.o;
  let moves = 0;
  for (const r of sol.routes) {
    if (r.ri >= 0) continue;
    let improved = true;
    while (improved) {
      improved = false;
      const L = r.seq.length;
      for (let len = 1; len <= 3 && !improved; len++) {
        for (let i = 0; i + len <= L && !improved; i++) {
          const seg = r.seq.slice(i, i + len), rest = r.seq.slice(0, i).concat(r.seq.slice(i + len));
          for (let p = 0; p <= rest.length && !improved; p++) {
            if (p === i) continue;
            const seq = rest.slice(0, p).concat(seg, rest.slice(p));
            if (tryRoute(P, r, seq, o)) { r.seq = seq; refresh(P, r, o); improved = true; moves++; }
          }
        }
      }
    }
  }
  return moves;
}

function whereMap(P, sol) {
  const w = new Int32Array(P.N).fill(-1);
  sol.routes.forEach((r, ri) => { for (const s of r.seq) if (s) w[s] = ri; });
  return w;
}

// Move one stop to another route, next to one of its nearest neighbors.
export function relocate(P, sol) {
  const o = sol.o;
  let moves = 0;
  const w = whereMap(P, sol);
  for (let s = 1; s < P.N; s++) {
    const ra = w[s];
    if (ra < 0) continue;
    const A = sol.routes[ra];
    if (A.ri >= 0) continue;
    const k = A.seq.indexOf(s);
    const without = A.seq.slice(0, k).concat(A.seq.slice(k + 1));
    const eA = evalSeq(P, A, without, o);
    if (!eA.ok) continue;
    const gain = A.cost - eA.cost;
    let best = -EPS, bestB = -1, bestP = -1;
    for (const t of P.knn[s]) {
      const rb = w[t];
      if (rb < 0 || rb === ra) continue;
      const B = sol.routes[rb];
      if (B.ri >= 0) continue;
      const kt = B.seq.indexOf(t);
      for (const p of [kt, kt + 1]) {
        const c = insertCost(P, B, s, p, o);
        if (gain - c > best) { best = gain - c; bestB = rb; bestP = p; }
      }
    }
    if (bestB < 0) continue;
    A.seq = without; refresh(P, A, o);
    insertAt(P, sol.routes[bestB], s, bestP, o);
    w[s] = bestB; moves++;
  }
  return moves;
}

// Swap two stops between routes.
export function exchange(P, sol) {
  const o = sol.o;
  let moves = 0;
  const w = whereMap(P, sol);
  for (let s = 1; s < P.N; s++) {
    const ra = w[s];
    if (ra < 0 || sol.routes[ra].ri >= 0) continue;
    for (const t of P.knn[s]) {
      const rb = w[t];
      if (rb < 0 || rb === ra || sol.routes[rb].ri >= 0) continue;
      const A = sol.routes[ra], B = sol.routes[rb];
      const sa = A.seq.map((x) => (x === s ? t : x)), sb = B.seq.map((x) => (x === t ? s : x));
      const eA = evalSeq(P, A, sa, o);
      if (!eA.ok) continue;
      const eB = evalSeq(P, B, sb, o);
      if (!eB.ok || eA.cost + eB.cost >= A.cost + B.cost - EPS) continue;
      A.seq = sa; B.seq = sb; refresh(P, A, o); refresh(P, B, o);
      w[s] = rb; w[t] = ra; moves++;
      break;
    }
  }
  return moves;
}

export function localSearch(P, sol, maxPasses = 30) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const m = twoOpt(P, sol) + orOpt(P, sol) + relocate(P, sol) + exchange(P, sol);
    if (!m) break;
  }
  if (sol.unserved.length) {
    const u = sol.unserved; sol.unserved = [];
    insertStops(P, sol, u, "regret");
  }
  return sol;
}

// ---------------------------------------------------------------------------
// Adaptive large neighborhood search with simulated annealing acceptance.

export const DESTROY = ["random", "worst", "related", "route"];
export const REPAIR = ["greedy", "regret"];

function routedStops(sol) {
  const out = [];
  for (const r of sol.routes) for (const s of r.seq) if (s) out.push(s);
  return out;
}

function movable(sol) {
  // In re-planning, stops on a van can still move within that van, so every routed stop is movable.
  return routedStops(sol);
}

// Plain multiplication, not **, so results match across JavaScript engines.
const pow2 = (x) => x * x, pow3 = (x) => x * x * x, pow4 = (x) => x * x * x * x;

function destroy(P, sol, op, q, rng) {
  const o = sol.o;
  const all = movable(sol);
  if (!all.length) return [];
  let pick = [];
  if (op === "random") {
    const c = all.slice();
    for (let i = 0; i < q && c.length; i++) pick.push(c.splice(Math.floor(rng() * c.length), 1)[0]);
  } else if (op === "worst") {
    const w = whereMap(P, sol);
    const sc = all.map((s) => {
      const r = sol.routes[w[s]], k = r.seq.indexOf(s);
      const e = evalSeq(P, r, r.seq.slice(0, k).concat(r.seq.slice(k + 1)), o);
      return [r.cost - e.cost, s];
    }).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
    const c = sc.map((x) => x[1]);
    while (pick.length < q && c.length) pick.push(c.splice(Math.floor(pow4(rng()) * c.length), 1)[0]);
  } else if (op === "related") {
    const seed = all[Math.floor(rng() * all.length)];
    const rel = (s) => P.D[seed * P.N + s] / 5 + Math.abs(P.a[seed] - P.a[s]) / 60 + (P.cold[seed] === P.cold[s] ? 0 : 0.5);
    const c = all.map((s) => [rel(s), s]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[1]);
    while (pick.length < q && c.length) pick.push(c.splice(Math.floor(pow3(rng()) * c.length), 1)[0]);
  } else {
    const used = sol.routes.filter((r) => r.seq.some((s) => s));
    used.sort((x, y) => x.seq.length - y.seq.length || x.v - y.v);
    const r = used[Math.floor(pow2(rng()) * used.length)];
    pick = r.seq.filter((s) => s);
    if (pick.length < q) {
      const c = all.filter((s) => !pick.includes(s));
      while (pick.length < q && c.length) pick.push(c.splice(Math.floor(rng() * c.length), 1)[0]);
    }
  }
  const set = new Set(pick);
  for (const r of sol.routes) {
    if (!r.seq.some((s) => set.has(s))) continue;
    let ri = r.ri;
    const seq = [];
    r.seq.forEach((s, k) => { if (set.has(s)) { if (ri >= 0 && k < r.ri) ri--; } else seq.push(s); });
    r.seq = seq; r.ri = ri;
    refresh(P, r, o);
  }
  return pick;
}

export function alns(P, start, { iters = 1000, seed = 1, localEvery = 0 } = {}) {
  const rng = mulberry32(seed * 7919 + 13);
  let cur = cloneSol(start), best = cloneSol(start);
  let curC = solCost(cur), bestC = curC;
  const nStops = Math.max(1, routedStops(cur).length + cur.unserved.length);
  const ops = [];
  for (const d of DESTROY) for (const r of REPAIR) ops.push({ d, r, w: 1, score: 0, uses: 0, wins: 0 });
  const T0 = (0.02 * curC) / Math.log(2); // a 2% worse solution is accepted half the time at the start
  const Tend = T0 / 200;
  const cool = iters > 1 ? Math.exp(Math.log(Tend / T0) / (iters - 1)) : 1;
  let T = T0;
  const trace = [{ it: 0, cur: curC, best: bestC }];
  for (let it = 1; it <= iters; it++) {
    let x = rng() * ops.reduce((s, op) => s + op.w, 0), op = ops[ops.length - 1];
    for (const c of ops) { x -= c.w; if (x <= 0) { op = c; break; } }
    const q = Math.max(2, Math.min(40, Math.round(nStops * (0.04 + 0.11 * rng()))));
    const cand = cloneSol(cur);
    const removed = destroy(P, cand, op.d, q, rng);
    const u = cand.unserved; cand.unserved = [];
    insertStops(P, cand, removed.concat(u), op.r);
    const c = solCost(cand);
    op.uses++;
    let gain = 0;
    if (c < bestC - EPS) { best = cloneSol(cand); bestC = c; gain = 33; op.wins++; }
    if (c < curC - EPS) { cur = cand; curC = c; gain = Math.max(gain, 9); } else if (rng() < Math.exp(-(c - curC) / T)) { cur = cand; curC = c; gain = Math.max(gain, 13); }
    op.score += gain;
    if (localEvery && it % localEvery === 0) {
      localSearch(P, cur, 3);
      curC = solCost(cur);
      if (curC < bestC - EPS) { best = cloneSol(cur); bestC = curC; }
    }
    if (it % 100 === 0) {
      for (const p of ops) { if (p.uses) p.w = Math.max(0.05, 0.8 * p.w + 0.2 * (p.score / p.uses)); p.score = 0; p.uses = 0; }
    }
    T *= cool;
    if (it % Math.max(1, Math.floor(iters / 60)) === 0 || it === iters) trace.push({ it, cur: curC, best: bestC });
  }
  best.trace = trace;
  best.ops = ops.map((p) => ({ d: p.d, r: p.r, w: p.w, wins: p.wins }));
  return best;
}

// ---------------------------------------------------------------------------
// Checks and metrics

export function checkSolution(P, sol, stops = staticStops(P)) {
  const errors = [];
  const seen = new Map();
  sol.routes.forEach((r) => {
    const veh = P.veh[r.v];
    const e = evalSeq(P, r, r.seq, sol.o, true);
    let load = 0;
    r.seq.forEach((s, k) => {
      if (s === 0) { load = 0; return; }
      seen.set(s, (seen.get(s) ?? 0) + 1);
      load += P.dem[s];
      if (P.cold[s] && !veh.reefer) errors.push(`stop ${s} needs a refrigerated van, on ${veh.name}`);
      if (e.lateAt[k] > sol.o.maxLate + 1e-9) errors.push(`stop ${s} is ${e.lateAt[k].toFixed(1)} min late on ${veh.name}`);
      if (e.arr[k] > P.b[s] + sol.o.maxLate + 1e-9) errors.push(`stop ${s} misses its window`);
    });
    if (e.load > veh.cap) errors.push(`${veh.name} carries ${e.load} crates over its ${veh.cap}`);
    if (e.used && e.end > veh.end + sol.o.overtime + 1e-9) errors.push(`${veh.name} returns after its shift`);
  });
  for (const s of sol.unserved) seen.set(s, (seen.get(s) ?? 0) + 1);
  for (const s of stops) if (seen.get(s) !== 1) errors.push(`stop ${s} appears ${seen.get(s) ?? 0} times`);
  return { ok: errors.length === 0, errors };
}

export function summarize(P, sol) {
  let km = 0, hours = 0, vans = 0, crates = 0, cap = 0, work = 0, late = 0, stops = 0, onTime = 0;
  for (const r of sol.routes) {
    const real = r.seq.filter((s) => s);
    if (!real.length && !r.inField) continue;
    const veh = P.veh[r.v];
    vans++; km += r.km; hours += (r.end - r.paidFrom) / 60; cap += veh.cap; late += r.late;
    for (let k = 0; k < r.seq.length; k++) {
      const s = r.seq[k];
      if (!s) continue;
      stops++; crates += P.dem[s]; work += P.svc[s];
      if (r.lateAt[k] <= 1e-9) onTime++;
    }
  }
  const drive = km / SPEED;
  return {
    cost: solCost(sol), km, hours, vans, stops, unserved: sol.unserved.length, late, onTime: stops ? onTime / stops : 1,
    capUtil: cap ? crates / cap : 0, timeUtil: hours ? (drive + work / 60) / hours : 0, crates,
  };
}

// ---------------------------------------------------------------------------
// Execution: drive the plan with noisy travel and service times.

export function legNoise(P, i, j, sd) {
  if (!sd) return 1;
  const z = hashGauss(P.cfg.seed, i * 1009 + 17, j * 7 + 3);
  return Math.round(Math.exp(sd * z - (sd * sd) / 2) * 1e6) / 1e6;
}

function svcNoise(P, s, sd) {
  if (!sd) return 1;
  const z = hashGauss(P.cfg.seed + 101, s, 99);
  return Math.round(Math.exp(sd * z - (sd * sd) / 2) * 1e6) / 1e6;
}

// A van being driven: its remaining sequence and where it is.
function vanState(P, r) {
  const veh = P.veh[r.v];
  return {
    v: r.v, seq: r.seq.slice(), node: 0, t: veh.start + LOAD, km: 0, departed: false, returned: null, broken: false,
    visits: [], lastDepot: veh.start, atDepot: true,
  };
}

// Advance a van until its next departure is at or after T. A van that leaves before T
// is committed to its next stop.
function advance(Ptrue, van, T, sd, eta, served) {
  const N = Ptrue.N;
  while (van.seq.length && van.t < T) {
    const j = van.seq.shift();
    const tt = travelTime(Ptrue, van.node, j, van.t) * legNoise(Ptrue, van.node, j, sd);
    van.km += Ptrue.D[van.node * N + j];
    van.departed = true; van.atDepot = false;
    const at = van.t + tt;
    if (j === 0) {
      van.visits.push({ s: 0, arr: at, beg: at, dep: at + RELOAD });
      van.t = at + RELOAD; van.node = 0;
      continue;
    }
    const bg = Math.max(at, Ptrue.a[j]);
    const dep = bg + Ptrue.svc[j] * svcNoise(Ptrue, j, sd * 0.6);
    const late = Math.max(0, at - Ptrue.b[j]);
    const rec = { s: j, v: van.v, arr: at, beg: bg, dep, late, pred: eta.get(j)?.t ?? at, pos: eta.get(j)?.pos ?? 0 };
    van.visits.push(rec);
    served.set(j, rec);
    van.t = dep; van.node = j;
  }
  if (!van.seq.length && van.node !== 0 && van.t < T) {
    const tt = travelTime(Ptrue, van.node, 0, van.t) * legNoise(Ptrue, van.node, 0, sd);
    van.km += Ptrue.D[van.node * N];
    van.returned = van.t + tt + UNLOAD;
    van.visits.push({ s: -1, arr: van.t + tt, beg: van.t + tt, dep: van.returned });
    van.node = 0; van.t = van.returned; van.atDepot = true;
  }
}

function recordEta(P, sol, eta) {
  for (const r of sol.routes) {
    const e = evalSeq(P, r, r.seq, sol.o, true);
    let pos = 0;
    r.seq.forEach((s, k) => { if (s) eta.set(s, { t: e.arr[k], pos: ++pos }); });
  }
}

function dayCost(P, vans, served, all) {
  let cost = 0, km = 0, hours = 0, ot = 0, late = 0, used = 0, tows = 0;
  for (const van of vans) {
    if (!van.departed) continue;
    const veh = P.veh[van.v];
    used++;
    const end = van.broken ? van.brokenAt : van.returned ?? van.t;
    const h = (end - veh.start) / 60;
    hours += h; km += van.km;
    ot += Math.max(0, end - veh.end);
    cost += veh.fixed + h * veh.perHour + otCost(veh, end) + van.km * veh.perKm;
    if (van.broken) { cost += TOW_COST; tows++; }
  }
  let onTime = 0;
  for (const rec of served.values()) { late += rec.late; if (rec.late <= 0) onTime++; }
  const unserved = all.filter((s) => !served.has(s));
  cost += late * LATE_PEN + unserved.length * UNSERVED_PEN;
  return { cost, km, hours, overtime: ot, late, vans: used, served: served.size, unserved: unserved.length, onTime: served.size ? onTime / served.size : 1, tows };
}

export function etaStats(served) {
  const err = [...served.values()].map((r) => r.arr - r.pred);
  const abs = err.map(Math.abs).sort((x, y) => x - y);
  const q = (p) => (abs.length ? abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] : 0);
  const bins = [];
  for (let lo = -30; lo < 60; lo += 5) bins.push({ lo, hi: lo + 5, n: 0 });
  for (const e of err) {
    const k = Math.max(0, Math.min(bins.length - 1, Math.floor((e + 30) / 5)));
    bins[k].n++;
  }
  const byPos = [[1, 4], [5, 8], [9, 12], [13, 99]].map(([lo, hi]) => {
    const xs = [...served.values()].filter((r) => r.pos >= lo && r.pos <= hi).map((r) => Math.abs(r.arr - r.pred));
    return { lo, hi, n: xs.length, mae: xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0 };
  });
  return {
    n: err.length, mean: err.length ? err.reduce((s, x) => s + x, 0) / err.length : 0,
    mae: abs.length ? abs.reduce((s, x) => s + x, 0) / abs.length : 0,
    p50: q(0.5), p90: q(0.9), within10: abs.length ? abs.filter((x) => x <= 10).length / abs.length : 1, bins, byPos,
  };
}

// Drive a static plan through a normal day (no events), with noise.
export function execute(P, plan, sd = P.cfg.noise / 100) {
  const eta = new Map();
  recordEta(P, plan, eta);
  const vans = plan.routes.map((r) => vanState(P, r));
  const served = new Map();
  for (const van of vans) if (van.seq.length) advance(P, van, Infinity, sd, eta, served);
  const res = dayCost(P, vans, served, staticStops(P));
  return { ...res, eta: etaStats(served), vans: vans.map((v) => ({ v: v.v, visits: v.visits, returned: v.returned })) };
}

// ---------------------------------------------------------------------------
// Dynamic day: new orders at 11:00, a bridge closure at 12:30, a van breakdown at 13:30.

export const STRATEGIES = {
  none: { label: "No re-plan", note: "Keep the morning routes. New orders are refused and the broken van's stops are lost." },
  greedy: { label: "Greedy insertion", note: "Keep every van's remaining order and insert new and orphaned stops at their cheapest place." },
  reopt: { label: "Re-optimize", note: "Greedy insertion, then ALNS over every stop not yet committed, from the vans' current positions." },
};

function replanState(P, vans, T, o) {
  const routes = [];
  for (const van of vans) {
    if (van.broken) continue;
    const veh = P.veh[van.v];
    const r = newRoute(P, van.v);
    if (van.node === 0 && van.atDepot) {
      if (van.departed) r.t0 = Math.max(van.t, T) + LOAD;
      else if (van.seq.length && van.t >= T) r.t0 = van.t; // still loading for its first trip
      else r.t0 = Math.max(veh.start, T) + LOAD;
      r.paidFrom = van.departed ? van.returned ?? van.t : veh.start;
      r.fixedDue = !van.departed;
      r.seq = van.seq.filter((s) => s);
    } else {
      r.n0 = van.node; r.t0 = van.t; r.paidFrom = van.t; r.fixedDue = false; r.inField = true;
      const cut = van.seq.indexOf(0);
      const onboard = cut < 0 ? van.seq.slice() : van.seq.slice(0, cut);
      const after = cut < 0 ? [] : van.seq.slice(cut + 1).filter((s) => s);
      r.onboard = new Set(onboard);
      r.seq = onboard.concat([0], after);
      r.ri = onboard.length;
    }
    refresh(P, r, o);
    routes.push(r);
  }
  return { routes, unserved: [], o };
}

export function playDay(P, plan, strategy = "reopt", opt = {}) {
  const sd = opt.sd ?? P.cfg.noise / 100;
  const iters = opt.iters ?? P.cfg.replanIters;
  const o = DYNAMIC_OPTS;
  const Ptrue = withClosure(P);
  const eta = new Map();
  recordEta(P, plan, eta);
  const vans = plan.routes.map((r) => vanState(P, r));
  const served = new Map();
  const newOrders = Array.from({ length: P.total - P.n }, (_, i) => P.n + 1 + i);
  const log = [];
  let known = P, pool = [], refused = 0, lostToBreakdown = 0, broken = null;
  const steps = [
    { t: EVENT_TIMES.orders, kind: "orders" },
    { t: EVENT_TIMES.closure, kind: "closure" },
    { t: EVENT_TIMES.breakdown, kind: "breakdown" },
  ];
  const t0 = Date.now();
  for (const ev of steps) {
    for (const van of vans) if (!van.broken) advance(Ptrue, van, ev.t, sd, eta, served);
    let text = "";
    if (ev.kind === "orders") {
      pool.push(...newOrders);
      text = `${newOrders.length} new orders arrive, windows from 13:00`;
    } else if (ev.kind === "closure") {
      known = withClosure(P);
      text = "The bridge between Riverside and Old Town closes: trips across it take 2.5 times as long";
    } else {
      // The van with the most stops still on board breaks down after its current stop.
      let best = null;
      for (const van of vans) {
        if (van.broken || van.atDepot) continue;
        const left = van.seq.filter((s) => s).length;
        if (!best || left > best.left) best = { van, left };
      }
      if (best) {
        const van = best.van;
        van.broken = true; van.brokenAt = van.t;
        const orphans = van.seq.filter((s) => s);
        van.seq = [];
        pool.push(...orphans);
        broken = { v: van.v, name: P.veh[van.v].name, orphans: orphans.length, t: van.t };
        text = `${P.veh[van.v].name} breaks down; ${orphans.length} stops on it go back to the depot to be re-picked`;
      }
    }
    const before = pool.length;
    if (strategy === "none") {
      if (ev.kind === "orders") refused += pool.length;
      if (ev.kind === "breakdown") lostToBreakdown += pool.length;
      pool = [];
    } else {
      const sol = replanState(known, vans, ev.t, o);
      insertStops(known, sol, pool, "greedy");
      let final = sol;
      if (strategy === "reopt" && iters > 0) {
        final = alns(known, sol, { iters, seed: P.cfg.seed + ev.t });
        if (solCost(final) > solCost(sol)) final = sol;
      }
      let i = 0;
      for (const van of vans) {
        if (van.broken) continue;
        const r = final.routes[i++];
        const seq = r.seq.slice();
        while (seq.length && seq[seq.length - 1] === 0) seq.pop();
        // A van still at the depot loads everything at once: drop the reload marker.
        van.seq = r.ri < 0 ? seq.filter((s) => s) : seq;
        if (r.ri < 0 && van.seq.length) van.t = r.t0; // a van at the depot loads after the re-plan
      }
      pool = final.unserved.slice();
      recordEta(known, { routes: final.routes, o }, eta);
      for (const r of final.routes) {
        const real = r.seq.filter((s) => s);
        for (const s of real) if (served.has(s)) throw new Error(`stop ${s} re-planned after being served`);
      }
    }
    log.push({ t: ev.t, kind: ev.kind, text, pool: before, left: pool.length });
  }
  for (const van of vans) if (!van.broken) advance(Ptrue, van, Infinity, sd, eta, served);
  const all = staticStops(P).concat(newOrders);
  const res = dayCost(P, vans, served, all);
  return {
    strategy, ...res, refused, lostToBreakdown, broken, log, ms: Date.now() - t0,
    eta: etaStats(served), newOrders: newOrders.length,
    newServed: newOrders.filter((s) => served.has(s)).length,
    vans: vans.map((v) => ({ v: v.v, visits: v.visits, broken: v.broken, brokenAt: v.brokenAt, returned: v.returned })),
    servedStops: [...served.keys()],
  };
}

// ---------------------------------------------------------------------------
// The full evaluation the page shows.

export const ALGOS = {
  nn: { label: "Nearest neighbor", note: "Each van takes the closest feasible stop next" },
  sweep: { label: "Sweep", note: "Stops by angle around the depot, vans filled in turn" },
  savings: { label: "Clarke-Wright savings", note: "Merge routes by distance saved, with time windows" },
  ls: { label: "Savings + local search", note: "2-opt, or-opt, relocate, and exchange to a local optimum" },
  alns: { label: "ALNS", note: "Destroy and repair with simulated annealing, then local search" },
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function solveAll(P, cfg = P.cfg) {
  const out = {};
  const time = (fn) => { const t = now(); const s = fn(); return [s, now() - t]; };
  const [nn, tNn] = time(() => nearestNeighbor(P));
  const [sw, tSw] = time(() => sweep(P));
  const [sv, tSv] = time(() => savings(P));
  const [ls, tLs] = time(() => localSearch(P, cloneSol(sv)));
  const startBest = [nn, sw, ls].reduce((x, y) => (solCost(y) < solCost(x) ? y : x));
  const [al, tAl] = time(() => localSearch(P, alns(P, startBest, { iters: cfg.iters, seed: cfg.seed })));
  const sols = { nn: [nn, tNn], sweep: [sw, tSw], savings: [sv, tSv], ls: [ls, tSv + tLs], alns: [al, tAl] };
  for (const [k, [s, ms]] of Object.entries(sols)) {
    const sum = summarize(P, s);
    const ex = execute(P, s);
    out[k] = { key: k, label: ALGOS[k].label, ms, ...sum, actualOnTime: ex.onTime, actualCost: ex.cost, etaMae: ex.eta.mae, sol: s };
  }
  out.alns.trace = al.trace;
  out.alns.ops = al.ops;
  return out;
}

// Plain-data view of a solution for the page and the worker.
export function planView(P, sol) {
  return sol.routes.map((r) => {
    const e = evalSeq(P, r, r.seq, sol.o, true);
    return {
      v: r.v, seq: r.seq.slice(), km: e.km, end: e.end, cost: e.cost, load: e.load, used: e.used,
      visits: r.seq.map((s, k) => ({ s, arr: e.arr[k], beg: e.beg[k], dep: e.dep[k], late: e.lateAt[k] })),
    };
  });
}

// ---------------------------------------------------------------------------
// Formatting

export const fmtTime = (t) => {
  const m = Math.round(t), h = Math.floor(m / 60), mm = m - h * 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
export const fmtMoney = (x) => `$${Math.round(x).toLocaleString("en-US")}`;
export const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
export const pct = (x, dp = 1) => `${(x * 100).toFixed(dp)}%`;
