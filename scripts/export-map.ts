/**
 * Export the default arena (reference layout, the TDM map) to map.json.
 * 0 = open floor, 1 = wall (brick, steel, or stone border).
 * team1 is blue (south). team2 is red (north). Spawns are the six slots
 * spawn.ts aims at, in hull order 1–6, as tile coordinates.
 *
 * Run: npx tsx scripts/export-map.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArena, circleHitsWall } from "../src/arena.ts";
import { CONFIG, homeTerritoryBounds } from "../src/config.ts";
import type { Wall } from "../src/types.ts";

const tile = CONFIG.tileSize;
const width = Math.floor(CONFIG.canvasWidth / tile);
const height = Math.floor(CONFIG.canvasHeight / tile);

function raster(walls: Wall[]): number[][] {
  const grid = Array.from({ length: height }, () => Array<number>(width).fill(0));
  for (const w of walls) {
    const x0 = Math.max(0, Math.floor(w.x / tile));
    const y0 = Math.max(0, Math.floor(w.y / tile));
    const x1 = Math.min(width, Math.ceil((w.x + w.w) / tile));
    const y1 = Math.min(height, Math.ceil((w.y + w.h) / tile));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) grid[y]![x] = 1;
    }
  }
  return grid;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * spawnTeam's aim point. If that point is inside a wall, the nearest open
 * point inside the same home box — the nudge findClearPoint is doing.
 */
function standingTile(
  preferX: number,
  preferY: number,
  walls: Wall[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number] {
  const r = CONFIG.tankRadius;
  const clear = (x: number, y: number) => !circleHitsWall(x, y, r, walls);
  let found = { x: clamp(preferX, x0, x1), y: clamp(preferY, y0, y1) };
  if (!clear(found.x, found.y)) {
    outer: for (let dist = 4; dist <= 180; dist += 4) {
      const steps = Math.max(8, Math.round(dist / 4));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = clamp(preferX + Math.cos(a) * dist, x0, x1);
        const y = clamp(preferY + Math.sin(a) * dist, y0, y1);
        if (!clear(x, y)) continue;
        found = { x, y };
        break outer;
      }
    }
  }
  return [Math.floor(found.x / tile), Math.floor(found.y / tile)];
}

/** Six slots per team, hull order 1–6, same columns and rows as spawnTeam. */
function spawnSlots(team: "blue" | "red", walls: Wall[]): [number, number][] {
  const pad = CONFIG.tileSize * 3 + CONFIG.tankRadius;
  const home = homeTerritoryBounds(team);
  const x0 = pad;
  const y0 = Math.max(home.y0 + 20, pad);
  const x1 = CONFIG.canvasWidth - pad;
  const y1 = Math.min(home.y1 - 20, CONFIG.canvasHeight - pad);
  const slots: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const preferX = x0 + ((x1 - x0) * (col + 0.5)) / 3;
    const preferY = y0 + ((y1 - y0) * (row + 0.35)) / 2;
    slots.push(standingTile(preferX, preferY, walls, x0, y0, x1, y1));
  }
  return slots;
}

const walls = buildArena("reference");
const grid = raster(walls);
const map = {
  width,
  height,
  grid,
  team_spawns: {
    team1: spawnSlots("blue", walls),
    team2: spawnSlots("red", walls),
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "map.json");
writeFileSync(out, JSON.stringify(map));

const midL = Math.floor(width / 2) - 1;
const midR = Math.floor(width / 2);
function cells(y: number): string {
  return [midL, midR].map((x) => grid[y]![x]).join(",");
}
console.log(`wrote ${out}`);
console.log(`tiles ${width}x${height}, tile ${tile}px`);
console.log(`top border rows 0-1 center cols ${midL},${midR}: ${cells(0)} | ${cells(1)}`);
console.log(`row just inside top (y=2): ${cells(2)}`);
console.log(`bottom border rows ${height - 2}-${height - 1}: ${cells(height - 2)} | ${cells(height - 1)}`);
console.log(`row just inside bottom (y=${height - 3}): ${cells(height - 3)}`);
console.log("team1", JSON.stringify(map.team_spawns.team1));
console.log("team2", JSON.stringify(map.team_spawns.team2));
