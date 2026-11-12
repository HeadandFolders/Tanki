import { ensureTwoRoutes, wallGrid } from "./arena-routes";
import { CONFIG, setWorldSize } from "./config";
import { createRandom, nextRandom } from "./random";
import type { TeamId, Wall } from "./types";

/**
 * Generated 144x90 arena. A hand-authored skeleton (corner bases, three
 * lanes, long spines with gaps, an open center) plus seeded cover clusters,
 * all point-symmetric about the map center so neither side has an edge.
 * Interior walls are bricks only.
 */

const OPEN = 0;
const BRICK = 1;
const BORDER = 3;
const BORDER_TILES = 2;

export interface ArenaZone {
  id: string;
  /** Spoken / typed name the commander and phrase reader match on. */
  name: string;
  /** Free-tile anchor in world px. */
  x: number;
  y: number;
  tileX: number;
  tileY: number;
  /** Zone on the other side of the map that this one mirrors. */
  mirrorOf: string;
}

/** Spawn boxes in tiles (inclusive). Red is the point mirror of blue. */
export const LARGE_SPAWN_TILES: Record<
  TeamId,
  { x0: number; y0: number; x1: number; y1: number }
> = {
  blue: { x0: 4, y0: 75, x1: 19, y1: 85 },
  red: { x0: 124, y0: 4, x1: 139, y1: 14 },
};

/** Walled base enclosure in tiles (inclusive, interior); exits are cut into its wall ring. */
export const LARGE_BASE_TILES: Record<
  TeamId,
  { x0: number; y0: number; x1: number; y1: number }
> = {
  blue: { x0: 2, y0: 72, x1: 31, y1: 87 },
  red: { x0: 112, y0: 2, x1: 141, y1: 17 },
};

interface Grid {
  cols: number;
  rows: number;
  cells: Uint8Array;
}

function mirror(g: Grid, x: number, y: number): { x: number; y: number } {
  return { x: g.cols - 1 - x, y: g.rows - 1 - y };
}

function at(g: Grid, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return BORDER;
  return g.cells[y * g.cols + x]!;
}

function set(g: Grid, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return;
  const i = y * g.cols + x;
  if (g.cells[i] === BORDER) return;
  g.cells[i] = v;
}

/** Brick rect in tiles (inclusive) on both sides of the map. */
function rectPair(g: Grid, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      set(g, x, y, BRICK);
      const m = mirror(g, x, y);
      set(g, m.x, m.y, BRICK);
    }
  }
}

/** Open rect in tiles (inclusive) on both sides; used to cut gaps into spines. */
function gapPair(g: Grid, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      set(g, x, y, OPEN);
      const m = mirror(g, x, y);
      set(g, m.x, m.y, OPEN);
    }
  }
}

/** True when no wall tile lies within `margin` tiles of the rect. */
function clearAround(
  g: Grid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  margin: number,
): boolean {
  for (let y = y0 - margin; y <= y1 + margin; y++) {
    for (let x = x0 - margin; x <= x1 + margin; x++) {
      if (at(g, x, y) !== OPEN) return false;
    }
  }
  return true;
}

type Shape = { w: number; h: number; cells: [number, number][] };

/** Cover cluster shapes in tiles; every piece is 2 tiles thick so it reads as a block. */
const SHAPES: Record<string, Shape> = {
  L: { w: 6, h: 6, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [0, 3], [1, 3], [0, 4], [1, 4], [0, 5], [1, 5]] },
  T: { w: 6, h: 6, cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [2, 2], [3, 2], [2, 3], [3, 3], [2, 4], [3, 4], [2, 5], [3, 5]] },
  plus: { w: 6, h: 6, cells: [[2, 0], [3, 0], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [0, 3], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [2, 4], [3, 4], [2, 5], [3, 5]] },
  pillars: { w: 7, h: 7, cells: [[0, 0], [1, 0], [0, 1], [1, 1], [5, 0], [6, 0], [5, 1], [6, 1], [0, 5], [1, 5], [0, 6], [1, 6], [5, 5], [6, 5], [5, 6], [6, 6]] },
  barH: { w: 7, h: 2, cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]] },
  barV: { w: 2, h: 7, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6]] },
  block: { w: 3, h: 3, cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] },
};

