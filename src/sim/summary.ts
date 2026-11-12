/** Aggregation for a batch of headless matches. Reads MatchRecord rows only. */
import type { CommanderProfile } from "../ai-commander";
import { TOOL_NAMES, type ToolName } from "../command-schema";
import { CONFIG, type ArenaId, type GameMode, type RedDifficulty, type Role, type ShareMode } from "../config";
import type { TeamId } from "../types";
import { TEAMS, type BaseHpSample, type MatchRecord, type MatchSpec, type Winner } from "./match";

export interface BatchParams {
  matches: number;
  seed: number;
  mode: GameMode;
  arena: ArenaId;
  mapSeed: number;
  share: ShareMode;
  difficulty: RedDifficulty;
  profiles: Record<TeamId, CommanderProfile>;
  hz: number;
  maxLengthSec: number;
  middleBandFraction: number;
  baseSampleSec: number;
  underStrengthAlive: number;
}

export interface LengthStats {
  mean: number;
  median: number;
  min: number;
  max: number;
}

export interface BaseHpBucket {
  t: number;
  samples: number;
  bluePct: number;
  redPct: number;
}

export interface BaseHpSummary {
  buckets: BaseHpBucket[];
  finalPct: Record<TeamId, number>;
  destroyed: Record<TeamId, number>;
}

export interface Summary {
  params: BatchParams;
  wins: Record<Winner, number>;
  /** Share of every match played, draws included in the denominator. */
  winRate: Record<Winner, number>;
  /** Share of matches that ended decisively. */
  decisiveWinRate: Record<TeamId, number>;
  draws: { total: number; overLength: number; decided: number };
  length: LengthStats;
  kills: Record<TeamId, { total: number; mean: number }>;
  /** Kills dealt per role, keyed by the killer's hull type, per team. */
  killsByRole: Record<TeamId, Partial<Record<Role, number>>>;
  /** Deaths per role, summed over the batch, per team. */
  deaths: Record<TeamId, Partial<Record<Role, number>>>;
  /** Deaths per team, batch total and per match. With respawns a death is a delay, not a lost hull. */
  deathsByTeam: Record<TeamId, { total: number; mean: number }>;
  /** Times a destroyed hull came back at its own base, batch total and per match. */
  respawns: Record<TeamId, { total: number; mean: number }>;
  /** Time spent with fewer living hulls than `params.underStrengthAlive`, per team. */
  underStrength: Record<TeamId, { secondsMean: number; shareMean: number }>;
  /** Hulls fielded per role, summed over the batch, per team — the death-rate denominator. */
  fielded: Record<TeamId, Partial<Record<Role, number>>>;
  middle: Record<TeamId, {
    tankSecondsMean: number;
    occupiedShareMean: number;
    concurrentMean: number;
  }>;
  /**
   * Middle-zone control as a share of match time: how often each team alone in
   * the zone got the fast respawn clock, how often both sides cancelled it out,
   * and how often nobody was there. The three shares add up to the match.
   */
  zone: {
    hold: Record<TeamId, { secondsMean: number; shareMean: number }>;
    contestedShareMean: number;
    openShareMean: number;
  };
  baseHp: BaseHpSummary | null;
  orders: Record<TeamId, { total: number; mean: number }>;
  /** Orders that reached a hull, split by intent tool and summed over the batch. */
  intents: Record<TeamId, Partial<Record<ToolName, number>>>;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function roleTotals(
  rows: MatchRecord[],
  team: TeamId,
  by: "deaths" | "killsByRole" | "fielded",
): Partial<Record<Role, number>> {
  const out: Partial<Record<Role, number>> = {};
  for (const row of rows) {
    for (const [role, count] of Object.entries(row[by][team])) {
      out[role as Role] = (out[role as Role] ?? 0) + (count ?? 0);
    }
  }
  return out;
}

function intentTotals(rows: MatchRecord[], team: TeamId): Partial<Record<ToolName, number>> {
  const out: Partial<Record<ToolName, number>> = {};
  for (const tool of TOOL_NAMES) {
    const total = rows.reduce((sum, row) => sum + (row.intents[team][tool] ?? 0), 0);
    if (total) out[tool] = total;
  }
  return out;
}

function lastAtOrBefore(samples: BaseHpSample[], t: number): BaseHpSample | undefined {
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i]!.t <= t + 1e-9) return samples[i];
  }
  return undefined;
}

