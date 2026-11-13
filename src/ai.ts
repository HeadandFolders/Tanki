import {
  CONFIG,
  homeTerritoryBounds,
  isMpOffline,
  isMpRules,
} from "./config";
import { baseReachOf, driveSpeedOf, hasRoundInAir, turnRateOf } from "./config/balance";
import {
  angleTo,
  circleHitsWall,
  dist,
  normalizeAngle,
  rotateToward,
  segmentHitsWall,
  tryMove,
  unstickFromWalls,
  usingWallIndex,
  wallIndexCovers,
  wallsFingerprint,
} from "./arena";
import {
  beliefFor,
  freshestContact,
  knownEnemyTanks,
  liveVisibleEnemies,
} from "./belief";
import { baseShotClear } from "./arena-bases";
import { canSeeTank } from "./fog";
import { nextRandom } from "./random";
import { COMBAT_LOCKED_GOALS, ORDERED_MOVE_GOALS } from "./goals";
import {
  finishOrder,
  noteDeviation,
  orderedPrey,
  setGoal,
  stackFor,
  updateInterruptStack,
} from "./interrupt-stack";
import { driveOrder, fitBodyStep, pullToClear } from "./motion";
import { detectStuck, replanStuckRoute, stuckBlockers } from "./stuck";
import type { Tank, Wall, WorldState, Wreck } from "./types";

export function updateTankAi(
  world: WorldState,
  tank: Tank,
  dt: number,
  isPlayerControlled: boolean,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  if (!tank.alive) {
    return { moveX: 0, moveY: 0, wantShoot: false, aimAngle: tank.angle };
  }

  const freed = unstickFromWalls(
    tank.x,
    tank.y,
    CONFIG.tankRadius,
    world.walls,
  );
  tank.x = freed.x;
  tank.y = freed.y;

  if (isPlayerControlled) {
    return { moveX: 0, moveY: 0, wantShoot: false, aimAngle: tank.angle };
  }

  // Multiplayer: hold until ordered, with explicit retreat interrupts.
  if (isMpRules(world.gameMode)) {
    return mpOfflineFriendlyBrain(world, tank, dt);
  }

  if (tank.team === "red" && !world.commanders?.red) {
    return enemyBrain(world, tank, dt);
  }
  return friendlyBrain(world, tank, dt);
}

function nearest<T extends { x: number; y: number }>(
  list: T[],
  x: number,
  y: number,
): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const item of list) {
    const d = dist(x, y, item.x, item.y);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

function isPlayerOrder(tank: Tank): boolean {
  return tank.goal.source === "player";
}

/** Map-mark orders stop on the X. Other holds keep the looser radius. */
function arriveRadius(tank: Tank): number {
  return tank.goal.params?.exact ? 8 : CONFIG.ai.holdRadius;
}

/**
 * Extra gap past the hull radius. A cell whose center merely misses a wall
 * is still blocked, so the body does not ride the wall while following it.
 */
const PATH_BODY_MARGIN = 2;

/**
 * Offsets, nearest first, tried when a lattice cell's center is inside the
 * body margin. Six-pixel spacing out to half a cell covers any corridor two
 * tiles or wider, whatever its position relative to the lattice.
 */
const CELL_PROBES: [number, number][] = (() => {
  const probes: [number, number][] = [];
  const half = CONFIG.ai.pathStep / 2;
  for (let ox = -half; ox <= half; ox += 6) {
    for (let oy = -half; oy <= half; oy += 6) probes.push([ox, oy]);
  }
  return probes.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
})();

function pathBody(radius: number): number {
  return radius + PATH_BODY_MARGIN;
}

/** True if a tank-sized body can travel the segment without hitting walls. */
function pathClear(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  walls: Wall[],
  r: number,
): boolean {
  if (segmentHitsWall(x0, y0, x1, y1, walls)) return false;
  const d = dist(x0, y0, x1, y1);
  const steps = Math.max(1, Math.ceil(d / Math.max(8, r * 0.75)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (circleHitsWall(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, walls)) {
      return false;
    }
  }
  return true;
}

interface RouteFoe {
  id: string;
  x: number;
  y: number;
  gunRange: number;
}

function livingFoes(world: WorldState, tank: Tank): { x: number; y: number }[] {
  return routeFoes(world, tank).map((f) => ({ x: f.x, y: f.y }));
}

function routeFoes(world: WorldState, tank: Tank): RouteFoe[] {
  const out: RouteFoe[] = [];
  const clear = world.shareMode === "clear" || isMpRules(world.gameMode);
  for (const t of world.tanks) {
    if (!t.alive || t.team === tank.team || (!clear && !canSeeTank(tank, t, world.walls))) continue;
    const role = CONFIG.roles[t.role];
    out.push({ id: t.id, x: t.x, y: t.y, gunRange: role.range });
  }
  if (!clear) {
    for (const contact of beliefFor(world, tank.team).contacts) {
      if (!contact.observed || world.time - contact.seenAt > CONFIG.ai.beliefTtlSec ||
        out.some((foe) => foe.id === contact.enemyId)) continue;
      const role = CONFIG.roles[contact.observed.role];
      out.push({ id: contact.enemyId, x: contact.x, y: contact.y, gunRange: role.range });
    }
  }
  return out;
}

const LATTICE_PAD = CONFIG.tileSize * 3;
const LATTICE_ORIGIN = { x: LATTICE_PAD, y: LATTICE_PAD };

/** Per wall-layout memo of lattice cell stances and swept-body edge tests. */
interface LatticeCache {
  cols: number;
  rows: number;
  /** 0 unknown, 1 free (px/py hold the stance), 2 walled. */
  state: Uint8Array;
  px: Float32Array;
  py: Float32Array;
  /** Per (cell, direction): 0 unknown, 1 clear, 2 blocked. */
  edges: Uint8Array;
}

const latticeCaches = new Map<string, LatticeCache>();

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function latticeSize(): { cols: number; rows: number } {
  const step = CONFIG.ai.pathStep;
  return {
    cols: Math.ceil((CONFIG.canvasWidth - LATTICE_PAD * 2) / step) + 1,
    rows: Math.ceil((CONFIG.canvasHeight - LATTICE_PAD * 2) / step) + 1,
  };
}

function latticeCache(walls: Wall[], clearance: number): LatticeCache {
  const { cols, rows } = latticeSize();
  const key = `${wallsSignature(walls)}|${clearance}|${cols}x${rows}`;
  const hit = latticeCaches.get(key);
  if (hit) return hit;
  if (latticeCaches.size >= 6) latticeCaches.clear();
  const n = cols * rows;
  const made: LatticeCache = {
    cols,
    rows,
    state: new Uint8Array(n),
    px: new Float32Array(n),
    py: new Float32Array(n),
    edges: new Uint8Array(n * 8),
  };
  latticeCaches.set(key, made);
  return made;
}

/**
 * A cell stands for the free point nearest its center. A two-tile corridor
 * is narrower than the lattice pitch, so a center-only test walled it off
 * and the search ran out of cells after a few dozen visits.
 */
function latticeStance(
  lat: LatticeCache,
  walls: Wall[],
  clearance: number,
  cx: number,
  cy: number,
): { x: number; y: number } | null {
  if (cx < 0 || cy < 0 || cx >= lat.cols || cy >= lat.rows) return null;
  const i = cy * lat.cols + cx;
  const state = lat.state[i];
  if (state === 1) return { x: lat.px[i]!, y: lat.py[i]! };
  if (state === 2) return null;
  const step = CONFIG.ai.pathStep;
  const o = LATTICE_ORIGIN;
  const center = clampMap(o.x + cx * step, o.y + cy * step);
  for (const [ox, oy] of CELL_PROBES) {
    const p = clampMap(center.x + ox, center.y + oy);
    if (!circleHitsWall(p.x, p.y, clearance, walls)) {
      lat.state[i] = 1;
      lat.px[i] = p.x;
      lat.py[i] = p.y;
      return p;
    }
  }
  lat.state[i] = 2;
  return null;
}

function latticeEdge(
  lat: LatticeCache,
  walls: Wall[],
  clearance: number,
  cx: number,
  cy: number,
  dir: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  const i = (cy * lat.cols + cx) * 8 + dir;
  const state = lat.edges[i];
  if (state) return state === 1;
  const clear = pathClear(from.x, from.y, to.x, to.y, walls, clearance);
  lat.edges[i] = clear ? 1 : 2;
  return clear;
}

function fillLattice(walls: Wall[], clearance: number): void {
  const lat = latticeCache(walls, clearance);
  for (let cy = 0; cy < lat.rows; cy++) {
    for (let cx = 0; cx < lat.cols; cx++) {
      const from = latticeStance(lat, walls, clearance, cx, cy);
      if (!from) continue;
      for (let di = 0; di < DIRS.length; di++) {
        const [dx, dy] = DIRS[di]!;
        const to = latticeStance(lat, walls, clearance, cx + dx, cy + dy);
        if (to) latticeEdge(lat, walls, clearance, cx, cy, di, from, to);
      }
    }
  }
}

interface DangerField {
  /** Fine pitch: half a path cell, so lattice cell (cx, cy) is fine cell (2cx, 2cy). */
  step: number;
  cols: number;
  rows: number;
  /** Extra travel-steps for being in each fine cell (terrain + enemies). */
  cost: Float32Array;
  /** 1 where a living enemy has a clear shot inside its reach. */
  seen: Uint8Array;
  /** 1 where any enemy adds cost, seen or not. */
  threat: Uint8Array;
}

function fieldGrid(): { step: number; cols: number; rows: number } {
  const step = CONFIG.ai.pathStep / 2;
  const cols = Math.ceil((CONFIG.canvasWidth - LATTICE_PAD * 2) / step) + 1;
  const rows = Math.ceil((CONFIG.canvasHeight - LATTICE_PAD * 2) / step) + 1;
  return { step, cols, rows };
}

const wallSigs = new WeakMap<Wall[], { print: number; sig: string }>();

/** FNV over the wall rects. Keyed on the array so a static layout hashes once. */
function wallsSignature(walls: Wall[]): string {
  const print = wallsFingerprint(walls);
  const hit = wallSigs.get(walls);
  if (hit && hit.print === print) return hit.sig;
  let h = 2166136261;
  for (const w of walls) {
    for (const v of [w.x, w.y, w.w, w.h, w.kind === "brick" ? 1 : w.kind === "steel" ? 2 : 3]) {
      h ^= v & 0xffff;
      h = Math.imul(h, 16777619);
      h ^= v >>> 16;
      h = Math.imul(h, 16777619);
    }
  }
  const sig = `${walls.length}:${h >>> 0}`;
  wallSigs.set(walls, { print, sig });
  return sig;
}

let openGroundCache: { sig: string; open: Uint8Array } | null = null;

/** Cells with fewer than 2 of 8 short rays hitting a wall. Static per layout. */
function openGround(walls: Wall[], sig: string): Uint8Array {
  if (openGroundCache?.sig === sig) return openGroundCache.open;
  const { step, cols, rows } = fieldGrid();
  const open = new Uint8Array(cols * rows);
  const reach = 40;
  const o = LATTICE_ORIGIN;
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const x = o.x + ix * step;
      const y = o.y + iy * step;
      let cover = 0;
      for (let i = 0; i < 8 && cover < 2; i++) {
        const a = (i / 8) * Math.PI * 2;
        if (segmentHitsWall(x, y, x + Math.cos(a) * reach, y + Math.sin(a) * reach, walls)) {
          cover++;
        }
      }
      if (cover < 2) open[iy * cols + ix] = 1;
    }
  }
  openGroundCache = { sig, open };
  return open;
}

