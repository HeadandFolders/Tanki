/**
 * Large arena audit: connectivity, two vertex-disjoint routes between every
 * zone pair, point symmetry, corridor width for the inflated hull, no pockets,
 * spawn line of sight, A* parity from each spawn, spawn-to-center travel time
 * and 6v6 step cost.
 * Run: npx tsx scripts/eval-arena.ts [seed]
 */
import assert from "node:assert/strict";
import { planOrderedRoute } from "../src/ai.ts";
import { buildArena, dist, segmentHitsWall } from "../src/arena.ts";
import { LARGE_BASE_TILES, LARGE_SPAWN_TILES, largeArenaZones } from "../src/arena-large.ts";
import { tankRouteCuts, tankStanceGraph, wallGrid } from "../src/arena-routes.ts";
import { CONFIG } from "../src/config.ts";
import { createWorld, stepWorld, type InputState } from "../src/game.ts";
import { restoreGoal } from "../src/interrupt-stack.ts";
import type { Tank, Wall } from "../src/types.ts";

const seed = Number(process.argv[2] ?? CONFIG.largeArena.seed);
const DT = 1 / 60;
const INPUT: InputState = { keys: new Set<string>(), mouseX: 0, mouseY: 0, shooting: false };
const failures: string[] = [];
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
}

const t0 = performance.now();
const walls = buildArena("large", seed);
const buildMs = performance.now() - t0;
const { grid, cols, rows } = wallGrid(walls);
const S = CONFIG.tileSize;
console.log(
  `large arena seed ${seed}: ${cols}x${rows} tiles = ${cols * S}x${rows * S}px, ` +
    `${walls.length} walls, built in ${buildMs.toFixed(1)}ms`,
);
check(walls.every((w) => w.kind === "brick" || w.kind === "border"), "interior walls are bricks only");

// --- symmetry ---------------------------------------------------------------
let asym = 0;
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    if (grid[y * cols + x] !== grid[(rows - 1 - y) * cols + (cols - 1 - x)]) asym++;
  }
}
check(asym === 0, `point symmetry (${asym} asymmetric tiles)`);

// --- connectivity / pockets -------------------------------------------------
const cuts = tankRouteCuts(walls);
check(cuts.components === 1, `single connected stance component (${cuts.components})`);
check(cuts.articulationPoints === 0, `no articulation points (${cuts.articulationPoints})`);
check(cuts.minDegree >= 2, `no dead-end stances, min degree ${cuts.minDegree} (${cuts.nodes} stances)`);

// --- corridor width ---------------------------------------------------------
const graph = tankStanceGraph(walls);
const hasStance = new Uint8Array(cols * rows);
for (const n of graph.nodes) hasStance[n.ty * cols + n.tx] = 1;
const open = (x: number, y: number) =>
  x >= 0 && y >= 0 && x < cols && y < rows && grid[y * cols + x] === 0;
function run(x: number, y: number, dx: number, dy: number): number {
  let n = 1;
  for (let k = 1; open(x + dx * k, y + dy * k); k++) n++;
  for (let k = 1; open(x - dx * k, y - dy * k); k++) n++;
  return n;
}
let width1 = 0;
let width2 = 0;
const squeezeTiles: string[] = [];
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    if (!hasStance[y * cols + x]) continue;
    const w = Math.min(run(x, y, 1, 0), run(x, y, 0, 1));
    if (w <= 1) width1++;
    else if (w === 2) {
      width2++;
      if (squeezeTiles.length < 12) squeezeTiles.push(`${x},${y}`);
    }
  }
}
check(width1 === 0, `no 1-tile corridors used by the hull (${width1})`);
check(
  width2 <= CONFIG.largeArena.maxSqueezeTiles,
  `2-tile squeezes ${width2} tiles <= ${CONFIG.largeArena.maxSqueezeTiles} (${squeezeTiles.join(" ")}${width2 > 12 ? " ..." : ""})`,
);

// --- zones ------------------------------------------------------------------
const zones = largeArenaZones(seed);
console.log(`zones: ${zones.map((z) => `${z.id}@${z.tileX},${z.tileY}`).join(" ")}`);
check(zones.every((z) => open(z.tileX, z.tileY) && hasStance[z.tileY * cols + z.tileX]), "every zone anchor is a free stance tile");
for (const z of zones) {
  const m = zones.find((o) => o.id === z.mirrorOf);
  const mx = cols - 1 - z.tileX;
  const my = rows - 1 - z.tileY;
  const self = z.mirrorOf === z.id;
  const near = !!m && Math.abs(m.tileX - mx) <= (self ? 1 : 0) && Math.abs(m.tileY - my) <= (self ? 1 : 0);
  check(near, `zone ${z.id} mirrors ${z.mirrorOf}`);
}