const SHAPE_NAMES = Object.keys(SHAPES);

interface FillRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

/** Blue-side fill regions in tiles; the mirror pair is stamped automatically. */
const FILL: FillRegion[] = [
  { x0: 16, y0: 16, x1: 42, y1: 24, count: 3 }, // northwest shoulder
  { x0: 16, y0: 30, x1: 43, y1: 60, count: 6 }, // west midfield
  { x0: 50, y0: 30, x1: 64, y1: 60, count: 3 }, // center-west
  { x0: 52, y0: 66, x1: 118, y1: 74, count: 5 }, // south crossing band
  { x0: 44, y0: 80, x1: 124, y1: 86, count: 3 }, // south lane cover
];

function stampShape(
  g: Grid,
  shape: Shape,
  x: number,
  y: number,
  rot: number,
): boolean {
  const cells = shape.cells.map(([cx, cy]) => {
    switch (rot) {
      case 1:
        return [shape.h - 1 - cy, cx] as [number, number];
      case 2:
        return [shape.w - 1 - cx, shape.h - 1 - cy] as [number, number];
      case 3:
        return [cy, shape.w - 1 - cx] as [number, number];
      default:
        return [cx, cy] as [number, number];
    }
  });
  const w = rot % 2 ? shape.h : shape.w;
  const h = rot % 2 ? shape.w : shape.h;
  const m = mirror(g, x + w - 1, y + h - 1);
  if (!clearAround(g, x, y, x + w - 1, y + h - 1, 3)) return false;
  if (!clearAround(g, m.x, m.y, m.x + w - 1, m.y + h - 1, 3)) return false;
  // A shape overlapping its own mirror would break symmetry at the center.
  if (m.x <= x + w + 2 && m.x + w + 2 >= x && m.y <= y + h + 2 && m.y + h + 2 >= y) {
    return false;
  }
  for (const [cx, cy] of cells) {
    set(g, x + cx, y + cy, BRICK);
    const mm = mirror(g, x + cx, y + cy);
    set(g, mm.x, mm.y, BRICK);
  }
  return true;
}

function skeleton(g: Grid): void {
  // --- Blue base (SW pocket; red = mirror). Three exits: two north gaps, one east.
  rectPair(g, 2, 70, 33, 71);
  gapPair(g, 8, 70, 11, 71);
  gapPair(g, 26, 70, 29, 71);
  rectPair(g, 32, 70, 33, 87);
  gapPair(g, 32, 78, 33, 81);
  // Baffles: nothing leaving a gap can see the far base in a straight line.
  rectPair(g, 12, 65, 46, 66);
  rectPair(g, 38, 71, 39, 81);

  // --- West flank corridor (x 2..11) with a spine and pillars.
  rectPair(g, 12, 14, 13, 60);
  gapPair(g, 12, 22, 13, 25);
  gapPair(g, 12, 30, 13, 31); // deliberate 2-tile squeeze
  gapPair(g, 12, 38, 13, 41);
  gapPair(g, 12, 52, 13, 55);
  rectPair(g, 6, 18, 7, 19);
  rectPair(g, 6, 32, 7, 33);
  rectPair(g, 6, 46, 7, 47);

  // --- South lane (y 78..87) spine with gaps and pillars; mirror = north lane.
  rectPair(g, 44, 76, 120, 77);
  gapPair(g, 56, 76, 59, 77);
  gapPair(g, 76, 76, 79, 77);
  gapPair(g, 100, 76, 103, 77);
  rectPair(g, 66, 82, 67, 83);
  rectPair(g, 90, 82, 91, 83);
  rectPair(g, 112, 82, 113, 83);

  // --- Midfield spines.
  rectPair(g, 51, 62, 100, 63);
  gapPair(g, 62, 62, 65, 63);
  gapPair(g, 80, 62, 83, 63);
  gapPair(g, 90, 62, 91, 63); // deliberate 2-tile squeeze
  rectPair(g, 46, 28, 47, 60);
  gapPair(g, 46, 36, 47, 39);
  gapPair(g, 46, 48, 47, 51);

  // --- Center: a wide east-west plaza. Long bars close the north and south
  // approaches so every path in comes through a crossing; small islands inside.
  rectPair(g, 60, 36, 83, 37);
  rectPair(g, 66, 42, 67, 43);
  rectPair(g, 70, 31, 71, 33);
  rectPair(g, 56, 40, 57, 41);
}

