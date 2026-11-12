import { gridToWalls } from "./arena-routes";
import { CONFIG } from "./config";
import {
  MAP_GEN,
  MAP_GEN_SIZE,
  averageHullSpeed,
  generatedApronTiles,
  generatedBaseTile,
  middleZoneGeometry,
  type GeneratedMapSize,
} from "./config/balance";
import { createRandom, nextRandom, type RandomState } from "./random";
import type { BaseTile, TeamId, Vec2, Wall } from "./types";

/**
 * Seeded map generation, in place of a hand-authored layout.
 *
 * Every cell is written together with its 180° rotation about the map centre,
 * so red always gets the same terrain as blue seen from the other side, and
 * neither base can look down a lane the other does not have.
 *
 * The field starts as solid brick and the routes are carved through it: two
 * straight arms of an avenue one each side of the wall band between the bases,
 * a baffle-lined alley well outside it, and a wave straddling the band itself.
 * The band stays solid except where a lane crosses it, so the shortest way from
 * base to base has to leave it and come back, and only the wave goes through the
 * middle zone. What is left of the brick is alcoves with one mouth each, and
 * cover at the back of them.
 *
 * Nothing is taken on trust. Each candidate is measured with A* over the
 * tank-fit lattice, and a candidate that fails any rule in `MAP_GEN.rules` is
 * thrown away and rebuilt from a fresh seed.
 */

const OPEN = 0;
const BRICK = 1;
const STEEL = 2;
const BORDER = 3;

export type MapRouteRole = "direct" | "protected" | "zone";

export interface MapRoute {
  role: MapRouteRole;
  /** World px polyline, blue base to red base. */
  points: Vec2[];
  lengthPx: number;
  /** Seconds at the average hull speed — the same ruler the size was chosen with. */
  travelSec: number;
  /** Share of the route standing in the open rather than behind cover. */
  exposedShare: number;
  /** True when any part of the route is inside the middle zone circle. */
  throughZone: boolean;
}

export interface MapGenCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface GeneratedMap {
  requestedSeed: number;
  /** The seed the accepted map came from, once retries are counted in. */
  seedUsed: number;
  attempts: number;
  cols: number;
  rows: number;
  walls: Wall[];
  routes: MapRoute[];
  /** Base centre to base centre, px. */
  straightPx: number;
  /** Drive time of the shortest route, seconds. */
  shortestSec: number;
  checks: MapGenCheck[];
  /** Why each rejected candidate was rejected, oldest first. */
  failures: string[];
  /** True when no candidate passed and the last one is used anyway. */
  forced: boolean;
}

interface Grid {
  cols: number;
  rows: number;
  cells: Uint8Array;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  grid: Grid;
  bases: Record<TeamId, BaseTile>;
  /**
   * Carved open ground in front of each base. Every route starts and ends
   * inside one of these, so the ground a route shares on its way out of a base
   * is ground every base has too, and the separation rule gives it away.
   */
  aprons: Record<TeamId, Rect>;
  zone: { cx: number; cy: number; r: number };
}

const px = (tile: number): number => tile * CONFIG.tileSize;
const tileOf = (pxv: number): number => Math.floor(pxv / CONFIG.tileSize);

function mirrorOf(g: Grid, x: number, y: number): { x: number; y: number } {
  return { x: g.cols - 1 - x, y: g.rows - 1 - y };
}

function at(g: Grid, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return BORDER;
  return g.cells[y * g.cols + x]!;
}

/** The stone border is the map's edge, not content: nothing may repaint it. */
function set(g: Grid, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return;
  const i = y * g.cols + x;
  if (g.cells[i] === BORDER) return;
  g.cells[i] = v;
}

/** Write a cell and its 180° twin, which is the only way to keep the map fair. */
function setPair(g: Grid, x: number, y: number, v: number): void {
  set(g, x, y, v);
  const m = mirrorOf(g, x, y);
  set(g, m.x, m.y, v);
}

function tileKey(g: Grid, x: number, y: number): number {
  return y * g.cols + x;
}

// ------------------------------------------------------------------ layout ---

function zoneTiles(cols: number, rows: number): { cx: number; cy: number; r: number } {
  const geo = middleZoneGeometry(px(cols), px(rows));
  return { cx: geo.x / CONFIG.tileSize, cy: geo.y / CONFIG.tileSize, r: geo.radius / CONFIG.tileSize };
}

function mirrorBase(base: BaseTile, cols: number, rows: number): BaseTile {
  const f = MAP_GEN.footprintTiles;
  return { tileX: cols - f - base.tileX, tileY: rows - f - base.tileY };
}

/** Open disc of `radius` tiles around a point, plus its twin in the north half. */
function carvePair(g: Grid, x: number, y: number, radius: number, value = OPEN): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius + radius) continue;
      setPair(g, x + dx, y + dy, value);
    }
  }
}

/**
 * A straight alley that reads as covered ground: `alleyRows` tiles across, run
 * the whole length of the line from `from` to `to`, with a block of cover
 * `baffleTiles` long stood `baffleDepthTiles` deep into alternating flanks every
 * `baffleEveryTiles`.
 *
 * The blocks are what makes it the long way round instead of a firing line. A
 * sight travelling the alley's length, straight or slant, meets a block within a
 * few tiles of wherever it stands, and one crossing the alley meets one before
 * it gets far. What is left open is a channel `alleyRows - baffleDepthTiles`
 * tiles tall that changes flank at every block: still wide enough to hold a
 * hull's stance, never long enough to hold a gun's run.
 */
