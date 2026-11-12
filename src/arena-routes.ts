import { CONFIG } from "./config";
import type { Wall, WallKind } from "./types";

/**
 * Tank-center samples. A one-tank-wide corridor collapses to a single file
 * of these samples, so those cells are articulation points and get opened.
 */
const STEP = 8;
const BORDER_TILES = 2;

const OPEN = 0;
const BRICK = 1;
const STEEL = 2;
const BORDER = 3;

interface TankNode {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

interface TankGraph {
  nodes: TankNode[];
  adj: number[][];
}

export interface RouteCuts {
  components: number;
  articulationPoints: number;
  nodes: number;
  minDegree: number;
}

const repaired = new Map<string, Wall[]>();

/** Open interior walls until every tank stance has two vertex-disjoint routes to every other. */
export function ensureTwoRoutes(walls: Wall[]): Wall[] {
  const cols = Math.floor(CONFIG.canvasWidth / CONFIG.tileSize);
  const rows = Math.floor(CONFIG.canvasHeight / CONFIG.tileSize);
  const grid = rasterize(walls, cols, rows);
  const key = gridKey(grid);
  const cached = repaired.get(key);
  if (cached) return cached;

  let stalled = 0;
  for (let iter = 0; iter < 800; iter++) {
    const graph = buildGraph(grid, cols, rows);
    const cuts = analyze(graph);
    if (
      graph.nodes.length >= 3 &&
      cuts.components === 1 &&
      cuts.articulationPoints === 0 &&
      cuts.minDegree >= 2
    ) {
      const out = gridToWalls(grid, cols, rows);
      repaired.set(key, out);
      return out;
    }
    const opened = repairOnce(grid, cols, rows, graph, cuts);
    if (!opened) {
      stalled++;
      if (stalled === 1) openPerimeter(grid, cols, rows);
      else break;
    } else {
      stalled = 0;
    }
  }

  return gridToWalls(grid, cols, rows);
}

export function tankRouteCuts(walls: Wall[]): RouteCuts {
  const cols = Math.floor(CONFIG.canvasWidth / CONFIG.tileSize);
  const rows = Math.floor(CONFIG.canvasHeight / CONFIG.tileSize);
  return analyze(buildGraph(rasterize(walls, cols, rows), cols, rows));
}

/** Tile grid of the current world: 0 open, 1 brick, 2 steel, 3 border. */
export function wallGrid(walls: Wall[]): { grid: Uint8Array; cols: number; rows: number } {
  const cols = Math.floor(CONFIG.canvasWidth / CONFIG.tileSize);
  const rows = Math.floor(CONFIG.canvasHeight / CONFIG.tileSize);
  return { grid: rasterize(walls, cols, rows), cols, rows };
}

/** Stable hash of the rasterized layout; host and guest compare it on join. */
export function layoutHash(walls: Wall[]): string {
  return gridKey(wallGrid(walls).grid);
}

/** Tank stance lattice (8px pitch, hull-inflated) with 4-neighbour adjacency. */
export function tankStanceGraph(walls: Wall[]): {
  nodes: { x: number; y: number; tx: number; ty: number }[];
  adj: number[][];
} {
  const { grid, cols, rows } = wallGrid(walls);
  return buildGraph(grid, cols, rows);
}

function repairOnce(
  grid: Uint8Array,
  cols: number,
  rows: number,
  graph: TankGraph,
  cuts: RouteCuts,
): boolean {
  if (graph.nodes.length === 0) {
    openPerimeter(grid, cols, rows);
    return true;
  }
  if (cuts.components > 1) {
    const labels = labelComponents(graph.adj, -1);
    const start: number[] = [];
    const goal: number[] = [];
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 0) start.push(i);
      else goal.push(i);
    }
    return link(grid, cols, rows, graph, start, goal, new Set());
  }

  const aps = articulationList(graph.adj);
  aps.sort((a, b) => splitSize(graph.adj, a) - splitSize(graph.adj, b));
  for (const ap of aps) {
    const labels = labelComponents(graph.adj, ap);
    let smallId = -1;
    let smallCount = Infinity;
    const full = new Map<number, number>();
    for (const id of labels) {
      if (id < 0) continue;
      full.set(id, (full.get(id) ?? 0) + 1);
    }
    for (const [id, count] of full) {
      if (count < smallCount) {
        smallCount = count;
        smallId = id;
      }
    }
    if (smallId < 0) continue;
    const start: number[] = [];
    const goal: number[] = [];
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === smallId) start.push(i);
      else if (labels[i] >= 0) goal.push(i);
    }
    const forbidden = new Set<number>();
    forbidden.add(tileIndex(graph.nodes[ap]!, cols));
    for (const v of graph.adj[ap]!) {
      if (labels[v] !== smallId) forbidden.add(tileIndex(graph.nodes[v]!, cols));
    }
    if (link(grid, cols, rows, graph, start, goal, forbidden)) return true;
  }
  return false;
}

