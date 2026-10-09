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
      damage: 4,
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

  fog: {
    cellSize: 16,
    revealAlpha: 0,
    exploredAlpha: 0.45,
    hiddenAlpha: 0.92,
  },

  llm: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    timeoutMs: 12000,
  },

  colors: {
    playerTeam: "#4f8cff",
    enemyTeam: "#e35d5d",
    wall: "#3a4658",
    floor: "#1a222e",
    wreck: "#6b5a3a",
    codeIcon: "#f0d060",
    marker: "#ffcc66",
    vision: "rgba(120,170,255,0.08)",
    accent: "#c9a227",
  },
} as const;

export type ShareMode = "auto" | "report" | "none";
export type Role = keyof typeof CONFIG.roles;