const dangerFields = new Map<string, DangerField>();

/** Build the per-layout tables now so the first match frame does not hitch. */
export function warmRoutePlanner(walls: Wall[]): void {
  usingWallIndex(walls, () => {
    const sig = wallsSignature(walls);
    openGround(walls, sig);
    fillLattice(walls, pathBody(CONFIG.tankRadius));
  });
}

interface FoeStamp {
  ix0: number;
  iy0: number;
  w: number;
  h: number;
  cost: Float32Array;
  seen: Uint8Array;
}

/**
 * One enemy's sightline stamp, keyed on its fine cell so the raycasts are
 * reused until it crosses into the next cell. Cleared when the walls change.
 */
let foeStamps: { sig: string; stamps: Map<string, FoeStamp> } = {
  sig: "",
  stamps: new Map(),
};

function foeCell(foe: RouteFoe, step: number): { x: number; y: number } {
  const o = LATTICE_ORIGIN;
  return {
    x: o.x + Math.round((foe.x - o.x) / step) * step,
    y: o.y + Math.round((foe.y - o.y) / step) * step,
  };
}

function foeStamp(walls: Wall[], sig: string, foe: RouteFoe): FoeStamp {
  const { step, cols, rows } = fieldGrid();
  const c = foeCell(foe, step);
  const key = `${c.x},${c.y},${Math.round(foe.gunRange)}`;
  if (foeStamps.sig !== sig) foeStamps = { sig, stamps: new Map() };
  const hit = foeStamps.stamps.get(key);
  if (hit) return hit;
  const lattice = CONFIG.ai.pathStep;
  const reach = Math.max(CONFIG.ai.dangerRadius, foe.gunRange);
  const o = LATTICE_ORIGIN;
  const ix0 = Math.max(0, Math.floor((c.x - reach - o.x) / step));
  const ix1 = Math.min(cols - 1, Math.ceil((c.x + reach - o.x) / step));
  const iy0 = Math.max(0, Math.floor((c.y - reach - o.y) / step));
  const iy1 = Math.min(rows - 1, Math.ceil((c.y + reach - o.y) / step));
  const w = ix1 - ix0 + 1;
  const h = iy1 - iy0 + 1;
  const cost = new Float32Array(w * h);
  const seen = new Uint8Array(w * h);
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = o.x + ix * step;
      const y = o.y + iy * step;
      const d = dist(x, y, c.x, c.y);
      if (d > reach) continue;
      const cells = Math.max(1, d / lattice);
      const falloff = CONFIG.ai.dangerK / (cells * cells);
      const idx = (iy - iy0) * w + (ix - ix0);
      if (segmentHitsWall(x, y, c.x, c.y, walls)) {
        cost[idx] = falloff * CONFIG.ai.dangerHiddenFrac;
      } else {
        cost[idx] = CONFIG.ai.dangerLosBase + falloff;
        seen[idx] = 1;
      }
    }
  }
  const stamp: FoeStamp = { ix0, iy0, w, h, cost, seen };
  if (foeStamps.stamps.size >= 96) foeStamps.stamps.clear();
  foeStamps.stamps.set(key, stamp);
  return stamp;
}

/**
 * Danger for one tick's enemy layout. Every search that tick reads the same
 * arrays, so a cell costs one lookup instead of a raycast per enemy.
 */
function dangerField(walls: Wall[], foes: RouteFoe[]): DangerField {
  if (!wallIndexCovers(walls)) {
    return usingWallIndex(walls, () => dangerField(walls, foes));
  }
  const sig = wallsSignature(walls);
  const { step, cols, rows } = fieldGrid();
  const key =
    sig +
    "|" +
    foes
      .map((f) => {
        const c = foeCell(f, step);
        return `${c.x},${c.y},${Math.round(f.gunRange)}`;
      })
      .join(";");
  const cached = dangerFields.get(key);
  if (cached) return cached;

  const open = openGround(walls, sig);
  const cost = new Float32Array(cols * rows);
  const seen = new Uint8Array(cols * rows);
  const threat = new Uint8Array(cols * rows);
  for (let i = 0; i < cost.length; i++) {
    if (open[i]) cost[i] = CONFIG.ai.exposureOpenSteps;
  }
  for (const foe of foes) {
    const st = foeStamp(walls, sig, foe);
    for (let y = 0; y < st.h; y++) {
      const row = (st.iy0 + y) * cols + st.ix0;
      const srow = y * st.w;
      for (let x = 0; x < st.w; x++) {
        const c = st.cost[srow + x]!;
        if (c === 0) continue;
        cost[row + x] += c;
        threat[row + x] = 1;
        if (st.seen[srow + x]) seen[row + x] = 1;
      }
    }
  }
  const field: DangerField = { step, cols, rows, cost, seen, threat };
  if (dangerFields.size >= 32) dangerFields.clear();
  dangerFields.set(key, field);
  return field;
}

function fieldIndex(field: DangerField, x: number, y: number): number {
  const o = LATTICE_ORIGIN;
  const ix = Math.min(field.cols - 1, Math.max(0, Math.round((x - o.x) / field.step)));
  const iy = Math.min(field.rows - 1, Math.max(0, Math.round((y - o.y) / field.step)));
  return iy * field.cols + ix;
}

/** Travel plus danger along a straight run, in the search's units. */
function runCost(
  field: DangerField,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { cost: number; seen: number; threat: boolean } {
  const len = dist(ax, ay, bx, by);
  const n = Math.max(1, Math.ceil(len / (field.step / 2)));
  const weight = len / n / CONFIG.ai.pathStep;
  let cost = len / CONFIG.ai.pathStep;
  let seen = 0;
  let threat = false;
  for (let s = 1; s <= n; s++) {
    const t = s / n;
    const idx = fieldIndex(field, ax + (bx - ax) * t, ay + (by - ay) * t);
    cost += field.cost[idx]! * weight;
    seen += field.seen[idx]!;
    if (field.threat[idx]) threat = true;
  }
  return { cost, seen, threat };
}

export interface RouteCommit {
  orderKey: string;
  intentX: number;
  intentY: number;
  points: { x: number; y: number }[];
  /** Travel plus exposure at the moment the polyline was searched. */
  cost: number;
  until: number;
  foes: RouteFoe[];
  /** Set while the hull is stuck: stillFor at the moment this detour was searched. */
  stuckFor?: number;
}

function orderRouteKey(tank: Tank, _tx: number, _ty: number): string {
  const p = tank.goal.params;
  // The target point is not part of the key. Combat steers at the enemy's
  // live position, so a rounded coordinate here changed every frame and
  // forced a fresh search each tick. committedRoute replans once the
  // intent has moved more than a cell, and on the commit timer.
  return [
    tank.goal.kind,
    tank.goal.source ?? "system",
    p?.targetTankId ?? "",
    (p?.targetTankIds ?? []).join(","),
    p?.wreckId ?? "",
    p?.exact ? "1" : "0",
  ].join("|");
}

/** Nearest free tile to the intent. Never a point inside a wall or on a living enemy. */
function reachableGoal(
  gx: number,
  gy: number,
  walls: Wall[],
  foes: RouteFoe[],
  radius: number,
): { x: number; y: number } {
  const body = pathBody(radius);
  // A foe sitting on the destination is the thing we are walking to (an
  // attack target). Treating them as a blocker snapped the end of the path
  // onto the nearest empty pocket ? often the far side of a wall ? and the
  // hull parked there, short of gun range.
  const clearOfEnemy = (x: number, y: number) =>
    foes.every(
      (f) =>
        dist(f.x, f.y, gx, gy) < radius * 2 ||
        dist(x, y, f.x, f.y) >= radius * 2 + 6,
    );
  const free = (x: number, y: number) =>
    !circleHitsWall(x, y, body, walls) && clearOfEnemy(x, y);
  const goal = clampMap(gx, gy);
  if (free(goal.x, goal.y)) return goal;
  for (let ring = 14; ring <= 180; ring += 14) {
    const steps = Math.max(8, Math.round((ring * 2) / 16));
    let best: { x: number; y: number; d: number } | null = null;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const p = clampMap(goal.x + Math.cos(a) * ring, goal.y + Math.sin(a) * ring);
      if (!free(p.x, p.y)) continue;
      const d = dist(p.x, p.y, goal.x, goal.y);
      if (!best || d < best.d) best = { x: p.x, y: p.y, d };
    }
    if (best) return best;
  }
  return goal;
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return dist(px, py, ax, ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return dist(px, py, ax + dx * t, ay + dy * t);
}

/** How close an enemy must be to the remaining polyline before their move forces a replan. */
function pathDangerRadius(foe: RouteFoe): number {
  return Math.max(foe.gunRange, CONFIG.ai.pathStep * 3);
}

function distToRemainingPath(
  px: number,
  py: number,
  tank: Tank,
  points: { x: number; y: number }[],
): number {
  if (points.length === 0) return dist(px, py, tank.x, tank.y);
  let best = Infinity;
  let ax = tank.x;
  let ay = tank.y;
  const start = upcomingIndex(tank, points);
  for (let i = start; i < points.length; i++) {
    const b = points[i]!;
    best = Math.min(best, distToSegment(px, py, ax, ay, b.x, b.y));
    ax = b.x;
    ay = b.y;
  }
  return best;
}

/**
 * An enemy who has actually relocated and now sits inside their gun range of
 * the remaining path. A stationary foe does not retrigger the search.
 */
function enemyMovedNearPath(
  tank: Tank,
  points: { x: number; y: number }[],
  prev: RouteFoe[],
  next: RouteFoe[],
): boolean {
  for (const foe of next) {
    const old = prev.find((f) => f.id === foe.id);
    if (old && dist(old.x, old.y, foe.x, foe.y) < CONFIG.ai.routeRiskMove) continue;
    if (distToRemainingPath(foe.x, foe.y, tank, points) <= pathDangerRadius(foe)) {
      return true;
    }
  }
  return false;
}

/** Same units as the search: cell steps of travel plus exposure along the polyline. */
function routeCost(
  points: { x: number; y: number }[],
  field: DangerField,
): number {
  let cost = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    cost += runCost(field, a.x, a.y, b.x, b.y).cost;
  }
  return cost;
}