function splitSize(adj: number[][], ap: number): number {
  const labels = labelComponents(adj, ap);
  const counts = new Map<number, number>();
  for (const id of labels) {
    if (id < 0) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let min = Infinity;
  for (const count of counts.values()) min = Math.min(min, count);
  return min;
}

function link(
  grid: Uint8Array,
  cols: number,
  rows: number,
  graph: TankGraph,
  startNodes: number[],
  goalNodes: number[],
  forbidden: Set<number>,
): boolean {
  const goal = new Uint8Array(cols * rows);
  for (const id of goalNodes) {
    const t = graph.nodes[id]!;
    if (t.tx < BORDER_TILES || t.ty < BORDER_TILES) continue;
    if (t.tx >= cols - BORDER_TILES || t.ty >= rows - BORDER_TILES) continue;
    goal[t.ty * cols + t.tx] = 1;
  }
  const blocked = new Uint8Array(cols * rows);
  for (const i of forbidden) {
    if (i >= 0 && i < blocked.length) blocked[i] = 1;
  }

  const seen = new Uint8Array(cols * rows);
  const prev = new Int32Array(cols * rows).fill(-1);
  // 0-1 BFS: an open step is processed before any step that breaks a wall.
  const front: number[] = [];
  const back: number[] = [];
  const pop = (): number | undefined => {
    if (front.length === 0) {
      while (back.length) front.push(back.pop()!);
    }
    return front.pop();
  };

  for (const id of startNodes) {
    const t = graph.nodes[id]!;
    const i = t.ty * cols + t.tx;
    if (t.tx < BORDER_TILES || t.ty < BORDER_TILES) continue;
    if (t.tx >= cols - BORDER_TILES || t.ty >= rows - BORDER_TILES) continue;
    if (seen[i]) continue;
    seen[i] = 1;
    front.push(i);
  }

  let found = -1;
  while (front.length > 0 || back.length > 0) {
    const i = pop()!;
    if (goal[i] && !blocked[i]) {
      found = i;
      break;
    }
    const x = i % cols;
    const y = (i - x) / cols;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < BORDER_TILES || ny < BORDER_TILES) continue;
      if (nx >= cols - BORDER_TILES || ny >= rows - BORDER_TILES) continue;
      const ni = ny * cols + nx;
      if (seen[ni] || blocked[ni]) continue;
      if (grid[ni] === BORDER) continue;
      seen[ni] = 1;
      prev[ni] = i;
      if (grid[ni] === OPEN) front.push(ni);
      else back.push(ni);
    }
  }
  if (found < 0) return false;

  const before = openInterior(grid);
  let cursor = found;
  while (cursor >= 0) {
    const x = cursor % cols;
    const y = (cursor - x) / cols;
    clearBlock(grid, cols, rows, x, y, 1);
    if (cursor === prev[cursor]) break;
    const next = prev[cursor]!;
    if (next < 0) break;
    cursor = next;
  }
  return openInterior(grid) > before;
}

function clearBlock(
  grid: Uint8Array,
  cols: number,
  rows: number,
  tx: number,
  ty: number,
  radius: number,
): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (x < BORDER_TILES || y < BORDER_TILES) continue;
      if (x >= cols - BORDER_TILES || y >= rows - BORDER_TILES) continue;
      const i = y * cols + x;
      if (grid[i] !== BORDER) grid[i] = OPEN;
    }
  }
}