function carveAlley(g: Grid, from: Vec2, to: Vec2): void {
  const l = MAP_GEN.layout;
  const across = l.alleyRows;
  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  const at = (along: number, cross: number): Vec2 =>
    horizontal ? { x: along, y: cross } : { x: cross, y: along };
  const near = horizontal ? from.x : from.y;
  const far = horizontal ? to.x : to.y;
  const lo = Math.min(near, far);
  const hi = Math.max(near, far);
  const centre = Math.round(((horizontal ? from.y : from.x) + (horizontal ? to.y : to.x)) / 2);
  const flank0 = centre - Math.floor((across - 1) / 2);
  for (let a = lo; a <= hi; a++) {
    for (let s = 0; s < across; s++) {
      const p = at(a, flank0 + s);
      setPair(g, p.x, p.y, OPEN);
    }
  }
  for (let a = lo, j = 0; a + l.baffleTiles - 1 <= hi; a += l.baffleEveryTiles, j++) {
    const northSide = j % 2 === 0;
    for (let w = 0; w < l.baffleTiles; w++) {
      for (let d = 0; d < l.baffleDepthTiles; d++) {
        const p = at(a + w, northSide ? flank0 + d : flank0 + across - 1 - d);
        setPair(g, p.x, p.y, BRICK);
      }
    }
  }
}

/** The 180° twin of a tile rect, which is how one write places both halves. */
function mirrorRect(g: Grid, r: Rect): Rect {
  return { x: g.cols - r.x - r.w, y: g.rows - r.y - r.h, w: r.w, h: r.h };
}

function fillRectPair(g: Grid, r: Rect, v: number): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) setPair(g, x, y, v);
  }
}

/**
 * Draw one candidate map. The field starts as solid brick and the three kinds of
 * route are carved through it, so a lane leaving the brick between the bases is a
 * detour by construction: the band on the straight line between the bases stays
 * solid except where a lane crosses it, and every lane reaches that band from
 * inside a base's own apron.
 *
 * Two straight arms of the avenue, one each side of the band, are the short open
 * way. The baffled alley south of it is the long covered way, and the wave
 * straddling the band is the contested way through the middle zone. What is left
 * of the brick is courtyards: open ground with exactly one door onto a lane and
 * cover inside, so that the map keeps sight breaks and hiding places no route
 * needs, and a courtyard never opens a shortcut a hull could drive.
 */
function buildLayout(seed: number, size: GeneratedMapSize): Layout {
  const cols = size.cols;
  const rows = size.rows;
  const g: Grid = { cols, rows, cells: new Uint8Array(cols * rows) };
  const pad = MAP_GEN.borderTiles;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      g.cells[tileKey(g, x, y)] =
        x < pad || y < pad || x >= cols - pad || y >= rows - pad ? BORDER : BRICK;
    }
  }

  const l = MAP_GEN.layout;
  const base = generatedBaseTile(rows);
  const bases: Record<TeamId, BaseTile> = { blue: base, red: mirrorBase(base, cols, rows) };
  const zone = zoneTiles(cols, rows);
  const rng = createRandom(seed);

  const half = rows / 2;
  const axis = rows >> 1;
  const band: [number, number] = [axis - 1, axis];
  const door = Math.max(1, Math.floor(l.trunkTiles / 2));
  const avenueOff = Math.round(l.avenueFraction * half);
  const avenueRow = axis + avenueOff;

  // 1. The aprons. This is the only ground a lane may cross the band on, so the
  //    band itself never opens outside one of them.
  const yard = generatedApronTiles(rows);
  const apron: Rect = {
    x: yard.x0,
    y: yard.y0,
    w: yard.x1 - yard.x0 + 1,
    h: yard.y1 - yard.y0 + 1,
  };
  fillRectPair(g, apron, OPEN);
  const aprons: Record<TeamId, Rect> = { blue: apron, red: mirrorRect(g, apron) };

  // 2. The avenue: one wide straight arm each side of the band, joined to both
  //    aprons by a trunk at the map's own edge. Nothing on it bends, so it reads
  //    as the open way across the map, and it is long only because the walls keep
  //    a hull off the band it cannot cross.
  const arm: Rect = {
    x: apron.x + door + 2,
    y: avenueRow,
    w: cols - 2 * (apron.x + door + 2) + 1,
    h: l.avenueRows,
  };
  const armNorth = rows - 1 - (avenueRow + l.avenueRows - 1);
  fillRectPair(g, arm, OPEN);
  fillRectPair(
    g,
    { x: arm.x, y: armNorth, w: l.trunkTiles, h: avenueRow + l.avenueRows - armNorth },
    OPEN,
  );

  // 3. The alley: the long way round, south of the avenue, straight as the
  //    avenue itself but baffled down its length, so a hull drives the same
  //    number of tiles in cover instead of in a firing line. Two trunks reach it
  //    from inside the aprons, near each end, baffled the same way.
  const alleyRow = Math.round(axis + l.trenchFraction * half);
  const alleyCol = apron.x + 12;
  const alleyFar = cols - 1 - alleyCol;
  carveAlley(g, { x: alleyCol, y: alleyRow }, { x: alleyFar, y: alleyRow });
  carveAlley(g, { x: alleyCol, y: axis + door + 2 }, { x: alleyCol, y: alleyRow });
  carveAlley(g, { x: alleyFar - 2, y: axis + door + 2 }, { x: alleyFar - 2, y: alleyRow });

  // 4. The wave astride the band: the only thing that crosses it between the
  //    aprons, on its own, so the contested way is the one that goes through the
  //    middle zone and no other route can borrow its crossings.
  const sineX0 = apron.x + 12;
  const sineSpan = cols - 1 - sineX0 - sineX0;
  const sineAmp = Math.round(l.serpentineFraction * half);
  const sineR = Math.floor(l.serpentineRows / 2);
  for (let i = 0; i <= sineSpan; i++) {
    const y = axis + Math.round(sineAmp * Math.sin((i / sineSpan) * Math.PI * l.serpentineLegs));
    carvePair(g, sineX0 + i, y, sineR);
  }

  // 5. Alcoves bored into the brick that is left, each one opening off a lane
  //    the routes already use. They add cover to hide behind and nothing else:
  //    no route can pass through one, because a bay has only one way in.
  carveBays(g, rng, band);

  return { grid: g, bases, aprons, zone };
}

