import { buildArena, circleHitsWall, type ArenaDensity } from "../src/arena";
import { ensureTwoRoutes } from "../src/arena-routes";
import type { Wall } from "../src/types";

const STEP = 8;
const R = 11;

function cuts(walls: ReturnType<typeof buildArena>) {
  const minX = 32 + R;
  const maxX = 1280 - 32 - R;
  const minY = 32 + R;
  const maxY = 800 - 32 - R;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = Math.ceil(minX / STEP) * STEP; x <= maxX; x += STEP) xs.push(x);
  for (let y = Math.ceil(minY / STEP) * STEP; y <= maxY; y += STEP) ys.push(y);
  const gw = xs.length;
  const gh = ys.length;
  const index = new Int32Array(gw * gh).fill(-1);
  const nodes: [number, number][] = [];
  const free = (x: number, y: number) => !circleHitsWall(x, y, R, walls);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!free(xs[gx]!, ys[gy]!)) continue;
      index[gy * gw + gx] = nodes.length;
      nodes.push([xs[gx]!, ys[gy]!]);
    }
  }
  const adj: number[][] = nodes.map(() => []);
  const seg = (a: [number, number], b: [number, number]) => {
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      if (!free(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
    }
    return true;
  };
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const a = index[gy * gw + gx]!;
      if (a < 0) continue;
      if (gx + 1 < gw) {
        const b = index[gy * gw + gx + 1]!;
        if (b >= 0 && seg(nodes[a]!, nodes[b]!)) {
          adj[a]!.push(b);
          adj[b]!.push(a);
        }
      }
      if (gy + 1 < gh) {
        const b = index[(gy + 1) * gw + gx]!;
        if (b >= 0 && seg(nodes[a]!, nodes[b]!)) {
          adj[a]!.push(b);
          adj[b]!.push(a);
        }
      }
    }
  }
  const n = adj.length;
  const disc = new Int32Array(n);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const child = new Int32Array(n);
  const next = new Int32Array(n);
  const isAp = new Uint8Array(n);
  const seen = new Uint8Array(n);
  let time = 0;
  let components = 0;
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    components++;
    seen[start] = 1;
    disc[start] = low[start] = ++time;
    const stack = [start];
    while (stack.length) {
      const u = stack[stack.length - 1]!;
      const edges = adj[u]!;
      if (next[u]! < edges.length) {
        const v = edges[next[u]!]!;
        next[u]!++;
        if (!seen[v]) {
          seen[v] = 1;
          parent[v] = u;
          child[u]!++;
          disc[v] = low[v] = ++time;
          stack.push(v);
        } else if (v !== parent[u] && disc[v]! < low[u]!) low[u] = disc[v]!;
      } else {
        stack.pop();
        const p = parent[u]!;
        if (p !== -1) {
          if (low[u]! < low[p]!) low[p] = low[u]!;
          if (parent[p] === -1) {
            if (child[p]! > 1) isAp[p] = 1;
          } else if (low[u]! >= disc[p]!) isAp[p] = 1;
        }
      }
    }
  }
  let aps = 0;
  let minDeg = Infinity;
  for (let i = 0; i < n; i++) {
    if (isAp[i]) aps++;
    minDeg = Math.min(minDeg, adj[i]!.length);
  }
  return { components, aps, nodes: n, minDeg };
}

const densities: ArenaDensity[] = ["reference", "standard", "dense"];
let failed = false;
for (const density of densities) {
  const t = Date.now();
  const walls = buildArena(density);
  const result = cuts(walls);
  const ok =
    result.components === 1 &&
    result.aps === 0 &&
    result.minDeg >= 2 &&
    result.nodes > 100;
  if (!ok) failed = true;
  console.log(density, result, ok ? "ok" : "FAIL", `${Date.now() - t}ms`);
}
const choked: Wall[] = [
  { x: 0, y: 0, w: 1280, h: 32, kind: "border" },
  { x: 0, y: 768, w: 1280, h: 32, kind: "border" },
  { x: 0, y: 32, w: 32, h: 736, kind: "border" },
  { x: 1248, y: 32, w: 32, h: 736, kind: "border" },
  { x: 640, y: 32, w: 16, h: 320, kind: "brick" },
  { x: 640, y: 368, w: 16, h: 400, kind: "brick" },
];
const opened = cuts(ensureTwoRoutes(choked));
const chokeOk =
  opened.components === 1 && opened.aps === 0 && opened.minDeg >= 2;
if (!chokeOk) failed = true;
console.log("choke repair", opened, chokeOk ? "ok" : "FAIL");

if (failed) process.exit(1);