/** Inner ring, three tiles thick, so the border itself is never a dead end. */
function openPerimeter(grid: Uint8Array, cols: number, rows: number): void {
  for (let y = BORDER_TILES; y < rows - BORDER_TILES; y++) {
    for (let x = BORDER_TILES; x < cols - BORDER_TILES; x++) {
      const onRing =
        x < BORDER_TILES + 3 ||
        y < BORDER_TILES + 3 ||
        x >= cols - BORDER_TILES - 3 ||
        y >= rows - BORDER_TILES - 3;
      if (onRing) grid[y * cols + x] = OPEN;
    }
  }
}

function openInterior(grid: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === OPEN) n++;
  return n;
}

function analyze(graph: TankGraph): RouteCuts {
  const { components, aps } = findCuts(graph.adj);
  let minDegree = graph.nodes.length ? Infinity : 0;
  for (const links of graph.adj) minDegree = Math.min(minDegree, links.length);
  if (!Number.isFinite(minDegree)) minDegree = 0;
  return {
    components,
    articulationPoints: aps.length,
    nodes: graph.nodes.length,
    minDegree,
  };
}

function articulationList(adj: number[][]): number[] {
  return findCuts(adj).aps;
}

function findCuts(adj: number[][]): { components: number; aps: number[] } {
  const n = adj.length;
  const disc = new Int32Array(n);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const childCount = new Int32Array(n);
  const nextEdge = new Int32Array(n);
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
      if (nextEdge[u]! < edges.length) {
        const v = edges[nextEdge[u]!]!;
        nextEdge[u]!++;
        if (!seen[v]) {
          seen[v] = 1;
          parent[v] = u;
          childCount[u]!++;
          disc[v] = low[v] = ++time;
          stack.push(v);
        } else if (v !== parent[u] && disc[v]! < low[u]!) {
          low[u] = disc[v]!;
        }
      } else {
        stack.pop();
        const p = parent[u]!;
        if (p !== -1) {
          if (low[u]! < low[p]!) low[p] = low[u]!;
          if (parent[p] === -1) {
            if (childCount[p]! > 1) isAp[p] = 1;
          } else if (low[u]! >= disc[p]!) {
            isAp[p] = 1;
          }
        }
      }
    }
  }

  const aps: number[] = [];
  for (let i = 0; i < n; i++) if (isAp[i]) aps.push(i);
  return { components, aps };
}

function labelComponents(adj: number[][], skip: number): number[] {
  const labels = new Array<number>(adj.length).fill(-1);
  if (skip >= 0) labels[skip] = -2;
  let next = 0;
  for (let i = 0; i < adj.length; i++) {
    if (labels[i] !== -1) continue;
    const q = [i];
    labels[i] = next;
    for (let head = 0; head < q.length; head++) {
      const u = q[head]!;
      for (const v of adj[u]!) {
        if (labels[v] === -1) {
          labels[v] = next;
          q.push(v);
        }
      }
    }
    next++;
  }
  return labels;
}

function buildGraph(grid: Uint8Array, cols: number, rows: number): TankGraph {
  const s = CONFIG.tileSize;
  const r = CONFIG.tankRadius;
  const minX = BORDER_TILES * s + r;
  const maxX = cols * s - BORDER_TILES * s - r;
  const minY = BORDER_TILES * s + r;
  const maxY = rows * s - BORDER_TILES * s - r;
  const xs: number[] = [];
  for (let x = Math.ceil(minX / STEP) * STEP; x <= maxX; x += STEP) xs.push(x);
  const ys: number[] = [];
  for (let y = Math.ceil(minY / STEP) * STEP; y <= maxY; y += STEP) ys.push(y);
  const gw = xs.length;
  const gh = ys.length;
  const index = new Int32Array(gw * gh).fill(-1);
  const nodes: TankNode[] = [];

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = xs[gx]!;
      const y = ys[gy]!;
      if (circleBlocked(grid, cols, rows, x, y, r)) continue;
      index[gy * gw + gx] = nodes.length;
      nodes.push({
        x,
        y,
        tx: Math.min(cols - 1, Math.max(0, Math.floor(x / s))),
        ty: Math.min(rows - 1, Math.max(0, Math.floor(y / s))),
      });
    }
  }

  const adj: number[][] = nodes.map(() => []);
  const connect = (a: number, b: number) => {
    const na = nodes[a]!;
    const nb = nodes[b]!;
    if (!segmentClear(grid, cols, rows, na.x, na.y, nb.x, nb.y, r)) return;
    adj[a]!.push(b);
    adj[b]!.push(a);
  };
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const a = index[gy * gw + gx]!;
      if (a < 0) continue;
      if (gx + 1 < gw) {
        const b = index[gy * gw + gx + 1]!;
        if (b >= 0) connect(a, b);
      }
      if (gy + 1 < gh) {
        const b = index[(gy + 1) * gw + gx]!;
        if (b >= 0) connect(a, b);
      }
    }
  }
  return { nodes, adj };
}

