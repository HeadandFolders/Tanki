import {
  ARENA_SPECS,
  CONFIG,
  homeTerritoryBounds,
  isBaseWar,
  isMpRules,
  type ArenaId,
  type GameMode,
  type Role,
  type ShareMode,
} from "./config";
import { findClearPoint } from "./arena";
import { goalState } from "./interrupt-stack";
import { generatedApronTiles, loadoutFor, TANK_TYPES } from "./config/balance";
import { LARGE_SPAWN_TILES } from "./arena-large";
import { baseWarSpawnPoints } from "./arena-bases";
import type { Goal, Tank, TeamId, Vec2, Wall } from "./types";

/** Axis-aligned spawn box per team. Large arena spawns in opposite corner bases. */
export function spawnBounds(
  arena: ArenaId,
  team: TeamId,
): { x0: number; y0: number; x1: number; y1: number } {
  const pad = CONFIG.tileSize * 3 + CONFIG.tankRadius;
  if (arena === "generated") {
    const s = CONFIG.tileSize;
    const spec = ARENA_SPECS.generated;
    const a = generatedApronTiles(spec.rows);
    /* Red's box is the point mirror of blue's, same as the map and the base. */
    const t =
      team === "blue"
        ? a
        : {
            x0: spec.cols - 1 - a.x1,
            y0: spec.rows - 1 - a.y1,
            x1: spec.cols - 1 - a.x0,
            y1: spec.rows - 1 - a.y0,
          };
    return {
      x0: t.x0 * s + CONFIG.tankRadius,
      y0: t.y0 * s + CONFIG.tankRadius,
      x1: (t.x1 + 1) * s - CONFIG.tankRadius,
      y1: (t.y1 + 1) * s - CONFIG.tankRadius,
    };
  }
  if (arena === "large") {
    const t = LARGE_SPAWN_TILES[team];
    const s = CONFIG.tileSize;
    return {
      x0: t.x0 * s + CONFIG.tankRadius,
      y0: t.y0 * s + CONFIG.tankRadius,
      x1: (t.x1 + 1) * s - CONFIG.tankRadius,
      y1: (t.y1 + 1) * s - CONFIG.tankRadius,
    };
  }
  const home = homeTerritoryBounds(team);
  return {
    x0: pad,
    y0: Math.max(home.y0 + 20, pad),
    x1: CONFIG.canvasWidth - pad,
    y1: Math.min(home.y1 - 20, CONFIG.canvasHeight - pad),
  };
}

export function createTeams(
  rng: () => number,
  withCarriers = false,
  shareMode: ShareMode = CONFIG.shareModeDefault,
  gameMode: GameMode = CONFIG.gameModeDefault,
  walls: Wall[],
  arena: ArenaId,
): Tank[] {
  const tanks: Tank[] = [];
  const fogged = shareMode !== "clear";

  for (const team of ["blue", "red"] as const) {
    const b = spawnBounds(arena, team);
    tanks.push(
      ...spawnTeam(team, b.x0, b.y0, b.x1, b.y1, rng, walls, fogged, gameMode,
        isBaseWar(gameMode) ? baseWarSpawnPoints(arena, team) : undefined),
    );
  }

  if (withCarriers) {
    pickCarrier(tanks, "blue", rng);
    pickCarrier(tanks, "red", rng);
  }
  return tanks;
}

function defaultBlueGoal(
  role: Role,
  i: number,
  preferX: number,
  fogged: boolean,
  rng: () => number,
  mpRules: boolean,
): Goal {
  const frontY =
    CONFIG.canvasHeight * (1 - CONFIG.homeTerritoryFraction) -
    30 -
    (i % 3) * 24;

  // Multiplayer: hold spawn until voice/text orders; no patrol/scout.
  if (mpRules) {
    return {
      kind: "holdPosition",
      source: "system",
      params: { x: preferX + (rng() - 0.5) * 40, y: frontY },
    };
  }

  if (fogged && role === "scout") {
    return {
      kind: "scout",
      source: "system",
      params: {
        x: preferX + (rng() - 0.5) * 100,
        y: CONFIG.canvasHeight * (0.28 + (i % 2) * 0.1),
      },
    };
  }
  if (fogged && role === "shooter") {
    return {
      kind: "holdPosition",
      source: "system",
      params: { x: preferX + (rng() - 0.5) * 40, y: frontY },
    };
  }
  return {
    kind: "patrol",
    source: "system",
    params: {
      x: preferX + (rng() - 0.5) * 80,
      y:
        CONFIG.canvasHeight * (0.52 + (i % 3) * 0.06) -
        (role === "scout" ? 30 : 0),
    },
  };
}

function spawnTeam(
  team: TeamId,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rng: () => number,
  walls: Wall[],
  fogged: boolean,
  gameMode: GameMode,
  fixedSpawns?: Vec2[],
): Tank[] {
  const mpRules = isMpRules(gameMode);
  // One type per numbered hull, from the mode's loadout in config/balance.ts.
  // The multiplayer company is fixed by number so both teams mirror exactly;
  // the legacy TDM / CTF rosters still deal their hulls out at random.
  const roles: Role[] = [...loadoutFor(gameMode)];
  if (gameMode === "tdm" || gameMode === "ctf") {
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
  }

  const out: Tank[] = [];
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!;
    const stats = TANK_TYPES[role];
    const col = i % 3;
    const row = Math.floor(i / 3);
    const preferX = x0 + ((x1 - x0) * (col + 0.5)) / 3;
    const preferY = y0 + ((y1 - y0) * (row + 0.35)) / 2;
    const pos = fixedSpawns?.[i] ?? findClearPoint(
      preferX,
      preferY,
      CONFIG.tankRadius,
      walls,
      y0,
      y1,
      x0,
      x1,
      rng,
    );
    const angle = team === "blue" ? -Math.PI / 2 : Math.PI / 2;

    const goal: Goal = mpRules
      ? {
          kind: "holdPosition",
          source: "system",
          params: { x: pos.x, y: pos.y },
        }
      : team === "blue"
        ? defaultBlueGoal(role, i, preferX, fogged, rng, false)
        : { kind: "attackNearest", source: "system" };

    out.push({
      id: `${team}-${i + 1}`,
      team,
      number: i + 1,
      role,
      x: pos.x,
      y: pos.y,
      angle,
      turretAngle: angle,
      hp: stats.maxHealth,
      maxHp: stats.maxHealth,
      alive: true,
      cooldown: 0,
      nukeCooldown: stats.nuke?.warmupSec ?? 0,
      ...goalState(goal),
      standStillTimer: 0,
      reportProgress: 0,
      debugProgress: 0,
      debugTargetId: null,
      lastKnownPos: { x: pos.x, y: pos.y },
      spawnPos: { x: pos.x, y: pos.y },
      isCodeCarrier: false,
      lastShotAt: -999,
    });
  }
  return out;
}

function pickCarrier(tanks: Tank[], team: TeamId, rng: () => number): void {
  const teamTanks = tanks.filter((t) => t.team === team);
  const pick = teamTanks[Math.floor(rng() * teamTanks.length)]!;
  pick.isCodeCarrier = true;
}