function upcomingIndex(
  tank: Tank,
  points: { x: number; y: number }[],
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = dist(tank.x, tank.y, points[i]!.x, points[i]!.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // Step off a vertex we are standing on. Skipping further cuts through walls
  // and makes the route look blocked on every frame.
  if (
    best < points.length - 1 &&
    dist(tank.x, tank.y, points[best]!.x, points[best]!.y) < 8
  ) {
    best++;
  }
  return best;
}

function routeBlocked(
  tank: Tank,
  points: { x: number; y: number }[],
  walls: Wall[],
): boolean {
  if (points.length === 0) return true;
  const i = upcomingIndex(tank, points);
  const next = points[i]!;
  return !pathClear(
    tank.x,
    tank.y,
    next.x,
    next.y,
    walls,
    CONFIG.tankRadius * 0.82,
  );
}

/** Point a short distance ahead of the hull, not back at a vertex already passed. */
function lookaheadPoint(
  tank: Tank,
  points: { x: number; y: number }[],
): { x: number; y: number } {
  if (points.length === 0) return { x: tank.x, y: tank.y };
  let remain = CONFIG.ai.routeLookahead;
  let fromX = tank.x;
  let fromY = tank.y;
  let start = upcomingIndex(tank, points);
  if (start < points.length - 1) {
    const a = points[start]!;
    const b = points[start + 1]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const ab2 = abx * abx + aby * aby;
    const along =
      ab2 > 1 ? ((tank.x - a.x) * abx + (tank.y - a.y) * aby) / ab2 : 1;
    if (along > 0) start++;
  }
  for (let i = start; i < points.length; i++) {
    const p = points[i]!;
    const seg = dist(fromX, fromY, p.x, p.y);
    if (seg >= remain || i === points.length - 1) {
      if (seg < 0.001) return { x: p.x, y: p.y };
      const t = Math.min(1, remain / seg);
      return {
        x: fromX + (p.x - fromX) * t,
        y: fromY + (p.y - fromY) * t,
      };
    }
    remain -= seg;
    fromX = p.x;
    fromY = p.y;
  }
  const last = points[points.length - 1]!;
  return { x: last.x, y: last.y };
}

/**
 * String-pull from the tank: from each anchor, jump to the farthest waypoint
 * the hull can reach in a straight line. A jump is refused when it sees more
 * of an enemy, or costs more danger, than the cells it replaces.
 */
function smoothPolyline(
  points: { x: number; y: number }[],
  walls: Wall[],
  field: DangerField,
  radius: number,
): { x: number; y: number }[] {
  if (points.length <= 2) return points;
  const body = pathBody(radius);
  const costTo = [0];
  const seenTo = [0];
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const run = runCost(field, a.x, a.y, b.x, b.y);
    costTo.push(costTo[k]! + run.cost);
    seenTo.push(seenTo[k]! + run.seen);
  }
  const out: { x: number; y: number }[] = [points[0]!];
  let i = 0;
  while (i < points.length - 1) {
    let best = i + 1;
    for (let j = points.length - 1; j > i + 1; j--) {
      const a = points[i]!;
      const b = points[j]!;
      if (!pathClear(a.x, a.y, b.x, b.y, walls, body)) continue;
      const cut = runCost(field, a.x, a.y, b.x, b.y);
      if (cut.seen > seenTo[j]! - seenTo[i]!) continue;
      // Vertices within half a cell of the chord are lattice quantisation,
      // not a detour. Their open-ground score must not keep the jog.
      let lateral = 0;
      for (let k = i + 1; k < j; k++) {
        const p = points[k]!;
        lateral = Math.max(lateral, distToSegment(p.x, p.y, a.x, a.y, b.x, b.y));
      }
      const quantised = lateral <= CONFIG.ai.pathStep / 2;
      if (!quantised && cut.cost > costTo[j]! - costTo[i]! + 0.25) continue;
      best = j;
      break;
    }
    out.push(points[best]!);
    i = best;
  }
  return out;
}

/**
 * Risk-aware polyline from the tank to a reachable tile.
 * Cost is travel time plus exposure (enemy LOS, gun range, open ground).
 */
export function planRoute(
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  walls: Wall[],
  radius: number,
  foes: RouteFoe[],
  softBlockers: readonly { x: number; y: number }[] = [],
): { x: number; y: number }[] {
  if (!wallIndexCovers(walls)) {
    return usingWallIndex(walls, () => planRoute(sx, sy, gx, gy, walls, radius, foes, softBlockers));
  }
  const goal = reachableGoal(gx, gy, walls, foes, radius);
  const start = { x: sx, y: sy };
  const clearance = pathBody(radius);
  const softCost = (ax: number, ay: number, bx: number, by: number): number =>
    softBlockers.reduce((cost, ally) => {
      // A hull already touching an ally must still be allowed to move away.
      const gap = Math.min(radius * 2 + PATH_BODY_MARGIN, dist(sx, sy, ally.x, ally.y));
      return cost + (distToSegment(ally.x, ally.y, ax, ay, bx, by) < gap - 1e-4 ? 100 : 0);
    }, 0);
  const bodyClear = (ax: number, ay: number, bx: number, by: number) =>
    pathClear(ax, ay, bx, by, walls, clearance) && softCost(ax, ay, bx, by) === 0;
  const directOrStay = (): { x: number; y: number }[] =>
    bodyClear(sx, sy, goal.x, goal.y) ? [start, goal] : softBlockers.length ? [] : [start];
  const field = dangerField(walls, foes);
  // No enemy reaches the straight line: drive it.
  if (
    bodyClear(sx, sy, goal.x, goal.y) &&
    !runCost(field, sx, sy, goal.x, goal.y).threat
  ) {
    return [start, goal];
  }

  const step = CONFIG.ai.pathStep;
  const origin = LATTICE_ORIGIN;
  const minX = origin.x;
  const maxX = CONFIG.canvasWidth - origin.x;
  const minY = origin.y;
  const maxY = CONFIG.canvasHeight - origin.y;
  const toCell = (x: number, y: number) => ({
    cx: Math.round((x - minX) / step),
    cy: Math.round((y - minY) / step),
  });
  const startC = toCell(sx, sy);
  const endC = toCell(goal.x, goal.y);
  const maxC = Math.ceil((maxX - minX) / step);
  const maxR = Math.ceil((maxY - minY) / step);

  const lattice = latticeCache(walls, clearance);
  const resolveCell = (cx: number, cy: number) => latticeStance(lattice, walls, clearance, cx, cy);
  const edgeClear = (cx: number, cy: number, dir: number, from: { x: number; y: number }, to: { x: number; y: number }) =>
    latticeEdge(lattice, walls, clearance, cx, cy, dir, from, to);
  const cellBlocked = (cx: number, cy: number): boolean => {
    if (cx < 0 || cy < 0 || cx > maxC || cy > maxR) return false;
    return resolveCell(cx, cy) === null;
  };

  const end = { ...endC };
  if (!resolveCell(end.cx, end.cy)) {
    let best: { cx: number; cy: number; d: number } | null = null;
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -5; dy <= 5; dy++) {
        const p = resolveCell(end.cx + dx, end.cy + dy);
        if (!p) continue;
        const d = dist(p.x, p.y, goal.x, goal.y);
        if (!best || d < best.d) best = { cx: end.cx + dx, cy: end.cy + dy, d };
      }
    }
    if (!best) return directOrStay();
    end.cx = best.cx;
    end.cy = best.cy;
  }
  const startCell = { ...startC };
  if (softBlockers.length || !resolveCell(startCell.cx, startCell.cy)) {
    let best: { cx: number; cy: number; d: number } | null = null;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const p = resolveCell(startCell.cx + dx, startCell.cy + dy);
        if (!p || (softBlockers.length && !bodyClear(sx, sy, p.x, p.y))) continue;
        const d = dist(p.x, p.y, sx, sy);
        if (!best || d < best.d) best = { cx: startCell.cx + dx, cy: startCell.cy + dy, d };
      }
    }
    if (best) {
      startCell.cx = best.cx;
      startCell.cy = best.cy;
    }
  }

  // Lattice cell (cx, cy) is fine cell (2cx, 2cy); the midpoint of an edge is
  // the fine cell between them, so a step that clips a sightline still pays.
  const fineAt = (fx: number, fy: number): number => {
    const ix = Math.min(field.cols - 1, Math.max(0, fx));
    const iy = Math.min(field.rows - 1, Math.max(0, fy));
    return field.cost[iy * field.cols + ix]!;
  };
  const seenAtCell = (cx: number, cy: number): boolean => {
    const ix = Math.min(field.cols - 1, Math.max(0, cx * 2));
    const iy = Math.min(field.rows - 1, Math.max(0, cy * 2));
    return field.seen[iy * field.cols + ix] === 1;
  };
  const dangerAtCell = (cx: number, cy: number): number => fineAt(cx * 2, cy * 2);

  // Textbook A*: f = g + Manhattan. Diagonal steps cost more than 1, so this
  // heuristic can overestimate; it still aims the open set at the goal.
  const manhattan = (cx: number, cy: number) =>
    Math.abs(cx - end.cx) + Math.abs(cy - end.cy);
  type Node = { cx: number; cy: number; g: number; f: number };
  const q: Node[] = [];
  const higherPriority = (a: Node, b: Node) =>
    a.f < b.f || (a.f === b.f && a.g > b.g);
  const heapPush = (n: Node) => {
    q.push(n);
    let i = q.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!higherPriority(q[i]!, q[parent]!)) break;
      const tmp = q[parent]!;
      q[parent] = q[i]!;
      q[i] = tmp;
      i = parent;
    }
  };
  const heapPop = (): Node => {
    const top = q[0]!;
    const last = q.pop()!;
    if (!q.length) return top;
    q[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      if (l < q.length && higherPriority(q[l]!, q[s]!)) s = l;
      if (r < q.length && higherPriority(q[r]!, q[s]!)) s = r;
      if (s === i) break;
      const tmp = q[s]!;
      q[s] = q[i]!;
      q[i] = tmp;
      i = s;
    }
    return top;
  };
  heapPush({
    cx: startCell.cx,
    cy: startCell.cy,
    g: 0,
    f: manhattan(startCell.cx, startCell.cy),
  });

  const W = lattice.cols;
  const key = (cx: number, cy: number) => cy * W + cx;
  const startKey = key(startCell.cx, startCell.cy);
  const best = new Map<number, number>([[startKey, 0]]);
  const came = new Map<number, number>([[startKey, -1]]);
  const dirs = DIRS;
  let foundKey = -1;
  let visits = 0;
  while (q.length && visits < 5000) {
    const cur = heapPop();
    visits++;
    const ck = key(cur.cx, cur.cy);
    if (cur.g !== best.get(ck)) continue;
    if (cur.cx === end.cx && cur.cy === end.cy) {
      foundKey = ck;
      break;
    }
    const from = resolveCell(cur.cx, cur.cy);
    if (!from) continue;
    for (let di = 0; di < dirs.length; di++) {
      const [dx, dy] = dirs[di]!;
      const nx = cur.cx + dx;
      const ny = cur.cy + dy;
      // A diagonal between two blocked orthogonal neighbors cuts the wall corner.
      if (
        dx !== 0 &&
        dy !== 0 &&
        cellBlocked(cur.cx + dx, cur.cy) &&
        cellBlocked(cur.cx, cur.cy + dy)
      ) {
        continue;
      }
      const to = resolveCell(nx, ny);
      if (!to || !edgeClear(cur.cx, cur.cy, di, from, to)) continue;
      const nk = key(nx, ny);
      const travel = dx !== 0 && dy !== 0 ? 1.414 : 1;
      const danger =
        (fineAt(cur.cx * 2 + dx, cur.cy * 2 + dy) + fineAt(nx * 2, ny * 2)) / 2;
      const ng = cur.g + travel * (1 + danger) + softCost(from.x, from.y, to.x, to.y);
      if (ng >= (best.get(nk) ?? Infinity)) continue;
      best.set(nk, ng);
      came.set(nk, ck);
      heapPush({ cx: nx, cy: ny, g: ng, f: ng + manhattan(nx, ny) });
    }
  }

  if (foundKey < 0 && softBlockers.length) return [];
  if (foundKey < 0) {
    // A partial path must not aim at the goal through a sightline.
    // Prefer an unseen cell; among those, the one with the best travel-plus-exposure score.
    const unseen: number[] = [];
    for (const k of came.keys()) {
      const cx = k % W;
      const cy = (k - cx) / W;
      if (!resolveCell(cx, cy)) continue;
      if (!seenAtCell(cx, cy)) unseen.push(k);
    }
    const pool = unseen.length ? unseen : [...came.keys()];
    let bestKey = -1;
    let bestScore = Infinity;
    for (const k of pool) {
      const cx = k % W;
      const cy = (k - cx) / W;
      const p = resolveCell(cx, cy);
      if (!p) continue;
      const score = dist(p.x, p.y, goal.x, goal.y) / step + dangerAtCell(cx, cy);
      if (score < bestScore) {
        bestScore = score;
        bestKey = k;
      }
    }
    foundKey = bestKey;
  }
  if (foundKey < 0) return directOrStay();

  const raw: { x: number; y: number }[] = [];
  let ck = foundKey;
  while (ck >= 0) {
    const cx = ck % W;
    const cy = (ck - cx) / W;
    const p = resolveCell(cx, cy);
    if (p) raw.push(p);
    ck = came.get(ck) ?? -1;
  }
  raw.reverse();
  if (
    raw.length === 0 ||
    (dist(raw[0]!.x, raw[0]!.y, sx, sy) > 8 &&
      bodyClear(sx, sy, raw[0]!.x, raw[0]!.y))
  ) {
    raw.unshift(start);
  }
  const last = raw[raw.length - 1];
  if (
    last &&
    dist(last.x, last.y, goal.x, goal.y) > 8 &&
    bodyClear(last.x, last.y, goal.x, goal.y)
  ) {
    raw.push(goal);
  }
  if (softBlockers.length) {
    const points = [start, ...raw, goal].filter((p, i, all) =>
      i === 0 || dist(p.x, p.y, all[i - 1]!.x, all[i - 1]!.y) > 1e-4);
    // Keep the costed lattice legs: ordinary smoothing only knows enemy danger.
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      if (!bodyClear(a.x, a.y, b.x, b.y)) return [];
    }
    return points;
  }
  return smoothPolyline(raw, walls, field, radius);
}