function segmentClear(
  grid: Uint8Array,
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
): boolean {
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    if (circleBlocked(grid, cols, rows, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) {
      return false;
    }
  }
  return true;
}

function circleBlocked(
  grid: Uint8Array,
  cols: number,
  rows: number,
  x: number,
  y: number,
  r: number,
): boolean {
  const s = CONFIG.tileSize;
  const tx0 = Math.floor((x - r) / s);
  const tx1 = Math.floor((x + r - 1e-6) / s);
  const ty0 = Math.floor((y - r) / s);
  const ty1 = Math.floor((y + r - 1e-6) / s);
  const r2 = r * r;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) return true;
      if (grid[ty * cols + tx] === OPEN) continue;
      const x0 = tx * s;
      const y0 = ty * s;
      const nx = Math.max(x0, Math.min(x, x0 + s));
      const ny = Math.max(y0, Math.min(y, y0 + s));
      const dx = x - nx;
      const dy = y - ny;
      if (dx * dx + dy * dy < r2) return true;
    }
  }
  return false;
}

function tileIndex(node: TankNode, cols: number): number {
  return node.ty * cols + node.tx;
}

function rasterize(walls: Wall[], cols: number, rows: number): Uint8Array {
  const s = CONFIG.tileSize;
  const grid = new Uint8Array(cols * rows);
  for (const w of walls) {
    const kind = w.kind === "border" ? BORDER : w.kind === "steel" ? STEEL : BRICK;
    const x0 = Math.max(0, Math.floor(w.x / s));
    const y0 = Math.max(0, Math.floor(w.y / s));
    const x1 = Math.min(cols, Math.ceil((w.x + w.w) / s));
    const y1 = Math.min(rows, Math.ceil((w.y + w.h) / s));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * cols + x;
        if (grid[i] === BORDER) continue;
        if (kind === BORDER) grid[i] = BORDER;
        else if (grid[i] === OPEN) grid[i] = kind;
        else if (kind === STEEL) grid[i] = STEEL;
      }
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (
        x < BORDER_TILES ||
        y < BORDER_TILES ||
        x >= cols - BORDER_TILES ||
        y >= rows - BORDER_TILES
      ) {
        grid[y * cols + x] = BORDER;
      }
    }
  }
  return grid;
}

function gridToWalls(grid: Uint8Array, cols: number, rows: number): Wall[] {
  const used = new Uint8Array(grid.length);
  const walls: Wall[] = [];
  const s = CONFIG.tileSize;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const kind = grid[y * cols + x]!;
      const i0 = y * cols + x;
      if (!kind || used[i0]) continue;
      let w = 1;
      while (x + w < cols && grid[y * cols + x + w] === kind && !used[y * cols + x + w]) {
        w++;
      }
      let h = 1;
      outer: while (y + h < rows) {
        for (let k = 0; k < w; k++) {
          if (grid[(y + h) * cols + x + k] !== kind || used[(y + h) * cols + x + k]) {
            break outer;
          }
        }
        h++;
      }
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) used[(y + yy) * cols + x + xx] = 1;
      }
      const wallKind: WallKind = kind === BORDER ? "border" : kind === STEEL ? "steel" : "brick";
      walls.push({ x: x * s, y: y * s, w: w * s, h: h * s, kind: wallKind });
    }
  }
  return walls;
}

function gridKey(grid: Uint8Array): string {
  let hash = 2166136261;
  for (let i = 0; i < grid.length; i++) {
    hash ^= grid[i]!;
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0);
}
