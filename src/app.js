import {
  ALGOS, DEFAULTS, EVENT_TIMES, FLEETS, HOODS, STRATEGIES, TIGHTNESS, clamp, decodeConfig, encodeConfig, fmtInt, fmtMoney, fmtTime, makeProblem, pct,
} from "./vrp.js";
import { compute } from "./run.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const SVG_NS = "http://www.w3.org/2000/svg";

let cfg = decodeConfig(location.hash);
let P = null; // geometry, built locally from the same seed
let A = null; // plan stage from the worker
let DY = null; // played day from the worker
let view = "plan", algo = "alns", strat = "reopt", etaView = "normal";
let clock = 21 * 60 + 30;
let playing = 0;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const narrow = () => matchMedia("(max-width: 600px)").matches;
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#6250d6", "#d03b8f", "#b07400", "#0e9bb3", "#8a5a2b", "#5b6dd6", "#c4321f", "#3f8f2f", "#9a4fd0"];
const vanColor = (v) => PALETTE[v % PALETTE.length];
const mins = (x) => `${Math.round(x)} min`;

// ---------------------------------------------------------------------------
// Form

const F = (name, label, title, step = 1) => ({ name, label, title, step });
const opts = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.label]));

const GROUPS = [
  { legend: "Orders", fields: [
    { name: "tight", label: "Time windows", type: "select", options: opts(TIGHTNESS), title: "Width of the delivery windows customers pick from" },
    F("n", "Stops (150 to 400)", "Orders known the evening before", 10),
    F("cold", "Cold orders (%)", "Orders with chilled or frozen items, which need a refrigerated van"),
    F("newPct", "New orders at 11:00 (%)", "Orders placed during the day, as a share of the planned stops"),
  ] },
  { legend: "Fleet", fields: [
    { name: "fleet", label: "Fleet mix", type: "select", options: opts(FLEETS), title: "Van types. The fleet is sized to the orders; half the vans run 07:00 to 16:30, half 11:30 to 21:00" },
  ] },
  { legend: "Solver", fields: [
    F("iters", "ALNS iterations", "Destroy and repair iterations for the morning plan", 100),
    F("replanIters", "Re-plan iterations", "ALNS iterations at each event during the day", 50),
    F("noise", "Travel time noise (%)", "Standard deviation of actual over predicted travel time, per leg"),
    F("seed", "Random seed", "Orders, the fleet, and the noise all come from this seed"),
  ] },
];

function field(f) {
  if (f.type === "select") {
    return el("label", { title: f.title || null }, [f.label, el("select", { name: f.name }, Object.entries(f.options).map(([v, t]) => el("option", { value: v, text: t })))]);
  }
  return el("label", { title: f.title || null }, [f.label, el("input", { type: "number", name: f.name, step: f.step, min: 0, inputmode: "numeric" })]);
}

function buildForm() {
  form.replaceChildren(...GROUPS.map((g) => {
    const selects = g.fields.filter((f) => f.type === "select");
    const rest = g.fields.filter((f) => f.type !== "select");
    const kids = [el("legend", { text: g.legend }), ...selects.map(field)];
    if (rest.length) kids.push(el("div", { class: "grid2" }, rest.map(field)));
    if (g.legend === "Fleet") kids.push(el("span", { class: "field-hint", id: "fleet-note" }));
    return el("fieldset", {}, kids);
  }));
  fillForm();
}

function fillForm() {
  for (const f of form.elements) if (f.name && f.name in cfg) f.value = cfg[f.name];
  const note = $("fleet-note");
  if (note) note.textContent = FLEETS[cfg.fleet].note + ".";
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (!f.name) return;
  let v = f.value;
  if (f.tagName !== "SELECT") {
    v = Number(f.value);
    if (f.value === "" || !Number.isFinite(v) || v < 0) return;
  }
  cfg = clamp({ ...cfg, [f.name]: v });
  schedule();
});
form.addEventListener("change", () => fillForm());

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(update, 400);
}

// ---------------------------------------------------------------------------
// Worker

let worker = null, jobId = 0, started = 0;
try {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => onResult(e.data);
  worker.onerror = () => { worker = null; runLocal(jobId); };
} catch {
  worker = null;
}

function onResult(m) {
  if (m.id !== jobId) return;
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  if (m.stage === "plan") {
    A = m;
    $("status").textContent = `Planned in ${secs} s. Playing the day...`;
    $("day-status").textContent = "Re-planning...";
  } else {
    DY = m.day;
    $("status").textContent = `Planned and played in ${secs} s`;
    $("day-status").textContent = "";
  }
  drawAll();
}

function runLocal(id) {
  setTimeout(() => { if (id === jobId) compute(cfg, (msg) => onResult({ id, ...msg })); }, 30);
}

function update() {
  P = makeProblem(cfg);
  A = null; DY = null;
  jobId++;
  started = performance.now();
  $("status").textContent = `Solving ${cfg.n} stops with ${P.veh.length} vans...`;
  $("day-status").textContent = "";
  if (worker) worker.postMessage({ id: jobId, cfg });
  else runLocal(jobId);
  history.replaceState(null, "", `#${encodeConfig(cfg)}`);
  drawAll();
}