/**
 * Alcoves bored into the brick behind a lane: trunk wide, a few tiles deep and
 * shut by a block of cover at the back, so a hull can sit out of a lane's fire
 * and wreck the block to open a shot. A bay has one way in and is shorter than
 * a firing line, which is what keeps it a hiding place rather than a route, a
 * sight break, or a pocket no hull can reach.
 */
function carveBays(g: Grid, rng: RandomState, band: [number, number]): void {
  const l = MAP_GEN.layout;
  const clear = l.bays.clearanceTiles;
  const half = Math.floor(l.trunkTiles / 2);
  const pad = MAP_GEN.borderTiles;
  let placed = 0;
  for (let tries = 0; placed < l.bays.count && tries < l.maxPlaceAttempts; tries++) {
    const [sx, sy] = (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as [number, number][]
    )[Math.floor(nextRandom(rng) * 4)]!;
    const len = l.bays.length[Math.floor(nextRandom(rng) * l.bays.length.length)]!;
    const mx = pad + half + Math.floor(nextRandom(rng) * (g.cols - 2 * (pad + half)));
    const my = pad + half + Math.floor(nextRandom(rng) * (g.rows - 2 * (pad + half)));
    if (at(g, mx, my) !== OPEN) continue;
    // Bore past the lane's own thickness, then stop at the first solid ground.
    let k = 1;
    while (at(g, mx + sx * k, my + sy * k) === OPEN) k++;
    const rect: Rect = sx > 0
      ? { x: mx + k, y: my - half, w: len, h: l.trunkTiles }
      : sx < 0
        ? { x: mx - k - len + 1, y: my - half, w: len, h: l.trunkTiles }
        : sy > 0
          ? { x: mx - half, y: my + k, w: l.trunkTiles, h: len }
          : { x: mx - half, y: my - k - len + 1, w: l.trunkTiles, h: len };
    // A bay lying on the band is a hole in the wall between the bases.
    if (rect.y <= band[1] && rect.y + rect.h - 1 >= band[0]) continue;
    // Solid ground all around it, except the side it opens back onto.
    let fits = true;
    for (let y = rect.y - clear; y < rect.y + rect.h + clear && fits; y++) {
      for (let x = rect.x - clear; x < rect.x + rect.w + clear; x++) {
        const towardMouth =
          sx > 0 ? x < rect.x : sx < 0 ? x >= rect.x + rect.w : sy > 0 ? y < rect.y : y >= rect.y + rect.h;
        if (towardMouth) continue;
        if (at(g, x, y) !== BRICK) {
          fits = false;
          break;
        }
      }
    }
    if (!fits) continue;
    fillRectPair(g, rect, OPEN);
    const back: Rect =
      sx !== 0
        ? { x: sx > 0 ? rect.x + len - l.bays.backTiles : rect.x, y: rect.y, w: l.bays.backTiles, h: rect.h }
        : { x: rect.x, y: sy > 0 ? rect.y + len - l.bays.backTiles : rect.y, w: rect.w, h: l.bays.backTiles };
    fillRectPair(g, back, nextRandom(rng) < l.steelShare ? STEEL : BRICK);
    placed++;
  }
}

// ------------------------------------------------------- tank-fit lattice ---

/**
 * Walkable stances are tile centres a hull fits in: the tile and all four of
 * its orthogonal neighbours must be open, which is what a 3-tile corridor is
 * measured against. Diagonal moves are allowed only around a corner that is
 * itself clear, so a route never clips a wall it cannot drive through.
 */
interface Lattice {
  cols: number;
  rows: number;
  walkable: Uint8Array;
}

function buildLattice(g: Grid): Lattice {
  const walkable = new Uint8Array(g.cols * g.rows);
  for (let y = 1; y < g.rows - 1; y++) {
    for (let x = 1; x < g.cols - 1; x++) {
      if (at(g, x, y) !== OPEN) continue;
      if (
        at(g, x + 1, y) !== OPEN ||
        at(g, x - 1, y) !== OPEN ||
        at(g, x, y + 1) !== OPEN ||
        at(g, x, y - 1) !== OPEN
      ) {
        continue;
      }
      walkable[y * g.cols + x] = 1;
    }
  }
  return { cols: g.cols, rows: g.rows, walkable };
}

