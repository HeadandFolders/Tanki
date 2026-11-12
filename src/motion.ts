import { CONFIG } from "./config";
import { turnRateOf } from "./config/balance";
import { angleTo, circleHitsWall, dist, normalizeAngle, segmentHitsWall } from "./arena";
import type { Role } from "./config";
import type { Wall } from "./types";

/**
 * How long the steered point may sit behind the hull before that counts as
 * oscillation rather than a corner. A short beat — not a think delay.
 */
const BEHIND_BEAT_SEC = 0.12;

/**
 * When oscillating, turn off the current travel by at most this much.
 * The forward half of the hull keeps moving, so corner speed stays up.
 */
const OSCILLATION_STEER = Math.PI / 3;

/** Same body margin the path grid uses, so a shortcut cannot spend it. */
const PATH_BODY_MARGIN = 2;

export interface DriveTrack {
  orderKey: string;
  /** Identity of the polyline. A replan must not keep a cursor into the old one. */
  pathStamp: string;
  cursor: number;
  behindFor: number;
  travel: number;
  /** False until the first frame has lined travel up with the path. */
  lined: boolean;
}

function pathStamp(points: { x: number; y: number }[]): string {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const mid = points[points.length >> 1]!;
  return [
    points.length,
    Math.round(a.x),
    Math.round(a.y),
    Math.round(mid.x),
    Math.round(mid.y),
    Math.round(b.x),
    Math.round(b.y),
  ].join(":");
}

export interface MotionAlly {
  id: string;
  x: number;
  y: number;
}

export interface BodyStep {
  x: number;
  y: number;
  blockerAllyIds?: string[];
}

export interface DriveOrder {
  blockerAllyIds?: string[];
  moveX: number;
  moveY: number;
  aimAngle: number;
  angle: number;
  arrived: boolean;
}

/**
 * Drive a committed polyline at full speed the same frame it is followed.
 * The hull faces along the path. A point that stays behind the hull is
 * oscillation: bias the steer instead of reversing.
 */