// ---------------------------------------------------------------------------
// Summary

function drawAll() {
  drawTabs();
  drawPlan();
  drawCards();
  drawMap();
  drawGantt();
  drawAlgoTable();
  drawConv();
  drawDayTable();
  drawEta();
}

function tabs(id, items, cur, attr) {
  $(id).replaceChildren(...Object.entries(items).map(([k, label]) => el("button", {
    type: "button", class: "tab", role: "tab", [`data-${attr}`]: k, "aria-selected": String(k === cur),
  }, [label])));
}

function drawTabs() {
  for (const b of $("view-tabs").children) b.setAttribute("aria-selected", String(b.dataset.view === view));
  for (const b of $("eta-tabs").children) b.setAttribute("aria-selected", String(b.dataset.view === etaView));
  const short = { nn: "Nearest neighbor", sweep: "Sweep", savings: "Savings", ls: "Savings + LS", alns: "ALNS" };
  tabs("algo-tabs", short, algo, "algo");
  tabs("strat-tabs", Object.fromEntries(Object.entries(STRATEGIES).map(([k, s]) => [k, s.label])), strat, "strat");
  $("algo-tabs").hidden = view !== "plan";
  $("strat-tabs").hidden = view !== "day";
  $("clock").hidden = view !== "day";
  $("events").hidden = view !== "day";
}

const bestConstruction = () => ["nn", "sweep", "savings"].reduce((x, y) => (A.algos[y].cost < A.algos[x].cost ? y : x));

function drawPlan() {
  if (!A) { $("rec").textContent = `Solving ${cfg.n} stops: nearest neighbor, sweep, savings, local search, then ${fmtInt(cfg.iters)} ALNS iterations.`; return; }
  const a = A.algos.alns, b = A.algos[bestConstruction()];
  const parts = [
    `${fmtInt(cfg.n)} orders, ${fmtInt(a.crates + 0)} crates. The ALNS plan uses ${a.vans} vans and ${fmtInt(a.km)} km for ${fmtMoney(a.cost)}, ${pct(1 - a.cost / b.cost, 0)} less than the best construction heuristic (${ALGOS[b.key].label.toLowerCase()}, ${fmtMoney(b.cost)}), and leaves ${a.unserved} ${a.unserved === 1 ? "order" : "orders"} unserved.`,
    `Every planned arrival is inside its window, but driven with ${cfg.noise}% travel time noise ${pct(a.actualOnTime)} of deliveries are on time, and ETAs are off by ${A.normal.eta.mae.toFixed(1)} minutes on average.`,
  ];
  if (DY) {
    const r = DY.reopt, g = DY.greedy, n = DY.none;
    parts.push(`In the played day, re-optimizing at each event costs ${fmtMoney(r.cost)} and delivers ${r.newServed} of ${r.newOrders} new orders at ${pct(r.onTime)} on time; greedy insertion costs ${fmtMoney(g.cost)} at ${pct(g.onTime)} on time, and not re-planning costs ${fmtMoney(n.cost)}.`);
  }
  $("rec").textContent = parts.join(" ");
}

function card(label, value, sub, title, cls = "") {
  return el("div", { class: "card", title }, [el("span", { class: "card-label", text: label }), el("span", { class: `card-total ${cls}`, text: value }), el("span", { class: "card-sub", text: sub })]);
}

function drawCards() {
  if (!A) { $("cards").replaceChildren(); return; }
  const a = A.algos.alns, b = A.algos[bestConstruction()];
  const e = A.normal.eta;
  const kids = [
    card("Plan cost (ALNS)", fmtMoney(a.cost), `${fmtMoney(b.cost - a.cost)} less than ${ALGOS[b.key].label.toLowerCase()}`, "Van fixed cost, paid driver hours, km, and $150 per order not delivered"),
    card("Vans and km", `${a.vans} vans`, `${fmtInt(a.km)} km, ${pct(a.capUtil, 0)} of capacity loaded`, "Vans with at least one stop"),
    card("Orders served", `${fmtInt(a.stops)} of ${fmtInt(cfg.n)}`, a.unserved ? `${a.unserved} left unserved` : "every order planned", "Orders in the morning plan", a.unserved > cfg.n * 0.02 ? "bad" : ""),
    card("On time when driven", pct(a.actualOnTime), `planned 100%, with ${cfg.noise}% travel noise`, "The plan driven once with noisy travel and service times", a.actualOnTime < 0.9 ? "bad" : ""),
  ];
  if (DY) {
    const r = DY.reopt, g = DY.greedy;
    kids.push(card("Played day, re-optimized", fmtMoney(r.cost), `${fmtMoney(g.cost - r.cost)} less than greedy insertion`, "Total day cost with the events, re-optimizing at each one", r.cost <= g.cost ? "good" : ""));
  } else kids.push(card("Played day", "...", "re-planning in the worker"));
  kids.push(card("ETA error", `${e.mae.toFixed(1)} min`, `p90 ${e.p90.toFixed(0)} min, ${pct(e.within10, 0)} within 10 min`, "Mean absolute error of the morning plan's arrival times on a normal day"));
  $("cards").replaceChildren(...kids);
}

