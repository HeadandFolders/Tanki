/** Wire protocol for host-authoritative LAN multiplayer. */

export type NetRole = "host" | "guest";
export type NetTeam = "blue" | "red";

export interface NetInput {
  keys: string[];
  mouseX: number;
  mouseY: number;
  shooting: boolean;
  controlledNumber: number;
}

export interface NetTankSnap {
  id: string;
  team: NetTeam;
  number: number;
  role: string;
  x: number;
  y: number;
  angle: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  goal: string;
  goalSource?: string;
}

export interface NetProjSnap {
  id: string;
  team: NetTeam;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export interface NetDeathSnap {
  id: string;
  team: NetTeam;
  tankNumber: number;
  role: string;
  x: number;
  y: number;
  angle: number;
  startedAt: number;
}

export interface NetStateSnap {
  time: number;
  matchLeft: number;
  outcome: string;
  /** Winner from absolute teams; guest maps to local win/lose. */
  winner: "blue" | "red" | "draw" | null;
  controlledBlue: string;
  controlledRed: string | null;
  tanks: NetTankSnap[];
  projectiles: NetProjSnap[];
  deathFx: NetDeathSnap[];
  chat: { text: string; kind: string }[];
  events: { text: string; kind: string }[];
}

export type ClientMsg =
  | { type: "hello"; role: NetRole; room: string; name?: string }
  | { type: "input"; input: NetInput }
  | { type: "order"; text: string }
  | { type: "ready" }
  | { type: "start" }
  | { type: "state"; state: NetStateSnap }
  | { type: "ping"; t: number };

export type ServerMsg =
  | {
      type: "welcome";
      role: NetRole;
      team: NetTeam;
      room: string;
      port: number;
      lanIps: string[];
      playerId: string;
    }
  | {
      type: "lobby";
      hostReady: boolean;
      guestReady: boolean;
      guestConnected: boolean;
    }
  | { type: "start"; seed: number }
  | { type: "state"; state: NetStateSnap }
  | { type: "peer-input"; input: NetInput }
  | { type: "peer-order"; text: string }
  | { type: "error"; message: string }
  | { type: "pong"; t: number };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode(raw: string): ClientMsg | ServerMsg | null {
  try {
    return JSON.parse(raw) as ClientMsg | ServerMsg;
  } catch {
    return null;
  }
}