// --- two vertex-disjoint routes between every zone pair ---------------------
function nearestNode(x: number, y: number): number {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i]!;
    const d = dist(n.x, n.y, x, y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}
// Node-split max flow (unit capacities): in(u)=2u, out(u)=2u+1.
const N = graph.nodes.length;
const head: number[] = [];
const to: number[] = [];
const cap: number[] = [];
const next: number[] = [];
const first = new Int32Array(2 * N).fill(-1);
function addEdge(a: number, b: number, c: number): void {
  to.push(b); cap.push(c); next.push(first[a]!); first[a] = to.length - 1;
  to.push(a); cap.push(0); next.push(first[b]!); first[b] = to.length - 1;
}
for (let u = 0; u < N; u++) addEdge(2 * u, 2 * u + 1, 1);
for (let u = 0; u < N; u++) for (const v of graph.adj[u]!) addEdge(2 * u + 1, 2 * v, 1);
void head;
const baseCap = cap.slice();
const parentEdge = new Int32Array(2 * N);
const queue = new Int32Array(2 * N);
function augment(src: number, dst: number): boolean {
  parentEdge.fill(-1);
  let qh = 0;
  let qt = 0;
  queue[qt++] = src;
  parentEdge[src] = -2;
  while (qh < qt) {
    const u = queue[qh++]!;
    if (u === dst) break;
    for (let e = first[u]!; e !== -1; e = next[e]!) {
      const v = to[e]!;
      if (cap[e]! > 0 && parentEdge[v] === -1) {
        parentEdge[v] = e;
        queue[qt++] = v;
      }
    }
  }
  if (parentEdge[dst] === -1) return false;
  for (let v = dst; v !== src; ) {
    const e = parentEdge[v]!;
    cap[e]! -= 1;
    cap[e ^ 1]! += 1;
    v = to[e ^ 1]!;
  }
  return true;
}
function disjointRoutes(a: number, b: number): number {
  for (let i = 0; i < cap.length; i++) cap[i] = baseCap[i]!;
  // Source leaves from out(a); sink is in(b), so a and b are not consumed.
  let flow = 0;
  while (flow < 2 && augment(2 * a + 1, 2 * b)) flow++;
  return flow;
}
const zoneNodes = zones.map((z) => nearestNode(z.x, z.y));
let pairs = 0;
let weakPairs: string[] = [];
const tFlow = performance.now();
for (let i = 0; i < zones.length; i++) {
  for (let j = i + 1; j < zones.length; j++) {
    pairs++;
    if (disjointRoutes(zoneNodes[i]!, zoneNodes[j]!) < 2) weakPairs.push(`${zones[i]!.id}-${zones[j]!.id}`);
  }
}
check(
  weakPairs.length === 0,
  `two vertex-disjoint routes for all ${pairs} zone pairs (${(performance.now() - tFlow).toFixed(0)}ms)${weakPairs.length ? ": " + weakPairs.join(" ") : ""}`,
);

// --- spawn line of sight ----------------------------------------------------
function spawnPoints(box: { x0: number; y0: number; x1: number; y1: number }): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let ty = box.y0; ty <= box.y1; ty += 2) {
    for (let tx = box.x0; tx <= box.x1; tx += 2) {
      if (open(tx, ty)) pts.push({ x: tx * S + S / 2, y: ty * S + S / 2 });
    }
  }
  return pts;
}
const bluePts = spawnPoints(LARGE_SPAWN_TILES.blue);
const redPts = spawnPoints(LARGE_SPAWN_TILES.red);
let losPairs = 0;
let losChecked = 0;
for (const a of bluePts) {
  for (const b of redPts) {
    losChecked++;
    if (!segmentHitsWall(a.x, a.y, b.x, b.y, walls)) losPairs++;
  }
}
check(losPairs === 0, `no spawn-to-spawn line of sight (${losPairs}/${losChecked} sample pairs see through)`);