// ---------------------------------------------------------------------------
// Map

const S = 20; // px per km
const MX = (x) => x * S, MY = (y) => 600 - y * S;
const nodeXY = (s) => (s > 0 ? [P.xs[s], P.ys[s]] : [P.xs[0], P.ys[0]]);

function lPath(pts) {
  // City grid: drive along x, then along y.
  let d = `M${MX(pts[0][0]).toFixed(1)},${MY(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += `H${MX(pts[i][0]).toFixed(1)}V${MY(pts[i][1]).toFixed(1)}`;
  return d;
}

// Where a van is at time t, from its visits.
function vanAt(v, t) {
  let pos = [P.xs[0], P.ys[0]], prevDep = -1, prev = pos;
  for (const x of v.visits) {
    const xy = nodeXY(x.s);
    if (t < x.arr) {
      if (prevDep < 0 || t <= prevDep) return prev;
      const f = (t - prevDep) / Math.max(1e-6, x.arr - prevDep);
      // Along the L-shaped path: x first, then y.
      const dx = Math.abs(xy[0] - prev[0]), dy = Math.abs(xy[1] - prev[1]), d = f * (dx + dy);
      return d <= dx ? [prev[0] + Math.sign(xy[0] - prev[0]) * d, prev[1]] : [xy[0], prev[1] + Math.sign(xy[1] - prev[1]) * (d - dx)];
    }
    prev = xy; prevDep = x.dep; pos = xy;
  }
  return pos;
}

function mapLegend() {
  const items = view === "plan"
    ? [["d-route", "Stop, colored by van"], ["d-uns", "Not in the plan"], ["d-depot", "Depot"]]
    : [["d-route", "Delivered"], ["d-late", "Delivered late"], ["d-pending", "Waiting"], ["d-uns", "Not delivered by day end"], ["d-van", "Van now"]];
  const li = items.map(([c, t]) => el("li", {}, [el("i", { class: `dot ${c}` }), t]));
  if (view === "day") li.push(el("li", {}, [el("i", { class: "swatch closure" }), "Closed bridge"]));
  $("map-legend").replaceChildren(...li);
}

let mapStops = []; // [x, y, s, info] for the tooltip

function drawMap() {
  mapLegend();
  const nodes = [];
  for (let k = 0; k <= 30; k += 2) {
    nodes.push(svg("line", { x1: MX(k), x2: MX(k), y1: 0, y2: 600, class: "street" }));
    nodes.push(svg("line", { y1: MY(k), y2: MY(k), x1: 0, x2: 600, class: "street" }));
  }
  nodes.push(svg("path", { class: "river", d: `M${MX(11.6)},${MY(0)} C${MX(10.8)},${MY(7)} ${MX(12.2)},${MY(12)} ${MX(11.3)},${MY(17)} S${MX(12.4)},${MY(26)} ${MX(11.8)},${MY(30)}` }));
  const box = P.closureDef;
  const closed = view === "day" && clock >= box.from;
  nodes.push(svg("rect", { x: MX(box.x0), y: MY(box.y1), width: (box.x1 - box.x0) * S, height: (box.y1 - box.y0) * S, class: `closure${closed ? "" : " off"}` }));
  nodes.push(svg("text", { x: MX(box.x1) + 4, y: MY(box.y0) - 4, class: "tick" }, closed ? "Bridge closed" : "Bridge"));
  for (const h of HOODS) nodes.push(svg("text", { x: MX(h.x), y: MY(h.y + h.r * 1.1), class: "hood", "text-anchor": "middle" }, h.name));
  mapStops = [];
  if (view === "plan") drawPlanMap(nodes); else drawDayMap(nodes);
  const [dx, dy] = [MX(P.xs[0]), MY(P.ys[0])];
  nodes.push(svg("rect", { x: dx - 7, y: dy - 7, width: 14, height: 14, rx: 2, class: "depot" }));
  nodes.push(svg("text", { x: dx + 10, y: dy + 16, class: "lbl" }, "Depot"));
  $("map").replaceChildren(...nodes);
  drawEvents();
}

function drawPlanMap(nodes) {
  if (!A) {
    for (let s = 1; s <= P.n; s++) nodes.push(svg("circle", { cx: MX(P.xs[s]), cy: MY(P.ys[s]), r: 3, class: "stop pending" }));
    $("map-note").textContent = "Solving...";
    return;
  }
  const plan = A.algos[algo].plan;
  for (const r of plan) {
    if (!r.seq.length) continue;
    nodes.push(svg("path", { d: lPath([[P.xs[0], P.ys[0]], ...r.seq.map(nodeXY), [P.xs[0], P.ys[0]]]), class: "route", stroke: vanColor(r.v) }));
  }
  for (const r of plan) {
    r.visits.forEach((x, k) => {
      const s = x.s;
      nodes.push(svg("circle", { cx: MX(P.xs[s]), cy: MY(P.ys[s]), r: P.cold[s] ? 4 : 3.4, class: "stop", fill: vanColor(r.v) }));
      mapStops.push([MX(P.xs[s]), MY(P.ys[s]), s, { v: r.v, pos: k + 1, plan: x }]);
    });
  }
  for (const s of A.algos[algo].unservedStops) {
    nodes.push(svg("circle", { cx: MX(P.xs[s]), cy: MY(P.ys[s]), r: 4, class: "stop unserved" }));
    mapStops.push([MX(P.xs[s]), MY(P.ys[s]), s, { unserved: true }]);
  }
  const a = A.algos[algo];
  $("map-note").textContent = `${ALGOS[algo].label}: ${ALGOS[algo].note}. ${a.vans} vans, ${fmtInt(a.km)} km, ${a.unserved} unserved. Lines follow the street grid. Larger dots are cold orders. Hover a stop for its window and planned arrival.`;
}

function drawDayMap(nodes) {
  if (!DY) {
    $("map-note").textContent = "Playing the day in the worker...";
    for (let s = 1; s <= P.n; s++) nodes.push(svg("circle", { cx: MX(P.xs[s]), cy: MY(P.ys[s]), r: 3, class: "stop pending" }));
    return;
  }
  const d = DY[strat], t = clock;
  const servedAt = new Map();
  for (const v of d.vans) {
    const done = [[P.xs[0], P.ys[0]]];
    for (const x of v.visits) { if (x.arr > t) break; done.push(nodeXY(x.s)); if (x.s > 0) servedAt.set(x.s, { v: v.v, x }); }
    if (v.visits.some((x) => x.arr <= t) || v.visits.length && t >= v.visits[0].arr) {
      const now = vanAt(v, t);
      done.push(now);
      nodes.push(svg("path", { d: lPath(done), class: "route", stroke: vanColor(v.v) }));
    }
  }
  const all = P.total;
  for (let s = 1; s <= all; s++) {
    if (s > P.n && t < EVENT_TIMES.orders) continue;
    const hit = servedAt.get(s);
    let cls = "stop pending", fill = null;
    if (hit) { cls = `stop${hit.x.late > 0 ? " late" : ""}`; fill = vanColor(hit.v); } else if (t >= 21 * 60 + 30) cls = "stop unserved";
    const c = svg("circle", { cx: MX(P.xs[s]), cy: MY(P.ys[s]), r: P.cold[s] ? 4 : 3.4, class: cls });
    if (fill) c.setAttribute("fill", fill);
    nodes.push(c);
    mapStops.push([MX(P.xs[s]), MY(P.ys[s]), s, hit ? { v: hit.v, actual: hit.x } : { pending: true }]);
  }
  for (const v of d.vans) {
    if (!v.visits.length || t < (v.visits[0].arr - 30)) continue;
    const ret = v.visits[v.visits.length - 1];
    if (!v.broken && ret.s === -1 && t > ret.dep) continue;
    const [x, y] = vanAt(v, t);
    const broken = v.broken && t >= v.brokenAt;
    nodes.push(svg("circle", { cx: MX(x), cy: MY(y), r: 6.5, class: broken ? "van broken" : "van", fill: vanColor(v.v) }));
    if (broken) nodes.push(svg("text", { x: MX(x) + 9, y: MY(y) - 8, class: "lbl" }, `${P.veh[v.v].name} broken down`));
  }
  const served = [...servedAt.keys()].length;
  $("map-note").textContent = `${STRATEGIES[strat].label}: ${STRATEGIES[strat].note} At ${fmtTime(t)}: ${served} delivered${t >= EVENT_TIMES.orders ? `, ${d.newOrders} new orders in` : ""}. Lines show where each van has driven so far.`;
}

function drawEvents() {
  if (!DY || view !== "day") { $("events").replaceChildren(); return; }
  const d = DY[strat];
  $("events").replaceChildren(...d.log.map((e) => el("li", { class: clock >= e.t ? "on" : "" }, [
    el("b", { text: `${fmtTime(e.t)} ` }), e.text, strat === "none" ? "" : `. Re-plan: ${e.pool} stops to place, ${e.left} left unplaced.`,
  ])));
}

const tipRow = (a, b) => el("div", { class: "tip-row" }, [el("span", { text: a }), el("b", { text: b })]);

function placeTip(tip, box, e) {
  tip.hidden = false;
  const left = e.clientX - box.left;
  const w = tip.offsetWidth;
  let x = left > box.width / 2 ? left - w - 12 : left + 12;
  x = Math.max(0, Math.min(box.width - w, x));
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.max(0, e.clientY - box.top + 14)}px`;
}