/** Polyline a move order should follow. Exported for the headless gap test. */
export function planOrderedRoute(
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  walls: Wall[],
  foes: { id: string; x: number; y: number; gunRange: number }[],
): { x: number; y: number }[] {
  return planRoute(sx, sy, gx, gy, walls, CONFIG.tankRadius, foes);
}

let routePlansThisFrame = 0;

/**
 * The movement the brain currently under way asked the motor for. Cleared with
 * the frame's route budget, so a hull holding station is never read as stalled.
 */
let motionWant: {
  tankId: string;
  key: string;
  intentX: number;
  intentY: number;
  arrived: boolean;
  fightBand: boolean;
} | null = null;

/** Resets the per-frame route search budget. Call once per world step. */
export function beginAiFrame(): void {
  routePlansThisFrame = 0;
  motionWant = null;
}

function committedRoute(
  tank: Tank,
  tx: number,
  ty: number,
  world: WorldState,
  foes: RouteFoe[],
): RouteCommit {
  const orderKey = orderRouteKey(tank, tx, ty);
  const cached = tank.routeCommit;
  const stuckFor = tank.stuckState?.stuck ? tank.stuckState.stillFor : null;
  const blockers = stuckFor == null ? [] : stuckBlockers(world, tank, tank.stuckState!);
  const orderChanged =
    !cached ||
    cached.orderKey !== orderKey ||
    dist(cached.intentX, cached.intentY, tx, ty) > 36;
  const blocked = cached
    ? routeBlocked(tank, cached.points, world.walls)
    : true;
  let stale = false;
  if (cached && !orderChanged && !blocked) {
    const timerExpired = world.time >= cached.until;
    const enemyNear = enemyMovedNearPath(tank, cached.points, cached.foes, foes);
    const costUp =
      !timerExpired &&
      !enemyNear &&
      routeCost(cached.points, dangerField(world.walls, foes)) > cached.cost * 1.25;
    stale = timerExpired || enemyNear || costUp;
  }
  if (cached && !orderChanged && !blocked && !stale) return cached;
  // A stuck hull is owed a search of its own: the budget is what let the freeze
  // outlast the frame in the first place.
  if (
    cached &&
    !orderChanged &&
    !blocked &&
    stuckFor == null &&
    routePlansThisFrame >= CONFIG.ai.routePlansPerFrame
  ) {
    return cached;
  }
  routePlansThisFrame++;

  let points = planRoute(tank.x, tank.y, tx, ty, world.walls, CONFIG.tankRadius, foes, blockers);
  if (blockers.length && points.length < 2) {
    // No way around the allies: keep the ordinary polyline rather than none.
    points = planRoute(tank.x, tank.y, tx, ty, world.walls, CONFIG.tankRadius, foes);
  }
  const commit: RouteCommit = {
    orderKey,
    intentX: tx,
    intentY: ty,
    points,
    cost: routeCost(points, dangerField(world.walls, foes)),
    until: world.time + CONFIG.ai.routeCommitSec + (tank.number % 6) * 0.05,
    foes: foes.map((f) => ({ ...f })),
    ...(stuckFor != null ? { stuckFor } : {}),
  };
  tank.routeCommit = commit;
  return commit;
}

function steerFoes(
  world: WorldState,
  tank: Tank,
  avoid: { x: number; y: number }[] | undefined,
): RouteFoe[] {
  const living = routeFoes(world, tank);
  if (!avoid) return living;
  return living.filter((f) => avoid.some((a) => dist(a.x, a.y, f.x, f.y) < 28));
}

function steerTo(
  tank: Tank,
  tx: number,
  ty: number,
  speed: number,
  dt: number,
  world: WorldState,
  opts: { separate?: boolean; avoid?: { x: number; y: number }[] } = {},
): { moveX: number; moveY: number; aimAngle: number } {
  const foes = steerFoes(world, tank, opts.avoid);
  const route = committedRoute(tank, tx, ty, world, foes);
  const waypoint = isMpRules(world.gameMode)
    ? pullToClear(
        tank.x,
        tank.y,
        route.points,
        upcomingIndex(tank, route.points),
        world.walls,
      )
    : lookaheadPoint(tank, route.points);
  const dest = route.points[route.points.length - 1] ?? { x: tx, y: ty };
  const ang = angleTo(tank.x, tank.y, waypoint.x, waypoint.y);
  tank.angle = rotateToward(tank.angle, ang, turnRateOf(tank.role) * 1.8 * dt);
  const atIntent = dist(tank.x, tank.y, tx, ty) < 14;
  const pathEndedShort =
    dist(tank.x, tank.y, dest.x, dest.y) < 14 && dist(dest.x, dest.y, tx, ty) > 28;
  if (atIntent) {
    noteMotionWant(tank, route.orderKey, tx, ty, { arrived: true });
    return { moveX: 0, moveY: 0, aimAngle: tank.angle };
  }
  if (pathEndedShort) {
    const seek = angleTo(tank.x, tank.y, tx, ty);
    tank.angle = rotateToward(tank.angle, seek, turnRateOf(tank.role) * 1.8 * dt);
    let moveX = Math.cos(seek) * speed * dt;
    let moveY = Math.sin(seek) * speed * dt;
    if (isMpRules(world.gameMode)) {
      const fitted = fitBodyStep(tank.x, tank.y, moveX, moveY, world.walls);
      moveX = fitted.x;
      moveY = fitted.y;
    }
    noteMotionWant(tank, route.orderKey, tx, ty);
    return { moveX, moveY, aimAngle: seek };
  }

  let vx = Math.cos(ang) * speed;
  let vy = Math.sin(ang) * speed;

  // Soft separation ? capped so it can't cancel seek and cause corner-shiver
  if (opts.separate !== false) {
    const sepR = CONFIG.ai.separationRadius;
    let sx = 0;
    let sy = 0;
    for (const o of world.tanks) {
      if (o.id === tank.id || !o.alive || o.team !== tank.team) continue;
      const dd = dist(tank.x, tank.y, o.x, o.y);
      if (dd < sepR && dd > 0.1) {
        const force = CONFIG.ai.separation * (1 - dd / sepR);
        sx += ((tank.x - o.x) / dd) * force;
        sy += ((tank.y - o.y) / dd) * force;
      }
    }
    const sepMag = Math.hypot(sx, sy);
    const sepCap = speed * 0.45;
    if (sepMag > sepCap && sepMag > 0) {
      sx = (sx / sepMag) * sepCap;
      sy = (sy / sepMag) * sepCap;
    }
    vx += sx;
    vy += sy;
  }

  let moveX = vx * dt;
  let moveY = vy * dt;
  if (isMpRules(world.gameMode)) {
    const fitted = fitBodyStep(tank.x, tank.y, moveX, moveY, world.walls);
    moveX = fitted.x;
    moveY = fitted.y;
  }
  noteMotionWant(tank, route.orderKey, tx, ty);
  return { moveX, moveY, aimAngle: ang };
}

/**
 * Teammates close enough to be what a stalled hull is leaning on. Hulls pass
 * through each other in this prototype, so they are named as soft blockers for
 * the reroute instead of turned into bodies the motor has to stop short of.
 */
function nearbyAllyIds(world: WorldState, tank: Tank): string[] {
  return world.tanks
    .filter((ally) => ally.alive && ally.team === tank.team && ally.id !== tank.id &&
      dist(ally.x, ally.y, tank.x, tank.y) <= CONFIG.ai.stuckAllyProbe)
    .map((ally) => ally.id);
}

function noteMotionWant(
  tank: Tank,
  orderKey: string,
  intentX: number,
  intentY: number,
  opts: { arrived?: boolean; fightBand?: boolean } = {},
): void {
  motionWant = {
    tankId: tank.id,
    key: orderKey,
    intentX,
    intentY,
    arrived: opts.arrived === true,
    fightBand: opts.fightBand === true,
  };
}

/**
 * A hull that wants to move and is not is the failure a player calls dumb.
 * Name it, search again with the allies holding it as soft blockers, and hold
 * honestly when nothing frees it — a freeze must never be a silent moveX = 0.
 */
