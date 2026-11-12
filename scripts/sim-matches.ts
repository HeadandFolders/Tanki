/**
 * Headless batch runner: `npm run sim -- --matches 50 --seed 1`
 * Plays scripted-vs-scripted matches with no rendering and prints summary
 * tables. Full per-match detail goes to a JSON file. See --help.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { COMMANDER_PROFILES, type CommanderProfile } from "../src/ai-commander.ts";
import { baseWarMap } from "../src/arena-bases.ts";
import { TOOL_NAMES } from "../src/command-schema.ts";
import { CONFIG, type ArenaId, type GameMode, type RedDifficulty, type Role, type ShareMode } from "../src/config.ts";
import { RESPAWN, TANK_TYPE_IDS } from "../src/config/balance.ts";
import { matchSeeds, matchSpec, runMatch, TEAMS, type MatchRecord } from "../src/sim/match.ts";
import { batchParams, summarize, type Summary } from "../src/sim/summary.ts";

const MODES: readonly GameMode[] = ["base-war", "mp-offline", "tdm"];
const ARENAS: readonly ArenaId[] = ["large", "dense", "reference", "standard"];
const SHARES: readonly ShareMode[] = ["clear", "auto", "report", "none"];
const DIFFICULTIES: readonly RedDifficulty[] = ["easy", "normal", "hard"];

// Every applied order is debug-logged; a batch would bury the tables in it.
console.debug = () => {};

const USAGE = [
  "usage: npm run sim -- [options]",
  "  --matches N        matches in the batch (default " + CONFIG.sim.defaultMatches + ")",
  "  --seed S           batch seed; each match derives its own seeds (default 1)",
  "  --blue PROFILE     tactical|default|rusher|turtle for blue (default tactical)",
  "  --red PROFILE      same options for red (default tactical)",
  "  --mode M           " + MODES.join("|") + " (default base-war; only it has bases to measure)",
  "  --arena A          " + ARENAS.join("|") + " (also --map; default " + CONFIG.arenaDefault + ")",
  "  --share S          " + SHARES.join("|") + " (default clear, i.e. no fog)",
  "  --difficulty D     " + DIFFICULTIES.join("|") + " order quality for both commanders (default normal)",
  "  --max-length SEC   a match still playing here ends as an over-length draw (default " +
    CONFIG.sim.maxLengthSec + ")",
  "  --hz 30|60         fixed simulation step (default " + CONFIG.sim.hz + ")",
  "  --middle-band F    middle area = central F of map height (default " + CONFIG.sim.middleBandFraction + ")",
  "  --base-sample SEC  base HP sample interval (default " + CONFIG.sim.baseSampleSec + "s)",
  "  --under-strength N count team time below N living hulls (default " +
    CONFIG.sim.underStrengthAlive + ")",
  "  --out PATH         JSON write target (default logs/sim-<matchup>-<mode>-<map>-<matches>mx<seed>.json)",
  "  --rows             also print one row per match",
  "  --help             this text",
].join("\n");

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function valueOf(args: string[], i: number, flag: string): string {
  if (i + 1 >= args.length) fail(`--${flag} needs a value`);
  return args[i + 1]!;
}

function listOf<T>(raw: string, allowed: readonly T[], flag: string, label: string): T {
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  return fail(`--${flag} ${label} must be one of ${allowed.join("|")} (got "${raw}")`);
}

function profileOf(raw: string, flag: string): CommanderProfile {
  if (raw === "default") return "tactical";
  return listOf(raw, COMMANDER_PROFILES, flag, "profile");
}

function numberOf(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${flag} must be a number (got "${raw}")`);
  return n;
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

let matches = CONFIG.sim.defaultMatches;
let seed = 1;
let blue: CommanderProfile = "tactical";
let red: CommanderProfile = "tactical";
let mode: GameMode = "base-war";
let arena: ArenaId = CONFIG.arenaDefault;
let share: ShareMode = "clear";
let difficulty: RedDifficulty = "normal";
let maxLengthSec = CONFIG.sim.maxLengthSec;
let hz = CONFIG.sim.hz;
let middleBand = CONFIG.sim.middleBandFraction;
let baseSampleSec = CONFIG.sim.baseSampleSec;
let underStrengthAlive = CONFIG.sim.underStrengthAlive;
let out = "";
let rows = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (!arg.startsWith("--")) fail(`unexpected argument "${arg}"`);
  const flag = arg.slice(2);
  switch (flag) {
    case "matches": matches = Math.trunc(numberOf(valueOf(args, i++, flag), flag)); break;
    case "seed": seed = Math.trunc(numberOf(valueOf(args, i++, flag), flag)); break;
    case "blue": blue = profileOf(valueOf(args, i++, flag), flag); break;
    case "red": red = profileOf(valueOf(args, i++, flag), flag); break;
    case "mode": mode = listOf(valueOf(args, i++, flag), MODES, flag, "mode"); break;
    case "arena":
    case "map": arena = listOf(valueOf(args, i++, flag), ARENAS, flag, "map"); break;
    case "share": share = listOf(valueOf(args, i++, flag), SHARES, flag, "share mode"); break;
    case "difficulty": difficulty = listOf(valueOf(args, i++, flag), DIFFICULTIES, flag, "difficulty"); break;
    case "max-length": maxLengthSec = numberOf(valueOf(args, i++, flag), flag); break;
    case "hz": hz = numberOf(valueOf(args, i++, flag), flag); break;
    case "middle-band": middleBand = numberOf(valueOf(args, i++, flag), flag); break;
    case "base-sample": baseSampleSec = numberOf(valueOf(args, i++, flag), flag); break;
    case "under-strength": underStrengthAlive = numberOf(valueOf(args, i++, flag), flag); break;
    case "out": out = valueOf(args, i++, flag); break;
    case "rows": rows = true; break;
    default: fail(`unknown option --${flag}`);
  }
}

if (!Number.isInteger(matches) || matches < 1) fail("--matches must be a positive integer");
if (hz !== 30 && hz !== 60) fail("--hz must be 30 or 60");
if (!(maxLengthSec > 0)) fail("--max-length must be positive");
if (!(middleBand > 0 && middleBand <= 1)) fail("--middle-band must be in (0, 1]");
if (!(baseSampleSec > 0)) fail("--base-sample must be positive");
if (!Number.isInteger(underStrengthAlive) || underStrengthAlive < 1) {
  fail("--under-strength must be a whole number of hulls, at least 1");
}
if (mode === "base-war" && !baseWarMap(arena)) {
  fail(`Base War has no bases on the ${arena} map; use --map dense or large`);
}
const engineClockSec = mode === "base-war" ? CONFIG.matchTimeLimitSec : CONFIG.matchDurationSec;
if (maxLengthSec >= engineClockSec) {
  console.log(`note: --max-length ${maxLengthSec}s is at or above the ${mode} clock (${engineClockSec}s),` +
    " so the engine's own timeout decides first.");
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const sec = (x: number): string => x.toFixed(1);

function table(title: string, header: string[], body: string[][]): void {
  const widths = header.map((cell, col) =>
    Math.max(cell.length, ...body.map((row) => (row[col] ?? "").length)));
  const line = (cells: string[]): string =>
    cells.map((cell, col) => (col === 0 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!)))
      .join("  ").trimEnd();
  console.log(`\n${title}`);
  console.log(`  ${line(header)}`);
  for (const row of body) console.log(`  ${line(row)}`);
}

console.log(`sim: ${matches} scripted matches, no rendering, ${hz} Hz fixed step`);
console.log(`  mode=${mode} arena=${arena} share=${share} difficulty=${difficulty}`);
console.log(`  blue=${blue}  red=${red}  seed=${seed}  first match world seed=${matchSeeds(seed, 0).world}`);
console.log(`  max length=${sec(maxLengthSec)}s  middle band=central ${pct(middleBand)} of map height` +
  `  base HP sample=${sec(baseSampleSec)}s`);
console.log(`  respawn delay=${RESPAWN.delaySec}s + ${RESPAWN.protectionSec}s protection at own base` +
  `  under strength=fewer than ${underStrengthAlive} hulls alive`);

const started = performance.now();
const results: MatchRecord[] = [];
const spec = matchSpec({
  seed, mode, arena, share, difficulty, hz, maxLengthSec,
  middleBandFraction: middleBand, baseSampleSec, underStrengthAlive,
  profiles: { blue, red },
});
for (let index = 0; index < matches; index++) {
  results.push(runMatch({ ...spec, index }));
  if ((index + 1) % 10 === 0) process.stdout.write(`  ...${index + 1}/${matches}\n`);
}
const wallSec = (performance.now() - started) / 1000;
console.log(`  played ${matches} matches in ${wallSec.toFixed(1)}s wall clock` +
  ` (${(matches / wallSec).toFixed(1)} matches/s, ` +
  `${(results.reduce((sum, r) => sum + r.lengthSec, 0) / wallSec).toFixed(0)}x realtime)`);

const summary: Summary = summarize(results, batchParams(spec, matches));

table("WIN RATE BY SIDE",
  ["side", "commander", "wins", "of all matches", "of decided matches"],
  TEAMS.map((team) => [
    team, summary.params.profiles[team],
    String(summary.wins[team]),
    pct(summary.winRate[team]),
    pct(summary.decisiveWinRate[team]),
  ]));
console.log(`  draws: ${summary.draws.total}/${matches} (${pct(summary.winRate.draw)}) — ` +
  `${summary.draws.overLength} over the length cap, ${summary.draws.decided} decided in play`);

table("MATCH LENGTH (SECONDS)", ["mean", "median", "min", "max", "ended by a clock"], [
  [sec(summary.length.mean), sec(summary.length.median), sec(summary.length.min), sec(summary.length.max),
    `${results.filter((row) => row.overLength).length}/${matches}`],
]);

table("KILLS AND DEATHS", ["team", "kills", "deaths by hull type", "kills/match"],
  TEAMS.map((team) => [
    team, String(summary.kills[team].total),
    Object.entries(summary.deaths[team]).map(([role, n]) => `${role} ${n}`).join(", ") || "none",
    summary.kills[team].mean.toFixed(2),
  ]));

table("RESPAWN", ["team", "deaths", "deaths/match", "respawns", "respawns/match",
  `below ${underStrengthAlive} alive`, "share of match"],
  TEAMS.map((team) => [
    team,
    String(summary.deathsByTeam[team].total),
    summary.deathsByTeam[team].mean.toFixed(2),
    String(summary.respawns[team].total),
    summary.respawns[team].mean.toFixed(2),
    `${summary.underStrength[team].secondsMean.toFixed(1)}s`,
    pct(summary.underStrength[team].shareMean),
  ]));
if (TEAMS.every((team) => summary.respawns[team].total === 0)) {
  console.log("  nothing came back: respawns run under the multiplayer rules only" +
    " (mp-offline, mp-online, base-war), or the batch ended before the delay.");
}

const typeRows = TANK_TYPE_IDS.map((role) => ({
  role: role as Role,
  fielded: TEAMS.reduce((sum, team) => sum + (summary.fielded[team][role] ?? 0), 0),
  kills: TEAMS.reduce((sum, team) => sum + (summary.killsByRole[team][role] ?? 0), 0),
  deaths: TEAMS.reduce((sum, team) => sum + (summary.deaths[team][role] ?? 0), 0),
})).filter((row) => row.fielded > 0);
const typeKills = typeRows.reduce((sum, row) => sum + row.kills, 0);
const typeFielded = typeRows.reduce((sum, row) => sum + row.fielded, 0);

table("HULL TYPES (both teams pooled)",
  ["type", "hulls", "share of fielded", "kills", "share of kills", "deaths", "K/D", "deaths per hull"],
  typeRows.map((row) => [
    CONFIG.roles[row.role].label,
    String(row.fielded),
    pct(typeFielded ? row.fielded / typeFielded : 0),
    String(row.kills),
    pct(typeKills ? row.kills / typeKills : 0),
    String(row.deaths),
    row.deaths ? (row.kills / row.deaths).toFixed(2) : row.kills ? "no deaths" : "—",
    (row.deaths / row.fielded).toFixed(2),
  ]));
const unattributed = TEAMS.reduce((sum, team) => sum + summary.kills[team].total, 0) - typeKills;
if (unattributed > 0) console.log(`  ${unattributed} kills had no hull type`);

table("MIDDLE AREA", ["team", "tank-seconds", "avg tanks there", "share of match with a tank there"],
  TEAMS.map((team) => [
    team,
    summary.middle[team].tankSecondsMean.toFixed(1),
    summary.middle[team].concurrentMean.toFixed(2),
    pct(summary.middle[team].occupiedShareMean),
  ]));

if (summary.baseHp) {
  table("BASE HP OVER TIME (mean of matches still running in the bucket)",
    ["by t<=", "samples", "blue %", "red %"],
    summary.baseHp.buckets.map((bucket) => [
      `${sec(bucket.t)}s`, String(bucket.samples),
      Number.isNaN(bucket.bluePct) ? "—" : pct(bucket.bluePct),
      Number.isNaN(bucket.redPct) ? "—" : pct(bucket.redPct),
    ]).concat([
      ["final", String(matches), pct(summary.baseHp.finalPct.blue), pct(summary.baseHp.finalPct.red)],
      ["destroyed", String(matches), String(summary.baseHp.destroyed.blue),
        String(summary.baseHp.destroyed.red)],
    ]));
} else {
  console.log("\nBASE HP OVER TIME: no bases in this mode (use --mode base-war)");
}

table("ORDERS APPLIED", ["team", "total", "per match"],
  TEAMS.map((team) => [team, String(summary.orders[team].total), summary.orders[team].mean.toFixed(1)]));

const intentTools = TOOL_NAMES.filter((tool) => TEAMS.some((team) => summary.intents[team][tool]));
table("ORDERS BY INTENT", ["intent", "blue", "red"], intentTools.length
  ? intentTools.map((tool) => [
    tool, String(summary.intents.blue[tool] ?? 0), String(summary.intents.red[tool] ?? 0)])
  : [["none", "0", "0"]]);

if (rows) {
  table("PER MATCH",
    ["#", "world seed", "winner", "length", "kills B/R", "mid B/R (s)", "base HP B/R", "reason"],
    results.map((row) => [
      String(row.index + 1), String(row.seed), row.winner, sec(row.lengthSec),
      `${row.kills.blue}/${row.kills.red}`,
      `${row.middleTankSeconds.blue.toFixed(0)}/${row.middleTankSeconds.red.toFixed(0)}`,
      row.baseHp.length
        ? `${(row.baseHp.at(-1)!.blue / CONFIG.baseHp * 100).toFixed(0)}%/` +
          `${(row.baseHp.at(-1)!.red / CONFIG.baseHp * 100).toFixed(0)}%`
        : "—",
      row.reason,
    ]));
}

const outPath = resolve(out || join("logs",
  `sim-${blue}-vs-${red}-${mode}-${arena}-${matches}mx${seed}.json`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ params: summary.params, summary, matches: results }, null, 2));
console.log(`\nwrote ${outPath}`);