function svgPoint(svgEl, e) {
  const pt = svgEl.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  return pt.matrixTransform(svgEl.getScreenCTM().inverse());
}

function stopRows(s) {
  const h = P.hood[s] >= 0 ? HOODS[P.hood[s]].name : "Outskirts";
  return [
    el("strong", { text: `Order ${s}${s > P.n ? " (placed 11:00)" : ""}, ${h}` }),
    tipRow("Window", `${fmtTime(P.a[s])} to ${fmtTime(P.b[s])}`),
    tipRow("Crates", `${P.dem[s]}${P.cold[s] ? ", cold" : ""}`),
    tipRow("Service time", mins(P.svc[s])),
  ];
}

{
  const map = $("map"), tip = map.nextElementSibling;
  map.addEventListener("pointermove", (e) => {
    if (!P) return;
    const p = svgPoint(map, e);
    let best = null, bd = 14 * 14;
    for (const m of mapStops) { const d = (m[0] - p.x) ** 2 + (m[1] - p.y) ** 2; if (d < bd) { bd = d; best = m; } }
    if (!best) { tip.hidden = true; return; }
    const [, , s, info] = best;
    const rows = stopRows(s);
    if (info.unserved) rows.push(el("div", { class: "tip-ev", text: "Not in this plan: no van could fit it." }));
    if (info.plan) rows.push(tipRow("Van", `${P.veh[info.v].name}, stop ${info.pos}`), tipRow("Planned arrival", fmtTime(info.plan.arr)), tipRow("Wait", mins(Math.max(0, info.plan.beg - info.plan.arr))));
    if (info.actual) {
      const x = info.actual;
      rows.push(tipRow("Van", P.veh[info.v].name), tipRow("Predicted", fmtTime(x.pred)), tipRow("Actual", fmtTime(x.arr)));
      if (x.late > 0) rows.push(el("div", { class: "tip-ev", text: `${mins(x.late)} late.` }));
    }
    if (info.pending) rows.push(el("div", { class: "tip-ev", text: "Not delivered yet." }));
    tip.replaceChildren(...rows);
    placeTip(tip, map.parentElement.getBoundingClientRect(), e);
  });
  map.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---------------------------------------------------------------------------
// Gantt

const G0 = 6.5 * 60, G1 = 22 * 60;
let ganttRows = [];

function drawGantt() {
  const g = $("gantt");
  g.classList.add("gantt");
  if (!A || (view === "day" && !DY)) { g.replaceChildren(); g.setAttribute("viewBox", "0 0 800 40"); $("gantt-sub").textContent = "Solving..."; return; }
  const W = narrow() ? 440 : 800, L = 34, R = 8, RH = narrow() ? 15 : 17, top = 22;
  const X = (t) => L + ((t - G0) / (G1 - G0)) * (W - L - R);
  let rows;
  if (view === "plan") {
    rows = A.algos[algo].plan.filter((r) => r.seq.length).map((r) => ({ v: r.v, visits: r.visits.map((x) => ({ ...x })), start: P.veh[r.v].start, end: r.end }));
  } else {
    rows = DY[strat].vans.filter((v) => v.visits.length).map((v) => ({ v: v.v, visits: v.visits, broken: v.broken, brokenAt: v.brokenAt, start: P.veh[v.v].start }));
  }
  rows.sort((a, b) => P.veh[a.v].start - P.veh[b.v].start || a.v - b.v);
  ganttRows = rows;
  const H = top + rows.length * RH + 8 + (view === "day" ? 12 : 0);
  g.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const nodes = [];
  for (let h = 7; h <= 22; h++) {
    if (narrow() && h % 2) continue;
    nodes.push(svg("line", { x1: X(h * 60), x2: X(h * 60), y1: top - 4, y2: H - 6, class: "grid" }));
    nodes.push(svg("text", { x: X(h * 60), y: 12, class: "tick", "text-anchor": "middle" }, `${h}:00`));
  }
  rows.forEach((r, i) => {
    const y = top + i * RH, veh = P.veh[r.v];
    const kids = [svg("rect", { x: X(veh.start), y: y + 1, width: X(veh.end) - X(veh.start), height: RH - 3, class: "shift" })];
    let prevDep = veh.start + 15;
    r.visits.forEach((x, k) => {
      kids.push(svg("line", { x1: X(prevDep), x2: X(x.arr), y1: y + RH / 2, y2: y + RH / 2, class: "drive" }));
      if (x.s > 0) {
        kids.push(svg("line", { x1: X(P.a[x.s]), x2: X(P.b[x.s]), y1: y + RH - 3, y2: y + RH - 3, class: "win" }));
        if (x.beg > x.arr + 0.5) kids.push(svg("rect", { x: X(x.arr), y: y + 3, width: X(x.beg) - X(x.arr), height: RH - 7, class: "wait" }));
        kids.push(svg("rect", { x: X(x.beg), y: y + 2, width: Math.max(1.2, X(x.dep) - X(x.beg)), height: RH - 5, class: `svc${x.late > 0 ? " late" : ""}`, "data-r": i, "data-k": k }));
      }
      prevDep = x.dep;
    });
    if (r.broken) {
      const bx = X(r.brokenAt), cy = y + RH / 2;
      kids.push(svg("path", { d: `M${bx - 4},${cy - 4}L${bx + 4},${cy + 4}M${bx - 4},${cy + 4}L${bx + 4},${cy - 4}`, class: "xmark" }));
    }
    kids.push(svg("text", { x: 2, y: y + RH - 5, class: "vname", fill: vanColor(r.v) }, veh.name));
    const row = svg("g", { class: "row" });
    row.append(...kids);
    nodes.push(row);
  });
  if (view === "day") {
    for (const [k, t] of Object.entries(EVENT_TIMES)) {
      nodes.push(svg("line", { x1: X(t), x2: X(t), y1: top - 4, y2: k === "closure" ? H - 10 : H - 22, class: "evline" }));
      nodes.push(svg("text", { x: X(t) + 3, y: k === "closure" ? H - 1 : H - 13, class: "evlbl" }, { orders: "new orders", closure: "bridge closes", breakdown: "breakdown" }[k]));
    }
    if (clock < 21 * 60 + 30) nodes.push(svg("line", { x1: X(clock), x2: X(clock), y1: top - 4, y2: H - 6, class: "now" }));
  }
  g.replaceChildren(...nodes);
  const late = rows.reduce((s, r) => s + r.visits.filter((x) => x.late > 0).length, 0);
  $("gantt-sub").textContent = view === "plan"
    ? `${ALGOS[algo].label}: ${rows.length} vans. Early shift 07:00 to 16:30, late shift 11:30 to 21:00. Green blocks are deliveries, grey is waiting for a window to open, and the purple line under each block is that stop's window.`
    : `${STRATEGIES[strat].label}, as driven: ${rows.length} vans, ${late} late deliveries. Dashed lines mark the events; an X marks the breakdown.`;
}

{
  const g = $("gantt"), tip = g.nextElementSibling;
  g.addEventListener("pointermove", (e) => {
    const t = e.target.closest("[data-r]");
    if (!t) { tip.hidden = true; return; }
    const r = ganttRows[Number(t.dataset.r)], x = r.visits[Number(t.dataset.k)];
    const rows = stopRows(x.s);
    rows.push(tipRow("Van", P.veh[r.v].name), tipRow(view === "plan" ? "Planned arrival" : "Arrived", fmtTime(x.arr)));
    if (view === "day" && x.pred != null) rows.push(tipRow("Predicted", fmtTime(x.pred)));
    if (x.beg > x.arr + 0.5) rows.push(tipRow("Waited", mins(x.beg - x.arr)));
    if (x.late > 0) rows.push(el("div", { class: "tip-ev", text: `${mins(x.late)} late.` }));
    tip.replaceChildren(...rows);
    placeTip(tip, g.parentElement.getBoundingClientRect(), e);
  });
  g.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---------------------------------------------------------------------------
// Tables and charts

function drawAlgoTable() {
  if (!A) { $("algo-rows").replaceChildren(); return; }
  const best = Math.min(...Object.values(A.algos).map((a) => a.cost));
  $("algo-rows").replaceChildren(...Object.keys(ALGOS).map((k) => {
    const a = A.algos[k];
    return el("tr", { "data-key": k, class: k === algo && view === "plan" ? "selected" : "" }, [
      el("td", { class: "name" }, [ALGOS[k].label, el("small", { text: ALGOS[k].note })]),
      el("td", { class: `num${a.cost === best ? " good" : ""}`, text: fmtMoney(a.cost) }),
      el("td", { class: "num", text: fmtInt(a.km) }),
      el("td", { class: "num", text: a.vans }),
      el("td", { class: `num${a.unserved ? " bad" : ""}`, text: a.unserved }),
      el("td", { class: "num", text: pct(a.capUtil, 0) }),
      el("td", { class: "num", text: pct(a.timeUtil, 0) }),
      el("td", { class: "num", text: pct(a.actualOnTime) }),
      el("td", { class: "num", text: a.ms < 1000 ? `${Math.round(a.ms)} ms` : `${(a.ms / 1000).toFixed(1)} s` }),
    ]);
  }));
  const ls = A.algos.ls, al = A.algos.alns;
  $("algo-note").textContent = `Click a row to show its routes. Every plan here has each arrival inside its window, so the planned on-time rate is 100%; the "driven" column runs the plan once with ${cfg.noise}% noise on each leg. ALNS starts from the cheapest of the other plans and takes ${(al.ms / 1000).toFixed(1)} s for ${fmtInt(cfg.iters)} iterations against ${Math.round(ls.ms)} ms for savings plus local search. Unserved orders cost $150 each in the objective.`;
}

function drawConv() {
  const g = $("conv");
  if (!A?.algos.alns.trace) { g.replaceChildren(); g.setAttribute("viewBox", "0 0 800 40"); return; }
  const tr = A.algos.alns.trace;
  const W = narrow() ? 440 : 800, H = 170, Pd = { l: 58, r: 10, t: 8, b: 22 };
  const lo = Math.min(...tr.map((p) => p.best)), hi = Math.max(...tr.map((p) => p.cur));
  const span = Math.max(1, hi - lo);
  const X = (i) => Pd.l + (i / tr[tr.length - 1].it) * (W - Pd.l - Pd.r);
  const Y = (c) => H - Pd.b - ((c - lo + span * 0.05) / (span * 1.1)) * (H - Pd.t - Pd.b);
  g.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const nodes = [];
  for (let k = 0; k <= 4; k++) {
    const c = lo - span * 0.05 + (span * 1.1 * k) / 4;
    nodes.push(svg("line", { x1: Pd.l, x2: W - Pd.r, y1: Y(c), y2: Y(c), class: "grid" }));
    nodes.push(svg("text", { x: Pd.l - 6, y: Y(c) + 4, class: "tick", "text-anchor": "end" }, fmtMoney(c)));
  }
  for (let k = 0; k <= 4; k++) {
    const it = Math.round((tr[tr.length - 1].it * k) / 4);
    nodes.push(svg("text", { x: X(it), y: H - 6, class: "tick", "text-anchor": "middle" }, fmtInt(it)));
  }
  nodes.push(svg("path", { d: tr.map((p, i) => `${i ? "L" : "M"}${X(p.it).toFixed(1)},${Y(p.cur).toFixed(1)}`).join(""), class: "l-cur" }));
  nodes.push(svg("path", { d: tr.map((p, i) => `${i ? "L" : "M"}${X(p.it).toFixed(1)},${Y(p.best).toFixed(1)}`).join(""), class: "l-best" }));
  g.replaceChildren(...nodes);
  const ops = A.algos.alns.ops.slice().sort((a, b) => b.wins - a.wins);
  const name = { random: "random", worst: "worst", related: "related (Shaw)", route: "route" };
  $("ops-note").textContent = `Cost of the current and best solution by iteration, before the final local search. Simulated annealing accepts worse solutions early and cools to almost none. Operators that found new bests: ${ops.filter((o) => o.wins).slice(0, 4).map((o) => `${name[o.d]} removal with ${o.r} repair (${o.wins})`).join(", ") || "none"}.`;
}

function drawDayTable() {
  if (!DY) { $("day-rows").replaceChildren(); $("day-note").textContent = A ? "Re-planning in the worker..." : ""; return; }
  const best = Math.min(...Object.values(DY).map((d) => d.cost));
  $("day-rows").replaceChildren(...Object.keys(STRATEGIES).map((k) => {
    const d = DY[k];
    return el("tr", { "data-key": k, class: k === strat && view === "day" ? "selected" : "" }, [
      el("td", { class: "name" }, [STRATEGIES[k].label, el("small", { text: STRATEGIES[k].note })]),
      el("td", { class: `num${d.cost === best ? " good" : ""}`, text: fmtMoney(d.cost) }),
      el("td", { class: "num", text: `${fmtInt(d.served)} of ${fmtInt(d.served + d.unserved)}` }),
      el("td", { class: "num", text: `${d.newServed} of ${d.newOrders}` }),
      el("td", { class: `num${d.onTime < 0.9 ? " bad" : ""}`, text: pct(d.onTime) }),
      el("td", { class: "num", text: fmtInt(d.late) }),
      el("td", { class: "num", text: fmtInt(d.overtime) }),
      el("td", { class: "num", text: fmtInt(d.km) }),
      el("td", { class: "num", text: d.ms < 1000 ? `${d.ms} ms` : `${(d.ms / 1000).toFixed(1)} s` }),
    ]);
  }));
  const r = DY.reopt;
  $("day-note").textContent = `Click a row to play that strategy on the map. ${r.broken ? `The breakdown hits ${r.broken.name} at ${fmtTime(r.broken.t)} with ${r.broken.orphans} stops still on board; those orders are re-picked at the depot and need a van that reloads there.` : ""} Re-planning allows up to 60 minutes late and 60 minutes of overtime, both paid for in the cost. Greedy insertion keeps each van's order, so it absorbs the closure as delay; re-optimizing runs ${cfg.replanIters} ALNS iterations at each event.`;
}

function drawEta() {
  const g = $("eta");
  const stats = etaView === "normal" ? A?.normal.eta : DY?.reopt.eta;
  if (!stats) { g.replaceChildren(); g.setAttribute("viewBox", "0 0 800 40"); $("eta-rows").replaceChildren(); return; }
  const W = narrow() ? 440 : 800, H = 180, Pd = { l: 40, r: 10, t: 10, b: 30 };
  const bins = stats.bins, max = Math.max(1, ...bins.map((b) => b.n));
  const X = (m) => Pd.l + ((m + 30) / 90) * (W - Pd.l - Pd.r);
  const Y = (n) => H - Pd.b - (n / max) * (H - Pd.t - Pd.b);
  g.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const nodes = [];
  const step = max > 40 ? Math.ceil(max / 40) * 10 : max > 8 ? 5 : 1;
  for (let v = 0; v <= max; v += step) {
    nodes.push(svg("line", { x1: Pd.l, x2: W - Pd.r, y1: Y(v), y2: Y(v), class: "grid" }));
    nodes.push(svg("text", { x: Pd.l - 6, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, v));
  }
  bins.forEach((b, i) => {
    const r = svg("rect", { x: X(b.lo) + 1, y: Y(b.n), width: X(b.hi) - X(b.lo) - 2, height: H - Pd.b - Y(b.n), class: `bar${b.lo >= 0 ? " late" : ""}`, "data-i": i });
    nodes.push(r);
  });
  for (let m = -30; m <= 60; m += narrow() ? 20 : 10) nodes.push(svg("text", { x: X(m), y: H - Pd.b + 14, class: "tick", "text-anchor": "middle" }, m === 60 ? "60+" : m));
  nodes.push(svg("line", { x1: X(0), x2: X(0), y1: Pd.t, y2: H - Pd.b, class: "zero" }));
  nodes.push(svg("text", { x: W - Pd.r, y: H - 2, class: "tick", "text-anchor": "end" }, "actual minus predicted arrival, minutes"));
  g.replaceChildren(...nodes);
  g._bins = bins;
  $("eta-sub").textContent = etaView === "normal"
    ? `The ALNS plan driven on a normal day: ${stats.n} arrivals against the morning ETA. Mean error ${stats.mean >= 0 ? "+" : ""}${stats.mean.toFixed(1)} min, mean absolute ${stats.mae.toFixed(1)} min, p50 ${stats.p50.toFixed(1)}, p90 ${stats.p90.toFixed(1)}, ${pct(stats.within10, 0)} within 10 minutes.`
    : `The played day with re-optimizing: ${stats.n} arrivals against the latest ETA before the van left for the stop. Mean error ${stats.mean >= 0 ? "+" : ""}${stats.mean.toFixed(1)} min, mean absolute ${stats.mae.toFixed(1)} min, p90 ${stats.p90.toFixed(1)}, ${pct(stats.within10, 0)} within 10 minutes.`;
  $("eta-rows").replaceChildren(...stats.byPos.map((b) => el("tr", {}, [
    el("td", { text: b.hi >= 99 ? `${b.lo}th stop and later` : `${b.lo} to ${b.hi}` }),
    el("td", { class: "num", text: fmtInt(b.n) }),
    el("td", { class: "num", text: b.n ? `${b.mae.toFixed(1)} min` : "n/a" }),
  ])));
  $("eta-note").textContent = "Each leg's actual time is the predicted time times a lognormal factor with mean 1, the same for every strategy. Errors add up along a route, so later stops get wider ETAs; a real dispatcher re-estimates ETAs from live van positions. Arriving early costs nothing here because the van waits for the window.";
}

{
  const g = $("eta"), tip = g.nextElementSibling;
  g.addEventListener("pointermove", (e) => {
    const t = e.target.closest("[data-i]");
    if (!t) { tip.hidden = true; return; }
    const b = g._bins[Number(t.dataset.i)];
    tip.replaceChildren(el("strong", { text: b.lo >= 55 ? "55 min or more late" : `${b.lo} to ${b.hi} min` }), tipRow("Arrivals", fmtInt(b.n)));
    placeTip(tip, g.parentElement.getBoundingClientRect(), e);
  });
  g.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---------------------------------------------------------------------------
// Interaction

function setView(v) {
  view = v;
  if (playing) stopPlay();
  drawAll();
}

$("view-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });
$("algo-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-algo]"); if (b) { algo = b.dataset.algo; drawAll(); } });
$("strat-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-strat]"); if (b) { strat = b.dataset.strat; drawAll(); } });
$("eta-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) { etaView = b.dataset.view; drawTabs(); drawEta(); } });
$("algo-rows").addEventListener("click", (e) => { const r = e.target.closest("[data-key]"); if (r) { algo = r.dataset.key; view = "plan"; drawAll(); } });
$("day-rows").addEventListener("click", (e) => { const r = e.target.closest("[data-key]"); if (r) { strat = r.dataset.key; view = "day"; drawAll(); } });

function setClock(t) {
  clock = t;
  $("time").value = t;
  $("time-label").textContent = fmtTime(t);
  drawMap();
  drawGantt();
}

$("time").addEventListener("input", (e) => { if (playing) stopPlay(); setClock(Number(e.target.value)); });

function stopPlay() {
  cancelAnimationFrame(playing);
  playing = 0;
  $("play").textContent = "Play the day";
}

$("play").addEventListener("click", () => {
  if (playing) { stopPlay(); return; }
  if (!DY) return;
  let t = clock >= 21 * 60 + 30 ? 7 * 60 : clock, last = performance.now();
  $("play").textContent = "Pause";
  const tick = (now) => {
    t = Math.min(21 * 60 + 30, t + ((now - last) / 1000) * 70); // 70 minutes of day per second
    last = now;
    setClock(Math.round(t / 5) * 5);
    if (t >= 21 * 60 + 30) { stopPlay(); return; }
    playing = requestAnimationFrame(tick);
  };
  playing = requestAnimationFrame(tick);
});

$("reset").addEventListener("click", () => {
  cfg = clamp({ ...DEFAULTS });
  buildForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

window.addEventListener("hashchange", () => {
  if (location.hash.slice(1) === encodeConfig(cfg)) return;
  cfg = decodeConfig(location.hash);
  buildForm();
  update();
});

let wasNarrow = narrow();
window.addEventListener("resize", () => {
  if (narrow() === wasNarrow) return;
  wasNarrow = narrow();
  drawAll();
});

buildForm();
update();
