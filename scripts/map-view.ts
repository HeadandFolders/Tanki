/**
 * Overhead SVG of the large arena: walls, the two-tile squeezes, zone anchors
 * with their mirrored pairs, and the spawn / base boxes.
 * Run: npx tsx scripts/map-view.ts [seed]  -> maps/large-<seed>.svg
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArena } from "../src/arena.ts";
import { LARGE_BASE_TILES, LARGE_SPAWN_TILES, largeArenaZones } from "../src/arena-large.ts";
import { tankStanceGraph, wallGrid } from "../src/arena-routes.ts";
import { CONFIG } from "../src/config.ts";

const seed = Number(process.argv[2] ?? CONFIG.largeArena.seed);
const walls = buildArena("large", seed);
const { grid, cols, rows } = wallGrid(walls);
const S = CONFIG.tileSize;
const zones = largeArenaZones(seed);

const graph = tankStanceGraph(walls);
const hasStance = new Uint8Array(cols * rows);
for (const n of graph.nodes) hasStance[n.ty * cols + n.tx] = 1;
const open = (x: number, y: number) =>
  x >= 0 && y >= 0 && x < cols && y < rows && grid[y * cols + x] === 0;
function run(x: number, y: number, dx: number, dy: number): number {
  let n = 1;
  for (let k = 1; open(x + dx * k, y + dy * k); k++) n++;
  for (let k = 1; open(x - dx * k, y - dy * k); k++) n++;
  return n;
}
const squeezes: string[] = [];
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    if (!hasStance[y * cols + x]) continue;
    if (Math.min(run(x, y, 1, 0), run(x, y, 0, 1)) === 2) {
      squeezes.push(`<rect x="${x * S}" y="${y * S}" width="${S}" height="${S}" fill="#f5a524" fill-opacity="0.55"/>`);
    }
  }
}

const box = (b: { x0: number; y0: number; x1: number; y1: number }, color: string, dash: string) =>
  `<rect x="${b.x0 * S}" y="${b.y0 * S}" width="${(b.x1 - b.x0 + 1) * S}" height="${(b.y1 - b.y0 + 1) * S}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="${dash}"/>`;

const zoneMarks = zones
  .map(
    (z) =>
      `<circle cx="${z.x}" cy="${z.y}" r="7" fill="#4cc9f0" stroke="#0b1020" stroke-width="1.5"/>` +
      `<text x="${z.x + 11}" y="${z.y - 7}" font-size="15" fill="#cfe3ff">${z.id}</text>`,
  )
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * S}" height="${rows * S}" viewBox="0 0 ${cols * S} ${rows * S}">
<rect width="100%" height="100%" fill="#101826"/>
${walls
  .map(
    (w) =>
      `<rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" fill="${w.kind === "border" ? "#3a4557" : "#b4553f"}"/>`,
  )
  .join("\n")}
${squeezes.join("\n")}
${box(LARGE_BASE_TILES.blue, "#4cc9f0", "6 4")}
${box(LARGE_BASE_TILES.red, "#e0596b", "6 4")}
${box(LARGE_SPAWN_TILES.blue, "#4cc9f0", "2 2")}
${box(LARGE_SPAWN_TILES.red, "#e0596b", "2 2")}
${zoneMarks}
<text x="16" y="${rows * S - 12}" font-size="16" fill="#8fa3c8">
seed ${seed} · ${cols}x${rows} tiles · ${walls.length} walls · ${squeezes.length} squeeze tiles · ${zones.length} zones
</text>
</svg>
`;

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "maps");
mkdirSync(out, { recursive: true });
const file = join(out, `large-${seed}.svg`);
writeFileSync(file, svg);
console.log(`${file}: ${cols}x${rows} tiles, ${walls.length} walls, ${squeezes.length} squeeze tiles, ${zones.length} zones`);