export function driveOrder(opts: {
  tank: { driveTrack?: DriveTrack; role: Role };
  orderKey: string;
  points: { x: number; y: number }[];
  x: number;
  y: number;
  angle: number;
  speed: number;
  dt: number;
  arriveRadius: number;
  goalX: number;
  goalY: number;
  /** When set, the steer point stays on the cleared polyline instead of cutting a corner. */
  walls?: Wall[];
  allies?: readonly MotionAlly[];
}): DriveOrder {
  const points =
    opts.points.length > 0 ? opts.points : [{ x: opts.goalX, y: opts.goalY }];

  const stamp = pathStamp(points);
  let track = opts.tank.driveTrack;
  if (!track || track.orderKey !== opts.orderKey) {
    track = {
      orderKey: opts.orderKey,
      pathStamp: stamp,
      cursor: 0,
      behindFor: 0,
      travel: opts.angle,
      lined: false,
    };
    opts.tank.driveTrack = track;
  } else if (track.pathStamp !== stamp || track.cursor >= points.length) {
    track.pathStamp = stamp;
    track.cursor = 0;
    track.lined = false;
  }

  const goalD = dist(opts.x, opts.y, opts.goalX, opts.goalY);
  if (goalD <= opts.arriveRadius) {
    track.behindFor = 0;
    return {
      moveX: 0,
      moveY: 0,
      aimAngle: track.travel,
      angle: track.travel,
      arrived: true,
    };
  }

  // First frame of the order: face along the path and go. Spawn facing is not oscillation.
  if (!track.lined) {
    const preview = pullToClear(opts.x, opts.y, points, 0, opts.walls);
    track.travel = angleTo(opts.x, opts.y, preview.x, preview.y);
    track.behindFor = 0;
    track.lined = true;
  }

  track.cursor = advanceCursor(opts.x, opts.y, points, track.cursor, track.travel);
  const carrot = pullToClear(opts.x, opts.y, points, track.cursor, opts.walls);
  const bearing = angleTo(opts.x, opts.y, carrot.x, carrot.y);
  const lastLeg = track.cursor >= points.length - 1;
  const rel = normalizeAngle(bearing - track.travel);
  // The steered point is behind the hull. The final point is the goal — go to it.
  const behind = !lastLeg && Math.cos(rel) < 0;
  if (behind) track.behindFor += opts.dt;
  else track.behindFor = 0;

  let heading = bearing;
  if (behind && track.behindFor > BEHIND_BEAT_SEC) {
    const tx = Math.cos(track.travel);
    const ty = Math.sin(track.travel);
    const cross = tx * (carrot.y - opts.y) - ty * (carrot.x - opts.x);
    const side = cross === 0 ? 1 : Math.sign(cross);
    const turn = Math.min(
      OSCILLATION_STEER,
      turnRateOf(opts.tank.role) * 2.4 * Math.max(opts.dt, 0),
    );
    const biased = normalizeAngle(track.travel + side * Math.max(turn, 0));
    const probe = opts.speed * Math.max(0, opts.dt);
    const fitted = fitBodyStep(
      opts.x,
      opts.y,
      Math.cos(biased) * probe,
      Math.sin(biased) * probe,
      opts.walls,
      opts.allies,
    );
    if (Math.hypot(fitted.x, fitted.y) >= probe * 0.8) heading = biased;
  }

  let step = opts.speed * Math.max(0, opts.dt);
  const room = goalD - opts.arriveRadius + 0.2;
  if (room < step) {
    const approach =
      (Math.cos(heading) * (opts.goalX - opts.x) +
        Math.sin(heading) * (opts.goalY - opts.y)) /
      goalD;
    if (approach > 0.2) step = Math.max(0, room);
  }

  track.travel = heading;
  let fitted = fitBodyStep(
    opts.x,
    opts.y,
    Math.cos(heading) * step,
    Math.sin(heading) * step,
    opts.walls,
    opts.allies,
  );
  // The steer chord is into the margin. Follow the cleared segment instead,
  // so a corner does not stop the hull or press it into the wall.
  if (
    opts.walls &&
    opts.walls.length > 0 &&
    step > 0 &&
    Math.hypot(fitted.x, fitted.y) < step * 0.5
  ) {
    const along = aimAlongSegment(opts.x, opts.y, points, track.cursor);
    const retry = fitBodyStep(
      opts.x,
      opts.y,
      Math.cos(along) * step,
      Math.sin(along) * step,
      opts.walls,
      opts.allies,
    );
    if (Math.hypot(retry.x, retry.y) > Math.hypot(fitted.x, fitted.y)) {
      fitted = retry;
      heading = along;
      track.travel = heading;
    }
  }
  return {
    ...(opts.allies ? { blockerAllyIds: fitted.blockerAllyIds ?? [] } : {}),
    moveX: fitted.x,
    moveY: fitted.y,
    aimAngle: heading,
    angle: heading,
    arrived: false,
  };
}

/**
 * Face the cleared segment. Off the segment, step back onto it before
 * continuing, so a refused corner chord does not freeze the hull.
 */
function aimAlongSegment(
  x: number,
  y: number,
  points: { x: number; y: number }[],
  cursor: number,
): number {
  const i = Math.max(0, Math.min(cursor, points.length - 1));
  const a = points[i]!;
  const b = points[Math.min(points.length - 1, i + 1)]!;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 > 1 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / ab2)) : 0;
  const px = a.x + abx * t;
  const py = a.y + aby * t;
  if (dist(x, y, px, py) > 2) return angleTo(x, y, px, py);
  const ahead = lookahead(x, y, points, i, 28);
  if (dist(x, y, ahead.x, ahead.y) < 1) return angleTo(x, y, b.x, b.y);
  return angleTo(x, y, ahead.x, ahead.y);
}

function segmentDistance(
  x: number,
  y: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): { along: number; gap: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;
  const along = ab2 > 1 ? ((x - a.x) * abx + (y - a.y) * aby) / ab2 : 1;
  const t = Math.max(0, Math.min(1, along));
  return { along, gap: dist(x, y, a.x + abx * t, a.y + aby * t) };
}