function stanceAt(lat: Lattice, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= lat.cols || ty >= lat.rows) return -1;
  return lat.walkable[ty * lat.cols + tx] ? ty * lat.cols + tx : -1;
}

/** Nearest walkable stance to a tile, searched outward. */
function nearestStance(lat: Lattice, tx: number, ty: number): number {
  const own = stanceAt(lat, tx, ty);
  if (own >= 0) return own;
  for (let r = 1; r < 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const s = stanceAt(lat, tx + dx, ty + dy);
        if (s >= 0) return s;
      }
    }
  }
  return -1;
}

const NEIGHBOURS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function neighbours(lat: Lattice, node: number): [number, number][] {
  const x = node % lat.cols;
  const y = Math.floor(node / lat.cols);
  const out: [number, number][] = [];
  for (const [dx, dy] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= lat.cols || ny >= lat.rows) continue;
    const n = ny * lat.cols + nx;
    if (!lat.walkable[n]) continue;
    if (dx !== 0 && dy !== 0) {
      // No corner cutting: both sides of the diagonal must be open too.
      if (!lat.walkable[y * lat.cols + nx] || !lat.walkable[ny * lat.cols + x]) continue;
    }
    out.push([n, Math.hypot(dx, dy)]);
  }
  return out;
}

/** Stance centre in world px. */
function stancePx(lat: Lattice, node: number): Vec2 {
  const x = node % lat.cols;
  const y = Math.floor(node / lat.cols);
  return { x: px(x) + CONFIG.tileSize / 2, y: px(y) + CONFIG.tileSize / 2 };
}

// ---------------------------------------------------------------- exposure ---

function blockedAt(g: Grid, xPx: number, yPx: number): boolean {
  return at(g, tileOf(xPx), tileOf(yPx)) !== OPEN;
}

/**
 * A point is covered when walls stand near enough to stop return fire from
 * more than one direction and no firing run long enough to sweep it passes
 * through. Open ground with nothing within a probe length is exposed.
 */
function isExposed(g: Grid, xPx: number, yPx: number): boolean {
  const s = CONFIG.tileSize;
  const probe = MAP_GEN.sight.probePx;
  let hits = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let hit = false;
    for (let d = s / 2; d <= probe; d += s / 2) {
      if (blockedAt(g, xPx + dx * d, yPx + dy * d)) {
        hit = true;
        break;
      }
    }
    if (hit) hits++;
  }
  if (hits < MAP_GEN.sight.coverRaysMin) return true;
  const runLimit = MAP_GEN.sight.firingRunTiles * s;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 4;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let run = 0;
    for (const sign of [1, -1]) {
      for (let d = s / 2; d <= runLimit; d += s / 2) {
        if (blockedAt(g, xPx + sign * dx * d, yPx + sign * dy * d)) break;
        run += s / 2;
      }
    }
    if (run >= runLimit) return true;
  }
  return false;
}

// ------------------------------------------------------------------- line ---

/** True when nothing stands between two points: a clear shot, and a sightline. */
function lineBlocked(g: Grid, a: Vec2, b: Vec2): boolean {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / (CONFIG.tileSize / 2)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (blockedAt(g, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return true;
  }
  return false;
}

// -------------------------------------------------------------------- a* ----

interface PlanOptions {
  /** Extra cost of one exposed step, in steps; this is what seeks cover. */
  exposureWeight?: number;
  /** Stances to treat as unusable, so a later route cannot reuse an earlier one. */
  excluded?: Set<number>;
}

interface PlanResult {
  nodes: number[];
  lengthPx: number;
  exposedShare: number;
}

/** Binary heap of (node, f) pairs; stale entries are skipped by the caller. */
class NodeHeap {
  private nodes: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, f: number): void {
    const { nodes, keys } = this;
    nodes.push(node);
    keys.push(f);
    let i = nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[i]! >= keys[parent]!) break;
      [nodes[i], nodes[parent]] = [nodes[parent]!, nodes[i]!];
      [keys[i], keys[parent]] = [keys[parent]!, keys[i]!];
      i = parent;
    }
  }

  pop(): number {
    const { nodes, keys } = this;
    const top = nodes[0]!;
    const lastNode = nodes.pop()!;
    const lastKey = keys.pop()!;
    if (nodes.length > 0) {
      nodes[0] = lastNode;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let small = i;
        if (l < nodes.length && keys[l]! < keys[small]!) small = l;
        if (r < nodes.length && keys[r]! < keys[small]!) small = r;
        if (small === i) break;
        [nodes[i], nodes[small]] = [nodes[small]!, nodes[i]!];
        [keys[i], keys[small]] = [keys[small]!, keys[i]!];
        i = small;
      }
    }
    return top;
  }
}