function noteStuck(world: WorldState, tank: Tank, dt: number, moveX: number, moveY: number): void {
  const want = motionWant?.tankId === tank.id ? motionWant : null;
  const state = detectStuck(tank.stuckState, {
    time: world.time,
    dt,
    movementKey: want?.key ?? null,
    held: false,
    arrived: want?.arrived ?? false,
    shootingInFightBand: want?.fightBand ?? false,
    fittedStep: { x: moveX, y: moveY, blockerAllyIds: want ? nearbyAllyIds(world, tank) : [] },
  });
  tank.stuckState = state;
  const detour = tank.routeCommit?.stuckFor;
  if (!state.stuck || !want) {
    if (detour != null) noteDeviation(world, tank, "stuck", false, "clear, resuming");
    return;
  }
  // The detour we already committed to gets its own window before another
  // search is spent; a reroute needs the same time the freeze needed to prove.
  if (detour != null && state.stillFor < detour + CONFIG.ai.stuckAfterSec) return;
  const gaveUp = state.stillFor >= CONFIG.ai.stuckGiveUpSec;
  const detoured = replanStuckRoute(
    world, tank, { x: want.intentX, y: want.intentY }, state, routeFoes(world, tank),
  ) !== null;
  if (gaveUp || !detoured) {
    noteDeviation(world, tank, "stuck", false, "stuck, holding");
    finishOrder(world, tank, "expired", "stuck",
      gaveUp ? "stuck, holding" : "stuck, no route; holding");
    delete tank.stuckState;
    delete tank.routeCommit;
    return;
  }
  const blocker = state.blockerAllyIds[0]?.split("-").pop();
  noteDeviation(world, tank, "stuck", true,
    blocker ? `stuck behind #${blocker}, rerouting` : "stuck, rerouting");
  delete tank.routeCommit;
}

function applyMove(
  tank: Tank,
  moveX: number,
  moveY: number,
  world: WorldState,
  dt: number,
): void {
  const beforeX = tank.x;
  const beforeY = tank.y;
  stepHull(tank, moveX, moveY, world);
  noteStuck(world, tank, dt, tank.x - beforeX, tank.y - beforeY);
}

function stepHull(
  tank: Tank,
  moveX: number,
  moveY: number,
  world: WorldState,
): void {
  if (!moveX && !moveY) {
    delete tank.wallSlide;
    return;
  }
  const radius = CONFIG.tankRadius;
  const want = Math.hypot(moveX, moveY);
  const direct = tryMove(tank.x, tank.y, moveX, moveY, radius, world.walls);
  const gained = Math.hypot(direct.x - tank.x, direct.y - tank.y);
  // A diagonal into a wall used to keep only the tiny free-axis leftover.
  // That leftover flips sign as the heading wobbles, so the hull vibrates.
  if (gained >= want * 0.65) {
    delete tank.wallSlide;
    tank.x = direct.x;
    tank.y = direct.y;
    return;
  }

  const nx = moveX / want;
  const ny = moveY / want;
  // Last free side while a hull is grazing a wall. Stops the slide from flipping.
  const prefer = tank.wallSlide ?? (tank.number % 2 === 0 ? 1 : -1);
  for (const side of [prefer, -prefer]) {
    const alt = tryMove(
      tank.x,
      tank.y,
      -ny * side * want,
      nx * side * want,
      radius,
      world.walls,
    );
    const dx = alt.x - tank.x;
    const dy = alt.y - tank.y;
    const step = Math.hypot(dx, dy);
    if (step < want * 0.65) continue;
    const along = dx * nx + dy * ny;
    if (along < -0.35) continue;
    tank.wallSlide = side;
    tank.x = alt.x;
    tank.y = alt.y;
    return;
  }

  const shorter: [number, number][] = [
    [-ny * prefer * want * 0.7, nx * prefer * want * 0.7],
    [ny * prefer * want * 0.7, -nx * prefer * want * 0.7],
    [moveX * 0.55, moveY * 0.55],
  ];
  for (const [ax, ay] of shorter) {
    const alt = tryMove(tank.x, tank.y, ax, ay, radius, world.walls);
    const dx = alt.x - tank.x;
    const dy = alt.y - tank.y;
    const step = Math.hypot(dx, dy);
    if (step < want * 0.35) continue;
    if (dx * nx + dy * ny < -0.2) continue;
    tank.x = alt.x;
    tank.y = alt.y;
    return;
  }

  delete tank.wallSlide;
  if (gained >= want * 0.25) {
    const along =
      ((direct.x - tank.x) * nx + (direct.y - tank.y) * ny);
    if (along > 0) {
      tank.x = direct.x;
      tank.y = direct.y;
    }
  }
}

function clampMap(x: number, y: number): { x: number; y: number } {
  const pad = CONFIG.tileSize * 3;
  return {
    x: Math.min(CONFIG.canvasWidth - pad, Math.max(pad, x)),
    y: Math.min(CONFIG.canvasHeight - pad, Math.max(pad, y)),
  };
}

function newPatrolPoint(tank: Tank, world: WorldState): { x: number; y: number } {
  const home = homeTerritoryBounds("blue");
  const marker = world.markers.find((m) => m.kind === "enemy");
  const contact = freshestContact(world);
  const baseX =
    contact?.x ??
    marker?.x ??
    CONFIG.canvasWidth * (0.2 + (tank.number % 5) * 0.15);
  const baseY =
    contact?.y ??
    marker?.y ??
    home.y0 - 40 - (tank.number % 4) * 35 - nextRandom(world.random) * 80;
  const jitter = CONFIG.ai.patrolRadius;
  return clampMap(
    baseX + (nextRandom(world.random) - 0.5) * jitter,
    baseY + (nextRandom(world.random) - 0.5) * jitter * 0.7,
  );
}

function newScoutPoint(tank: Tank, world: WorldState): { x: number; y: number } {
  const lane = 0.15 + ((tank.number - 1) % 5) * 0.17;
  return clampMap(
    CONFIG.canvasWidth * lane + (nextRandom(world.random) - 0.5) * 60,
    CONFIG.canvasHeight * (0.22 + nextRandom(world.random) * 0.28),
  );
}

function spreadSlot(tank: Tank): { x: number; y: number } {
  const lane = (tank.number - 0.5) / 6;
  return clampMap(
    CONFIG.canvasWidth * (0.1 + lane * 0.8),
    CONFIG.canvasHeight * (0.55 + (tank.number % 3) * 0.1),
  );
}

/**
 * Combat overlay: hold the hull's own stand-off band and shoot. `push` hulls
 * close into the old fight band; everything else keeps the distance its gun
 * was tuned for, so an artillery hull snipes from its own reach instead of
 * crowding the target like a gunner does.
 */
function combatManeuver(
  world: WorldState,
  tank: Tank,
  enemy: Tank,
  speed: number,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const stats = CONFIG.roles[tank.role];
  const fightRange = stats.range;
  const standoffPx = fightRange * stats.standoff;
  const d = dist(tank.x, tank.y, enemy.x, enemy.y);
  const aimAngle = angleTo(tank.x, tank.y, enemy.x, enemy.y);
  tank.angle = rotateToward(tank.angle, aimAngle, turnRateOf(tank.role) * 2 * dt);

  let moveX = 0;
  let moveY = 0;
  const tooClose =
    stats.doctrine === "push" ? d < CONFIG.ai.kiteRange * 0.75 : d < standoffPx;
  if (tooClose && !tank.goal.noRetreat) {
    // Only back off through the hull's own band ? softer step, no separation tug
    const away = angleTo(enemy.x, enemy.y, tank.x, tank.y);
    const s = steerTo(
      tank,
      tank.x + Math.cos(away) * 55,
      tank.y + Math.sin(away) * 55,
      speed * 0.85,
      dt,
      world,
      { separate: false },
    );
    moveX = s.moveX;
    moveY = s.moveY;
  } else if (d > fightRange) {
    const s = steerTo(tank, enemy.x, enemy.y, speed, dt, world, {
      separate: false,
    });
    moveX = s.moveX;
    moveY = s.moveY;
  } else {
    // In fight band: hold station and shoot ? no lateral orbit dance
    moveX = 0;
    moveY = 0;
    noteMotionWant(tank, orderRouteKey(tank, enemy.x, enemy.y), enemy.x, enemy.y, { fightBand: true });
  }

  return { moveX, moveY, wantShoot: true, aimAngle };
}

/**
 * Soft AI: under fog, system-hold gunners peel toward team-belief contacts.
 * Never steals a player order.
 */
function maybeEngageFromBelief(world: WorldState, tank: Tank): void {
  if (isPlayerOrder(tank)) return;
  if (world.shareMode === "clear") return;
  if (tank.role === "scout") return;
  const g = tank.goal.kind;
  if (g !== "holdPosition" && g !== "patrol" && g !== "idle") return;

  const contact = freshestContact(world);
  if (!contact) return;
  const d = dist(tank.x, tank.y, contact.x, contact.y);
  // A short-leash hull does not give up its post for a rumour down the team net.
  if (d > Math.min(CONFIG.ai.beliefEngageRadius, CONFIG.roles[tank.role].chaseRange)) return;

  setGoal(world, tank, {
    kind: "attackNearest",
    source: "system",
    params: { x: contact.x, y: contact.y },
  });
}

/**
 * Cover-me slot: stand in front of the VIP, on the line between the VIP and
 * the enemies they are aiming at. Never a ring behind the barrel.
 */
function escortCoverSlot(
  world: WorldState,
  tank: Tank,
  vip: Tank,
): { x: number; y: number; faceAngle: number } {
  const guards = world.tanks
    .filter(
      (t) =>
        t.alive &&
        t.team === vip.team &&
        t.id !== vip.id &&
        t.goal.kind === "escort" &&
        t.goal.params?.targetTankId === vip.id,
    )
    .sort((a, b) => a.number - b.number);
  const n = Math.max(1, guards.length);
  let index = guards.findIndex((g) => g.id === tank.id);
  if (index < 0) index = Math.max(0, tank.number - 1) % n;

  // No-fog multiplayer: everyone is on the map. Fog modes only use known contacts.
  const enemies = isMpRules(world.gameMode)
    ? world.tanks.filter((e) => e.alive && e.team !== vip.team)
    : knownEnemyTanks(world, vip);
  const aim = vip.angle;
  const ahead = enemies.filter((e) => {
    const bearing = angleTo(vip.x, vip.y, e.x, e.y);
    return Math.abs(normalizeAngle(bearing - aim)) < (Math.PI * 2) / 3;
  });
  const pool = ahead.length ? ahead : [];
  const threat = pool.length ? nearest(pool, vip.x, vip.y) : null;
  const faceAngle = threat
    ? angleTo(vip.x, vip.y, threat.x, threat.y)
    : aim;

  let radius: number = CONFIG.ai.escortDistance;
  if (threat) {
    const d = dist(vip.x, vip.y, threat.x, threat.y);
    radius = Math.min(110, Math.max(40, d * 0.55));
    if (radius > d - 26) radius = Math.max(28, d * 0.42);
  }

  const spread = Math.min(CONFIG.ai.escortArcSpread, 1.35);
  const t = n === 1 ? 0.5 : index / (n - 1);
  const slotAngle = faceAngle - spread / 2 + t * spread;

  const place = (ang: number, rad: number) =>
    clampMap(
      vip.x + Math.cos(ang) * rad,
      vip.y + Math.sin(ang) * rad,
    );
  let raw = place(slotAngle, radius);
  const intendedBlocked = circleHitsWall(raw.x, raw.y, CONFIG.tankRadius, world.walls);
  const nudges = [0, 0.28, -0.28, 0.55, -0.55];
  const scales = [1, 0.72, 1.2, 0.5];
  let placed = false;
  for (const scale of scales) {
    for (const nudge of nudges) {
      const p = place(slotAngle + nudge, radius * scale);
      if (!circleHitsWall(p.x, p.y, CONFIG.tankRadius, world.walls)) {
        raw = p;
        placed = true;
        break;
      }
    }
    if (placed) break;
  }
  const occupied = world.tanks.some((ally) =>
    ally.alive && ally.team === tank.team && ally.id !== tank.id &&
    dist(ally.x, ally.y, raw.x, raw.y) < CONFIG.tankRadius * 2,
  );
  noteDeviation(world, tank, "escort_slot_blocked", intendedBlocked || occupied,
    "cover slot blocked; adjusting cover position");
  return { x: raw.x, y: raw.y, faceAngle };
}

