/** All tunable gameplay values live here. */
export const CONFIG = {
  canvasWidth: 960,
  canvasHeight: 640,
  matchDurationSec: 5 * 60,

  arenaPadding: 24,
  wallThickness: 18,

  tankRadius: 12,
  tankTurnRate: 4.2, // rad/s
  separationForce: 90,

  roles: {
    scout: {
      count: 2,
      speed: 95,
      maxHp: 55,
      visionRadius: 165,
      debugRate: 0.55, // progress / second while standing
      canShoot: false,
      damage: 0,
      fireCooldown: 0.55,
      projectileSpeed: 320,
      projectileLife: 0.7,
    },
    shooter: {
      count: 4,
      speed: 130,
      maxHp: 110,
      visionRadius: 95,
      debugRate: 0.18,
      canShoot: true,
      damage: 22,
      fireCooldown: 0.38,
      projectileSpeed: 420,
      projectileLife: 0.9,
    },
  },

  debugRange: 42,
  debugStandStillSpeed: 12,
  reportInSeconds: 3,
  reportInExposeRadius: 40, // must be away from walls-ish; standing still exposed
  markerFadeSeconds: 10,
  wreckMarkClickRadius: 22,

  bulletRadius: 3.5,
  friendlyFire: false,

  shareModeDefault: "report" as ShareMode,

  ai: {
    thinkInterval: 0.25,
    holdRadius: 28,
    attackAggro: 220,
    escortDistance: 70,
    retreatHpFraction: 0.28,
    pathStep: 36,
    pushbackChance: 0.18,
  },

  /**
   * Pre-revealed friendly home strip as a fraction of map height.
   * Blue owns the bottom band; red owns the top (spawn only — player fog
   * only starts with blue's home). Prefer ~0.2 over 0.5 so most of the
   * map stays a hunt.
   */
  homeTerritoryFraction: 0.2,

  fog: {
    cellSize: 16,
    revealAlpha: 0,
    exploredAlpha: 0.28,
    hiddenAlpha: 0.94,
    gridStep: 48,
  },

  llm: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    timeoutMs: 12000,
  },

  colors: {
    playerTeam: "#4f8cff",
    enemyTeam: "#e35d5d",
    wall: "#4a5564",
    wallStroke: "#2a323e",
    floor: "#243040",
    floorAlt: "#1e2836",
    homeTint: "rgba(79, 140, 255, 0.12)",
    frontline: "rgba(201, 162, 39, 0.75)",
    grid: "rgba(180, 200, 220, 0.12)",
    wreck: "#6b5a3a",
    codeIcon: "#f0d060",
    marker: "#ffcc66",
    vision: "rgba(120,170,255,0.10)",
    accent: "#c9a227",
  },
} as const;

/** Axis-aligned home band for a team (blue = south, red = north). */
export function homeTerritoryBounds(team: "blue" | "red"): {
  y0: number;
  y1: number;
} {
  const H = CONFIG.canvasHeight;
  const h = H * CONFIG.homeTerritoryFraction;
  if (team === "blue") return { y0: H - h, y1: H };
  return { y0: 0, y1: h };
}

export type ShareMode = "auto" | "report" | "none";
export type Role = keyof typeof CONFIG.roles;