function plan(
  lat: Lattice,
  from: number,
  to: number,
  exposed: Uint8Array,
  options: PlanOptions = {},
): PlanResult | null {
  if (from < 0 || to < 0) return null;
  const weight = options.exposureWeight ?? 0;
  const excluded = options.excluded;
  const size = lat.cols * lat.rows;
  const cost = new Float64Array(size).fill(Infinity);
  const came = new Int32Array(size).fill(-1);
  const settled = new Uint8Array(size);
  const gx = (to % lat.cols) * CONFIG.tileSize + CONFIG.tileSize / 2;
  const gy = Math.floor(to / lat.cols) * CONFIG.tileSize + CONFIG.tileSize / 2;
  const h = (node: number): number => {
    const dx = (node % lat.cols) * CONFIG.tileSize + CONFIG.tileSize / 2 - gx;
    const dy = Math.floor(node / lat.cols) * CONFIG.tileSize + CONFIG.tileSize / 2 - gy;
    // Admissible against a diagonal step of sqrt(2) tiles.
    return Math.hypot(dx, dy) / CONFIG.tileSize;
  };
  const heap = new NodeHeap();
  cost[from] = 0;
  heap.push(from, h(from));

  while (heap.size > 0) {
    const node = heap.pop();
    if (settled[node]) continue;
    settled[node] = 1;
    if (node === to) break;
    for (const [n, step] of neighbours(lat, node)) {
      if (settled[n] || excluded?.has(n)) continue;
      const next = cost[node]! + step + (weight && exposed[n] ? weight : 0);
      if (next >= cost[n]!) continue;
      cost[n] = next;
      came[n] = node;
      heap.push(n, next + h(n));
    }
  }
  if (cost[to] === Infinity) return null;

  const nodes: number[] = [];
  for (let n = to; n >= 0; n = came[n]!) nodes.push(n);
  nodes.reverse();
  let lengthPx = 0;
  let exposedCount = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (i > 0) {
      const a = stancePx(lat, nodes[i - 1]!);
      const b = stancePx(lat, nodes[i]!);
      lengthPx += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (exposed[nodes[i]!]) exposedCount++;
  }
  return {
    nodes,
    lengthPx,
    exposedShare: nodes.length ? exposedCount / nodes.length : 1,
  };
}

// ------------------------------------------------------------------ audit ---

/**
 * A route as the rules read it. The open/covered share is measured on the
 * ground outside every base's apron, because that apron is ground all three
 * ways have in common and says nothing about which way is which.
 */
function routeOf(
  lat: Lattice,
  planResult: PlanResult,
  exposed: Uint8Array,
  bases: Vec2[],
  mergePx: number,
): Omit<MapRoute, "role" | "throughZone"> {
  const points = planResult.nodes.map((n) => stancePx(lat, n));
  let measured = 0;
  let inTheOpen = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (bases.some((b) => Math.hypot(p.x - b.x, p.y - b.y) <= mergePx)) continue;
    measured++;
    if (exposed[planResult.nodes[i]!]) inTheOpen++;
  }
  return {
    points,
    lengthPx: planResult.lengthPx,
    travelSec: planResult.lengthPx / averageHullSpeed(),
    exposedShare: measured ? inTheOpen / measured : 1,
  };
}

function insideZone(zone: Layout["zone"], point: Vec2): boolean {
  return Math.hypot(point.x / CONFIG.tileSize - zone.cx, point.y / CONFIG.tileSize - zone.cy) <= zone.r;
}

/**
 * The tiles of a route that the next search may not reuse. Nodes inside a
 * base's merge radius are left out of the set: every route reaches a base
 * through the same apron, and the separation rule already ignores that ground.
 * Excluding them would put the start stance itself in the set and leave the
 * next search with nowhere to begin.
 */
function routeTiles(
  lat: Lattice,
  nodes: number[],
  bases: Vec2[],
  mergePx: number,
): Set<number> {
  const taken = new Set<number>();
  for (const n of nodes) {
    const p = stancePx(lat, n);
    if (bases.some((b) => Math.hypot(p.x - b.x, p.y - b.y) <= mergePx)) continue;
    taken.add(n);
  }
  return taken;
}

/**
 * How much of one route runs alongside the other instead of merely crossing it.
 * Two corridors that meet at right angles share the handful of tiles at the
 * junction no matter how distinct they are, and every route leaves a base
 * through the same apron, so the rule counts the tiles that sit within
 * `radiusTiles` of the other route's ground: a few per cent is a junction, half
 * of it is one route riding the other.
 */
function rideShare(
  a: Vec2[],
  b: Vec2[],
  ignore: Vec2[],
  ignoreRadius: number,
  radiusTiles: number,
): number {
  const T = CONFIG.tileSize;
  const near = new Set<string>();
  for (const q of b) near.add(`${Math.floor(q.x / T)},${Math.floor(q.y / T)}`);
  const rides = (tx: number, ty: number): boolean => {
    for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
      for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
        if (dx * dx + dy * dy > radiusTiles * radiusTiles) continue;
        if (near.has(`${tx + dx},${ty + dy}`)) return true;
      }
    }
    return false;
  };
  let measured = 0;
  let riding = 0;
  for (const p of a) {
    if (ignore.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= ignoreRadius)) continue;
    measured++;
    if (rides(Math.floor(p.x / T), Math.floor(p.y / T))) riding++;
  }
  return measured ? riding / measured : 1;
}

/** The worse of the two directions: a route may be short and still ride a long one. */
function routeOverlap(
  a: MapRoute,
  b: MapRoute,
  bases: Vec2[],
  mergePx: number,
  radiusTiles: number,
): number {
  return Math.max(
    rideShare(a.points, b.points, bases, mergePx, radiusTiles),
    rideShare(b.points, a.points, bases, mergePx, radiusTiles),
  );
}

