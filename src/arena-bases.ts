import { segmentHitsWall } from "./arena";
import { ARENA_SPECS, CONFIG, type ArenaId } from "./config";
import type { BaseState, TeamId, Vec2, Wall } from "./types";

export interface BaseTile {
  tileX: number;
  tileY: number;
}

export interface BaseWarArenaData {
  bases: Record<TeamId, BaseTile>;
  defensiveAnchors: Record<TeamId, BaseTile[]>;
}

function mirrored(
  arena: ArenaId,
  blueBase: BaseTile,
  blueAnchors: BaseTile[],
): BaseWarArenaData {
  const spec = ARENA_SPECS[arena];
  const mirror = (point: BaseTile): BaseTile => ({
    tileX: spec.cols - 3 - point.tileX,
    tileY: spec.rows - 3 - point.tileY,
  });
  return {
    bases: { blue: blueBase, red: mirror(blueBase) },
    defensiveAnchors: {
      blue: blueAnchors,
      red: blueAnchors.map(mirror),
    },
  };
}

export const BASE_WAR_ARENAS: Partial<Record<ArenaId, BaseWarArenaData>> = {
  dense: mirrored("dense", { tileX: 29, tileY: 40 }, [
    { tileX: 26, tileY: 37 },
    { tileX: 34, tileY: 37 },
    { tileX: 29, tileY: 36 },
  ]),
  large: mirrored("large", { tileX: 6, tileY: 82 }, [
    { tileX: 3, tileY: 79 },
    { tileX: 11, tileY: 79 },
    { tileX: 6, tileY: 78 },
  ]),
};

export function baseRect(tile: BaseTile): { x: number; y: number; w: number; h: number } {
  const size = CONFIG.tileSize * 3;
  return { x: tile.tileX * CONFIG.tileSize, y: tile.tileY * CONFIG.tileSize, w: size, h: size };
}

export function baseCenter(tile: BaseTile): Vec2 {
  const rect = baseRect(tile);
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function defensiveAnchors(arena: ArenaId, team: TeamId): Vec2[] {
  const data = BASE_WAR_ARENAS[arena];
  if (!data) return [];
  return data.defensiveAnchors[team].map(baseCenter);
}

export function baseWarSpawnPoints(arena: ArenaId, team: TeamId): Vec2[] {
  const base = baseCenter(BASE_WAR_ARENAS[arena]!.bases[team]);
  const facing = team === "blue" ? -1 : 1;
  return Array.from({ length: 6 }, (_, i) => ({
    x: base.x - facing * ((i % 3) - 1) * 40,
    y: base.y + facing * (88 - Math.floor(i / 3) * 32),
  }));
}

export function baseShotClear(from: Vec2, base: BaseState, walls: Wall[], range: number): boolean {
  if (!base.alive) return false;
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;
  const distance = Math.hypot(dx, dy);
  if (distance > range || distance < 1) return false;
  const edge = Math.min(base.w / 2 / Math.abs(dx), base.h / 2 / Math.abs(dy)) + 1 / distance;
  return !segmentHitsWall(from.x, from.y, cx + dx * edge, cy + dy * edge, walls);
}

function baseWall(tile: BaseTile, team: TeamId): Wall {
  return { ...baseRect(tile), kind: "steel", baseTeam: team };
}

function overlaps(a: Wall | { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function prepareBaseWarWalls(walls: Wall[], arena: ArenaId): Wall[] {
  const data = BASE_WAR_ARENAS[arena];
  if (!data) throw new Error(`Base War has no base data for arena ${arena}.`);
  const clearance = (["blue", "red"] as const).map((team) => {
    const rect = baseRect(data.bases[team]);
    const margin = CONFIG.tileSize * 3;
    return {
      x: rect.x - margin,
      y: rect.y - margin,
      w: rect.w + margin * 2,
      h: rect.h + margin * 2,
    };
  });
  for (const team of ["blue", "red"] as const) {
    for (const point of baseWarSpawnPoints(arena, team)) {
      clearance.push({ x: point.x - 16, y: point.y - 16, w: 32, h: 32 });
    }
  }
  const cleared = walls.filter((wall) =>
    wall.kind === "border" || !clearance.some((rect) => overlaps(wall, rect)),
  );
  for (const team of ["blue", "red"] as const) {
    cleared.push(baseWall(data.bases[team], team));
  }
  return cleared;
}

export function restoreBaseWarWalls(walls: Wall[], arena: ArenaId): Wall[] {
  const data = BASE_WAR_ARENAS[arena]!;
  const rects = Object.values(data.bases).map(baseRect);
  const restored = walls.filter((wall) => !rects.some((rect) => overlaps(wall, rect)));
  for (const team of ["blue", "red"] as const) {
    restored.push(baseWall(data.bases[team], team));
  }
  return restored;
}

export function createBaseStates(arena: ArenaId): Record<TeamId, BaseState> | undefined {
  const data = BASE_WAR_ARENAS[arena];
  if (!data) return undefined;
  const make = (team: TeamId): BaseState => ({
    team,
    ...baseRect(data.bases[team]),
    hp: CONFIG.baseHp,
    maxHp: CONFIG.baseHp,
    alive: true,
    lastHitAt: -999,
    lastDamagedAt: -999,
    lastAlertAt: -999,
    destroyedAt: null,
  });
  return { blue: make("blue"), red: make("red") };
}
