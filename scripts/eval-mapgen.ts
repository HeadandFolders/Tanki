/**
 * Map generator audit: for each seed, build candidates until one passes (or
 * report that none did), print the three measured routes, re-check the accepted
 * map is its own 180° mirror, and collect why the rejects were rejected.
 *
 * Run: npx tsx scripts/eval-mapgen.ts [seedCount] [--seed N] [--attempts] [--svg]
 *   seedCount  how many seeds to try, from --seed (default 20)
 *   --seed N   first map seed
 *   --attempts audit each retry as its own candidate, instead of the chain
 *   --svg      write logs/mapgen-<seed>.svg dumps of the accepted maps
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { MAP_GEN, MAP_GEN_SIZE } from "../src/config/balance.ts";
import {
  describeMapSize,
  generateCandidate,
  generatedMap,
  generatedMapIsSymmetric,
  type GeneratedMap,
  type MapRoute,
} from "../src/mapgen.ts";

const argv = process.argv.slice(2);
const flags = new Set<string>();
let firstSeed = MAP_GEN.seedDefault;
let count = 20;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--seed") {
    firstSeed = Number(argv[++i]);
    continue;
  }
  if (a.startsWith("--")) {
    flags.add(a);
    continue;
  }
  if (/^\d+$/.test(a)) count = Number(a);
}
const perAttempt = flags.has("--attempts");
const wantSvg = flags.has("--svg");

const S = 16;
console.log(describeMapSize(MAP_GEN_SIZE));
console.log(
  `rules: exposed >=${MAP_GEN.rules.exposedShareMin}, protected <=${MAP_GEN.rules.protectedShareMax} exposed and ` +
    `${MAP_GEN.rules.protectedLengthMin}-${MAP_GEN.rules.protectedLengthMax}x, detour >=${MAP_GEN.rules.detourRatioMin}x, ` +
    `gap >=${MAP_GEN.rules.exposureGapMin}, route overlap <=${(MAP_GEN.rules.routeOverlapShareMax * 100).toFixed(0)}% ` +
    `of one route within ${MAP_GEN.rules.routeSeparationTiles} tiles of another, ` +
    `drive ${MAP_GEN.baseToBaseSec.min}-${MAP_GEN.baseToBaseSec.max}s, max ${MAP_GEN.rules.maxAttempts} attempts`,
);
console.log("");

const accepted: GeneratedMap[] = [];
const rejected: GeneratedMap[] = [];
const asymmetric: number[] = [];
const shortOfRoutes: number[] = [];
const reasons = new Map<string, number>();
let attemptTotal = 0;
let msTotal = 0;

function noteFailures(map: GeneratedMap): void {
  for (const f of map.failures) {
    const key = f.split(":")[0]!;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
}

function routeLine(route: MapRoute): string {
  return (
    `${route.role.padEnd(10)} ${(route.lengthPx / S).toFixed(0).padStart(4)} tiles ` +
    `${String(Math.round(route.lengthPx)).padStart(5)}px  ${route.travelSec.toFixed(1)}s  ` +
    `${(route.exposedShare * 100).toFixed(0).padStart(3)}% open  ` +
    `${route.throughZone ? "through the zone" : "-"}`
  );
}

for (let i = 0; i < count; i++) {
  const seed = firstSeed + i;
  const t0 = performance.now();
  const map = generatedMap(seed);
  msTotal += performance.now() - t0;
  attemptTotal += map.attempts;
  if (!generatedMapIsSymmetric(seed)) asymmetric.push(seed);
  if (map.routes.length < 3) shortOfRoutes.push(seed);
  const mirrored = !asymmetric.includes(seed);
  if (map.forced) rejected.push(map);
  else accepted.push(map);

  const verdict = map.forced ? "REJECT" : "ok";
  console.log(
    `seed ${seed}  ${verdict}  after ${map.attempts} attempt(s)  ` +
      `straight ${(map.straightPx / S).toFixed(0)} tiles  shortest ${map.shortestSec.toFixed(1)}s  ` +
      `routes ${map.routes.length}  ${mirrored ? "mirrored" : "NOT MIRRORED"}`,
  );
  for (const route of map.routes) console.log(`  ${routeLine(route)}`);
  if (map.forced) {
    for (const f of map.failures) console.log(`  fail ${f}`);
    noteFailures(map);
  }
  if (perAttempt && map.attempts > 1) {
    for (let a = 0; a < map.attempts - 1; a++) {
      const single = generateCandidate(seed + a * 7919);
      console.log(`  attempt ${a + 1} was rejected: ${single.failures.join("; ") || "(passed?)"}`);
      noteFailures(single);
    }
  }
  if (wantSvg && !map.forced) dumpSvg(map, seed);
}

function dumpSvg(map: GeneratedMap, seed: number): void {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${map.cols * S}" height="${map.rows * S}" viewBox="0 0 ${map.cols * S} ${map.rows * S}">`,
    `<rect width="100%" height="100%" fill="#202020"/>`,
  ];
  for (const w of map.walls) {
    const fill = w.kind === "border" ? "#8a8a90" : w.kind === "steel" ? "#c0c0c8" : "#b05028";
    parts.push(`<rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" fill="${fill}"/>`);
  }
  const colors: Record<MapRoute["role"], string> = {
    direct: "#f0d060",
    protected: "#4ad07a",
    zone: "#b45ad0",
  };
  for (const route of map.routes) {
    const d = route.points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    parts.push(
      `<path d="${d}" fill="none" stroke="${colors[route.role]}" stroke-width="14" stroke-opacity="0.75" stroke-linecap="round"/>`,
    );
  }
  parts.push("</svg>");
  mkdirSync("logs", { recursive: true });
  writeFileSync(`logs/mapgen-${seed}.svg`, parts.join(""));
}

const rate = accepted.length / count;
console.log("");
console.log(`=== ${count} seeds: ${accepted.length} accepted, ${rate * 100}% first-chain success, ` +
  `${(attemptTotal / Math.max(1, count)).toFixed(2)} attempts per map, ${(msTotal / Math.max(1, count)).toFixed(0)}ms per map`);
console.log(`  mirrored 180°: ${count - asymmetric.length}/${count}` +
    (asymmetric.length ? ` — broken on ${asymmetric.join(", ")}` : ""));
console.log(`  three routes measured: ${count - shortOfRoutes.length}/${count}` +
    (shortOfRoutes.length ? ` — short on ${shortOfRoutes.join(", ")}` : ""));

function summarise(name: string, pick: (m: GeneratedMap) => MapRoute | undefined): void {
  const rows = accepted.map(pick).filter((r): r is MapRoute => !!r);
  if (rows.length === 0) {
    console.log(`  ${name}: none`);
    return;
  }
  const tiles = rows.map((r) => r.lengthPx / S);
  const secs = rows.map((r) => r.travelSec);
  const exposure = rows.map((r) => r.exposedShare);
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
  const spread = (a: number[]): string => `${Math.min(...a).toFixed(1)}-${Math.max(...a).toFixed(1)}`;
  console.log(
    `  ${name}: mean ${mean(tiles).toFixed(0)} tiles / ${mean(secs).toFixed(1)}s, ` +
      `range ${spread(tiles)} tiles / ${spread(secs)}s, mean ${(mean(exposure) * 100).toFixed(0)}% open`,
  );
}

const byRole = (role: MapRoute["role"]) => (m: GeneratedMap): MapRoute | undefined =>
  m.routes.find((r) => r.role === role);
summarise("direct (short, exposed)", byRole("direct"));
summarise("protected (long, covered)", byRole("protected"));
summarise("zone (through the middle)", byRole("zone"));

if (reasons.size > 0) {
  console.log("  rejected for:");
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}x ${reason}`);
  }
} else {
  console.log("  no rejects");
}

if (wantSvg) console.log(`  svg dumps in logs/mapgen-<seed>.svg`);
process.exit(
  accepted.length === count && asymmetric.length === 0 && shortOfRoutes.length === 0 ? 0 : 1,
);
