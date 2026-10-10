import { CONFIG } from "./config";
import type { Wall, WallKind } from "./types";

const T = () => CONFIG.tileSize;

function rect(
  tx: number,
  ty: number,
  tw: number,
  th: number,
  kind: WallKind,
): Wall {
  const s = T();
  return { x: tx * s, y: ty * s, w: tw * s, h: th * s, kind };
}

export type ArenaDensity = "standard" | "dense";

/**
 * Battle City–style tile arena: stone border, brick chokes, steel hardpoints,
 * eagle nest at southern home. `dense` adds extra walls / choke geometry
 * (Multiplayer · Offline).
 */
export function buildArena(density: ArenaDensity = "standard"): Wall[] {
  const s = T();
  const cols = Math.floor(CONFIG.canvasWidth / s);
  const rows = Math.floor(CONFIG.canvasHeight / s);
  const walls: Wall[] = [];

  // Outer stone border (2 tiles thick)
  walls.push(rect(0, 0, cols, 2, "border"));
  walls.push(rect(0, rows - 2, cols, 2, "border"));
  walls.push(rect(0, 2, 2, rows - 4, "border"));
  walls.push(rect(cols - 2, 2, 2, rows - 4, "border"));

  // Brick maze / chokes (tile coords)
  const bricks: [number, number, number, number][] = [
    // central corridor bricks
    [18, 10, 2, 6],
    [28, 16, 2, 6],
    [22, 14, 4, 2],
    // left bunker
    [6, 8, 6, 2],
    [6, 8, 2, 5],
    // right bunker
    [36, 22, 6, 2],
    [40, 18, 2, 6],
    // north islands
    [20, 5, 6, 2],
    [12, 6, 2, 3],
    // south approaches (above home)
    [16, 28, 8, 2],
    [30, 28, 6, 2],
    // flank lanes
    [4, 16, 5, 2],
    [39, 14, 5, 2],
    [10, 20, 2, 4],
    [36, 10, 2, 4],
    // mid scatter
    [24, 20, 4, 2],
    [14, 12, 3, 2],
    [32, 8, 3, 2],
  ];

  if (density === "dense") {
    bricks.push(
      // extra mid chokes / corridors
      [16, 18, 2, 5],
      [30, 12, 2, 5],
      [24, 10, 2, 3],
      [20, 22, 6, 2],
      [26, 26, 2, 3],
      // tighter flanks
      [8, 14, 2, 4],
      [38, 20, 2, 4],
      [12, 24, 4, 2],
      [34, 6, 4, 2],
      // pocket walls near spawn approaches
      [18, 32, 3, 2],
      [28, 32, 3, 2],
      [22, 6, 2, 2],
      [10, 10, 3, 2],
      [35, 16, 3, 2],
      // right-half fill — match left density with chokes/corridors;
      // leave N/S spawn bands (~rows 2–8 red, ~38–48 blue) with gaps
      [44, 5, 5, 2],
      [50, 5, 2, 4],
      [54, 6, 6, 2],
      [62, 5, 2, 5],
      [66, 6, 5, 2],
      [72, 7, 2, 4],
      [44, 10, 2, 5],
      [48, 12, 4, 2],
      [54, 10, 2, 4],
      [58, 12, 6, 2],
      [66, 10, 2, 5],
      [70, 12, 4, 2],
      [46, 16, 5, 2],
      [52, 16, 2, 5],
      [56, 18, 4, 2],
      [62, 16, 2, 6],
      [66, 18, 5, 2],
      [72, 16, 2, 5],
      [44, 20, 2, 4],
      [48, 22, 6, 2],
      [56, 22, 2, 5],
      [60, 24, 5, 2],
      [68, 22, 2, 5],
      [72, 24, 3, 2],
      [46, 26, 4, 2],
      [50, 28, 2, 4],
      [54, 28, 5, 2],
      [62, 28, 2, 4],
      [66, 30, 6, 2],
      [74, 28, 2, 3],
      [44, 32, 5, 2],
      [52, 32, 2, 3],
      [58, 34, 5, 2],
      [66, 34, 2, 3],
      [70, 34, 4, 2],
    );
  }

  for (const [x, y, w, h] of bricks) {
    walls.push(rect(x, y, w, h, "brick"));
  }

  // Steel hardpoints
  const steel: [number, number, number, number][] = [
    [22, 8, 2, 2],
    [26, 22, 2, 2],
    [8, 24, 2, 2],
    [38, 12, 2, 2],
    [20, 18, 2, 2],
  ];
  if (density === "dense") {
    steel.push(
      [16, 14, 2, 2],
      [32, 20, 2, 2],
      [24, 16, 2, 2],
      [12, 18, 2, 2],
      // right-half hardpoints
      [48, 8, 2, 2],
      [58, 8, 2, 2],
      [70, 10, 2, 2],
      [50, 18, 2, 2],
      [64, 20, 2, 2],
      [74, 18, 2, 2],
      [48, 28, 2, 2],
      [60, 30, 2, 2],
      [70, 28, 2, 2],
    );
  }
  for (const [x, y, w, h] of steel) {
    walls.push(rect(x, y, w, h, "steel"));
  }

  // Eagle nest brick U at bottom center (home)
  const ex = Math.floor(cols / 2) - 3;
  const ey = rows - 7;
  walls.push(rect(ex, ey, 2, 4, "brick"));
  walls.push(rect(ex + 4, ey, 2, 4, "brick"));
  walls.push(rect(ex, ey + 3, 6, 1, "brick"));

  return walls;
}

/** World position of the eagle emblem (visual + landmark). */
export function eaglePosition(): { x: number; y: number } {
  return {
    x: CONFIG.canvasWidth / 2,
    y: CONFIG.canvasHeight - CONFIG.tileSize * 4.5,
  };
}

export function circleHitsWall(
  x: number,
  y: number,
  r: number,
  walls: Wall[],
): boolean {
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
