import type { GameMode, RedDifficulty, Role, ShareMode } from "./config";
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
    wreckId?: string;
  };
  /** Default system; set to player when radio/text order applied. */
  source?: GoalSource;
}

/** Shared fog-of-war contact for AI (share modes feed this, not only the map). */
export interface TeamContact {
  enemyId: string;
  x: number;
  y: number;
  seenAt: number;
  seenBy: string;
}

export interface TeamBelief {
  contacts: TeamContact[];
}

export interface OrderResult {
  tankId: string;
  goal: GoalKind;
  params?: Goal["params"];
  chatLine: string;
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
  goal: Goal;
  lastOrderChat?: string;
  standStillTimer: number;
  reportProgress: number;
  debugProgress: number;
  debugTargetId: string | null;
  lastKnownPos: Vec2;
  isCodeCarrier: boolean;
  lastShotAt: number;
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
}

export interface WorldState {
  time: number;
  matchLeft: number;
  shareMode: ShareMode;
  gameMode: GameMode;
  walls: Wall[];
  tanks: Tank[];
  projectiles: Projectile[];
  wrecks: Wreck[];
  /** mp-offline death blink husks (removed after blinks; no wreck gameplay). */
  deathFx: DeathFx[];
  markers: SightingMarker[];
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
  chat: ChatLine[];
  events: ChatLine[];
  nextWreckLabel: number;
  rngSeed: number;
  /** AI-facing shared contacts (P1: share modes affect team belief). */
  teamBelief: TeamBelief;
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
  source: "llm" | "mock";
  ms: number;
  /** Set when an LLM attempt failed and results came from offline fallback. */
  llmError?: string;
}
