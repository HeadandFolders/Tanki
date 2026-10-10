/** All tunable gameplay values live here. */
export const CONFIG = {
  canvasWidth: 1280,
  canvasHeight: 800,
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
      maxHp: 70,
      visionRadius: 165,
      debugRate: 0.55,
      canShoot: true,
      damage: 16,
      fireCooldown: 0.22,
      projectileSpeed: 420,
      projectileLife: 0.85,
      fightRange: 130,
    },
    shooter: {
      count: 4,
      speed: 130,
      maxHp: 110,
      visionRadius: 95,
      debugRate: 0.18,
      canShoot: true,
      damage: 22,
      fireCooldown: 0.16,
      projectileSpeed: 480,
      projectileLife: 0.9,
      fightRange: 95,
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

  /** No-fog TDM is the playtest default (full map + enemies always visible). */
  shareModeDefault: "clear" as ShareMode,
  /** Team Deathmatch is the rules default; CTF = Capture the Code. */
  gameModeDefault: "tdm" as GameMode,
  /** Top-bar Mode menu preset (bundles rules + fog share). */
  menuModeDefault: "tdm-nofog" as MenuMode,

  ai: {
    thinkInterval: 0.25,
    holdRadius: 36,
    attackAggro: 260,
    /** Only abandon move/spread/hold orders when an enemy is this close. */
    orderThreatRadius: 70,
    escortDistance: 70,
    retreatHpFraction: 0.32,
    pathStep: 36,
    pushbackChance: 0.12,
    /** Soft separation; keep below seek speed to avoid corner-shiver. */
    separation: 55,
    separationRadius: 40,
    patrolRadius: 160,
    kiteRange: 55,
    /** Spacing between tanks sharing one moveTo landmark. */
    formationSpacing: 72,
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
    timeoutMs: 12000,
    /** Paths go through Vite `/llm/*` proxies (see vite.config.ts) to avoid CORS. */
    openai: {
      path: "/llm/openai/v1/chat/completions",
      model: "gpt-4o-mini",
    },
    gemini: {
      path: "/llm/gemini/v1beta/models",
      model: "gemini-2.0-flash",
    },
    anthropic: {
      path: "/llm/anthropic/v1/messages",
      model: "claude-haiku-4-5-20251001",
    },
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

/** Vision/share modes. `clear` = no fog; map and enemies always visible. */
export type ShareMode = "auto" | "report" | "none" | "clear";
export type GameMode = "tdm" | "ctf";
/** Mode menu presets shown in the top bar. */
export type MenuMode = "tdm-nofog" | "tdm" | "ctf";
export type Role = keyof typeof CONFIG.roles;

/** Resolve a Mode-menu preset into game rules + fog share. */
export function modesFromMenu(menu: MenuMode): {
  share: ShareMode;
  mode: GameMode;
} {
  switch (menu) {
    case "tdm-nofog":
      return { share: "clear", mode: "tdm" };
    case "tdm":
      return { share: "report", mode: "tdm" };
    case "ctf":
      return { share: "report", mode: "ctf" };
  }
}