// Base exits: runs of open tiles on the wall ring just outside the enclosure.
function exitRuns(box: { x0: number; y0: number; x1: number; y1: number }): number {
  const ring: boolean[] = [];
  for (let x = box.x0 - 1; x <= box.x1 + 1; x++) ring.push(open(x, box.y0 - 1));
  for (let y = box.y0; y <= box.y1 + 1; y++) ring.push(open(box.x1 + 1, y));
  for (let x = box.x1; x >= box.x0 - 1; x--) ring.push(open(x, box.y1 + 1));
  for (let y = box.y1; y >= box.y0; y--) ring.push(open(box.x0 - 1, y));
  let runs = 0;
  for (let i = 0; i < ring.length; i++) if (ring[i] && !ring[(i + ring.length - 1) % ring.length]) runs++;
  return runs;
}
const blueExits = exitRuns(LARGE_BASE_TILES.blue);
const redExits = exitRuns(LARGE_BASE_TILES.red);
check(blueExits >= 2 && blueExits <= 3 && redExits === blueExits, `base has 2-3 exits (blue ${blueExits}, red ${redExits})`);
let spawnInBase = true;
for (const team of ["blue", "red"] as const) {
  const sp = LARGE_SPAWN_TILES[team];
  const b = LARGE_BASE_TILES[team];
  if (sp.x0 < b.x0 || sp.y0 < b.y0 || sp.x1 > b.x1 || sp.y1 > b.y1) spawnInBase = false;
}
check(spawnInBase, "spawn boxes lie inside the base enclosures");

// --- A* parity from each spawn ----------------------------------------------
function polyLen(pts: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y);
  return len;
}
function routeLen(sx: number, sy: number, gx: number, gy: number): number {
  const pts = planOrderedRoute(sx, sy, gx, gy, walls, []);
  return polyLen([{ x: sx, y: sy }, ...pts]);
}
const blueBox = LARGE_SPAWN_TILES.blue;
const blueSpawn = { x: ((blueBox.x0 + blueBox.x1 + 1) / 2) * S, y: ((blueBox.y0 + blueBox.y1 + 1) / 2) * S };
const redSpawn = { x: cols * S - blueSpawn.x, y: rows * S - blueSpawn.y };
const center = zones.find((z) => z.id === "center")!;

/** Exact shortest path over the inflated-hull stance graph (Dijkstra, euclidean edges). */
function stanceDistances(sx: number, sy: number): Float64Array {
  let start = 0;
  let bestD = Infinity;
  graph.nodes.forEach((n, i) => {
    const d = dist(n.x, n.y, sx, sy);
    if (d < bestD) {
      bestD = d;
      start = i;
    }
  });
  const d = new Float64Array(graph.nodes.length).fill(Infinity);
  const done = new Uint8Array(graph.nodes.length);
  const heap: { i: number; d: number }[] = [];
  const push = (i: number, v: number) => {
    heap.push({ i, d: v });
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p]!.d <= heap[k]!.d) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]!.d < heap[m]!.d) m = l;
        if (r < heap.length && heap[r]!.d < heap[m]!.d) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };
  d[start] = 0;
  push(start, 0);
  while (heap.length) {
    const { i } = pop();
    if (done[i]) continue;
    done[i] = 1;
    const a = graph.nodes[i]!;
    for (const j of graph.adj[i]!) {
      const b = graph.nodes[j]!;
      const nd = d[i]! + dist(a.x, a.y, b.x, b.y);
      if (nd < d[j]!) {
        d[j] = nd;
        push(j, nd);
      }
    }
  }
  return d;
}
function nearestStance(x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  graph.nodes.forEach((n, i) => {
    const dd = dist(n.x, n.y, x, y);
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  });
  return best;
}
const fromBlueD = stanceDistances(blueSpawn.x, blueSpawn.y);
const fromRedD = stanceDistances(redSpawn.x, redSpawn.y);
let worstParity = 0;
let worstPlanner = 0;
for (const z of zones) {
  const m = zones.find((o) => o.id === z.mirrorOf)!;
  const fromBlue = fromBlueD[nearestStance(z.x, z.y)]!;
  const fromRed = fromRedD[nearestStance(m.x, m.y)]!;
  const diff = Math.abs(fromBlue - fromRed) / Math.max(1, Math.max(fromBlue, fromRed));
  worstParity = Math.max(worstParity, diff);
  if (diff > 0.05) console.log(`  parity ${z.id}: blue ${fromBlue.toFixed(0)}px vs red->${m.id} ${fromRed.toFixed(0)}px`);
  const pBlue = routeLen(blueSpawn.x, blueSpawn.y, z.x, z.y);
  const pRed = routeLen(redSpawn.x, redSpawn.y, m.x, m.y);
  worstPlanner = Math.max(worstPlanner, Math.abs(pBlue - pRed) / Math.max(1, Math.max(pBlue, pRed)));
}
check(worstParity <= 0.05, `A* spawn-to-zone distance parity within 5% (worst ${(worstParity * 100).toFixed(1)}%)`);
console.log(
  `  info: in-game planner polyline lengths (exposure-weighted, not pure distance) differ by up to ${(worstPlanner * 100).toFixed(1)}%`,
);