function clusters(g: Grid, seed: number): void {
  const rng = createRandom(seed);
  for (const region of FILL) {
    let placed = 0;
    for (let attempt = 0; attempt < 400 && placed < region.count; attempt++) {
      const name = SHAPE_NAMES[Math.floor(nextRandom(rng) * SHAPE_NAMES.length)]!;
      const shape = SHAPES[name]!;
      const rot = Math.floor(nextRandom(rng) * 4);
      const w = rot % 2 ? shape.h : shape.w;
      const h = rot % 2 ? shape.w : shape.h;
      const x = region.x0 + Math.floor(nextRandom(rng) * Math.max(1, region.x1 - region.x0 - w + 1));
      const y = region.y0 + Math.floor(nextRandom(rng) * Math.max(1, region.y1 - region.y0 - h + 1));
      if (stampShape(g, shape, x, y, rot)) placed++;
    }
  }
}

function tilesToWalls(g: Grid): Wall[] {
  const s = CONFIG.tileSize;
  const walls: Wall[] = [];
  const W = g.cols * s;
  const H = g.rows * s;
  const b = BORDER_TILES * s;
  walls.push({ x: 0, y: 0, w: W, h: b, kind: "border" });
  walls.push({ x: 0, y: H - b, w: W, h: b, kind: "border" });
  walls.push({ x: 0, y: 0, w: b, h: H, kind: "border" });
  walls.push({ x: W - b, y: 0, w: b, h: H, kind: "border" });
  const used = new Uint8Array(g.cells.length);
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const i0 = y * g.cols + x;
      if (g.cells[i0] !== BRICK || used[i0]) continue;
      let w = 1;
      while (x + w < g.cols && g.cells[i0 + w] === BRICK && !used[i0 + w]) w++;
      let h = 1;
      outer: while (y + h < g.rows) {
        for (let k = 0; k < w; k++) {
          const j = (y + h) * g.cols + x + k;
          if (g.cells[j] !== BRICK || used[j]) break outer;
        }
        h++;
      }
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) used[(y + yy) * g.cols + x + xx] = 1;
      }
      walls.push({ x: x * s, y: y * s, w: w * s, h: h * s, kind: "brick" });
    }
  }
  return walls;
}

function newGrid(): Grid {
  const { cols, rows } = CONFIG.largeArena;
  const cells = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (
        x < BORDER_TILES ||
        y < BORDER_TILES ||
        x >= cols - BORDER_TILES ||
        y >= rows - BORDER_TILES
      ) {
        cells[y * cols + x] = BORDER;
      }
    }
  }
  return { cols, rows, cells };
}

/**
 * ensureTwoRoutes opens single-file corridors and dead ends; mirror every
 * cell it opened so the repaired map stays symmetric, then re-check.
 */