function advanceCursor(
  x: number,
  y: number,
  points: { x: number; y: number }[],
  cursor: number,
  travel: number,
): number {
  let i = Math.max(0, Math.min(cursor, points.length - 1));
  // A sideways nudge used to project past the next vertex and skip a segment.
  if (i > 0 && i < points.length - 1) {
    const here = segmentDistance(x, y, points[i]!, points[Math.min(points.length - 1, i + 1)]!);
    let best = i;
    let bestGap = here.gap;
    for (let j = 0; j < i; j++) {
      const earlier = segmentDistance(x, y, points[j]!, points[j + 1]!);
      if (earlier.gap + 6 < bestGap) {
        best = j;
        bestGap = earlier.gap;
      }
    }
    i = best;
  }
  const fx = Math.cos(travel);
  const fy = Math.sin(travel);
  while (i < points.length - 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const { along, gap } = segmentDistance(x, y, a, b);
    const nearEnd = dist(x, y, b.x, b.y) < 10;
    const behindHull = (a.x - x) * fx + (a.y - y) * fy < -6;
    const nextCloser = dist(x, y, b.x, b.y) + 8 < dist(x, y, a.x, a.y);
    // Finish the segment we're actually on. Do not skip it from the side.
    if (along < 0.98 && !nearEnd && !(behindHull && nextCloser && gap < 12)) break;
    i++;
  }
  return i;
}

function chordClear(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  walls: Wall[],
): boolean {
  if (segmentHitsWall(x0, y0, x1, y1, walls)) return false;
  const d = dist(x0, y0, x1, y1);
  const radius = CONFIG.tankRadius + PATH_BODY_MARGIN;
  const steps = Math.max(1, Math.ceil(d / 4));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (circleHitsWall(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, walls)) {
      return false;
    }
  }
  return true;
}

/** Nearest wall surface point to the hull center, and the gap to it (negative = overlap). */
function nearestWall(
  x: number,
  y: number,
  walls: Wall[],
): { gap: number; nx: number; ny: number } {
  let best = { gap: Infinity, nx: x, ny: y };
  const r = CONFIG.tankRadius;
  for (const w of walls) {
    const nx = Math.max(w.x, Math.min(x, w.x + w.w));
    const ny = Math.max(w.y, Math.min(y, w.y + w.h));
    const gap = Math.hypot(x - nx, y - ny) - r;
    if (gap < best.gap) best = { gap, nx, ny };
  }
  return best;
}

/** Gap between the hull and the nearest wall. Negative means the body overlaps. */
function bodyGap(x: number, y: number, walls: Wall[]): number {
  return nearestWall(x, y, walls).gap;
}

function allyStepFraction(x: number, y: number, moveX: number, moveY: number, ally: MotionAlly): number {
  const px = x - ally.x;
  const py = y - ally.y;
  const along = px * moveX + py * moveY;
  if (along >= 0) return 1;
  const gap = px * px + py * py - (CONFIG.tankRadius * 2) ** 2;
  if (gap <= 0) return 0;
  const lengthSq = moveX * moveX + moveY * moveY;
  const discriminant = along * along - lengthSq * gap;
  if (discriminant <= 0) return 1;
  return Math.min(1, Math.max(0, (-along - Math.sqrt(discriminant)) / lengthSq));
}

/**
 * Shorten a step so the hull does not give up the path's body margin.
 * A steer chord that only clips at the end would otherwise slide along the wall.
 */
