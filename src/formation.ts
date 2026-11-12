/**
 * Formation allocator for intent-only commands. A parser says "surround 6" or
 * "flank the left of 5"; this module decides where each tank stands. Every
 * slot is a free tile, never inside a wall.
 */
import { circleHitsWall, dist } from "./arena";
import { CONFIG } from "./config";
import type { FlankSide } from "./command-schema";
import type { Tank, Vec2, Wall, WorldState } from "./types";

export interface Slot {
  tankId: string;
  x: number;
  y: number;
}

/** The distance a tank can shoot from: the same range the AI fires at. */
export function gunRange(tank: Tank): number {
  return CONFIG.roles[tank.role].range;
}

/** Stand slightly inside gun range so the shot is in reach on arrival. */
const RANGE_FRACTION = 0.85;

/**
 * Surround: tanks evenly spaced around the target at gun range. Two tanks
 * land on opposite sides, square to the line they approach along.
 */
export function surroundSlots(
  world: WorldState,
  tanks: Tank[],
  target: Vec2,
): Slot[] {
  if (!tanks.length) return [];
  const center = centroid(tanks);
  const approach = Math.atan2(center.y - target.y, center.x - target.x);
  const n = tanks.length;
  const angles =
    n === 1
      ? [approach]
      : Array.from({ length: n }, (_, i) => approach + Math.PI / 2 + (i * 2 * Math.PI) / n);
  const radius = Math.min(...tanks.map((t) => gunRange(t))) * RANGE_FRACTION;
  const points = angles.map((a) => ({
    x: target.x + Math.cos(a) * radius,
    y: target.y + Math.sin(a) * radius,
  }));
  return place(world, tanks, assign(tanks, points));
}

/**
 * Flank: 90° off the line from the player to the reference, on the named
 * side, at gun range. Several tanks spread along that line, never across it.
 */
export function flankSlots(
  world: WorldState,
  tanks: Tank[],
  reference: Vec2,
  viewer: Vec2 | null,
  side: FlankSide,
  fallbackHeading: number,
): Slot[] {
  if (!tanks.length) return [];
  const heading =
    viewer && dist(viewer.x, viewer.y, reference.x, reference.y) > 1
      ? Math.atan2(reference.y - viewer.y, reference.x - viewer.x)
      : fallbackHeading;
  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  // y grows downward, so the right of a heading is (-sin, cos).
  const sign = side === "right" ? 1 : -1;
  const nx = -Math.sin(heading) * sign;
  const ny = Math.cos(heading) * sign;
  const radius = Math.min(...tanks.map((t) => gunRange(t))) * RANGE_FRACTION;
  const spacing = CONFIG.ai.formationSpacing;
  const n = tanks.length;
  const points = Array.from({ length: n }, (_, i) => {
    const along = (i - (n - 1) / 2) * spacing;
    return {
      x: reference.x + nx * radius + fx * along,
      y: reference.y + ny * radius + fy * along,
    };
  });
  return place(world, tanks, assign(tanks, points));
}

/** Points spread across a heading around one spot (relative moves). */
export function lineSlots(
  world: WorldState,
  tanks: Tank[],
  center: Vec2,
  heading: number,
): Slot[] {
  const spacing = CONFIG.ai.formationSpacing;
  const n = tanks.length;
  const px = -Math.sin(heading);
  const py = Math.cos(heading);
  const points = Array.from({ length: n }, (_, i) => {
    const along = (i - (n - 1) / 2) * spacing;
    return { x: center.x + px * along, y: center.y + py * along };
  });
  return place(world, tanks, assign(tanks, points));
}

/** Lowest total travel. Six tanks at most, so every ordering is checked. */
function assign(tanks: Tank[], points: Vec2[]): Vec2[] {
  let best: number[] = tanks.map((_, i) => i);
  let bestCost = Infinity;
  const used = new Array<boolean>(points.length).fill(false);
  const order: number[] = [];
  const walk = (i: number, cost: number) => {
    if (cost >= bestCost) return;
    if (i === tanks.length) {
      bestCost = cost;
      best = [...order];
      return;
    }
    const t = tanks[i]!;
    for (let p = 0; p < points.length; p++) {
      if (used[p]) continue;
      used[p] = true;
      order.push(p);
      walk(i + 1, cost + dist(t.x, t.y, points[p]!.x, points[p]!.y));
      order.pop();
      used[p] = false;
    }
  };
  walk(0, 0);
  return best.map((p) => points[p]!);
}

function place(world: WorldState, tanks: Tank[], points: Vec2[]): Slot[] {
  const taken: Vec2[] = [];
  const slots: Slot[] = [];
  tanks.forEach((tank, i) => {
    const p = freePointNear(points[i]!, world.walls, taken);
    taken.push(p);
    slots.push({ tankId: tank.id, x: p.x, y: p.y });
  });
  return slots;
}

/** Nearest tile center a tank fits on, clear of walls and of slots already given. */
export function freePointNear(ideal: Vec2, walls: Wall[], taken: Vec2[] = []): Vec2 {
  const tile = CONFIG.tileSize;
  const pad = CONFIG.arenaPadding + CONFIG.tankRadius;
  const body = CONFIG.tankRadius * 2 + 8;
  const col0 = Math.floor(ideal.x / tile);
  const row0 = Math.floor(ideal.y / tile);
  let best = null as { p: Vec2; d: number } | null;
  for (let ring = 0; ring <= 24; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = { x: (col0 + dx) * tile + tile / 2, y: (row0 + dy) * tile + tile / 2 };
        if (p.x < pad || p.y < pad) continue;
        if (p.x > CONFIG.canvasWidth - pad || p.y > CONFIG.canvasHeight - pad) continue;
        if (circleHitsWall(p.x, p.y, CONFIG.tankRadius, walls)) continue;
        if (taken.some((q) => dist(q.x, q.y, p.x, p.y) < body)) continue;
        const d = dist(p.x, p.y, ideal.x, ideal.y);
        if (!best || d < best.d) best = { p, d };
      }
    }
    // A tile one ring further out can still be closer; stop one ring after a hit.
    if (best && best.d < (ring + 1) * tile) break;
  }
  return best?.p ?? {
    x: Math.min(CONFIG.canvasWidth - pad, Math.max(pad, ideal.x)),
    y: Math.min(CONFIG.canvasHeight - pad, Math.max(pad, ideal.y)),
  };
}

function centroid(tanks: Tank[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const t of tanks) {
    x += t.x;
    y += t.y;
  }
  return { x: x / tanks.length, y: y / tanks.length };
}
