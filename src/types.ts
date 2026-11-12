import type { RouteCommit } from "./ai";
import type { AiCommanderState } from "./ai-commander";
import type { DriveTrack } from "./motion";
import type { StuckState } from "./stuck";
import type { RandomState } from "./random";
import type { InterruptStack, OrderEvent } from "./interrupt-stack";
import type { CommandSource } from "./command-schema";
import type { CommandRecord } from "./command-pipeline";
import type { ArenaId, GameMode, RedDifficulty, Role, ShareMode } from "./config";
import type { ArenaZone } from "./arena-large";
import type { GoalKind } from "./goals";

export type { RedDifficulty };

export type TeamId = "blue" | "red";
export type { GoalKind };

/** Who assigned the current goal — player orders outrank soft AI rewrites. */
export type GoalSource = "player" | "system";

export interface Goal {
  kind: GoalKind;
  params?: {
    x?: number;
    y?: number;
    targetTankId?: string;
    /** Named enemies for "2 and 3 attack 5 and 6". Each attacker hunts the nearest. */
    targetTankIds?: readonly string[];
    wreckId?: string;
    /** Stop on this point instead of fanning out or holding short of it. */
    exact?: boolean;
    /** Flank relative to the commander facing the enemy cluster. */
    side?: "left" | "right";
    /** stealth = prefer a covered route. Still a moveTo; bots already shoot in range. */
    risk?: "normal" | "stealth";
  };
  /** Default system; set to player when radio/text order applied. */
  source?: GoalSource;
  /** Which parser produced this goal from a radio/text order. Display only. */
  commandSource?: CommandSource;
  issuer?: "human" | "ai_commander";
  noRetreat?: boolean;
  commandId?: number;
}

/** Shared fog-of-war contact for AI (share modes feed this, not only the map). */
export interface TeamContact {
  enemyId: string;
  x: number;
  y: number;
  seenAt: number;
  seenBy: string;
  observed?: Pick<Tank, "number" | "team" | "role" | "hp" | "maxHp" | "angle">;
}

export interface TeamBelief {
  contacts: TeamContact[];
}

export interface OrderResult {
  tankId: string;
  goal: GoalKind;
  params?: Goal["params"];
  noRetreat?: boolean;
  chatLine: string;
  /** Which parser produced this order. */
  commandSource?: CommandSource;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Tank {
  id: string;
  team: TeamId;
  number: number; // 1–6
  role: Role;
  x: number;
  y: number;
  angle: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  cooldown: number;
  /** Seconds until this hull may launch another nuke; 0 for types that have none. */
  nukeCooldown: number;
  readonly goal: Readonly<Goal> & { readonly params?: Readonly<NonNullable<Goal["params"]>> };
  orderStack?: InterruptStack;
  routeCommit?: RouteCommit;
  driveTrack?: DriveTrack;
  stuckState?: StuckState;
  wallSlide?: number;
  redFocus?: { id: string; until: number };
  lastOrderChat?: string;
  standStillTimer: number;
  reportProgress: number;
  debugProgress: number;
  debugTargetId: string | null;
  lastKnownPos: Vec2;
  isCodeCarrier: boolean;
  lastShotAt: number;
  /** Hull that landed the killing blow, once this tank is dead. Kill attribution for the batch report. */
  killedBy?: string;
  /** The point this hull was fielded at, which is where it respawns. */
  spawnPos?: Vec2;
  /** Seconds left before a destroyed hull returns to `spawnPos`; absent once it is back or if the mode has no respawns. */
  respawnLeft?: number;
  /** Until this world time, incoming hull damage is ignored. Set when a respawned hull appears. */
  spawnProtectionUntil?: number;
}

export interface Projectile {
  id: string;
  team: TeamId;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  life: number;
  fromShooter: boolean;
  /**
   * Nuke carrier round. It detonates wherever it dies — on a hull, on a base,
   * against a wall or at the end of its flight — and the blast is what hurts.
   */
  nuke?: { blastRadius: number; damageVsTank: number; damageVsBase: number };
}

export interface Wreck {
  id: string;
  label: string; // A, B, C…
  team: TeamId;
  tankNumber: number;
  x: number;
  y: number;
  wasCodeCarrier: boolean;
  marked: boolean;
  debugged: boolean;
  debugResult: "clean" | "code" | null;
}

/** Brief blink-out husk (mp-offline); not a gameplay wreck. */
export interface DeathFx {
  id: string;
  team: TeamId;
  tankNumber: number;
  role: Role;
  x: number;
  y: number;
  angle: number;
  startedAt: number;
}

export interface SightingMarker {
  id: string;
  kind: "enemy" | "wreck";
  x: number;
  y: number;
  createdAt: number;
  label: string;
}

export interface ChatLine {
  team?: TeamId;
  t: number;
  text: string;
  kind: "ally" | "sys" | "warn";
}

export type WallKind = "brick" | "steel" | "border";

export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: WallKind;
  baseTeam?: TeamId;
}