function reachableShare(lat: Lattice, from: number): number {
  if (from < 0) return 0;
  const seen = new Uint8Array(lat.walkable.length);
  const queue = [from];
  seen[from] = 1;
  let count = 1;
  for (let head = 0; head < queue.length; head++) {
    for (const [n] of neighbours(lat, queue[head]!)) {
      if (seen[n]) continue;
      seen[n] = 1;
      count++;
      queue.push(n);
    }
  }
  let total = 0;
  for (let i = 0; i < lat.walkable.length; i++) if (lat.walkable[i]) total++;
  return total ? count / total : 0;
}

export interface AuditResult {
  routes: MapRoute[];
  checks: MapGenCheck[];
  straightPx: number;
  shortestSec: number;
  failures: string[];
}

/**
 * Measure one candidate. The three routes are found by measurement, not by
 * name: the shortest is the one a commander will call the short way, the
 * cover-seeking plan that cannot reuse its tiles is the protected way, and the
 * plan that still has to enter the middle zone after both are taken is the
 * contested way. Each is then judged against the rules.
 */
function audit(layout: Layout): AuditResult {
  const g = layout.grid;
  const lat = buildLattice(g);
  const exposedFlags = new Uint8Array(lat.cols * lat.rows);
  for (let y = 0; y < lat.rows; y++) {
    for (let x = 0; x < lat.cols; x++) {
      const i = y * lat.cols + x;
      if (!lat.walkable[i]) continue;
      const p = stancePx(lat, i);
      exposedFlags[i] = isExposed(g, p.x, p.y) ? 1 : 0;
    }
  }

  const blueCenter = baseCenterPx(layout.bases.blue);
  const redCenter = baseCenterPx(layout.bases.red);
  const bases = [blueCenter, redCenter];
  const mergePx = MAP_GEN.rules.baseMergeTiles * CONFIG.tileSize;
  const from = nearestStance(lat, tileOf(blueCenter.x), tileOf(blueCenter.y));
  const to = nearestStance(lat, tileOf(redCenter.x), tileOf(redCenter.y));
  const straightPx = Math.hypot(redCenter.x - blueCenter.x, redCenter.y - blueCenter.y);

  const check = (name: string, passed: boolean, detail: string): MapGenCheck => ({ name, passed, detail });
  const checks: MapGenCheck[] = [];

  const shared = reachableShare(lat, from);
  checks.push(
    check(
      "connected",
      shared >= MAP_GEN.rules.reachableShareMin,
      `${(shared * 100).toFixed(1)}% of stances reachable from a base (min ${(MAP_GEN.rules.reachableShareMin * 100).toFixed(0)}%)`,
    ),
  );

  // Spawn sightlines: no hull at either base may see the other base's ground.
  const clearPairs = baseSightPairs(g, layout);
  checks.push(
    check(
      "no base-to-base sightline",
      clearPairs === 0,
      clearPairs === 0
        ? "no spawn point sees the far base"
        : `${clearPairs} spawn pair(s) have a clear shot between the bases`,
    ),
  );

  const direct = plan(lat, from, to, exposedFlags);
  if (!direct || !to || from < 0) {
    checks.push(check("route exists", false, "no A* path between the bases at all"));
    return { routes: [], checks, straightPx, shortestSec: 0, failures: failuresOf(checks) };
  }

  const directRoute = {
    role: "direct" as MapRouteRole,
    throughZone: false,
    ...routeOf(lat, direct, exposedFlags, bases, mergePx),
  };
  directRoute.throughZone = directRoute.points.some((p) => insideZone(layout.zone, p));
  const directTiles = routeTiles(lat, direct.nodes, bases, mergePx);

  checks.push(
    check(
      "short route is exposed",
      directRoute.exposedShare >= MAP_GEN.rules.exposedShareMin,
      `${(directRoute.exposedShare * 100).toFixed(0)}% of it stands in the open (min ${(MAP_GEN.rules.exposedShareMin * 100).toFixed(0)}%)`,
    ),
  );
  checks.push(
    check(
      "walls force a detour",
      directRoute.lengthPx / straightPx >= MAP_GEN.rules.detourRatioMin,
      `shortest route is ${(directRoute.lengthPx / straightPx).toFixed(2)}x the straight line (min ${MAP_GEN.rules.detourRatioMin})`,
    ),
  );

  const protectedPlan = plan(lat, from, to, exposedFlags, {
    exposureWeight: MAP_GEN.rules.exposureCostWeight,
    excluded: directTiles,
  });
  const routes: MapRoute[] = [directRoute];
  if (!protectedPlan) {
    checks.push(check("protected route exists", false, "no cover-seeking path once the short route is taken"));
  } else {
    const protectedRoute: MapRoute = {
      role: "protected",
      throughZone: false,
      ...routeOf(lat, protectedPlan, exposedFlags, bases, mergePx),
    };
    protectedRoute.throughZone = protectedRoute.points.some((p) => insideZone(layout.zone, p));
    const ratio = protectedRoute.lengthPx / directRoute.lengthPx;
    checks.push(
      check(
        "protected route is longer",
        ratio >= MAP_GEN.rules.protectedLengthMin && ratio <= MAP_GEN.rules.protectedLengthMax,
        `${ratio.toFixed(2)}x the short route (want ${MAP_GEN.rules.protectedLengthMin}-${MAP_GEN.rules.protectedLengthMax})`,
      ),
    );
    checks.push(
      check(
        "protected route is covered",
        protectedRoute.exposedShare <= MAP_GEN.rules.protectedShareMax,
        `${(protectedRoute.exposedShare * 100).toFixed(0)}% exposed (max ${(MAP_GEN.rules.protectedShareMax * 100).toFixed(0)}%)`,
      ),
    );
    checks.push(
      check(
        "routes differ in exposure",
        directRoute.exposedShare - protectedRoute.exposedShare >= MAP_GEN.rules.exposureGapMin,
        `${((directRoute.exposedShare - protectedRoute.exposedShare) * 100).toFixed(0)}% gap (min ${(MAP_GEN.rules.exposureGapMin * 100).toFixed(0)}%)`,
      ),
    );
    const ride = routeOverlap(
      directRoute,
      protectedRoute,
      bases,
      mergePx,
      MAP_GEN.rules.routeSeparationTiles,
    );
    checks.push(
      check(
        "routes are separate",
        ride <= MAP_GEN.rules.routeOverlapShareMax,
        `${(ride * 100).toFixed(0)}% of one route runs alongside the other (max ${(MAP_GEN.rules.routeOverlapShareMax * 100).toFixed(0)}%)`,
      ),
    );
    routes.push(protectedRoute);
  }

  // The contested route: through the middle zone circle, on neither of the two
  // corridors already found.
  const takenForZone = new Set(directTiles);
  if (protectedPlan)
    for (const n of routeTiles(lat, protectedPlan.nodes, bases, mergePx)) takenForZone.add(n);
  const zoneStances = zoneStanceList(lat, layout.zone);
  let zonePlan: PlanResult | null = null;
  for (const stance of zoneStances) {
    if (takenForZone.has(stance)) continue;
    const via = plan(lat, from, stance, exposedFlags, { excluded: takenForZone });
    if (!via) continue;
    const rest = plan(lat, stance, to, exposedFlags, { excluded: takenForZone });
    if (!rest) continue;
    const merged = {
      nodes: [...via.nodes, ...rest.nodes.slice(1)],
      lengthPx: via.lengthPx + rest.lengthPx,
      exposedShare: 0,
    };
    if (!zonePlan || merged.lengthPx < zonePlan.lengthPx) zonePlan = merged;
  }
  if (!zonePlan) {
    checks.push(check("zone route exists", false, "no path through the middle zone once the other two are taken"));
  } else {
    const zoneRoute: MapRoute = {
      role: "zone",
      throughZone: true,
      ...routeOf(lat, zonePlan, exposedFlags, bases, mergePx),
    };
    const ratio = zoneRoute.lengthPx / directRoute.lengthPx;
    checks.push(
      check(
        "zone route is not a slog",
        ratio <= MAP_GEN.rules.zoneLengthMax,
        `${ratio.toFixed(2)}x the short route (max ${MAP_GEN.rules.zoneLengthMax})`,
      ),
    );
    for (const other of routes) {
      const ride = routeOverlap(zoneRoute, other, bases, mergePx, MAP_GEN.rules.routeSeparationTiles);
      checks.push(
        check(
          `zone route clear of ${other.role}`,
          ride <= MAP_GEN.rules.routeOverlapShareMax,
          `${(ride * 100).toFixed(0)}% of it runs alongside the ${other.role} route (max ${(MAP_GEN.rules.routeOverlapShareMax * 100).toFixed(0)}%)`,
        ),
      );
    }
    routes.push(zoneRoute);
  }

  checks.push(
    check(
      "drive time in window",
      directRoute.travelSec >= MAP_GEN.baseToBaseSec.min && directRoute.travelSec <= MAP_GEN.baseToBaseSec.max,
      `shortest route drives in ${directRoute.travelSec.toFixed(1)}s (want ${MAP_GEN.baseToBaseSec.min}-${MAP_GEN.baseToBaseSec.max}s)`,
    ),
  );

  return {
    routes,
    checks,
    straightPx,
    shortestSec: directRoute.travelSec,
    failures: failuresOf(checks),
  };
}