function symmetricRepair(g: Grid): void {
  for (let round = 0; round < 6; round++) {
    const fixed = wallGrid(ensureTwoRoutes(tilesToWalls(g))).grid;
    let changed = 0;
    for (let y = 0; y < g.rows; y++) {
      for (let x = 0; x < g.cols; x++) {
        const i = y * g.cols + x;
        if (g.cells[i] === BRICK && fixed[i] === OPEN) {
          g.cells[i] = OPEN;
          const m = mirror(g, x, y);
          set(g, m.x, m.y, OPEN);
          changed++;
        }
      }
    }
    if (!changed) return;
  }
}

const built = new Map<number, { walls: Wall[]; zones: ArenaZone[] }>();

function generate(seed: number): { walls: Wall[]; zones: ArenaZone[] } {
  const cached = built.get(seed);
  if (cached) return cached;
  // Route repair reads the world size; run it at this arena's size and restore.
  const prevW = CONFIG.canvasWidth;
  const prevH = CONFIG.canvasHeight;
  setWorldSize(CONFIG.largeArena.cols, CONFIG.largeArena.rows);
  const g = newGrid();
  skeleton(g);
  clusters(g, seed);
  symmetricRepair(g);
  const walls = tilesToWalls(g);
  const zones = makeZones(g);
  setWorldSize(prevW / CONFIG.tileSize, prevH / CONFIG.tileSize);
  const out = { walls, zones };
  built.set(seed, out);
  return out;
}

/** Fresh copies each call; buildArena may overlay saved edits onto them. */
export function buildLargeWalls(seed: number): Wall[] {
  return generate(seed).walls.map((w) => ({ ...w }));
}

export function largeArenaZones(seed: number = CONFIG.largeArena.seed): ArenaZone[] {
  return generate(seed).zones;
}

/** Nearest tile with one tile of clearance all around, searched outward. */
function freeTileNear(g: Grid, tx: number, ty: number): { x: number; y: number } {
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (clearAround(g, x, y, x, y, 1)) return { x, y };
      }
    }
  }
  return { x: tx, y: ty };
}

/** Blue-side zone nominal tiles; the mirror zone is derived. `center` mirrors itself. */
const ZONE_SEEDS: [string, string, string, number, number][] = [
  // [id, mirrorId, spoken name, tileX, tileY]
  ["south_base", "north_base", "south base", 12, 80],
  ["south_gate", "north_gate", "south gate", 28, 68],
  ["west_lane", "east_lane", "west lane", 7, 40],
  ["north_lane", "south_lane", "north lane", 60, 7],
  ["west_crossing", "east_crossing", "west crossing", 42, 44],
  ["south_crossing", "north_crossing", "south crossing", 72, 70],
  ["southeast_corner", "northwest_corner", "southeast corner", 128, 82],
];

const MIRROR_NAMES: Record<string, string> = {
  north_base: "north base",
  north_gate: "north gate",
  east_lane: "east lane",
  south_lane: "south lane",
  east_crossing: "east crossing",
  north_crossing: "north crossing",
  northwest_corner: "northwest corner",
};

function makeZones(g: Grid): ArenaZone[] {
  const s = CONFIG.tileSize;
  const zones: ArenaZone[] = [];
  const push = (id: string, name: string, mirrorOf: string, tx: number, ty: number) => {
    zones.push({ id, name, x: (tx + 0.5) * s, y: (ty + 0.5) * s, tileX: tx, tileY: ty, mirrorOf });
  };
  for (const [id, mid, name, tx, ty] of ZONE_SEEDS) {
    const t = freeTileNear(g, tx, ty);
    push(id, name, mid, t.x, t.y);
    const m = mirror(g, t.x, t.y);
    push(mid, MIRROR_NAMES[mid]!, id, m.x, m.y);
  }
  // The exact map center is its own mirror; the skeleton keeps it open.
  zones.push({
    id: "center",
    name: "center",
    x: (g.cols / 2) * s,
    y: (g.rows / 2) * s,
    tileX: g.cols / 2 - 1,
    tileY: g.rows / 2 - 1,
    mirrorOf: "center",
  });
  return zones;
}
