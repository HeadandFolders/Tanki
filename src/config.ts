/** All tunable gameplay values live here. */
export const CONFIG = {
  canvasWidth: 960,
  canvasHeight: 640,
  /** Battle City–style tile grid */
  tileSize: 16,
  matchDurationSec: 5 * 60,

  arenaPadding: 32, // ~2 tiles (border)
  wallThickness: 16,

  tankRadius: 11,
  tankTurnRate: 4.2, // rad/s
  separationForce: 90,
  /** Drawn tank sprite scale (pixels per pattern cell) */
  spriteScale: 2,

  roles: {
    scout: {
      count: 2,
      speed: 95,
      maxHp: 55,
      visionRadius: 165,
      debugRate: 0.55,
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
  reportInExposeRadius: 40,
  markerFadeSeconds: 10,
  wreckMarkClickRadius: 22,

  bulletRadius: 3,
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
   * Blue = south, red = north spawn. ~0.2 keeps most of the map a hunt.
   */
  homeTerritoryFraction: 0.2,

  fog: {
    cellSize: 16,
    revealAlpha: 0,
    exploredAlpha: 0.35,
    hiddenAlpha: 0.96,
    gridStep: 16,
  },

  llm: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    timeoutMs: 12000,
  },

  colors: {
    // Battle City palette
    playerTeam: "#f0d030",
    playerScout: "#c8e060",
    enemyTeam: "#c0c0c8",
    enemyScout: "#a8b0b8",
    brickLight: "#e07038",
    brickDark: "#a04020",
    brickMortar: "#602010",
    steelLight: "#e8e8e8",
    steelMid: "#a8a8b0",
    steelDark: "#606068",
    borderLight: "#d0d0d0",
    borderDark: "#888890",
    floor: "#2a2a2a",
    floorAlt: "#242424",
    homeTint: "rgba(240, 208, 48, 0.08)",
    frontline: "rgba(240, 208, 48, 0.55)",
    grid: "rgba(255,255,255,0.04)",
    wreck: "#705838",
    codeIcon: "#f0d060",
    marker: "#f8f060",
    vision: "rgba(240, 208, 48, 0.08)",
    accent: "#f0d030",
    eagle: "#e8c040",
    bullet: "#f8f060",
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