// --- spawn-to-center travel time -------------------------------------------
const speed = CONFIG.roles.shooter.speed;
const centerLen = routeLen(blueSpawn.x, blueSpawn.y, center.x, center.y);
const [tMin, tMax] = CONFIG.largeArena.spawnToCenterSec;
const estSec = centerLen / speed;

function simToCenter(): { sec: number; tank: Tank } | null {
  const world = createWorld("clear", "mp-offline", "normal", seed, "off", "large", seed);
  world.outcome = "playing";
  const tank = world.tanks.find((t) => t.team === "blue" && t.id !== world.controlledId && t.role === "shooter")!;
  for (const t of world.tanks) if (t.id !== tank.id && t.team === "blue") t.alive = false;
  for (const t of world.tanks) {
    if (t.team === "red") {
      restoreGoal(t, { kind: "holdPosition", source: "system", params: { x: t.x, y: t.y } });
    }
  }
  tank.x = blueSpawn.x;
  tank.y = blueSpawn.y;
  tank.lastKnownPos = { x: tank.x, y: tank.y };
  restoreGoal(tank, { kind: "moveTo", source: "player", params: { x: center.x, y: center.y, exact: true } });
  for (let f = 0; f < 60 * 40; f++) {
    stepWorld(world, DT, INPUT, null);
    if (dist(tank.x, tank.y, center.x, center.y) <= CONFIG.ai.holdRadius) return { sec: world.time, tank };
    if (!tank.alive) return null;
  }
  return null;
}
const sim = simToCenter();
console.log(
  `spawn->center: route ${centerLen.toFixed(0)}px, ${estSec.toFixed(1)}s at ${speed}px/s (shooter); ` +
    `simulated moveTo ${sim ? sim.sec.toFixed(1) + "s" : "did not arrive in 40s"}; target ${tMin}-${tMax}s (config.largeArena.spawnToCenterSec)`,
);
check(estSec >= tMin && estSec <= tMax, `spawn-to-center ${estSec.toFixed(1)}s within ${tMin}-${tMax}s`);

// --- 6v6 step cost ----------------------------------------------------------
function stepCost(): { avg: number; max: number; p99: number } {
  const world = createWorld("clear", "mp-offline", "normal", seed, "normal", "large", seed);
  world.outcome = "playing";
  const samples: number[] = [];
  const zonesCycle = zones.filter((z) => z.id !== "center");
  for (let f = 0; f < 60 * 20; f++) {
    if (f % 180 === 0) {
      // Fresh orders for every bot keep the planners busy.
      world.tanks.forEach((t, i) => {
        if (!t.alive || t.id === world.controlledId) return;
        const z = i % 2 === 0 ? center : zonesCycle[(i + f / 180) % zonesCycle.length]!;
        restoreGoal(t, { kind: "moveTo", source: "player", params: { x: z.x, y: z.y } });
      });
    }
    const t1 = performance.now();
    stepWorld(world, DT, INPUT, null);
    samples.push(performance.now() - t1);
  }
  samples.sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { avg, max: samples[samples.length - 1]!, p99: samples[Math.floor(samples.length * 0.99)]! };
}
const cost = stepCost();
console.log(`6v6 stepWorld over 20s: avg ${cost.avg.toFixed(2)}ms, p99 ${cost.p99.toFixed(2)}ms, max ${cost.max.toFixed(2)}ms (budget 16.7ms)`);
check(cost.avg < 8 && cost.p99 < 16.7, "6v6 step cost leaves headroom for 60fps");

void (walls as Wall[]);
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  assert.fail(failures.join("; "));
}
console.log("\neval-arena: all checks passed");
