/**
 * Per-map fairness sweep: play the same scripted matchup on a run of generated
 * maps and report the win rate by side for each seed's map, together with the
 * base damage and kill split, flagging the seeds where one side comes out ahead.
 *
 * Run: npm run sim:mapsweep -- [--seeds 20] [--start 1000] [--matches 1]
 *   --seeds N       how many map seeds to sweep
 *   --start S       first map seed
 *   --matches N     matches played on each map (each gets its own world seed)
 *   --mode M        base-war|mp-offline|tdm (default base-war)
 *   --max-length S  clock per match; the default is the engine's own base-war limit,
 *                   since the batch default is shorter than one crossing of this map
 *   --hz 30|60      fixed simulation step (default CONFIG.sim.hz)
 *   --p P           flag a map whose win split has under P chance under a fair coin
 *                   (needs --matches 4 or more to mean anything; see the note below)
 *   --skew R        flag a clock-decided map where one side dealt R x the other's base damage
 *   --out PATH      JSON write target (default logs/map-sweep-<seeds>x<matches>.json)
 *
 * What a flag can and cannot mean. The terrain is its own 180° rotation, so one
 * base can never be nearer, better covered or better sighted than the other —
 * `eval:mapgen` proves that per seed. So a flagged map is not a lopsided map, it
 * is the matchup coming out one-sided on that map, and the honest reading is the
 * pooled win rate over all the maps, not any single row.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG, type ArenaId, type GameMode } from "../src/config.ts";
import { MAP_GEN } from "../src/config/balance.ts";
import { describeMapSize, generatedMap, type GeneratedMap, type MapRoute } from "../src/mapgen.ts";
import { matchSpec, runMatch, type MatchRecord } from "../src/sim/match.ts";

const MODES: readonly GameMode[] = ["base-war", "mp-offline", "tdm"];
const ARENA: ArenaId = "generated";

// Every applied order is debug-logged; a sweep would bury its own table in it.
console.debug = () => {};

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number (got "${process.argv[i + 1]}")`);
  return n;
}

const seeds = Math.trunc(arg("seeds", 20));
const firstSeed = Math.trunc(arg("start", MAP_GEN.seedDefault));
const matches = Math.trunc(arg("matches", 1));
const flagP = arg("p", 0.05);
const skewFlag = arg("skew", 1.6);
/**
 * Below this share of a base knocked off, the damage ratio is one small number
 * over another and flags on noise, so a clock-decided map is only skew-flagged
 * when both sides got at least this far.
 */
const damageFloor = 0.05;
/** A win split has no statistical power until there are enough matches to split. */
const minMatchesForWinFlag = 4;
const maxLengthSec = arg("max-length", CONFIG.matchTimeLimitSec);
const hz = Math.trunc(arg("hz", CONFIG.sim.hz));
const modeIndex = process.argv.indexOf("--mode");
const modeRaw = modeIndex < 0 ? "base-war" : process.argv[modeIndex + 1]!;
if (!(MODES as readonly string[]).includes(modeRaw)) {
  throw new Error(`--mode must be one of ${MODES.join("|")} (got "${modeRaw}")`);
}
const gameMode = modeRaw as GameMode;
const outIndex = process.argv.indexOf("--out");
const jsonPath = resolve(
  outIndex < 0 ? `logs/map-sweep-${seeds}x${matches}.json` : process.argv[outIndex + 1]!,
);

/** Chance of a split at least this lopsided, both tails, under a fair coin. */
function binomialTwoSided(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  let tail = 0;
  for (let k = Math.max(wins, losses); k <= n; k++) {
    let coef = 1;
    for (let j = 0; j < k; j++) coef = (coef * (n - j)) / (j + 1);
    tail += coef / 2 ** n;
  }
  return Math.min(1, 2 * tail);
}

/** Mean share of the named team's base that the other side knocked off by the clock. */
function baseDamage(records: MatchRecord[], victim: "blue" | "red"): number {
  const dealt = records.map((r) => {
    const last = r.baseHp.at(-1);
    return last ? (CONFIG.baseHp - last[victim]) / CONFIG.baseHp : 0;
  });
  return dealt.reduce((s, v) => s + v, 0) / Math.max(1, dealt.length);
}

