import type { Role, ShareMode } from "./config";

export type TeamId = "blue" | "red";

export type GoalKind =
  | "moveTo"
  | "holdPosition"
  | "attackNearest"
  | "escort"
  | "retreat"
  | "reportIn"
  | "debug"
  | "idle";

export interface Goal {
  kind: GoalKind;
  params?: {
    x?: number;
    y?: number;
    targetTankId?: string;
    wreckId?: string;
  };
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
  walls: Wall[];
  tanks: Tank[];
  projectiles: Projectile[];
  wrecks: Wreck[];
  markers: SightingMarker[];
  fogExplored: Uint8Array;
  fogCols: number;
  fogRows: number;
  controlledId: string;
  outcome: "playing" | "win" | "lose" | "draw";
  chat: ChatLine[];
  events: ChatLine[];
  nextWreckLabel: number;
  rngSeed: number;
}

export interface InterpretContext {
  apiKey?: string;
}