export function fitBodyStep(
  x: number,
  y: number,
  moveX: number,
  moveY: number,
  walls: Wall[] | undefined,
  allies: readonly MotionAlly[] = [],
): BodyStep {
  if (allies.length) {
    const fitted = fitBodyStep(x, y, moveX, moveY, walls);
    const limits = allies.map((ally) => ({
      id: ally.id, fraction: allyStepFraction(x, y, fitted.x, fitted.y, ally),
    }));
    const fraction = Math.min(1, ...limits.map((limit) => limit.fraction));
    return {
      x: fitted.x * fraction,
      y: fitted.y * fraction,
      blockerAllyIds: [...new Set(limits.filter((limit) => limit.fraction < 1).map((limit) => limit.id))].sort(),
    };
  }
  if (!walls || walls.length === 0 || (moveX === 0 && moveY === 0)) {
    return { x: moveX, y: moveY };
  }
  const near = nearestWall(x, y, walls);
  const need = Math.min(near.gap, PATH_BODY_MARGIN);
  // The whole step, not just the endpoint. Losing a fraction of a pixel every
  // frame would grind the hull into the wall.
  const clearAt = (mx: number, my: number, t: number) => {
    const distStep = Math.hypot(mx * t, my * t);
    const n = Math.max(1, Math.ceil(distStep / 2));
    for (let i = 1; i <= n; i++) {
      const u = (t * i) / n;
      if (bodyGap(x + mx * u, y + my * u, walls) < need - 1e-4) return false;
    }
    return true;
  };
  const fit = (mx: number, my: number): number => {
    if (clearAt(mx, my, 1)) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (clearAt(mx, my, mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const t = fit(moveX, moveY);
  if (t >= 0.5) return { x: moveX * t, y: moveY * t };

  // Already at the margin and the step presses into the wall. Scaling the
  // vector down only ever reaches zero, and the hull sits there for good.
  // Drop the component pointing at the wall and slide along it instead.
  const d = Math.hypot(x - near.nx, y - near.ny);
  if (d > 1e-6) {
    const ux = (x - near.nx) / d;
    const uy = (y - near.ny) / d;
    const into = moveX * ux + moveY * uy;
    if (into < 0) {
      const sx = moveX - into * ux;
      const sy = moveY - into * uy;
      const slideLen = Math.hypot(sx, sy);
      if (slideLen > 1e-3) {
        const ts = fit(sx, sy);
        if (slideLen * ts > Math.hypot(moveX, moveY) * t) {
          return { x: sx * ts, y: sy * ts };
        }
      }
    }
  }
  return { x: moveX * t, y: moveY * t };
}

/**
 * Look ahead along the polyline. If that chord would enter the body margin,
 * stop at the farthest vertex that is still clear — do not cut the corner.
 */
export function pullToClear(
  x: number,
  y: number,
  points: { x: number; y: number }[],
  cursor: number,
  walls: Wall[] | undefined,
): { x: number; y: number } {
  if (points.length === 0) return { x, y };
  const full = lookahead(x, y, points, cursor, CONFIG.ai.routeLookahead);
  if (!walls || walls.length === 0 || chordClear(x, y, full.x, full.y, walls)) return full;

  let best: { x: number; y: number } | null = null;
  let i = Math.max(0, Math.min(cursor, points.length - 1));
  if (i < points.length - 1 && dist(x, y, points[i]!.x, points[i]!.y) < 8) i++;
  for (; i < points.length; i++) {
    const p = points[i]!;
    if (!chordClear(x, y, p.x, p.y, walls)) break;
    best = p;
  }
  if (best) return best;

  const a = points[Math.max(0, Math.min(cursor, points.length - 1))]!;
  const b = points[Math.min(points.length - 1, Math.max(0, cursor) + 1)]!;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 > 1 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / ab2)) : 0;
  return { x: a.x + abx * t, y: a.y + aby * t };
}

function lookahead(
  x: number,
  y: number,
  points: { x: number; y: number }[],
  cursor: number,
  distance: number,
): { x: number; y: number } {
  let remain = distance;
  let fromX = x;
  let fromY = y;
  let start = cursor;
  // Already past this vertex: steer down the next segment, not back to the point.
  if (start < points.length - 1) {
    const a = points[start]!;
    const b = points[start + 1]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const ab2 = abx * abx + aby * aby;
    const along = ab2 > 1 ? ((x - a.x) * abx + (y - a.y) * aby) / ab2 : 1;
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
