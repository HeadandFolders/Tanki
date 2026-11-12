import { prepareBaseWarWalls, restoreBaseWarWalls } from "./arena-bases";
import { ensureTwoRoutes, layoutHash } from "./arena-routes";
import { DENSE_WALLS, REFERENCE_WALLS, STANDARD_WALLS } from "./arena-layouts";
import { buildLargeWalls, largeArenaZones, type ArenaZone } from "./arena-large";
import { ARENA_SPECS, CONFIG, setWorldSize, type ArenaId } from "./config";
import { MAP_GEN_SIZE } from "./config/balance";
import { generatedWalls } from "./mapgen";
import type { Wall } from "./types";

export type ArenaDensity = ArenaId;

/**
 * Every stance a tank can occupy has two disjoint routes to every other stance.
 * Reference is the TDM / CTF map. Large (the default, see CONFIG.arenaDefault)
 * is the generated 144x90 map and dense the 80x50 multiplayer fill; "generated"
 * is the seeded map generator's own, three times the area and verified by its
 * own A* pass rather than this repair pass. All are selectable. A saved edit is
 * opened again if it would leave a dead end or a one-tank chokepoint. Sets the
 * world size.
 */
/** Hash of the layout a peer would build, without disturbing the current world size. */
export function arenaLayoutHash(arena: ArenaId, seed: number): string {
  const cols = CONFIG.canvasWidth / CONFIG.tileSize;
  const rows = CONFIG.canvasHeight / CONFIG.tileSize;
  const hash = layoutHash(buildArena(arena, seed));
  setWorldSize(cols, rows);
  return hash;
}

export interface BuildArenaOptions {
  seed?: number;
  baseWar?: boolean;
}

export function buildArena(
  arena: ArenaId = "standard",
  options: number | BuildArenaOptions = CONFIG.largeArena.seed,
): Wall[] {
  const seed = typeof options === "number" ? options : (options.seed ?? CONFIG.largeArena.seed);
  const baseWar = typeof options !== "number" && options.baseWar === true;
  if (arena === "generated") {
    // The generator's own A* pass is what says this map has three routes; a
    // repair pass over the walls afterwards would move the ground it measured,
    // and a dragged edit would do the same to a peer's copy of the map.
    setWorldSize(MAP_GEN_SIZE.cols, MAP_GEN_SIZE.rows);
    const laid = generatedWalls(seed);
    return baseWar ? restoreBaseWarWalls(prepareBaseWarWalls(laid, arena), arena) : laid;
  }
  const spec = ARENA_SPECS[arena];
  setWorldSize(spec.cols, spec.rows);
  const base =
    arena === "reference"
      ? REFERENCE_WALLS
      : arena === "dense"
        ? DENSE_WALLS
        : arena === "large"
          ? buildLargeWalls(seed)
          : STANDARD_WALLS;
  let laid = withSavedLayout(
    base.map((w) => ({ ...w })),
    arena,
  );
  if (baseWar) laid = prepareBaseWarWalls(laid, arena);
  const routed = ensureTwoRoutes(laid).map((w) => ({ ...w }));
  return baseWar ? restoreBaseWarWalls(routed, arena) : routed;
}

/** Named zone anchors of the arena; empty for the hand-authored band maps. */
export function arenaZones(arena: ArenaId, seed: number): ArenaZone[] {
  return arena === "large" ? largeArenaZones(seed) : [];
}

const WALL_LAYOUT_KEY = "tanki-wall-layout-v1";

/** Edits are stored per arena so a drag on one map never clobbers another. */
function layoutKey(arena: ArenaId): string {
  return `${WALL_LAYOUT_KEY}:${arena}`;
}

/** Remember dragged structures for one arena. The stone border is not stored. */
export function saveWallLayout(walls: Wall[], arena: ArenaId): void {
  if (typeof localStorage === "undefined") return;
  const interior = walls
    .filter((w) => w.kind !== "border")
    .map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, kind: w.kind }));
  localStorage.setItem(
    layoutKey(arena),
    JSON.stringify({ map: arena, walls: interior }),
  );
}

export function clearWallLayout(arena: ArenaId): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(layoutKey(arena));
}

function withSavedLayout(walls: Wall[], arena: ArenaId): Wall[] {
  if (typeof localStorage === "undefined") return walls;
  try {
    const raw = localStorage.getItem(layoutKey(arena));
    if (!raw) return walls;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return walls;
    const saved = parsed as { map?: string; walls?: unknown };
    if (saved.map !== arena || !Array.isArray(saved.walls)) return walls;
    const interior: Wall[] = [];
    for (const item of saved.walls) {
      if (!item || typeof item !== "object") continue;
      const w = item as Wall;
      if (w.kind !== "brick" && w.kind !== "steel") continue;
      if (!(w.w > 0) || !(w.h > 0)) continue;
      interior.push({ x: w.x, y: w.y, w: w.w, h: w.h, kind: w.kind });
    }
    if (interior.length === 0) return walls;
    return [...walls.filter((w) => w.kind === "border"), ...interior];
  } catch {
    return walls;
  }
}