/** Tile of the 3x3 base footprint's top-left corner. */
export interface BaseTile {
  tileX: number;
  tileY: number;
}

/** Side of the map the base backs onto; the other three sides are open. */
export type WallSide = "north" | "south" | "east" | "west";

/** What a map declares about its base: where it sits and what wall backs it. */
export interface BasePlacement {
  tile: BaseTile;
  wall: WallSide;
}

export interface BaseState {
  team: TeamId;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  lastHitAt: number;
  lastDamagedAt: number;
  lastAlertAt: number;
  destroyedAt: number | null;
}

export interface WorldState {
  time: number;
  matchLeft: number;
  shareMode: ShareMode;
  gameMode: GameMode;
  /** Which arena the walls came from; keys wall edits and the net handshake. */
  arenaId: ArenaId;
  /** Layout seed (only the generated "large" arena reads it). */
  arenaSeed: number;
  /** Named zone anchors of this arena; empty on the hand-authored band maps. */
  zones: ArenaZone[];
  walls: Wall[];
  bases?: Record<TeamId, BaseState>;
  tanks: Tank[];
  projectiles: Projectile[];
  wrecks: Wreck[];
  /** mp-offline death blink husks (removed after blinks; no wreck gameplay). */
  deathFx: DeathFx[];
  markers: SightingMarker[];
  /** Commander map marks (hold F and click). One X per team. */
  playerMarks: Record<TeamId, Vec2 | null>;
  fogExplored: Uint8Array;
  fogCols: number;
  fogRows: number;
  controlledId: string;
  /**
   * Online multiplayer: red tank controlled by the joining human.
   * Null in single-player / offline modes.
   */
  remoteControlledId: string | null;
  /** ready = menu; countdown = 3-2-1; playing = live match */
  outcome: "ready" | "countdown" | "playing" | "win" | "lose" | "draw";
  outcomeReason?: string | null;
  chat: ChatLine[];
  events: ChatLine[];
  orderEvents?: OrderEvent[];
  humanCommands?: CommandRecord[];
  nextWreckLabel: number;
  rngSeed: number;
  random: RandomState;
  wreckSeq: number;
  deathFxSeq: number;
  /** AI-facing shared contacts (P1: share modes affect team belief). */
  teamBelief: TeamBelief;
  redTeamBelief?: TeamBelief;
  commanders?: Partial<Record<TeamId, AiCommanderState>>;
  /** Red AI aggression tier for measurable “strong” baselines. */
  redDifficulty: RedDifficulty;
}

/** Resolved LLM backend for radio orders (provider is never "auto" here). */
export type LlmBackend = "openrouter" | "openai" | "gemini" | "anthropic";

export interface InterpretContext {
  apiKey?: string;
  /** Override auto key-prefix detection. */
  provider?: LlmBackend;
  /** Override default model id for that provider. */
  model?: string;
}

export interface InterpretBundle {
  results: OrderResult[];
  source: "llm" | "mock" | "needle";
  ms: number;
  /** Set when an LLM attempt failed and results came from offline fallback. */
  llmError?: string;
  /** Shown when the order was understood but could not be carried out. */
  notice?: string;
}