function orderedPreyIds(tank: Tank): readonly string[] {
  if (tank.goal.kind !== "attackNearest") return [];
  const many = tank.goal.params?.targetTankIds;
  if (many?.length) return many;
  const one = tank.goal.params?.targetTankId;
  return one ? [one] : [];
}

/** Nearest living enemy among the ones this attack order named. */
function nearestOrderedPrey(world: WorldState, tank: Tank): Tank | null {
  const ids = new Set(orderedPreyIds(tank));
  if (!ids.size) return null;
  return nearest(
    world.tanks.filter(
      (t) => t.alive && t.team !== tank.team && ids.has(t.id),
    ),
    tank.x,
    tank.y,
  );
}

/** Clear shots only; an active player attack may shoot only its locked prey. */
function shotTarget(world: WorldState, tank: Tank): Tank | null {
  const range = CONFIG.roles[tank.role].range;
  const attacking = isPlayerOrder(tank) && tank.goal.kind === "attackNearest";
  const prey = attacking ? orderedPrey(world, tank) : null;
  if (attacking && !prey) return null;
  let closest: Tank | null = null;
  let closestD = range;
  for (const e of world.tanks) {
    if (!e.alive || e.team === tank.team) continue;
    if (attacking && e.id !== prey?.id) continue;
    if (!isMpRules(world.gameMode) && world.shareMode !== "clear" &&
      !canSeeTank(tank, e, world.walls)) continue;
    const d = dist(tank.x, tank.y, e.x, e.y);
    if (d > range) continue;
    if (segmentHitsWall(tank.x, tank.y, e.x, e.y, world.walls)) continue;
    if (!closest || d < closestD) {
      closestD = d;
      closest = e;
    }
  }
  return closest;
}

/** Start the caption on a fireable shot, not each frame or cooldown cycle. */
function notePathShot(world: WorldState, tank: Tank, wantShoot: boolean, moving: boolean): void {
  const stack = stackFor(tank);
  const offOrder = tank.goal.kind !== "attackNearest" && tank.goal.kind !== "attackBase";
  const stats = CONFIG.roles[tank.role];
  // Match the AI fire gate in game.ts tryShoot: the hull shoots what its own
  // gun can reach, so the caption must not promise a shot it cannot take.
  const canFire = stats.canShoot && world.tanks.some((enemy) =>
    enemy.alive && enemy.team !== tank.team &&
    dist(tank.x, tank.y, enemy.x, enemy.y) < stats.range,
  );
  const shooting = offOrder && wantShoot && canFire;
  const active =
    shooting &&
    ((tank.cooldown <= 0 && !hasRoundInAir(world.projectiles, tank.id)) ||
      stack.deviations.includes("los_shot_on_path"));
  noteDeviation(world, tank, "los_shot_on_path", active,
    moving ? "taking a clear shot on the way" : "holding; taking a defensive shot");
}

/** Red AI sticky focus so nearest-of-many blues doesn?t flip every tick. */
function stickyFocus(
  tank: Tank,
  now: number,
  candidates: Tank[],
  x: number,
  y: number,
  stickSec: number,
): Tank | null {
  const cur = tank.redFocus;
  if (cur && now < cur.until) {
    const still = candidates.find((c) => c.id === cur.id && c.alive);
    if (still) return still;
  }
  const n = nearest(candidates, x, y);
  if (n) tank.redFocus = { id: n.id, until: now + stickSec };
  else delete tank.redFocus;
  return n;
}

/**
 * Multiplayer bot AI (offline and online):
 * - Hold the current spot until a player order says otherwise
 * - Shoot without diverting orders; retreat interrupts temporarily use the retreat motor
 */
function mpOfflineFriendlyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  updateInterruptStack(world, tank);
  const stats = CONFIG.roles[tank.role];
  const speed = driveSpeedOf(tank, world.time);
  const liveEnemies = liveVisibleEnemies(world, tank);
  const nearestLive = nearest(liveEnemies, tank.x, tank.y);

  // Never invent patrol/scout/idle wander ? force system soft goals back to hold.
  if (
    !isPlayerOrder(tank) &&
    (tank.goal.kind === "patrol" ||
      tank.goal.kind === "scout" ||
      tank.goal.kind === "idle" ||
      tank.goal.kind === "attackNearest" ||
      tank.goal.kind === "debug")
  ) {
    setGoal(world, tank, {
      kind: "holdPosition",
      source: "system",
      params: { x: tank.x, y: tank.y },
    });
  }

  let wantShoot = false;
  let aimAngle = tank.angle;
  let moveX = 0;
  let moveY = 0;
  // True while a move/hold is still driving. A shot must not yaw the hull off that path.
  let drivingPath = false;

  const activeGoal = tank.goal.kind;

  if (activeGoal === "holdPosition" || activeGoal === "moveTo") {
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    const exact = tank.goal.params?.exact === true;
    const radius = arriveRadius(tank);
    if (dist(tank.x, tank.y, tx, ty) > radius) {
      const route = committedRoute(tank, tx, ty, world, routeFoes(world, tank));
      const drive = driveOrder({
        tank,
        orderKey: route.orderKey,
        points: route.points,
        x: tank.x,
        y: tank.y,
        angle: tank.angle,
        speed,
        dt,
        arriveRadius: radius,
        goalX: tx,
        goalY: ty,
        walls: world.walls,
      });
      noteMotionWant(tank, route.orderKey, tx, ty, { arrived: drive.arrived });
      if (drive.arrived && activeGoal === "moveTo") {
        setGoal(world, tank, {
          ...tank.goal,
          kind: "holdPosition",
          params: { x: tx, y: ty, exact },
          source: tank.goal.source ?? "system",
        }, "success");
      } else if (!drive.arrived) {
        drivingPath = true;
        moveX = drive.moveX;
        moveY = drive.moveY;
        tank.angle = drive.angle;
        aimAngle = drive.aimAngle;
      }
    } else if (activeGoal === "moveTo") {
      setGoal(world, tank, {
        ...tank.goal,
        kind: "holdPosition",
        params: { x: tx, y: ty, exact },
        source: tank.goal.source ?? "system",
      }, "success");
    }
  } else if (activeGoal === "spreadOut") {
    const slot = spreadSlot(tank);
    const tx = tank.goal.params?.x ?? slot.x;
    const ty = tank.goal.params?.y ?? slot.y;
    if (tank.goal.params?.x == null || tank.goal.params?.y == null) {
      setGoal(world, tank, { ...tank.goal, params: { ...tank.goal.params, x: tx, y: ty } });
    }
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      setGoal(world, tank, {
        ...tank.goal,
        kind: "holdPosition",
        params: { x: tx, y: ty },
        source: tank.goal.source ?? "system",
      }, "success");
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, {
        separate: true,
        avoid: livingFoes(world, tank),
      });
      moveX = s.moveX;
      moveY = s.moveY;
      if (!nearestLive) aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "escort") {
    const tid = tank.goal.params?.targetTankId;
    const buddy = world.tanks.find((t) => t.id === tid && t.alive);
    if (buddy && buddy.id !== tank.id) {
      const slot = escortCoverSlot(world, tank, buddy);
      const dSlot = dist(tank.x, tank.y, slot.x, slot.y);
      const dBuddy = dist(tank.x, tank.y, buddy.x, buddy.y);
      if (dSlot > CONFIG.ai.escortSlotRadius) {
        const sprint =
          dBuddy > CONFIG.ai.escortCatchup
            ? 1.25
            : dSlot > CONFIG.ai.escortDistance
              ? 1.1
              : 1;
        const s = steerTo(tank, slot.x, slot.y, speed * sprint, dt, world, {
          separate: false,
          avoid: livingFoes(world, tank),
        });
        moveX = s.moveX;
        moveY = s.moveY;
      }
      if (!nearestLive) aimAngle = slot.faceAngle;
    } else {
      setGoal(world, tank, {
        ...tank.goal,
        kind: "holdPosition",
        params: { x: tank.x, y: tank.y },
      }, "expired", "escort_lost", "escort lost; holding");
    }
  } else if (activeGoal === "attackBase") {
    const base = world.bases?.[tank.team === "blue" ? "red" : "blue"];
    const baseReach = baseReachOf(tank.role);
    if (!base?.alive) {
      setGoal(world, tank, { ...tank.goal, kind: "holdPosition", params: { x: tank.x, y: tank.y } },
        "success", "order_complete", "base down, holding");
    } else if (baseShotClear(tank, base, world.walls, baseReach)) {
      wantShoot = true;
      aimAngle = angleTo(tank.x, tank.y, base.x + base.w / 2, base.y + base.h / 2);
      tank.angle = rotateToward(tank.angle, aimAngle, turnRateOf(tank.role) * 2.6 * dt);
    } else {
      const cached = tank.routeCommit;
      let stance = cached?.orderKey.startsWith("attackBase|")
        ? { x: cached.intentX, y: cached.intentY } : null;
      if (!stance || !baseShotClear(stance, base, world.walls, baseReach)) {
        let best = Infinity;
        const step = CONFIG.tileSize;
        const cx = base.x + base.w / 2;
        const cy = base.y + base.h / 2;
        for (let y = cy - 192; y <= cy + 192; y += step) {
          for (let x = cx - 192; x <= cx + 192; x += step) {
            if (x < 24 || y < 24 || x > CONFIG.canvasWidth - 24 || y > CONFIG.canvasHeight - 24) continue;
            const d = dist(tank.x, tank.y, x, y);
            if (d >= best || circleHitsWall(x, y, CONFIG.tankRadius + 2, world.walls)) continue;
            if (!baseShotClear({ x, y }, base, world.walls, baseReach - 12)) continue;
            stance = { x, y };
            best = d;
          }
        }
      }
      if (stance) {
        const route = committedRoute(tank, stance.x, stance.y, world, routeFoes(world, tank));
        const drive = driveOrder({
          tank, orderKey: route.orderKey, points: route.points,
          x: tank.x, y: tank.y, angle: tank.angle, speed, dt,
          arriveRadius: 1, goalX: stance.x, goalY: stance.y, walls: world.walls,
        });
        noteMotionWant(tank, route.orderKey, stance.x, stance.y, { arrived: drive.arrived });
        drivingPath = !drive.arrived;
        moveX = drive.moveX;
        moveY = drive.moveY;
        tank.angle = drive.angle;
        aimAngle = drive.aimAngle;
      }
    }
  } else if (activeGoal === "attackNearest" && isPlayerOrder(tank)) {
    // Player-ordered attack: close distance even without LOS; shoot when hittable.
    const hunt = orderedPrey(world, tank);
    if (hunt) {
      const seesHunt = canSeeTank(tank, hunt, world.walls);
      const dHunt = dist(tank.x, tank.y, hunt.x, hunt.y);
      // Stop and shoot only when the shot line is actually clear.
      // A short Euclidean distance through a wall is not "in range".
      if (seesHunt && dHunt <= stats.range) {
        const fight = combatManeuver(world, tank, hunt, speed, dt);
        moveX = fight.moveX;
        moveY = fight.moveY;
        wantShoot = true;
        aimAngle = fight.aimAngle;
      } else {
        // Follow the committed polyline the same way a move order does.
        // Seeking a lookahead waypoint used to park the hull at the last
        // lattice point ? often a pocket short of gun range, with a wall
        // between the tank and the named enemy.
        const route = committedRoute(
          tank,
          hunt.x,
          hunt.y,
          world,
          routeFoes(world, tank),
        );
        const drive = driveOrder({
          tank,
          orderKey: route.orderKey,
          points: route.points,
          x: tank.x,
          y: tank.y,
          angle: tank.angle,
          speed,
          dt,
          arriveRadius: seesHunt ? 14 : 1,
          goalX: hunt.x,
          goalY: hunt.y,
          walls: world.walls,
        });
        noteMotionWant(tank, route.orderKey, hunt.x, hunt.y, { arrived: drive.arrived });
        if (!drive.arrived) {
          drivingPath = true;
          moveX = drive.moveX;
          moveY = drive.moveY;
          tank.angle = drive.angle;
        }
        aimAngle = seesHunt
          ? angleTo(tank.x, tank.y, hunt.x, hunt.y)
          : drive.aimAngle;
        if (seesHunt) wantShoot = true;
      }
    }
  } else if (activeGoal === "retreat") {
    const home = homeTerritoryBounds(tank.team);
    const homeX = CONFIG.canvasWidth * (0.15 + (tank.number % 5) * 0.15);
    const homeY = (home.y0 + home.y1) / 2;
    if (dist(tank.x, tank.y, homeX, homeY) < 45) {
      // During an interrupt this is ignored, retaining the suspended base order.
      setGoal(world, tank, {
        ...tank.goal,
        kind: "holdPosition",
        params: { x: homeX, y: homeY },
      }, "success");
    } else {
      const s = steerTo(tank, homeX, homeY, speed * 1.1, dt, world, {
        avoid: livingFoes(world, tank),
      });
      moveX = s.moveX;
      moveY = s.moveY;
      if (!nearestLive) aimAngle = s.aimAngle;
    }
  } else {
    // Unsupported orders expire in place instead of silently becoming another move.
    setGoal(world, tank, {
      ...tank.goal,
      kind: "holdPosition",
      params: { x: tank.x, y: tank.y },
    }, "expired", "order_unsupported", "order unsupported in this mode; holding");
  }

  const shot = tank.goal.kind === "attackBase" ? null : shotTarget(world, tank);
  if (tank.goal.kind !== "attackBase") wantShoot = shot != null;
  if (shot) {
    wantShoot = true;
    aimAngle = angleTo(tank.x, tank.y, shot.x, shot.y);
    // In range with a clear line: fire. A move/hold keeps the hull on the path.
    if (!drivingPath) {
      tank.angle = rotateToward(
        tank.angle,
        aimAngle,
        turnRateOf(tank.role) * 2.6 * dt,
      );
    }
  }

  applyMove(tank, moveX, moveY, world, dt);
  notePathShot(world, tank, wantShoot, moveX !== 0 || moveY !== 0);
  if (tank.goal.kind !== "escort") {
    noteDeviation(world, tank, "escort_slot_blocked", false, "cover slot clear");
  }
  return { moveX, moveY, wantShoot, aimAngle };
}

function friendlyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  updateInterruptStack(world, tank);
  // Online: both teams use hold-until-ordered brains for non-human tanks.
  if (isMpRules(world.gameMode)) {
    return mpOfflineFriendlyBrain(world, tank, dt);
  }

  const speed = driveSpeedOf(tank, world.time);
  const liveEnemies = liveVisibleEnemies(world, tank);
  const known = knownEnemyTanks(world, tank);
  const nearestLive = nearest(liveEnemies, tank.x, tank.y);
  const nearestKnown = nearest(known, tank.x, tank.y);

  let wantShoot = false;
  let aimAngle = tank.angle;
  let moveX = 0;
  let moveY = 0;

  maybeEngageFromBelief(world, tank);

  const goal = tank.goal.kind;
  const softOrdered = ORDERED_MOVE_GOALS.has(goal);

  // Only system AI may divert into combat. Player panic/HP retreat is an interrupt.
  const allowCombat =
    !isPlayerOrder(tank) && !stackFor(tank).interrupt &&
    !COMBAT_LOCKED_GOALS.has(goal) &&
    !(goal === "debug" && tank.standStillTimer > 0.3);
  if (nearestLive && allowCombat) {
    const dEnemy = dist(tank.x, tank.y, nearestLive.x, nearestLive.y);
    const fight = combatManeuver(world, tank, nearestLive, speed, dt);
    const abandonOrder =
      !softOrdered &&
      (dEnemy < Math.min(CONFIG.ai.attackAggro, CONFIG.roles[tank.role].chaseRange) ||
        goal === "attackNearest" ||
        goal === "idle");
    // Preserve close-range system combat when no retreat interrupt is active.
    const closeSystemCombat = softOrdered && dEnemy < CONFIG.ai.orderThreatRadius;
    if (abandonOrder || closeSystemCombat) {
      applyMove(tank, fight.moveX, fight.moveY, world, dt);
      return {
        moveX: fight.moveX,
        moveY: fight.moveY,
        wantShoot: fight.wantShoot,
        aimAngle: fight.aimAngle,
      };
    }
    // Distant contact while under orders: keep moving, still shoot if LOS
    wantShoot = true;
    aimAngle = fight.aimAngle;
  }

  const activeGoal = tank.goal.kind;

  if (activeGoal === "attackNearest") {
    const playerAttack = isPlayerOrder(tank);
    const specific = playerAttack ? orderedPrey(world, tank) : nearestOrderedPrey(world, tank);
    const focus = playerAttack ? specific : specific ?? nearestLive ?? nearestKnown;
    // The ordered prey can be a fog-belief position, not a currently visible tank.
    const seesSpecific = specific && (playerAttack
      ? liveEnemies.some((enemy) => enemy.id === specific.id)
      : canSeeTank(tank, specific, world.walls));
    if (specific && seesSpecific) {
      const fight = combatManeuver(world, tank, specific, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = fight.wantShoot;
      aimAngle = fight.aimAngle;
    } else if (specific) {
      const route = committedRoute(
        tank,
        specific.x,
        specific.y,
        world,
        routeFoes(world, tank),
      );
      const drive = driveOrder({
        tank,
        orderKey: route.orderKey,
        points: route.points,
        x: tank.x,
        y: tank.y,
        angle: tank.angle,
        speed,
        dt,
        arriveRadius: playerAttack ? 1 : 14,
        goalX: specific.x,
        goalY: specific.y,
        walls: world.walls,
      });
      noteMotionWant(tank, route.orderKey, specific.x, specific.y, { arrived: drive.arrived });
      if (!drive.arrived) {
        moveX = drive.moveX;
        moveY = drive.moveY;
        tank.angle = drive.angle;
      }
      aimAngle = drive.aimAngle;
    } else if (!playerAttack && nearestLive) {
      const fight = combatManeuver(world, tank, nearestLive, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = fight.wantShoot;
      aimAngle = fight.aimAngle;
    } else if (focus) {
      // Hunt last team-belief contact under fog
      const s = steerTo(tank, focus.x, focus.y, speed * 0.95, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    } else if (!playerAttack) {
      ensureWaypoint(tank, world);
      const tx = tank.goal.params?.x ?? tank.x;
      const ty = tank.goal.params?.y ?? tank.y;
      if (dist(tank.x, tank.y, tx, ty) < 28) {
        const p = newPatrolPoint(tank, world);
        setGoal(world, tank, {
          ...tank.goal,
          kind: "attackNearest",
          source: tank.goal.source ?? "system",
          params: { ...tank.goal.params, ...p },
        });
      }
      const s = steerTo(
        tank,
        tank.goal.params!.x!,
        tank.goal.params!.y!,
        speed * 0.95,
        dt,
        world,
      );
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "holdPosition" || activeGoal === "moveTo") {
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    const exact = tank.goal.params?.exact === true;
    const radius = arriveRadius(tank);
    if (dist(tank.x, tank.y, tx, ty) > radius) {
      const route = committedRoute(tank, tx, ty, world, routeFoes(world, tank));
      const drive = driveOrder({
        tank,
        orderKey: route.orderKey,
        points: route.points,
        x: tank.x,
        y: tank.y,
        angle: tank.angle,
        speed,
        dt,
        arriveRadius: radius,
        goalX: tx,
        goalY: ty,
      });
      noteMotionWant(tank, route.orderKey, tx, ty, { arrived: drive.arrived });
      if (drive.arrived && activeGoal === "moveTo") {
        setGoal(world, tank, {
          ...tank.goal,
          kind: "holdPosition",
          params: { x: tx, y: ty, exact },
          source: tank.goal.source ?? "system",
        }, "success");
      } else if (!drive.arrived) {
        moveX = drive.moveX;
        moveY = drive.moveY;
        tank.angle = drive.angle;
        if (!wantShoot) aimAngle = drive.aimAngle;
      }
    } else if (activeGoal === "moveTo") {
      setGoal(world, tank, {
        ...tank.goal,
        kind: "holdPosition",
        params: { x: tx, y: ty, exact },
        source: tank.goal.source ?? "system",
      }, "success");
      moveX = 0;
      moveY = 0;
    } else {
      moveX = 0;
      moveY = 0;
    }
  } else if (activeGoal === "scout") {
    ensureScoutWaypoint(tank, world);
    const tx = tank.goal.params!.x!;
    const ty = tank.goal.params!.y!;
    if (dist(tank.x, tank.y, tx, ty) < 28) {
      // Arrived probe point ? report in under report mode, else next probe
      if (world.shareMode === "report" && !isPlayerOrder(tank)) {
        setGoal(world, tank, { kind: "reportIn", source: "system" });
      } else {
        setGoal(world, tank, {
          ...tank.goal,
          kind: "scout",
          source: tank.goal.source ?? "system",
          params: { ...tank.goal.params, ...newScoutPoint(tank, world) },
        });
      }
    }
    const s = steerTo(tank, tx, ty, speed * 0.95, dt, world, {
      separate: true,
    });
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = nearestLive
      ? angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y)
      : s.aimAngle;
    if (nearestLive) wantShoot = true;
  } else if (activeGoal === "patrol" || activeGoal === "idle") {
    if (activeGoal === "idle") {
      setGoal(world, tank, {
        kind: "patrol",
        source: "system",
        params: newPatrolPoint(tank, world),
      });
    }
    ensureWaypoint(tank, world);
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, tx, ty) < 24) {
      setGoal(world, tank, {
        ...tank.goal,
        kind: "patrol",
        source: tank.goal.source ?? "system",
        params: { ...tank.goal.params, ...newPatrolPoint(tank, world) },
      });
    }
    const s = steerTo(
      tank,
      tank.goal.params!.x!,
      tank.goal.params!.y!,
      speed * 0.9,
      dt,
      world,
    );
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = s.aimAngle;
  } else if (activeGoal === "spreadOut") {
    const slot = spreadSlot(tank);
    const tx = tank.goal.params?.x ?? slot.x;
    const ty = tank.goal.params?.y ?? slot.y;
    if (tank.goal.params?.x == null || tank.goal.params?.y == null) {
      setGoal(world, tank, { ...tank.goal, params: { ...tank.goal.params, x: tx, y: ty } });
    }
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      setGoal(world, tank, {
        ...tank.goal,
        kind: "holdPosition",
        params: { x: tx, y: ty },
        source: tank.goal.source ?? "system",
      }, "success");
      moveX = 0;
      moveY = 0;
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "escort") {
    const tid = tank.goal.params?.targetTankId;
    const buddy = world.tanks.find((t) => t.id === tid && t.alive);
    if (buddy && buddy.id !== tank.id) {
      const slot = escortCoverSlot(world, tank, buddy);
      const dSlot = dist(tank.x, tank.y, slot.x, slot.y);
      const dBuddy = dist(tank.x, tank.y, buddy.x, buddy.y);
      const catchup = CONFIG.ai.escortCatchup;
      // On station: hold still (no trail-orbit shiver / pile-up nudge)
      if (dSlot <= CONFIG.ai.escortSlotRadius) {
        moveX = 0;
        moveY = 0;
      } else {
        const sprint =
          dBuddy > catchup ? 1.25 : dSlot > CONFIG.ai.escortDistance ? 1.1 : 1;
        const s = steerTo(tank, slot.x, slot.y, speed * sprint, dt, world, {
          separate: true,
        });
        moveX = s.moveX;
        moveY = s.moveY;
      }
      // Face threat / fire lane, not the VIP's rear
      if (nearestLive) {
        aimAngle = angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y);
        wantShoot = true;
      } else if (nearestKnown) {
        aimAngle = angleTo(tank.x, tank.y, nearestKnown.x, nearestKnown.y);
      } else {
        aimAngle = slot.faceAngle;
      }
      tank.angle = rotateToward(
        tank.angle,
        aimAngle,
        turnRateOf(tank.role) * 2 * dt,
      );
    } else {
      setGoal(world, tank, {
        ...tank.goal,
        kind: "holdPosition",
        params: { x: tank.x, y: tank.y },
      }, "expired", "escort_lost", "escort lost; holding");
    }
  } else if (activeGoal === "retreat") {
    const home = homeTerritoryBounds(tank.team);
    const homeX = CONFIG.canvasWidth * (0.15 + (tank.number % 5) * 0.15);
    const homeY = (home.y0 + home.y1) / 2;
    const s = steerTo(tank, homeX, homeY, speed * 1.1, dt, world);
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = nearestLive
      ? angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y)
      : s.aimAngle;
    if (nearestLive) wantShoot = true;
    if (dist(tank.x, tank.y, homeX, homeY) < 45) {
      if (isPlayerOrder(tank) || stackFor(tank).interrupt) {
        // setGoal ignores interrupt arrival: the suspended base must survive.
        setGoal(world, tank, {
          ...tank.goal,
          kind: "holdPosition",
          params: { x: tank.x, y: tank.y },
        }, "success");
        moveX = 0;
        moveY = 0;
      } else {
        setGoal(world, tank, {
          kind: "patrol",
          source: "system",
          params: newPatrolPoint(tank, world),
        });
      }
    }
  } else if (activeGoal === "reportIn") {
    if (
      !isPlayerOrder(tank) && nearestLive &&
      dist(tank.x, tank.y, nearestLive.x, nearestLive.y) <
        CONFIG.ai.kiteRange + 20
    ) {
      const fight = combatManeuver(world, tank, nearestLive, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = true;
      aimAngle = fight.aimAngle;
    } else {
      moveX = 0;
      moveY = 0;
      if (nearestLive) {
        aimAngle = angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y);
        wantShoot = true;
      }
    }
  } else if (activeGoal === "debug") {
    const wreck = pickDebugWreck(world, tank);
    if (wreck) {
      tank.debugTargetId = wreck.id;
      if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange * 0.7) {
        const s = steerTo(tank, wreck.x, wreck.y, speed, dt, world);
        moveX = s.moveX;
        moveY = s.moveY;
        aimAngle = s.aimAngle;
      }
    } else {
      setGoal(world, tank, isPlayerOrder(tank) ? {
        ...tank.goal,
        kind: "holdPosition",
        params: { x: tank.x, y: tank.y },
      } : {
        kind: "patrol",
        source: "system",
        params: newPatrolPoint(tank, world),
      });
    }
  }

  // Player orders allow defensive fire, never a chase or a different attack target.
  if (stackFor(tank).base.source === "player") {
    const shot = tank.goal.kind === "attackBase" ? null : shotTarget(world, tank);
    wantShoot = shot != null;
    if (shot) {
      aimAngle = angleTo(tank.x, tank.y, shot.x, shot.y);
      if (moveX === 0 && moveY === 0) {
        tank.angle = rotateToward(tank.angle, aimAngle, turnRateOf(tank.role) * 2 * dt);
      }
    }
  }
  applyMove(tank, moveX, moveY, world, dt);
  notePathShot(world, tank, wantShoot, moveX !== 0 || moveY !== 0);
  if (tank.goal.kind !== "escort") {
    noteDeviation(world, tank, "escort_slot_blocked", false, "cover slot clear");
  }
  return { moveX, moveY, wantShoot, aimAngle };
}