/** World position of the eagle emblem (visual + landmark). */
export function eaglePosition(): { x: number; y: number } {
  return {
    x: CONFIG.canvasWidth / 2,
    y: CONFIG.canvasHeight - CONFIG.tileSize * 4.5,
  };
}

const WALL_CELL = 96;
let activeWalls: Wall[] | null = null;
let activeBuckets: Map<number, Wall[]> | null = null;
let wallQueryStamp = 1;
const wallSeen = new WeakMap<Wall, number>();

function wallBucketKey(ix: number, iy: number): number {
  return ix * 73856093 + iy * 19349663;
}

/** True while `usingWallIndex` is running for this exact wall array. */
export function wallIndexCovers(walls: Wall[]): boolean {
  return activeWalls === walls && activeBuckets !== null;
}

/**
 * Rebuild a uniform grid for `walls` and run `fn`. Segment and circle tests
 * against that same array then touch only the cells the query crosses.
 */
export function usingWallIndex<T>(walls: Wall[], fn: () => T): T {
  if (activeWalls === walls && activeBuckets) return fn();
  const prevWalls = activeWalls;
  const prevBuckets = activeBuckets;
  const buckets = wallBuckets(walls);
  activeWalls = walls;
  activeBuckets = buckets;
  try {
    return fn();
  } finally {
    activeWalls = prevWalls;
    activeBuckets = prevBuckets;
  }
}

const bucketCache = new WeakMap<Wall[], { print: number; buckets: Map<number, Wall[]> }>();

/** Cheap O(n) fingerprint so in-place edits (map editor drags) still invalidate. */
export function wallsFingerprint(walls: Wall[]): number {
  let f = walls.length;
  for (const w of walls) f = (f * 31 + w.x * 3 + w.y * 7 + w.w * 11 + w.h * 13) | 0;
  return f;
}

function wallBuckets(walls: Wall[]): Map<number, Wall[]> {
  const print = wallsFingerprint(walls);
  const hit = bucketCache.get(walls);
  if (hit && hit.print === print) return hit.buckets;
  const buckets = new Map<number, Wall[]>();
  for (const w of walls) {
    const x0 = Math.floor(w.x / WALL_CELL);
    const y0 = Math.floor(w.y / WALL_CELL);
    const x1 = Math.floor((w.x + w.w) / WALL_CELL);
    const y1 = Math.floor((w.y + w.h) / WALL_CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = wallBucketKey(ix, iy);
        const list = buckets.get(key);
        if (list) list.push(w);
        else buckets.set(key, [w]);
      }
    }
  }
  bucketCache.set(walls, { print, buckets });
  return buckets;
}

function considerWall(w: Wall): boolean {
  if (wallSeen.get(w) === wallQueryStamp) return false;
  wallSeen.set(w, wallQueryStamp);
  return true;
}

function forEachSegmentCell(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (ix: number, iy: number) => void,
): void {
  let ix = Math.floor(x0 / WALL_CELL);
  let iy = Math.floor(y0 / WALL_CELL);
  const ixEnd = Math.floor(x1 / WALL_CELL);
  const iyEnd = Math.floor(y1 / WALL_CELL);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
  const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
  const dtX = dx === 0 ? Infinity : WALL_CELL / Math.abs(dx);
  const dtY = dy === 0 ? Infinity : WALL_CELL / Math.abs(dy);
  let tMaxX =
    dx === 0
      ? Infinity
      : ((dx > 0 ? (ix + 1) * WALL_CELL : ix * WALL_CELL) - x0) / dx;
  let tMaxY =
    dy === 0
      ? Infinity
      : ((dy > 0 ? (iy + 1) * WALL_CELL : iy * WALL_CELL) - y0) / dy;
  visit(ix, iy);
  for (let n = 0; n < 80 && (ix !== ixEnd || iy !== iyEnd); n++) {
    if (Math.abs(tMaxX - tMaxY) <= 1e-9) {
      visit(ix + stepX, iy);
      visit(ix, iy + stepY);
      tMaxX += dtX;
      tMaxY += dtY;
      ix += stepX;
      iy += stepY;
    } else if (tMaxX < tMaxY) {
      tMaxX += dtX;
      ix += stepX;
    } else {
      tMaxY += dtY;
      iy += stepY;
    }
    visit(ix, iy);
  }
}