function failuresOf(checks: MapGenCheck[]): string[] {
  return checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
}

function baseCenterPx(tile: BaseTile): Vec2 {
  const f = MAP_GEN.footprintTiles;
  return { x: px(tile.tileX + f / 2), y: px(tile.tileY + f / 2) };
}

/**
 * How many pairs of apron points — the ground a respawned hull appears on —
 * have a clear shot at the far side's apron. Any pair that sees the other end
 * means one base can shell the other from home, which no generated map may do.
 */
function baseSightPairs(g: Grid, layout: Layout): number {
  const sample = (r: Rect): Vec2[] => {
    const out: Vec2[] = [];
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0.5],
    ]) {
      out.push({
        x: px(r.x + (r.w - 1) * dx) + CONFIG.tileSize / 2,
        y: px(r.y + (r.h - 1) * dy) + CONFIG.tileSize / 2,
      });
    }
    return out;
  };
  const blue = sample(layout.aprons.blue);
  const red = sample(layout.aprons.red);
  let clear = 0;
  for (const a of blue) {
    for (const b of red) {
      if (!lineBlocked(g, a, b)) clear++;
    }
  }
  return clear;
}

/** Every stance inside the middle zone circle, nearest the centre first. */
function zoneStanceList(lat: Lattice, zone: Layout["zone"]): number[] {
  const out: number[] = [];
  for (let y = 0; y < lat.rows; y++) {
    for (let x = 0; x < lat.cols; x++) {
      const i = y * lat.cols + x;
      if (!lat.walkable[i]) continue;
      if (Math.hypot(x - zone.cx, y - zone.cy) <= zone.r) out.push(i);
    }
  }
  out.sort(
    (a, b) =>
      Math.hypot((a % lat.cols) - zone.cx, Math.floor(a / lat.cols) - zone.cy) -
      Math.hypot((b % lat.cols) - zone.cx, Math.floor(b / lat.cols) - zone.cy),
  );
  return out.slice(0, 64);
}