function routeOf(map: GeneratedMap, role: MapRoute["role"]): MapRoute | undefined {
  return map.routes.find((r) => r.role === role);
}

const line = (cells: string[]): string =>
  cells.map((c, i) => (i === 0 ? c : c.padStart(9))).join(" ");

const COLUMNS = [
  "map", "drive", "direct", "protect", "zone", "blue", "red", "draw",
  "dmg>red", "dmg>blue", "skew", "kills", "chance", "verdict",
];

console.log(describeMapSize());
console.log(`  ${seeds} map seed(s) from ${firstSeed}, ${matches} match(es) each at ${hz}Hz,` +
  ` mode=${gameMode}, clock ${maxLengthSec}s, tactical vs tactical`);
console.log(`  FLAG = a win split under ${(flagP * 100).toFixed(0)}% chance` +
  (matches < minMatchesForWinFlag
    ? ` (off at ${matches} match${matches === 1 ? "" : "es"} per map: a 1-0 split is p=1.0 by construction —` +
      ` use --matches ${minMatchesForWinFlag} or more)`
    : ""));
console.log(`  FLAG = a map where no base fell and one side dealt over ${skewFlag}x the other's base damage,` +
  ` with both sides past ${(damageFloor * 100).toFixed(0)}% so the ratio is not noise`);
console.log(`  the terrain is a 180° mirror, so a flag points at the matchup on the map, never at the map itself`);
console.log(`  a bare crossing costs ${MAP_GEN.baseToBaseSec.min}-${MAP_GEN.baseToBaseSec.max}s, so the clock` +
  " usually decides before a base does\n");
console.log(line(COLUMNS));

const rows: Array<Record<string, unknown>> = [];
const flagged: number[] = [];
const totals = { blue: 0, red: 0, draw: 0 };
const skewTo = { blue: 0, red: 0 };
let basesTotal = 0;
let msTotal = 0;

for (let i = 0; i < seeds; i++) {
  const mapSeed = firstSeed + i;
  const map = generatedMap(mapSeed);
  const spec = matchSpec({
    seed: mapSeed,
    mode: gameMode,
    arena: ARENA,
    mapSeed,
    share: "clear",
    maxLengthSec,
    hz,
  });
  const t0 = performance.now();
  const results: MatchRecord[] = [];
  for (let index = 0; index < matches; index++) {
    results.push(runMatch({ ...spec, index }));
  }
  msTotal += performance.now() - t0;

  const wins = { blue: 0, red: 0, draw: 0 };
  const kills = { blue: 0, red: 0 };
  for (const r of results) {
    wins[r.winner]++;
    kills.blue += r.kills.blue;
    kills.red += r.kills.red;
  }
  totals.blue += wins.blue;
  totals.red += wins.red;
  totals.draw += wins.draw;

  const dmg = { red: baseDamage(results, "red"), blue: baseDamage(results, "blue") };
  const skew = Math.max(dmg.red, dmg.blue) / Math.max(0.01, Math.min(dmg.red, dmg.blue));
  const ahead = dmg.red >= dmg.blue ? "blue" : "red";
  const p = binomialTwoSided(wins.blue, wins.red);
  const decided = wins.blue + wins.red;
  /* A base that falls is at 0% and the side that dropped it is at 100% by
     definition, so the damage ratio only says something when no base fell and
     the clock resolved the match on HP. */
  const basesTaken = results.filter((r) => r.reason === "Base destroyed");
  const takeSec = basesTaken.length
    ? basesTaken.reduce((s, r) => s + r.lengthSec, 0) / basesTaken.length
    : 0;
  const winFlag = matches >= minMatchesForWinFlag && p < flagP;
  const damageFlag =
    basesTaken.length === 0 && Math.min(dmg.red, dmg.blue) >= damageFloor && skew > skewFlag;
  if (winFlag || damageFlag) flagged.push(mapSeed);
  if (damageFlag) skewTo[ahead]++;
  basesTotal += basesTaken.length;

  const secs = (role: MapRoute["role"]): string => {
    const r = routeOf(map, role);
    return r ? `${r.travelSec.toFixed(1)}s` : "none";
  };
  console.log(
    line([
      String(mapSeed),
      `${map.shortestSec.toFixed(1)}s`,
      secs("direct"),
      secs("protected"),
      secs("zone"),
      String(wins.blue),
      String(wins.red),
      String(wins.draw),
      `${(dmg.red * 100).toFixed(0)}%`,
      `${(dmg.blue * 100).toFixed(0)}%`,
      `${skew.toFixed(2)}:${ahead}`,
      `${kills.blue}/${kills.red}`,
      p.toFixed(3),
      winFlag
        ? `FLAG ${wins.blue}-${wins.red} wins`
        : damageFlag
          ? `FLAG ${ahead} on damage`
          : basesTaken.length === results.length && decided
            ? `${wins.blue >= wins.red ? "blue" : "red"} took a base in ${takeSec.toFixed(0)}s`
            : basesTaken.length > 0
              ? `${basesTaken.length}/${results.length} bases taken`
              : decided === 0
                ? "no base fell"
                : `${wins.blue >= wins.red ? "blue" : "red"} ahead on base HP`,
    ]),
  );
  rows.push({
    mapSeed,
    forced: map.forced,
    attempts: map.attempts,
    routes: map.routes.map((r) => ({
      role: r.role,
      tiles: Math.round(r.lengthPx / CONFIG.tileSize),
      travelSec: Number(r.travelSec.toFixed(1)),
      exposedShare: Number(r.exposedShare.toFixed(3)),
      throughZone: r.throughZone,
    })),
    wins,
    kills,
    baseDamageDealt: { byBlue: Number(dmg.red.toFixed(3)), byRed: Number(dmg.blue.toFixed(3)) },
    basesTaken: basesTaken.length,
    baseTakeSec: Number(takeSec.toFixed(1)),
    chance: Number(p.toFixed(4)),
    flagged: winFlag || damageFlag,
    flagReason: winFlag ? "wins" : damageFlag ? "damage" : null,
    matches: results.map((r) => ({
      winner: r.winner,
      lengthSec: Number(r.lengthSec.toFixed(1)),
      reason: r.reason,
      kills: { ...r.kills },
    })),
  });
}

