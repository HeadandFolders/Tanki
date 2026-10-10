import type { Role, ShareMode } from './config';

export type Team = 'blue' | 'red';
export type GoalKind =
  | 'moveTo'
  | 'holdPosition'
  | 'attackNearest'
  | 'escort'
  | 'retreat'
  | 'reportIn'
  | 'debug'
  | 'idle';

export type MatchPhase = 'playing' | 'win' | 'lose' | 'draw';
export type WallKind = 'brick' | 'steel' | 'border';
export type ChatKind = 'ally' | 'sys' | 'warn';

export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: WallKind;
}

export interface Goal {
  kind: GoalKind;
  x?: number;
  y?: number;
  targetId?: number;
  wreckId?: number;
  label?: string;
}

export interface Tank {
  id: number;
  team: Team;
  number: number;
  role: Role;
  x: number;
  y: number;
  angle: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  isCodeCarrier: boolean;
  goal: Goal;
  fireCooldown: number;
  stillTime: number;
  reportLatched: boolean;
  debugProgress: number;
  debugWreckId: number | null;
  hurtFlash: number;
  lastContactChat: number;
}

export interface Projectile {
  id: number;
  team: Team;
  ownerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  damage: number;
}

export interface Wreck {
  id: number;
  label: string;
  team: Team;
  tankNumber: number;
  x: number;
  y: number;
  wasCodeCarrier: boolean;
  marked: boolean;
  debugged: boolean;
  debugResult: 'clean' | 'code' | null;
}

export interface Marker {
  kind: 'enemy' | 'wreck';
  x: number;
  y: number;
  life: number;
  label?: string;
}

export interface ChatLine {
  kind: ChatKind;
  text: string;
}

export interface PlayerInput {
  ax: number;
  ay: number;
  shoot: boolean;
  aimX: number;
  aimY: number;
}

export interface WorldState {
  matchId: number;
  tanks: Tank[];
  projectiles: Projectile[];
  wrecks: Wreck[];
  walls: Wall[];
  fog: Uint8Array;
  live: Uint8Array;
  fogCols: number;
  fogRows: number;
  markers: Marker[];
  time: number;
  phase: MatchPhase;
  endReason: string;
  shareMode: ShareMode;
  controlledId: number;
  chat: ChatLine[];
  events: string[];
  chatRev: number;
  eventRev: number;
  nextProjectileId: number;
  nextWreckId: number;
  nextWreckLetter: number;
  redWipeAnnounced: boolean;
  scoutHintAt: number;
  noContactHintAt: number;
}

export interface OrderResult {
  tankId: number;
  goal: Goal;
  chatLine: string;
}

export type OrderBatch = OrderResult[] & {
  meta: { source: 'llm' | 'mock'; ms: number; warning?: string };
};

export interface PickResult {
  kind: 'tank' | 'wreck' | 'empty';
  id?: number;
}
