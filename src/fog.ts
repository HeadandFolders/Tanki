import { CONFIG, homeTerritoryBounds } from "./config";
import { segmentHitsWall } from "./arena";
import type { Tank, Wall, WorldState } from "./types";

export function createFogGrid(): {
  explored: Uint8Array;
  cols: number;
  rows: number;
} {
  const cols = Math.ceil(CONFIG.canvasWidth / CONFIG.fog.cellSize);
  const rows = Math.ceil(CONFIG.canvasHeight / CONFIG.fog.cellSize);
  return { explored: new Uint8Array(cols * rows), cols, rows };
}

/** Pre-reveal the player's home strip (bottom band). Enemy home stays fogged. */
export function revealHomeTerritory(world: WorldState): void {
  const { y0, y1 } = homeTerritoryBounds("blue");
  const cell = CONFIG.fog.cellSize;
  const minR = Math.max(0, Math.floor(y0 / cell));
  const maxR = Math.min(world.fogRows - 1, Math.floor((y1 - 1) / cell));
  for (let r = minR; r <= maxR; r++) {
    for (let c = 0; c < world.fogCols; c++) {
      world.fogExplored[r * world.fogCols + c] = 1;
    }
  }
}

export function revealAround(
  world: WorldState,
  x: number,
  y: number,
  radius: number,
  walls: Wall[],
): void {
  const cell = CONFIG.fog.cellSize;
  const minC = Math.max(0, Math.floor((x - radius) / cell));
  const maxC = Math.min(world.fogCols - 1, Math.floor((x + radius) / cell));
  const minR = Math.max(0, Math.floor((y - radius) / cell));
  const maxR = Math.min(world.fogRows - 1, Math.floor((y + radius) / cell));
  const r2 = radius * radius;

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cx = c * cell + cell * 0.5;
      const cy = r * cell + cell * 0.5;
      const dx = cx - x;
      const dy = cy - y;
      if (dx * dx + dy * dy > r2) continue;
      if (segmentHitsWall(x, y, cx, cy, walls)) continue;
      world.fogExplored[r * world.fogCols + c] = 1;
    }
  }
}

export function isExplored(world: WorldState, x: number, y: number): boolean {
  const cell = CONFIG.fog.cellSize;
  const c = Math.floor(x / cell);
  const r = Math.floor(y / cell);
  if (c < 0 || r < 0 || c >= world.fogCols || r >= world.fogRows) return false;
  return world.fogExplored[r * world.fogCols + c] === 1;
}

/** Live vision contributors for map reveal based on share mode. */
export function visionTanksForReveal(
  world: WorldState,
  playerTeam: "blue",
): Tank[] {
  const friendlies = world.tanks.filter((t) => t.team === playerTeam && t.alive);
  const controlled = friendlies.find((t) => t.id === world.controlledId);
  if (world.shareMode === "auto") return friendlies;
  if (world.shareMode === "none") return controlled ? [controlled] : [];
  // report: only controlled lives; others dump on report-in (handled separately)
  return controlled ? [controlled] : [];
}

export function canSeeTank(
  viewer: Tank,
  target: Tank,
  walls: Wall[],
): boolean {
  if (!viewer.alive || !target.alive) return false;
  const radius = CONFIG.roles[viewer.role].visionRadius;
  const d = Math.hypot(viewer.x - target.x, viewer.y - target.y);
  if (d > radius) return false;
  return !segmentHitsWall(viewer.x, viewer.y, target.x, target.y, walls);
}

export function anyTeammateSees(
  world: WorldState,
  team: "blue" | "red",
  target: Tank,
): boolean {
  return world.tanks.some(
    (t) => t.team === team && t.alive && canSeeTank(t, target, world.walls),
  );
}

/** Snapshot fog cells currently visible to a tank (for report-in dump). */
export function captureVisibleCells(
  world: WorldState,
  tank: Tank,
): { c: number; r: number }[] {
  const cell = CONFIG.fog.cellSize;
  const radius = CONFIG.roles[tank.role].visionRadius;
  const minC = Math.max(0, Math.floor((tank.x - radius) / cell));
  const maxC = Math.min(world.fogCols - 1, Math.floor((tank.x + radius) / cell));
  const minR = Math.max(0, Math.floor((tank.y - radius) / cell));
  const maxR = Math.min(world.fogRows - 1, Math.floor((tank.y + radius) / cell));
  const r2 = radius * radius;
  const out: { c: number; r: number }[] = [];
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cx = c * cell + cell * 0.5;
      const cy = r * cell + cell * 0.5;
      const dx = cx - tank.x;
      const dy = cy - tank.y;
      if (dx * dx + dy * dy > r2) continue;
      if (segmentHitsWall(tank.x, tank.y, cx, cy, world.walls)) continue;
      out.push({ c, r });
    }
  }
  return out;
}

export function applyDiscoveryCells(
  world: WorldState,
  cells: { c: number; r: number }[],
): number {
  let n = 0;
  for (const { c, r } of cells) {
    const i = r * world.fogCols + c;
    if (world.fogExplored[i] === 0) {
      world.fogExplored[i] = 1;
      n++;
    }
  }
  return n;
}