const decided = totals.blue + totals.red;
const pooledP = binomialTwoSided(totals.blue, totals.red);
console.log(`\n=== ${seeds} maps x ${matches} match(es) = ${seeds * matches} matches in` +
  ` ${(msTotal / 1000).toFixed(0)}s (${(msTotal / 1000 / Math.max(1, seeds * matches)).toFixed(0)}s per match)`);
console.log(
  `  pooled wins: blue ${totals.blue}, red ${totals.red}, draws ${totals.draw}` +
    (decided
      ? `  -> blue ${((100 * totals.blue) / decided).toFixed(0)}% of decided, chance ${pooledP.toFixed(3)}`
      : "  -> no base fell, so wins alone cannot judge these maps"),
);
console.log(`  bases destroyed in ${basesTotal} of ${seeds * matches} match(es); the rest ran the clock`);
const skewedTotal = skewTo.blue + skewTo.red;
console.log(
  `  clock-decided maps where one side dealt over ${skewFlag}x the base damage: ${skewedTotal} of ${seeds}` +
    (skewedTotal
      ? `  -> ${skewTo.blue} for blue, ${skewTo.red} for red,` +
        ` chance that split is ${(binomialTwoSided(skewTo.blue, skewTo.red) * 100).toFixed(0)}%`
      : ""),
);
if (matches < minMatchesForWinFlag) {
  console.log(`  per-map win flags are off at ${matches} match${matches === 1 ? "" : "es"} per map — read the pooled` +
    " line, not a row. The terrain cannot be the cause of any of these: each map is its own 180° rotation.");
}
console.log(`  flagged seeds: ${flagged.length ? flagged.join(", ") : "none"}`);
mkdirSync("logs", { recursive: true });
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      params: {
        seeds, firstSeed, matches, mode: gameMode, arena: ARENA, maxLengthSec, hz,
        flagP, skewFlag, damageFloor, minMatchesForWinFlag,
      },
      totals,
      basesTaken: basesTotal,
      flagged,
      rows,
    },
    null,
    2,
  ),
);
console.log(`  wrote ${jsonPath}`);
process.exit(flagged.length === 0 ? 0 : 2);
