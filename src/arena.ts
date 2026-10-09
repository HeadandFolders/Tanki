import { CONFIG } from "./config";
import type { Wall } from "./types";

/** Small arena with choke points and cover walls. */
export function buildArena(): Wall[] {
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;
  const p = CONFIG.arenaPadding;
  const t = CONFIG.wallThickness;

  const walls: Wall[] = [
    // Outer bounds (inner faces)
    { x: p, y: p, w: W - p * 2, h: t },
    { x: p, y: H - p - t, w: W - p * 2, h: t },
    { x: p, y: p, w: t, h: H - p * 2 },
    { x: W - p - t, y: p, w: t, h: H - p * 2 },

    // Central choke corridor
    { x: W * 0.42, y: H * 0.28, w: t, h: H * 0.18 },
    { x: W * 0.56, y: H * 0.54, w: t, h: H * 0.18 },

    // Side bunkers / cover
    { x: W * 0.22, y: H * 0.22, w: 90, h: t },
    { x: W * 0.22, y: H * 0.22, w: t, h: 70 },
    { x: W * 0.68, y: H * 0.68, w: 90, h: t },
    { x: W * 0.68 + 90 - t, y: H * 0.68 - 55, w: t, h: 55 + t },

    // North/south islands
    { x: W * 0.48, y: H * 0.14, w: 70, h: t },
    { x: W * 0.38, y: H * 0.82, w: 110, h: t },

    // Flank walls creating lanes
    { x: W * 0.14, y: H * 0.48, w: 80, h: t },
    { x: W * 0.78, y: H * 0.42, w: 80, h: t },
  ];

  return walls;
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
  // Liang-Barsky-ish quick reject via crossings
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
  let nx = x + dx;
  let ny = y + dy;
  if (!circleHitsWall(nx, ny, r, walls)) return { x: nx, y: ny };
  if (!circleHitsWall(x + dx, y, r, walls)) return { x: x + dx, y };
  if (!circleHitsWall(x, y + dy, r, walls)) return { x, y: y + dy };
  return { x, y };
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy);
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
