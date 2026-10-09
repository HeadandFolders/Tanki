import { CONFIG, homeTerritoryBounds, type Role } from "./config";
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

export function createTeams(seed = Date.now()): Tank[] {
  const rng = mulberry32(seed >>> 0);
  const tanks: Tank[] = [];
  const pad = CONFIG.arenaPadding + 36;
  const W = CONFIG.canvasWidth;

  const blueHome = homeTerritoryBounds("blue");
  const redHome = homeTerritoryBounds("red");

  // Friendly company deploys across the southern home strip; enemy across northern.
  tanks.push(
    ...spawnTeam(
      "blue",
      pad,
      blueHome.y0 + 28,
      W - pad,
      blueHome.y1 - 36,
      rng,
    ),
  );
  tanks.push(
    ...spawnTeam(
      "red",
      pad,
      redHome.y0 + 36,
      W - pad,
      redHome.y1 - 28,
      rng,
    ),
  );

  pickCarrier(tanks, "blue", rng);
  pickCarrier(tanks, "red", rng);
  return tanks;
}

function spawnTeam(
  team: TeamId,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rng: () => number,
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

  const out: Tank[] = [];
  for (let i = 0; i < 6; i++) {
    const role = roles[i];
    const stats = CONFIG.roles[role];
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = x0 + ((x1 - x0) * (col + 0.5)) / 3 + (rng() - 0.5) * 12;
    const y = y0 + ((y1 - y0) * (row + 0.5)) / 2 + (rng() - 0.5) * 10;
    const angle = team === "blue" ? -Math.PI / 2 : Math.PI / 2;
    out.push({
      id: `${team}-${i + 1}`,
      team,
      number: i + 1,
      role,
      x,
      y,
      angle,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      alive: true,
      cooldown: 0,
      goal:
        team === "blue"
          ? { kind: "holdPosition", params: { x, y } }
          : { kind: "attackNearest" },
      standStillTimer: 0,
      reportProgress: 0,
      debugProgress: 0,
      debugTargetId: null,
      lastKnownPos: { x, y },
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
