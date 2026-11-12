/** Tank stats, armour, repairs, nukes and per-mode loadouts live in config/balance. */
import { BASE_HP, MAP_GEN_SIZE, TANK_TYPES } from "./config/balance";

/**
 * Arena ids. "large" is the generated 144x90 map; "generated" is the seeded
 * map generator's own output, about three times that area; the others are 80x50.
 */
export type ArenaId = "reference" | "standard" | "dense" | "large" | "generated";

export const ARENA_SPECS: Record<ArenaId, { cols: number; rows: number }> = {
  reference: { cols: 80, rows: 50 },
  standard: { cols: 80, rows: 50 },
  dense: { cols: 80, rows: 50 },
  large: { cols: 144, rows: 90 },
  generated: { cols: MAP_GEN_SIZE.cols, rows: MAP_GEN_SIZE.rows },
};

/** A base occupies a 3x3 block of tiles. */
export const BASE_FOOTPRINT = 3;

/** Current world extent in px. Set by buildArena(); read through CONFIG getters. */
const WORLD = { width: 1280, height: 800 };

export function setWorldSize(cols: number, rows: number): void {
  WORLD.width = cols * CONFIG.tileSize;
  WORLD.height = rows * CONFIG.tileSize;
}

/** Every gameplay number that is not a tank stat lives here; tank stats and base HP live in config/balance.ts. */
export const CONFIG = {
  /** World width in px (arena extent, not the screen). */
  get canvasWidth(): number {
    return WORLD.width;
  },
  /** World height in px (arena extent, not the screen). */
  get canvasHeight(): number {
    return WORLD.height;
  },
  /** On-screen canvas size; the camera maps the world into this. */
  viewWidth: 1280,
  viewHeight: 800,
  /** Battle City–style tile grid */
  tileSize: 16,
  matchDurationSec: 5 * 60,
  matchTimeLimitSec: 600,
  /** Base War structure HP; the number itself is in config/balance.ts. */
  baseHp: BASE_HP,
  baseDamageMultiplier: 0.25,
  baseHitFlashSec: 0.12,
  baseDestructionSec: 0.9,
  baseAttackAlertCooldownSec: 5,
  /** Seconds of 3-2-1 after Start before the match goes live. */
  startCountdownSec: 3,

  arenaPadding: 32, // ~2 tiles (border)
  wallThickness: 16,

  tankRadius: 11,
  separationForce: 90,
  /** Drawn tank sprite scale (pixels per pattern cell) */
  spriteScale: 2,

  /** Every hull's stats by type. See src/config/balance.ts for the table itself. */
  roles: TANK_TYPES,

  debugRange: 42,
  debugStandStillSpeed: 12,
  reportInSeconds: 3,
  reportInExposeRadius: 40,
  markerFadeSeconds: 10,
  wreckMarkClickRadius: 22,

  bulletRadius: 3,
  friendlyFire: false,

  /**
   * The map used whenever one is not chosen: MP and Base War worlds, the
   * batch runner and a LAN host all fall back to this. Every other map id stays
   * selectable by name.
   */
  arenaDefault: "large" as ArenaId,
  /** No-fog TDM is the playtest default (full map + enemies always visible). */
  shareModeDefault: "clear" as ShareMode,
  /** Team Deathmatch is the rules default; CTF = Capture the Code. */
  gameModeDefault: "tdm" as GameMode,
  /** Top-bar Mode menu preset (bundles rules + fog share). */
  menuModeDefault: "tdm-nofog" as MenuMode,

  /**
   * Multiplayer · Offline — local/bot TDM, no fog, gunners only, hold-until-ordered.
   * Tunables for death blink VFX and panic escape; the map itself is CONFIG.arenaDefault.
   */
  mpOffline: {
    /** Blink on/off cycles before the husk is removed (no wreck). */
    deathBlinkCount: 2,
    /** Half-period of one blink (visible or hidden), seconds. */
    deathBlinkHalfPeriodSec: 0.14,
    /**
     * True melee / “under close attack” enter radius for panic.
     * Must stay well below fightRange so ordered attackers don’t thrash.
     */
    meleePanicRadius: 36,
    /** Enemies inside this range count toward "surrounded". */
    surroundRadius: 115,
    /** Need this many nearby enemies to count as surrounded. */
    surroundEnemyCount: 2,
    /** Keep panicking until threats are beyond this (hysteresis exit). */
    panicClearRadius: 105,
    /** Minimum panic commitment so flee isn’t frame-flipped. */
    panicCommitSec: 0.55,
    /** How far to flee when panicking. */
    escapeDistance: 130,
    /**
     * Open fire on any enemy this close when the shot line is clear.
     * Mirrors the Gunner's own gun reach; each hull otherwise shoots to its
     * own `range` in the balance table.
     */
    shootRange: TANK_TYPES.shooter.range,
  },

  /**
   * Headless batch measurement (`npm run sim`). Nothing in the live game reads
   * these; they define how a batch match is stepped and where the middle area
   * is, so the numbers a batch reports are comparable across runs.
   */
  sim: {
    /** Fixed step rate for batch matches. The live loop uses frame delta; tests do not. */
    hz: 30,
    /** Matches in a batch when --matches is omitted. */
    defaultMatches: 20,
    /**
     * A match still playing here is stopped and counted as an over-length
     * draw. Keep it under the mode's own clock or the engine decides first.
     */
    maxLengthSec: 300,
    /**
     * Middle area: a band across the full map width, centred on the map, this
     * fraction of map height. 0.4 of 800px is the middle 320px.
     */
    middleBandFraction: 0.4,
    /** Base HP is sampled every this many match seconds. */
    baseSampleSec: 5,
    /**
     * A team with fewer living hulls than this is "under strength", and the
     * batch times how long it stays there. Six hulls a side, so one respawn
     * timer running is not enough to trip it.
     */
    underStrengthAlive: 5,
  },

  /** Two-device LAN multiplayer (WebSocket relay + host-authoritative sim). */
  net: {
    /** Dedicated WS/HTTP port (Vite stays on 4847). */
    port: 4855,
    /** Snapshot send rate from host (Hz). */
    snapshotHz: 18,
    /** Default room when none typed. */
    defaultRoom: "TANK",
  },

  /** Follow camera (world larger than the screen). */
  camera: {
    /** Exponential follow rate (1/s); higher snaps harder. */
    followRate: 7,
    zoomDefault: 1,
    zoomMin: 0.6,
    zoomMax: 1.6,
    /** Wheel zoom step per notch (multiplicative). */
    zoomStep: 1.12,
    /** Minimap panel backing width in px; height follows the arena aspect. */
    minimapWidth: 360,
  },

  /** Generated 144x90 arena (point-symmetric, bricks only). */
  largeArena: {
    cols: 144,
    rows: 90,
    /** Layout seed; host and guest must agree (sent over the relay). */
    seed: 20261111,
    /** Spawn-to-center travel window reported by eval-arena (seconds, shooter speed). */
    spawnToCenterSec: [10, 15] as const,
    /** Deliberate 2-tile squeezes allowed by eval-arena (tiles of width 2). */
    maxSqueezeTiles: 40,
  },

  ai: {
    thinkInterval: 0.25,
    holdRadius: 36,
    attackAggro: 260,
    /** Only abandon move/spread/hold orders when an enemy is this close. */
    orderThreatRadius: 70,
    /** Ring radius for "cover me" / escort slots around the VIP. */
    escortDistance: 56,
    /** How wide the threat-facing cover arc is (radians). */
    escortArcSpread: 1.6,
    /** Arrival slack — stop micro-nudging once inside this of the cover slot. */
    escortSlotRadius: 22,
    /** Sprint toward VIP when farther than this. */
    escortCatchup: 110,
    retreatHpFraction: 0.32,
    retreatResumeHpFraction: 0.45,
    pathStep: 36,
    /** Reuse a tank's polyline until this timer, a nearby enemy, or a 25% cost jump. */
    routeCommitSec: 0.4,
    /** How long a wanted-but-zero fitBodyStep displacement counts as stuck (0.4-0.6s window). */
    stuckAfterSec: 0.5,
    /** Retry the reroute once per stuckAfterSec window, then hold and say so. */
    stuckGiveUpSec: 2,
    /** Allies this close are treated as blockers when the step was not body-fitted. */
    stuckAllyProbe: 40,
    /** Fresh A* plans allowed per simulation step; the rest keep their last route. */
    routePlansPerFrame: 3,
    /** An enemy must move this far before their position counts as a new risk. */
    routeRiskMove: 56,
    /** Look ahead along the polyline so the hull does not aim at every corner. */
    routeLookahead: 52,
    /**
     * Danger field: each enemy adds K / d² (d in path cells, floored at 1) to
     * cells inside its shot reach. A cell it can see also pays a flat toll, so
     * a long sightline is never free. Crossing a watched lane ~5 cells from a
     * gun costs about as much as a 12–15 cell detour behind cover.
     */
    dangerK: 90,
    /** Flat extra steps for a cell an enemy has a clear shot at. */
    dangerLosBase: 3,
    /** Share of K / d² still paid behind cover, so hugging a gun's wall is not free. */
    dangerHiddenFrac: 0.12,
    /** Smallest danger radius in px; a longer shot reach overrides it. */
    dangerRadius: 300,
    /** Open ground (no nearby wall) costs this many extra steps even without a current shot. */
    exposureOpenSteps: 1.6,
    pushbackChance: 0.12,
    /** Soft separation; keep below seek speed to avoid corner-shiver. */
    separation: 70,
    separationRadius: 48,
    patrolRadius: 160,
    kiteRange: 55,
    /** Spacing between tanks sharing one moveTo landmark. */
    formationSpacing: 72,
    /** How long shared enemy contacts stay in team belief (seconds). */
    beliefTtlSec: 12,
    /**
     * Under fog, gunners with system hold/patrol only peel for team contacts
     * inside this radius (player orders still use orderThreatRadius).
     */
    beliefEngageRadius: 220,
    /** Default red difficulty for TDM baselines. */
    redDifficultyDefault: "normal" as RedDifficulty,
    redDifficulty: {
      easy: { speedMul: 0.85, aggroMul: 0.7, engageRangeMul: 0.85 },
      normal: { speedMul: 1, aggroMul: 1, engageRangeMul: 1 },
      hard: { speedMul: 1.12, aggroMul: 1.25, engageRangeMul: 1.2 },
    },
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
    /** Pre-Start connectivity check (should fail fast on bad keys). */
    probeTimeoutMs: 6000,
    /** Paths go through Vite `/llm/*` proxies (see vite.config.ts) to avoid CORS. */
    openai: {
      path: "/llm/openai/v1/chat/completions",
      model: "gpt-4o-mini",
    },
    /** OpenRouter — OpenAI-compatible; any model id OpenRouter hosts. */
    openrouter: {
      path: "/llm/openrouter/api/v1/chat/completions",
      model: "openai/gpt-4o-mini",
    },
    gemini: {
      path: "/llm/gemini/v1beta/models",
      model: "gemini-3.8-flash",
    },
    anthropic: {
      path: "/llm/anthropic/v1/messages",
      model: "claude-haiku-4-5-20251001",
    },
  },

  /**
   * EXPERIMENTAL local command parser (Cactus Needle), run between the phrase
   * reader and the LLM API. Off by default; `?needle=1` turns it on for a page.
   */
  needle: {
    use_needle_sidecar: false,
    /** Execute a Needle reading only at or above this confidence. */
    threshold: 0.8,
    /** Fall through to the LLM path if Needle has not answered by then. */
    timeoutMs: 40,
    /** How far ahead of the player a relative move ("move left") lands. */
    relativeMoveDistance: 160,
    /** Comparison records kept in memory for the dump hotkey. */
    logSize: 200,
    /** Lines shown in the command overlay. */
    overlaySize: 20,
  },

  colors: {
    // Battle City palette — darker friendlies so white # labels pop
    playerTeam: "#c09010",
    playerScout: "#6a9020",
    /** Per-tank body tints (index 0 unused; 1–6) for readable numbers. */
    playerTankByNumber: [
      "#000000",
      "#b8860b", // 1 gold
      "#c45c12", // 2 burnt orange
      "#8a6a10", // 3 olive gold
      "#a04018", // 4 rust
      "#706018", // 5 drab
      "#984818", // 6 copper
    ] as const,
    playerScoutByNumber: [
      "#000000",
      "#5a8820",
      "#4a7818",
      "#688828",
      "#3a6810",
      "#789030",
      "#486818",
    ] as const,
    enemyTeam: "#909098",
    enemyScout: "#707078",
    enemyHeavy: "#6a6a78",
    playerHeavyByNumber: [
      "#000000",
      "#8a6848",
      "#6a5040",
      "#7a5844",
      "#5a4838",
      "#846050",
      "#645040",
    ] as const,
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
    /**
     * Middle respawn zone. The ring is the colour of whoever owns the bonus
     * right now: the blue team's gold, the red team's red, violet when both
     * sides are in it, and grey while it stands open.
     */
    zoneBlue: "#e8c040",
    zoneRed: "#ec5555",
    zoneContested: "#b45ad0",
    zoneOpen: "#8f9aa8",
    zoneFillBlue: "rgba(232, 192, 64, 0.13)",
    zoneFillRed: "rgba(236, 85, 85, 0.13)",
    zoneFillContested: "rgba(180, 90, 208, 0.16)",
    zoneFillOpen: "rgba(143, 154, 168, 0.07)",
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
export type GameMode = "tdm" | "ctf" | "mp-offline" | "mp-online" | "heavy-light" | "base-war";
/** Mode menu presets shown in the top bar. */
export type MenuMode =
  | "tdm-nofog"
  | "tdm"
  | "ctf"
  | "mp-offline"
  | "mp-online"
  | "heavy-light"
  | "base-war";
export type Role = keyof typeof CONFIG.roles;
export type RedDifficulty = "easy" | "normal" | "hard";

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
    case "base-war":
      return { share: "clear", mode: "base-war" };
    case "mp-offline":
      return { share: "clear", mode: "mp-offline" };
    case "mp-online":
      return { share: "clear", mode: "mp-online" };
    case "heavy-light":
      return { share: "clear", mode: "heavy-light" };
  }
}

export function isBaseWar(mode: GameMode): boolean {
  return mode === "base-war";
}

/** Local/bot only (no network). */
export function isMpOffline(mode: GameMode): boolean {
  return mode === "mp-offline" || mode === "base-war";
}

/** Two-device networked match. */
export function isMpOnline(mode: GameMode): boolean {
  return mode === "mp-online";
}

/**
 * Shared Multiplayer ruleset: no fog, the five-type company loadout, blink
 * deaths, the default maze map, hold-until-ordered teammates (offline bots or online
 * humans+bots).
 */
export function isMpRules(mode: GameMode): boolean {
  return mode === "mp-offline" || mode === "mp-online" || mode === "base-war";
}
