/**
 * Headless batch measurement. Simulation only — no canvas, no DOM, no
 * wall-clock pacing: a match is stepped at a fixed rate as fast as the CPU
 * allows, and every number a batch reports comes from this file.
 */
import { setCommander, type CommanderProfile } from "../ai-commander";
import type { ToolName } from "../command-schema";
import { CONFIG, type ArenaId, type GameMode, type RedDifficulty, type Role, type ShareMode } from "../config";
import { createWorld, startMatch, stepWorld, type InputState } from "../game";
import type { TeamId } from "../types";

export type Winner = TeamId | "draw";

export const TEAMS: readonly TeamId[] = ["blue", "red"];
export const DEFAULT_PROFILES: Record<TeamId, CommanderProfile> = { blue: "tactical", red: "tactical" };

const INPUT: InputState = { keys: [], mouseX: 0, mouseY: 0, shooting: false };
const EPS = 1e-9;

export interface MatchSpec {
  /** Batch seed; each match derives its own seeds from it. */
  seed: number;
  /** 0-based position in the batch. */
  index: number;
  mode: GameMode;
  arena: ArenaId;
  share: ShareMode;
  difficulty: RedDifficulty;
  profiles: Record<TeamId, CommanderProfile>;
  hz: number;
  maxLengthSec: number;
  middleBandFraction: number;
  baseSampleSec: number;
  underStrengthAlive: number;
}

/** Defaults for a batch, overridable per run. */
export function matchSpec(overrides: Partial<MatchSpec> = {}): MatchSpec {
  return {
    seed: 1,
    index: 0,
    mode: "base-war",
    arena: CONFIG.arenaDefault,
    share: "clear",
    difficulty: "normal",
    profiles: DEFAULT_PROFILES,
    hz: CONFIG.sim.hz,
    maxLengthSec: CONFIG.sim.maxLengthSec,
    middleBandFraction: CONFIG.sim.middleBandFraction,
    baseSampleSec: CONFIG.sim.baseSampleSec,
    underStrengthAlive: CONFIG.sim.underStrengthAlive,
    ...overrides,
  };
}

export interface TankDeath {
  t: number;
  tankId: string;
  team: TeamId;
  role: Role;
  /** Friendly fire is off, so this is always the opposing team. */
  byTeam: TeamId;
  /** Hull type that fired the killing shot; missing only if no round was attributed. */
  byRole?: Role;
}

export interface BaseHpSample {
  t: number;
  blue: number;
  red: number;
}

export interface MatchRecord {
  index: number;
  seed: number;
  profiles: Record<TeamId, CommanderProfile>;
  winner: Winner;
  /** Engine reason, or the length cap that stopped a live match. */
  reason: string;
  /** True when the match was ended by a clock, not by a base or an elimination. */
  overLength: boolean;
  lengthSec: number;
  kills: Record<TeamId, number>;
  /** Kills dealt per team keyed by the killer's hull type. */
  killsByRole: Record<TeamId, Partial<Record<Role, number>>>;
  /** Hulls the team fielded at kick-off, per type — the denominator for a death rate. */
  fielded: Record<TeamId, Partial<Record<Role, number>>>;
  /** Deaths per team keyed by hull type. */
  deaths: Record<TeamId, Partial<Record<Role, number>>>;
  deathsLog: TankDeath[];
  /** Times a destroyed hull came back at its own base (alive false → true). */
  respawns: Record<TeamId, number>;
  /** Seconds the team spent with fewer living hulls than `MatchSpec.underStrengthAlive`. */
  underStrengthSec: Record<TeamId, number>;
  /** Sum of (living tanks in the middle band x seconds), per team. */
  middleTankSeconds: Record<TeamId, number>;
  /** Seconds during which the team had at least one tank in the middle band. */
  middleOccupiedSeconds: Record<TeamId, number>;
  /** Base HP over time; empty when the mode has no bases. */
  baseHp: BaseHpSample[];
  /** Orders that actually reached a living hull. */
  orders: Record<TeamId, number>;
  /** How those orders split across intent tools — what a commander spent its slots on. */
  intents: Record<TeamId, Partial<Record<ToolName, number>>>;
}

