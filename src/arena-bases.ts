import { segmentHitsWall } from "./arena";
import { AUTHORED_BASES } from "./arena-layouts";
import { LARGE_BASE } from "./arena-large";
import { ARENA_SPECS, BASE_FOOTPRINT, CONFIG, type ArenaId } from "./config";
import type {
  BasePlacement,
  BaseState,
  BaseTile,
  TeamId,
  Vec2,
  Wall,
  WallSide,
} from "./types";

/**
 * What Base War reads off a map. The base tile is the map's own data: an
 * authored layout declares it in arena-layouts.ts, the generated large arena
 * declares its own in arena-large.ts, and a future map generator sets the same
 * field. Everything else here — the mirrored red side, the spawn ranks, the
 * garrison posts, the wall block the base is — is derived from that tile.
 */
export interface BaseWarMapData {
  bases: Record<TeamId, BaseTile>;
  /** Which side of the map the base backs onto; the other three sides are open. */
  wall: Record<TeamId, WallSide>;
  defensiveAnchors: Record<TeamId, BaseTile[]>;
}

const OPPOSITE: Record<WallSide, WallSide> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

function placement(arena: ArenaId): BasePlacement | undefined {
  return arena === "large" ? LARGE_BASE : AUTHORED_BASES[arena];
}

/** Rotating the map 180 degrees about its centre, which is how red mirrors blue. */
function mirrorTile(arena: ArenaId, tile: BaseTile): BaseTile {
  const spec = ARENA_SPECS[arena];
  return {
    tileX: spec.cols - BASE_FOOTPRINT - tile.tileX,
    tileY: spec.rows - BASE_FOOTPRINT - tile.tileY,
  };
}

/** Unit step from the base into its open ground, away from the wall behind it. */
function openFace(wall: WallSide): Vec2 {
  if (wall === "north") return { x: 0, y: 1 };
  if (wall === "south") return { x: 0, y: -1 };
  if (wall === "east") return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

/** A shallow arc of garrison posts, each inside the apron prepareBaseWarWalls cuts. */
function anchorPosts(tile: BaseTile, wall: WallSide): BaseTile[] {
  const face = openFace(wall);
  const across = { x: -face.y, y: face.x };
  // baseCenter adds the footprint centre, so an offset here is measured from it.
  const post = (out: number, lateral: number): BaseTile => ({
    tileX: tile.tileX + face.x * out + across.x * lateral,
    tileY: tile.tileY + face.y * out + across.y * lateral,
  });
  return [post(4, -3), post(4, 3), post(3, 0)];
}

/** Base placement for this map, or undefined when the map has no bases. */
export function baseWarMap(arena: ArenaId): BaseWarMapData | undefined {
  const blue = placement(arena);
  if (!blue) return undefined;
  const redTile = mirrorTile(arena, blue.tile);
  const redWall = OPPOSITE[blue.wall];
  return {
    bases: { blue: blue.tile, red: redTile },
    wall: { blue: blue.wall, red: redWall },
    defensiveAnchors: {
      blue: anchorPosts(blue.tile, blue.wall),
      red: anchorPosts(redTile, redWall),
    },
  };
}

export function baseRect(tile: BaseTile): { x: number; y: number; w: number; h: number } {
  const size = CONFIG.tileSize * BASE_FOOTPRINT;
  return { x: tile.tileX * CONFIG.tileSize, y: tile.tileY * CONFIG.tileSize, w: size, h: size };
}

export function baseCenter(tile: BaseTile): Vec2 {
  const rect = baseRect(tile);
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function defensiveAnchors(arena: ArenaId, team: TeamId): Vec2[] {
  const data = baseWarMap(arena);
  if (!data) return [];
  return data.defensiveAnchors[team].map(baseCenter);
}

export function baseWarSpawnPoints(arena: ArenaId, team: TeamId): Vec2[] {
  const data = baseWarMap(arena);
  if (!data) throw new Error(`Base War has no base data for arena ${arena}.`);
  const center = baseCenter(data.bases[team]);
  const face = openFace(data.wall[team]);
  const across = { x: -face.y, y: face.x };
  return Array.from({ length: 6 }, (_, i) => {
    const out = 88 - Math.floor(i / 3) * 32;
    const lateral = ((i % 3) - 1) * 40;
    return {
      x: center.x + face.x * out + across.x * lateral,
      y: center.y + face.y * out + across.y * lateral,
    };
  });
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
  const data = baseWarMap(arena);
  if (!data) throw new Error(`Base War has no base data for arena ${arena}.`);
  const clearance = (["blue", "red"] as const).map((team) => {
    const rect = baseRect(data.bases[team]);
    const margin = CONFIG.tileSize * BASE_FOOTPRINT;
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
  const data = baseWarMap(arena)!;
  const rects = Object.values(data.bases).map(baseRect);
  const restored = walls.filter((wall) => !rects.some((rect) => overlaps(wall, rect)));
  for (const team of ["blue", "red"] as const) {
    restored.push(baseWall(data.bases[team], team));
  }
  return restored;
}

export function createBaseStates(arena: ArenaId): Record<TeamId, BaseState> | undefined {
  const data = baseWarMap(arena);
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