/**
 * Mean base HP percent on a fixed grid across the match cap. A bucket averages
 * only the matches still running at that time, so `samples` is how many
 * matches back it up; matches that ended earlier show in `final`, not here.
 */
function baseHpCurve(rows: MatchRecord[], bucketCount: number, spanSec: number): BaseHpBucket[] {
  const step = spanSec / bucketCount;
  return Array.from({ length: bucketCount }, (_, i) => {
    const t = (i + 1) * step;
    let blue = 0;
    let red = 0;
    let samples = 0;
    for (const row of rows) {
      if (row.lengthSec + 1e-9 < t) continue;
      const at = lastAtOrBefore(row.baseHp, t);
      if (!at) continue;
      blue += at.blue;
      red += at.red;
      samples += 1;
    }
    return {
      t,
      samples,
      bluePct: samples ? blue / samples / CONFIG.baseHp : NaN,
      redPct: samples ? red / samples / CONFIG.baseHp : NaN,
    };
  });
}

export function summarize(rows: MatchRecord[], params: BatchParams): Summary {
  const wins: Record<Winner, number> = { blue: 0, red: 0, draw: 0 };
  for (const row of rows) wins[row.winner] += 1;
  const draws = {
    total: wins.draw,
    overLength: rows.filter((row) => row.winner === "draw" && row.overLength).length,
    decided: rows.filter((row) => row.winner === "draw" && !row.overLength).length,
  };
  const decided = wins.blue + wins.red;
  const lengths = rows.map((row) => row.lengthSec);
  const perTeam = Object.fromEntries(TEAMS.map((team) => [team, {
    kills: {
      total: rows.reduce((sum, row) => sum + row.kills[team], 0),
      mean: mean(rows.map((row) => row.kills[team])),
    },
    deaths: roleTotals(rows, team, "deaths"),
    deathsByTeam: {
      total: rows.reduce((sum, row) => sum + row.deathsLog.filter((d) => d.team === team).length, 0),
      mean: mean(rows.map((row) => row.deathsLog.filter((d) => d.team === team).length)),
    },
    respawns: {
      total: rows.reduce((sum, row) => sum + row.respawns[team], 0),
      mean: mean(rows.map((row) => row.respawns[team])),
    },
    underStrength: {
      secondsMean: mean(rows.map((row) => row.underStrengthSec[team])),
      shareMean: mean(rows.map((row) =>
        row.lengthSec > 0 ? row.underStrengthSec[team] / row.lengthSec : 0)),
    },
    killsByRole: roleTotals(rows, team, "killsByRole"),
    fielded: roleTotals(rows, team, "fielded"),
    middle: {
      tankSecondsMean: mean(rows.map((row) => row.middleTankSeconds[team])),
      occupiedShareMean: mean(rows.map((row) =>
        row.lengthSec > 0 ? row.middleOccupiedSeconds[team] / row.lengthSec : 0)),
      concurrentMean: mean(rows.map((row) =>
        row.lengthSec > 0 ? row.middleTankSeconds[team] / row.lengthSec : 0)),
    },
    zoneHold: {
      secondsMean: mean(rows.map((row) => row.zoneHoldSeconds[team])),
      shareMean: mean(rows.map((row) =>
        row.lengthSec > 0 ? row.zoneHoldSeconds[team] / row.lengthSec : 0)),
    },
    orders: {
      total: rows.reduce((sum, row) => sum + row.orders[team], 0),
      mean: mean(rows.map((row) => row.orders[team])),
    },
    decisiveWinRate: decided ? wins[team] / decided : 0,
  }])) as Record<TeamId, {
    kills: { total: number; mean: number };
    killsByRole: Partial<Record<Role, number>>;
    deaths: Partial<Record<Role, number>>;
    deathsByTeam: { total: number; mean: number };
    respawns: { total: number; mean: number };
    underStrength: { secondsMean: number; shareMean: number };
    fielded: Partial<Record<Role, number>>;
    middle: Summary["middle"][TeamId];
    zoneHold: Summary["zone"]["hold"][TeamId];
    orders: { total: number; mean: number };
    decisiveWinRate: number;
  }>;
  const traced = rows.filter((row) => row.baseHp.length);
  return {
    params,
    wins,
    winRate: {
      blue: rows.length ? wins.blue / rows.length : 0,
      red: rows.length ? wins.red / rows.length : 0,
      draw: rows.length ? wins.draw / rows.length : 0,
    },
    decisiveWinRate: {
      blue: perTeam.blue.decisiveWinRate,
      red: perTeam.red.decisiveWinRate,
    },
    draws,
    length: {
      mean: mean(lengths),
      median: median(lengths),
      min: lengths.length ? Math.min(...lengths) : 0,
      max: lengths.length ? Math.max(...lengths) : 0,
    },
    kills: Object.fromEntries(TEAMS.map((team) => [team, perTeam[team].kills])) as Summary["kills"],
    killsByRole: Object.fromEntries(TEAMS.map((team) => [team, perTeam[team].killsByRole])) as Summary["killsByRole"],
    deaths: Object.fromEntries(TEAMS.map((team) => [team, perTeam[team].deaths])) as Summary["deaths"],
    deathsByTeam: Object.fromEntries(TEAMS.map((team) => [team,
      perTeam[team].deathsByTeam])) as Summary["deathsByTeam"],
    respawns: Object.fromEntries(TEAMS.map((team) => [team,
      perTeam[team].respawns])) as Summary["respawns"],
    underStrength: Object.fromEntries(TEAMS.map((team) => [team,
      perTeam[team].underStrength])) as Summary["underStrength"],
    fielded: Object.fromEntries(TEAMS.map((team) => [team, perTeam[team].fielded])) as Summary["fielded"],
    middle: Object.fromEntries(TEAMS.map((team) => [team, perTeam[team].middle])) as Summary["middle"],
    zone: {
      hold: Object.fromEntries(TEAMS.map((team) =>
        [team, perTeam[team].zoneHold])) as Summary["zone"]["hold"],
      contestedShareMean: mean(rows.map((row) =>
        row.lengthSec > 0 ? row.zoneContestedSeconds / row.lengthSec : 0)),
      openShareMean: mean(rows.map((row) => {
        if (row.lengthSec <= 0) return 0;
        const claimed = row.zoneHoldSeconds.blue + row.zoneHoldSeconds.red + row.zoneContestedSeconds;
        return Math.max(0, 1 - claimed / row.lengthSec);
      })),
    },
    baseHp: traced.length ? {
      buckets: baseHpCurve(traced, 10, params.maxLengthSec),
      finalPct: Object.fromEntries(TEAMS.map((team) => [team,
        mean(traced.map((row) => row.baseHp.at(-1)![team] / CONFIG.baseHp))])) as Record<TeamId, number>,
      destroyed: Object.fromEntries(TEAMS.map((team) => [team,
        traced.filter((row) => row.baseHp.at(-1)![team] <= 0).length])) as Record<TeamId, number>,
    } : null,
    orders: Object.fromEntries(TEAMS.map((team) => [team, perTeam[team].orders])) as Summary["orders"],
    intents: Object.fromEntries(TEAMS.map((team) => [team, intentTotals(rows, team)])) as Summary["intents"],
  };
}

/** Spec fields the batch used, so the JSON and the tables describe one run. */
export function batchParams(spec: MatchSpec, matches: number): BatchParams {
  return {
    matches,
    seed: spec.seed,
    mode: spec.mode,
    arena: spec.arena,
    mapSeed: spec.mapSeed,
    share: spec.share,
    difficulty: spec.difficulty,
    profiles: { ...spec.profiles },
    hz: spec.hz,
    maxLengthSec: spec.maxLengthSec,
    middleBandFraction: spec.middleBandFraction,
    baseSampleSec: spec.baseSampleSec,
    underStrengthAlive: spec.underStrengthAlive,
  };
}
