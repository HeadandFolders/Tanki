import { CONFIG } from './config';
import type { Wall } from './types';

const T = CONFIG.tileSize;

function rect(tx: number, ty: number, tw: number, th: number, kind: Wall['kind']): Wall {
  return { x: tx * T, y: ty * T, w: tw * T, h: th * T, kind };
}

/** Fixed Battle City–style arena. Gaps stay wide enough for an 11px-radius hull. */
export function buildWalls(): Wall[] {
  const walls: Wall[] = [
    rect(0, 0, 60, 2, 'border'),
    rect(0, 38, 60, 2, 'border'),
    rect(0, 2, 2, 36, 'border'),
    rect(58, 2, 2, 36, 'border'),

    // North islands — leave a central lane (tiles 28–31).
    rect(8, 4, 10, 2, 'brick'),
    rect(42, 4, 10, 2, 'brick'),
    rect(18, 6, 8, 2, 'brick'),
    rect(34, 6, 8, 2, 'brick'),
    rect(10, 8, 2, 4, 'brick'),
    rect(48, 8, 2, 4, 'brick'),

    // Left / right bunkers. Tiles 2–7 and 52–57 stay open as flank lanes.
    rect(10, 12, 6, 2, 'brick'),
    rect(10, 12, 2, 5, 'brick'),
    rect(44, 12, 6, 2, 'brick'),
    rect(48, 12, 2, 5, 'brick'),

    // Central choke. Open tiles 26–33, plus the flank lanes.
    rect(10, 18, 16, 2, 'brick'),
    rect(34, 18, 16, 2, 'brick'),

    // Mid scatter and flank posts.
    rect(8, 22, 6, 2, 'brick'),
    rect(46, 22, 6, 2, 'brick'),
    rect(22, 24, 2, 5, 'brick'),
    rect(36, 24, 2, 5, 'brick'),
    rect(14, 28, 8, 2, 'brick'),
    rect(38, 28, 8, 2, 'brick'),

    // South approaches sit just north of the home strip so the gold band stays open.
    rect(8, 27, 10, 2, 'brick'),
    rect(42, 27, 10, 2, 'brick'),

    // Steel hardpoints.
    rect(14, 16, 2, 2, 'steel'),
    rect(44, 16, 2, 2, 'steel'),
    rect(28, 14, 2, 2, 'steel'),
    rect(16, 26, 2, 2, 'steel'),
    rect(42, 26, 2, 2, 'steel'),
    rect(24, 29, 2, 2, 'steel'),

    // Eagle nest, opening north, sitting in the home strip.
    rect(27, 33, 1, 4, 'brick'),
    rect(32, 33, 1, 4, 'brick'),
    rect(28, 36, 4, 1, 'brick'),
  ];
  return walls;
}

export function eagleAnchor() {
  return { x: 30 * T, y: 35 * T };
}

export function circleHitsRect(cx: number, cy: number, r: number, w: Wall): boolean {
  const nx = Math.max(w.x, Math.min(cx, w.x + w.w));
  const ny = Math.max(w.y, Math.min(cy, w.y + w.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

export function circleHitsAny(cx: number, cy: number, r: number, walls: Wall[]): boolean {
  for (const w of walls) {
    if (circleHitsRect(cx, cy, r, w)) return true;
  }
  return false;
}

export function segmentHitsRect(x1: number, y1: number, x2: number, y2: number, r: Wall): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (let i = 0; i < 4; i++) {
    const pi = p[i] ?? 0;
    const qi = q[i] ?? 0;
    if (Math.abs(pi) < 1e-8) {
      if (qi < 0) return false;
      continue;
    }
    const t = qi / pi;
    if (pi < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1;
}

export function segmentHitsWalls(x1: number, y1: number, x2: number, y2: number, walls: Wall[]): boolean {
  const minx = Math.min(x1, x2);
  const maxx = Math.max(x1, x2);
  const miny = Math.min(y1, y2);
  const maxy = Math.max(y1, y2);
  for (const w of walls) {
    if (w.x > maxx || w.x + w.w < minx || w.y > maxy || w.y + w.h < miny) continue;
    if (segmentHitsRect(x1, y1, x2, y2, w)) return true;
  }
  return false;
}

export function tryMove(x: number, y: number, dx: number, dy: number, radius: number, walls: Wall[]) {
  const nx = x + dx;
  const ny = y + dy;
  if (!circleHitsAny(nx, ny, radius, walls)) return { x: nx, y: ny };
  if (!circleHitsAny(nx, y, radius, walls)) return { x: nx, y };
  if (!circleHitsAny(x, ny, radius, walls)) return { x, y: ny };
  return { x, y };
}

export function unstick(x: number, y: number, radius: number, walls: Wall[]) {
  if (!circleHitsAny(x, y, radius, walls)) return { x, y };
  for (let ring = 2; ring <= 96; ring += 2) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const nx = x + Math.cos(a) * ring;
      const ny = y + Math.sin(a) * ring;
      if (!circleHitsAny(nx, ny, radius, walls)) return { x: nx, y: ny };
    }
  }
  return { x, y };
}

/** Snap a simulation angle to the 4 draw facings. 0 = east, −π/2 = north. */
export function cardinalAngle(angle: number): number {
  const dirs = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  let best = dirs[0] ?? 0;
  let bestAbs = Infinity;
  for (const d of dirs) {
    const diff = Math.atan2(Math.sin(angle - d), Math.cos(angle - d));
    const ad = Math.abs(diff);
    if (ad < bestAbs) {
      bestAbs = ad;
      best = d;
    }
  }
  return best;
}

export function rotateToward(current: number, desired: number, maxStep: number): number {
  const delta = Math.atan2(Math.sin(desired - current), Math.cos(desired - current));
  if (delta > maxStep) return current + maxStep;
  if (delta < -maxStep) return current - maxStep;
  return current + delta;
}

export function angleDelta(current: number, desired: number): number {
  return Math.atan2(Math.sin(desired - current), Math.cos(desired - current));
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
