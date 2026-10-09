import { CONFIG, homeTerritoryBounds, type Role } from "./config";
import { buildArena, findClearPoint } from "./arena";
import type { Tank, TeamId } from "./types";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createTeams(
  seed = Date.now(),
  withCarriers = false,
): Tank[] {
  const rng = mulberry32(seed >>> 0);
  const walls = buildArena();
  const tanks: Tank[] = [];
  const pad = CONFIG.tileSize * 3 + CONFIG.tankRadius;
  const W = CONFIG.canvasWidth;

  const blueHome = homeTerritoryBounds("blue");
  const redHome = homeTerritoryBounds("red");

  tanks.push(
    ...spawnTeam(
      "blue",
      pad,
      Math.max(blueHome.y0 + 20, pad),
      W - pad,
      Math.min(blueHome.y1 - 20, CONFIG.canvasHeight - pad),
      rng,
      walls,
    ),
  );
  tanks.push(
    ...spawnTeam(
      "red",
      pad,
      Math.max(redHome.y0 + 20, pad),
      W - pad,
      Math.min(redHome.y1 - 20, CONFIG.canvasHeight - pad),
      rng,
      walls,
    ),
  );

  if (withCarriers) {
    pickCarrier(tanks, "blue", rng);
    pickCarrier(tanks, "red", rng);
  }
  return tanks;
}

function spawnTeam(
  team: TeamId,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rng: () => number,
  walls: ReturnType<typeof buildArena>,
): Tank[] {
  const roles: Role[] = [
    "scout",
    "scout",
    "shooter",
    "shooter",
    "shooter",
    "shooter",
  ];
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  const frontY =
    team === "blue" ? y0 + (y1 - y0) * 0.35 : y1 - (y1 - y0) * 0.35;

  const out: Tank[] = [];
  for (let i = 0; i < 6; i++) {
    const role = roles[i];
    const stats = CONFIG.roles[role];
    const col = i % 3;
    const row = Math.floor(i / 3);
    const preferX = x0 + ((x1 - x0) * (col + 0.5)) / 3;
    const preferY = y0 + ((y1 - y0) * (row + 0.35)) / 2;
    const pos = findClearPoint(
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

    // Friendlies start mobile (patrol); enemy hunts south.
    const goal =
      team === "blue"
        ? {
            kind: "patrol" as const,
            params: {
              x: preferX,
              y: frontY - (role === "scout" ? 40 : 10),
            },
          }
        : { kind: "attackNearest" as const };

    out.push({
      id: `${team}-${i + 1}`,
      team,
      number: i + 1,
      role,
      x: pos.x,
      y: pos.y,
      angle,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      alive: true,
      cooldown: 0,
      goal,
      standStillTimer: 0,
      reportProgress: 0,
      debugProgress: 0,
      debugTargetId: null,
      lastKnownPos: { x: pos.x, y: pos.y },
      isCodeCarrier: false,
      lastShotAt: -999,
    });
  }
  return out;
}

function pickCarrier(tanks: Tank[], team: TeamId, rng: () => number): void {
  const teamTanks = tanks.filter((t) => t.team === team);
  const pick = teamTanks[Math.floor(rng() * teamTanks.length)];
  pick.isCodeCarrier = true;
}