function ensureWaypoint(tank: Tank, world: WorldState): void {
  if (tank.goal.params?.x == null || tank.goal.params?.y == null) {
    const p = newPatrolPoint(tank, world);
    setGoal(world, tank, { ...tank.goal, params: { ...tank.goal.params, ...p } });
  }
}

function ensureScoutWaypoint(tank: Tank, world: WorldState): void {
  if (tank.goal.params?.x == null || tank.goal.params?.y == null) {
    setGoal(world, tank, {
      ...tank.goal,
      params: { ...tank.goal.params, ...newScoutPoint(tank, world) },
    });
  }
}

function pickDebugWreck(world: WorldState, tank: Tank): Wreck | null {
  if (tank.goal.params?.wreckId) {
    const specific = world.wrecks.find(
      (w) => w.id === tank.goal.params?.wreckId && !w.debugged,
    );
    if (specific) return specific;
  }
  const marked = world.wrecks.filter((w) => w.marked && !w.debugged);
  const visibleThreat = liveVisibleEnemies(world, tank).some(
    (e) => dist(tank.x, tank.y, e.x, e.y) < 140,
  );
  if (visibleThreat) return null;
  return nearest(marked, tank.x, tank.y);
}

function redTier(world: WorldState) {
  return CONFIG.ai.redDifficulty[world.redDifficulty] ?? CONFIG.ai.redDifficulty.normal;
}

function enemyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const tier = redTier(world);
  const speed = driveSpeedOf(tank, world.time) * tier.speedMul;
  const players = world.tanks.filter(
    (t) => t.team === "blue" && t.alive && canSeeTank(tank, t, world.walls),
  );
  // Sticky focus ? with one red left, nearest-blue flipping caused perpetual spin.
  const focusPlayer = stickyFocus(
    tank,
    world.time,
    players,
    tank.x,
    tank.y,
    1.25,
  );
  const engageMul = tier.engageRangeMul;

  let moveX = 0;
  let moveY = 0;
  let wantShoot = false;
  let aimAngle = tank.angle;

  if (tank.hp / tank.maxHp < CONFIG.ai.retreatHpFraction && focusPlayer) {
    const redHome = homeTerritoryBounds("red");
    const s = steerTo(
      tank,
      CONFIG.canvasWidth * (0.2 + (tank.number % 3) * 0.25),
      (redHome.y0 + redHome.y1) / 2,
      speed * 1.05,
      dt,
      world,
    );
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = angleTo(tank.x, tank.y, focusPlayer.x, focusPlayer.y);
    wantShoot = true;
  } else if (focusPlayer) {
    const fight = combatManeuver(world, tank, focusPlayer, speed, dt);
    // Hard: stick closer; easy: hang back a bit
    const scale = tier.aggroMul;
    moveX = fight.moveX * Math.min(1.15, 0.85 + 0.15 * scale);
    moveY = fight.moveY * Math.min(1.15, 0.85 + 0.15 * scale);
    wantShoot = fight.wantShoot;
    aimAngle = fight.aimAngle;
  } else {
    let huntedWreck = false;
    if (!isMpOffline(world.gameMode)) {
      const playerWrecks = world.wrecks.filter(
        (w) => w.team === "blue" && !w.debugged,
      );
      const wreck = nearest(playerWrecks, tank.x, tank.y);
      if (wreck && dist(tank.x, tank.y, wreck.x, wreck.y) < 280 * engageMul) {
        huntedWreck = true;
        tank.debugTargetId = wreck.id;
        if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange * 0.7) {
          const s = steerTo(tank, wreck.x, wreck.y, speed, dt, world);
          moveX = s.moveX;
          moveY = s.moveY;
          aimAngle = s.aimAngle;
        }
      }
    }
    if (!huntedWreck) {
      const home = homeTerritoryBounds("blue");
      const lane = 0.18 + (tank.number % 5) * 0.16;
      const push = 20 + 40 * tier.aggroMul;
      const targetY =
        home.y0 - push - ((world.time * 8 + tank.number * 40) % 120);
      const s = steerTo(
        tank,
        CONFIG.canvasWidth * lane +
          Math.sin(world.time * 0.4 + tank.number) * 30,
        targetY,
        speed * 0.9,
        dt,
        world,
      );
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  }

  applyMove(tank, moveX, moveY, world, dt);
  return { moveX, moveY, wantShoot, aimAngle };
}