export function circleHitsWall(
  x: number,
  y: number,
  r: number,
  walls: Wall[],
): boolean {
  if (activeBuckets && activeWalls === walls) {
    wallQueryStamp++;
    const x0 = Math.floor((x - r) / WALL_CELL);
    const y0 = Math.floor((y - r) / WALL_CELL);
    const x1 = Math.floor((x + r) / WALL_CELL);
    const y1 = Math.floor((y + r) / WALL_CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const list = activeBuckets.get(wallBucketKey(ix, iy));
        if (!list) continue;
        for (const w of list) {
          if (!considerWall(w)) continue;
          const nearestX = Math.max(w.x, Math.min(x, w.x + w.w));
          const nearestY = Math.max(w.y, Math.min(y, w.y + w.h));
          const dx = x - nearestX;
          const dy = y - nearestY;
          if (dx * dx + dy * dy < r * r) return true;
        }
      }
    }
    return false;
  }
  for (const w of walls) {
    const nearestX = Math.max(w.x, Math.min(x, w.x + w.w));
    const nearestY = Math.max(w.y, Math.min(y, w.y + w.h));
    const dx = x - nearestX;
    const dy = y - nearestY;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

export function segmentHitsWall(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  walls: Wall[],
): boolean {
  if (activeBuckets && activeWalls === walls) {
    wallQueryStamp++;
    let hit = false;
    forEachSegmentCell(x0, y0, x1, y1, (ix, iy) => {
      if (hit) return;
      const list = activeBuckets!.get(wallBucketKey(ix, iy));
      if (!list) return;
      for (const w of list) {
        if (!considerWall(w)) continue;
        if (segIntersectsRect(x0, y0, x1, y1, w.x, w.y, w.w, w.h)) hit = true;
      }
    });
    return hit;
  }
  for (const w of walls) {
    if (segIntersectsRect(x0, y0, x1, y1, w.x, w.y, w.w, w.h)) return true;
  }
  return false;
}

function segIntersectsRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  if (pointInRect(x0, y0, rx, ry, rw, rh) || pointInRect(x1, y1, rx, ry, rw, rh))
    return true;
  const edges: [number, number, number, number][] = [
    [rx, ry, rx + rw, ry],
    [rx + rw, ry, rx + rw, ry + rh],
    [rx + rw, ry + rh, rx, ry + rh],
    [rx, ry + rh, rx, ry],
  ];
  for (const e of edges) {
    if (segmentsIntersect(x0, y0, x1, y1, e[0], e[1], e[2], e[3])) return true;
  }
  return false;
}

function pointInRect(
  x: number,
  y: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(d) < 1e-8) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function tryMove(
  x: number,
  y: number,
  dx: number,
  dy: number,
  r: number,
  walls: Wall[],
): { x: number; y: number } {
  const nx = x + dx;
  const ny = y + dy;
  if (!circleHitsWall(nx, ny, r, walls)) return { x: nx, y: ny };
  if (!circleHitsWall(x + dx, y, r, walls)) return { x: x + dx, y };
  if (!circleHitsWall(x, y + dy, r, walls)) return { x, y: y + dy };
  return { x, y };
}

export function unstickFromWalls(
  x: number,
  y: number,
  r: number,
  walls: Wall[],
): { x: number; y: number } {
  if (!circleHitsWall(x, y, r, walls)) return { x, y };
  const steps = [8, 16, 28, 44, 64];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  for (const distStep of steps) {
    for (const [dx, dy] of dirs) {
      const nx = x + dx * distStep;
      const ny = y + dy * distStep;
      if (!circleHitsWall(nx, ny, r, walls)) return { x: nx, y: ny };
    }
  }
  return { x, y };
}

export function findClearPoint(
  preferX: number,
  preferY: number,
  r: number,
  walls: Wall[],
  yMin: number,
  yMax: number,
  xMin: number,
  xMax: number,
  rng: () => number,
): { x: number; y: number } {
  for (let i = 0; i < 40; i++) {
    const x = Math.min(
      xMax,
      Math.max(xMin, preferX + (rng() - 0.5) * (20 + i * 6)),
    );
    const y = Math.min(
      yMax,
      Math.max(yMin, preferY + (rng() - 0.5) * (16 + i * 5)),
    );
    if (!circleHitsWall(x, y, r, walls)) return { x, y };
  }
  return unstickFromWalls((xMin + xMax) / 2, (yMin + yMax) / 2, r, walls);
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function angleTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

export function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function rotateToward(
  current: number,
  target: number,
  maxDelta: number,
): number {
  const diff = normalizeAngle(target - current);
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Snap angle to NES-style 4-way facing for sprites. */
export function cardinalAngle(angle: number): number {
  const dirs = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  let best = dirs[0]!;
  let bestDiff = Infinity;
  for (const d of dirs) {
    const diff = Math.abs(normalizeAngle(angle - d));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return best;
}