/** Split one batch seed into per-match world and commander streams. */
export function matchSeeds(seed: number, index: number): Record<"world" | TeamId, number> {
  const mix = (salt: number): number => {
    let h = Math.imul((seed >>> 0) ^ 0x9e3779b9 ^ Math.imul(salt + 1, 0x85ebca6b), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h || 1;
  };
  const world = mix(index * 3);
  return { world, blue: mix(index * 3 + 1), red: mix(index * 3 + 2) };
}

function middleBand(fraction: number): { y0: number; y1: number } {
  const half = CONFIG.canvasHeight * Math.min(1, Math.max(0, fraction)) / 2;
  return { y0: CONFIG.canvasHeight / 2 - half, y1: CONFIG.canvasHeight / 2 + half };
}

function emptyTeamRecord(): Record<TeamId, number> {
  return { blue: 0, red: 0 };
}

function emptyRoleRecord(): Record<TeamId, Partial<Record<Role, number>>> {
  return { blue: {}, red: {} };
}

/**
 * Play one full scripted-vs-scripted match. The runner never mutates the
 * world outside what a normal match does; it only reads it between steps.
 */
export function runMatch(spec: MatchSpec): MatchRecord {
  const dt = 1 / spec.hz;
  const seeds = matchSeeds(spec.seed, spec.index);
  const world = createWorld(spec.share, spec.mode, spec.difficulty, seeds.world, "off", spec.arena);
  for (const team of TEAMS) setCommander(world, team, spec.difficulty, seeds[team], spec.profiles[team]);
  startMatch(world);

  const band = middleBand(spec.middleBandFraction);
  const record: MatchRecord = {
    index: spec.index,
    seed: seeds.world,
    profiles: { ...spec.profiles },
    winner: "draw",
    reason: "",
    overLength: false,
    lengthSec: 0,
    kills: emptyTeamRecord(),
    killsByRole: emptyRoleRecord(),
    fielded: emptyRoleRecord(),
    deaths: emptyRoleRecord(),
    deathsLog: [],
    respawns: emptyTeamRecord(),
    underStrengthSec: emptyTeamRecord(),
    middleTankSeconds: emptyTeamRecord(),
    middleOccupiedSeconds: emptyTeamRecord(),
    baseHp: [],
    orders: emptyTeamRecord(),
    intents: { blue: {}, red: {} },
  };
  if (world.bases) {
    record.baseHp.push({ t: 0, blue: world.bases.blue.hp, red: world.bases.red.hp });
  }

  const alive = new Map(world.tanks.map((tank) => [tank.id, tank.alive]));
  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    record.fielded[tank.team][tank.role] = (record.fielded[tank.team][tank.role] ?? 0) + 1;
  }
  let nextSampleAt = spec.baseSampleSec;
  for (let tick = 0; tick < spec.maxLengthSec / dt; tick++) {
    stepWorld(world, dt, INPUT);
    for (const tank of world.tanks) {
      if (alive.get(tank.id) && !tank.alive) {
        const byTeam: TeamId = tank.team === "blue" ? "red" : "blue";
        const killer = world.tanks.find((t) => t.id === tank.killedBy);
        record.deaths[tank.team][tank.role] = (record.deaths[tank.team][tank.role] ?? 0) + 1;
        record.kills[byTeam] += 1;
        if (killer) {
          record.killsByRole[killer.team][killer.role] =
            (record.killsByRole[killer.team][killer.role] ?? 0) + 1;
        }
        record.deathsLog.push({
          t: world.time, tankId: tank.id, team: tank.team, role: tank.role,
          byTeam, byRole: killer?.role,
        });
      } else if (!alive.get(tank.id) && tank.alive) {
        record.respawns[tank.team] += 1;
      }
      alive.set(tank.id, tank.alive);
    }
    const inMiddle = emptyTeamRecord();
    const living = emptyTeamRecord();
    for (const tank of world.tanks) {
      if (!tank.alive) continue;
      living[tank.team] += 1;
      if (tank.y >= band.y0 && tank.y <= band.y1) inMiddle[tank.team] += 1;
    }
    for (const team of TEAMS) {
      record.middleTankSeconds[team] += inMiddle[team] * dt;
      if (inMiddle[team]) record.middleOccupiedSeconds[team] += dt;
      if (living[team] < spec.underStrengthAlive) record.underStrengthSec[team] += dt;
    }
    if (world.bases && world.time + EPS >= nextSampleAt) {
      record.baseHp.push({ t: world.time, blue: world.bases.blue.hp, red: world.bases.red.hp });
      nextSampleAt += spec.baseSampleSec;
    }
    if (world.outcome !== "playing") break;
  }

  const decided = world.outcome !== "playing";
  if (world.bases) {
    // Close the trace on the state the match ended with, not the last grid tick.
    const last = record.baseHp.at(-1)!;
    if (last.blue !== world.bases.blue.hp || last.red !== world.bases.red.hp || last.t !== world.time) {
      record.baseHp.push({ t: world.time, blue: world.bases.blue.hp, red: world.bases.red.hp });
    }
  }
  const byClock = !decided || /^Time (up|expired)/.test(world.outcomeReason ?? "");
  record.overLength = byClock;
  record.winner = !decided ? "draw" : world.outcome === "win" ? "blue" : world.outcome === "lose" ? "red" : "draw";
  record.reason = decided ? (world.outcomeReason ?? world.outcome) : `Length cap ${spec.maxLengthSec}s`;
  record.lengthSec = world.time;
  for (const team of TEAMS) {
    const executed = (world.commanders?.[team]?.orders ?? []).filter((order) => order.tanks?.length);
    record.orders[team] = executed.length;
    for (const order of executed) {
      const tool = order.intent?.tool;
      if (!tool) continue;
      record.intents[team][tool] = (record.intents[team][tool] ?? 0) + 1;
    }
  }
  return record;
}