// -------------------------------------------------------------- public api ---

export function describeMapSize(size: GeneratedMapSize = MAP_GEN_SIZE): string {
  const area = size.cols * size.rows;
  const reference = MAP_GEN.referenceArena.cols * MAP_GEN.referenceArena.rows;
  return [
    `map ${(size.cols * CONFIG.tileSize) | 0}x${(size.rows * CONFIG.tileSize) | 0}px`,
    `(${size.cols}x${size.rows} tiles, ${(area / reference).toFixed(2)}x the ${(MAP_GEN.referenceArena.cols * MAP_GEN.referenceArena.rows).toString()} tile reference)`,
    `| base-to-base straight ${Math.round(size.straightPx)}px`,
    `| route estimate ${Math.round(size.estRoutePx)}px`,
    `| ${(size.estSec).toFixed(1)}s at the ${size.avgSpeed.toFixed(1)} px/s average hull`,
  ].join(" ");
}

/**
 * One candidate: build it, measure it, and say what it failed. Retries are the
 * caller's business, so the audit script can report on single attempts.
 */
export function generateCandidate(
  seedUsed: number,
  size: GeneratedMapSize = MAP_GEN_SIZE,
): GeneratedMap {
  const layout = buildLayout(seedUsed, size);
  const result = audit(layout);
  return {
    requestedSeed: seedUsed,
    seedUsed,
    attempts: 1,
    cols: size.cols,
    rows: size.rows,
    walls: gridToWalls(layout.grid.cells, layout.grid.cols, layout.grid.rows),
    routes: result.routes,
    straightPx: result.straightPx,
    shortestSec: result.shortestSec,
    checks: result.checks,
    failures: result.failures,
    forced: result.failures.length > 0,
  };
}

const cache = new Map<number, GeneratedMap>();

/**
 * The map for a seed: build candidates until one passes every rule, retrying
 * with the next seed in the chain if it does not. Deterministic, so a batch run
 * and a live game with the same `--map-seed` get the same map.
 */
export function generatedMap(
  requestedSeed: number,
  size: GeneratedMapSize = MAP_GEN_SIZE,
): GeneratedMap {
  const key = requestedSeed * 1_000_003 + size.cols * 4096 + size.rows;
  const hit = cache.get(key);
  if (hit) return hit;

  let last: GeneratedMap | null = null;
  for (let attempt = 0; attempt < MAP_GEN.rules.maxAttempts; attempt++) {
    const map = generateCandidate(requestedSeed + attempt * 7919, size);
    map.requestedSeed = requestedSeed;
    map.attempts = attempt + 1;
    if (!map.forced) {
      cache.set(key, map);
      return map;
    }
    last = map;
  }

  // Nothing passed: keep the best last attempt rather than fail the game.
  const fallback = last ?? {
    requestedSeed,
    seedUsed: requestedSeed,
    attempts: 0,
    cols: size.cols,
    rows: size.rows,
    walls: [],
    routes: [],
    straightPx: 0,
    shortestSec: 0,
    checks: [],
    failures: ["no candidate built"],
    forced: true,
  };
  cache.set(key, fallback);
  return fallback;
}

/** Wall list for a map seed, with retries already resolved. */
export function generatedWalls(seed: number, size?: GeneratedMapSize): Wall[] {
  return generatedMap(seed, size).walls.map((w) => ({ ...w }));
}

/** The three measured routes, for the debug overlay and the batch report. */
export function generatedRoutes(seed: number, size?: GeneratedMapSize): MapRoute[] {
  return generatedMap(seed, size).routes;
}

/**
 * Turn the accepted wall list back into a grid and check every tile against its
 * 180° partner. The layout is built in mirrored pairs, so this only fails if
 * something wrote a tile without going through setPair.
 */
export function generatedMapIsSymmetric(seed: number, size?: GeneratedMapSize): boolean {
  const map = generatedMap(seed, size);
  const g: Grid = { cols: map.cols, rows: map.rows, cells: gridFromWalls(map.walls, map.cols, map.rows) };
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      if (at(g, x, y) !== at(g, g.cols - 1 - x, g.rows - 1 - y)) return false;
    }
  }
  return true;
}

function gridFromWalls(walls: Wall[], cols: number, rows: number): Uint8Array {
  const cells = new Uint8Array(cols * rows);
  for (const w of walls) {
    const kind = w.kind === "border" ? BORDER : w.kind === "steel" ? STEEL : BRICK;
    for (let y = tileOf(w.y); y < tileOf(w.y + w.h); y++) {
      for (let x = tileOf(w.x); x < tileOf(w.x + w.w); x++) {
        if (x >= 0 && y >= 0 && x < cols && y < rows) cells[y * cols + x] = kind;
      }
    }
  }
  return cells;
}
