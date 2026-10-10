import { CONFIG, fogGridSize, homeTerritoryBounds, type ShareMode } from './config';
import { dist, segmentHitsWalls } from './arena';
import type { Marker, Tank, Wall, WorldState } from './types';

export function tankSeesPoint(tank: Tank, x: number, y: number, walls: Wall[]): boolean {
  if (!tank.alive) return false;
  const reach = CONFIG.roles[tank.role].visionRadius;
  if (dist(tank.x, tank.y, x, y) > reach) return false;
  return !segmentHitsWalls(tank.x, tank.y, x, y, walls);
}

export function anyTeammateSeesEnemy(world: WorldState, team: Tank['team']): boolean {
  const mates = world.tanks.filter((t) => t.alive && t.team === team);
  const foes = world.tanks.filter((t) => t.alive && t.team !== team);
  for (const m of mates) {
    for (const f of foes) {
      if (tankSeesPoint(m, f.x, f.y, world.walls)) return true;
    }
  }
  return false;
}

export function livingFoes(world: WorldState, team: Tank['team']): Tank[] {
  return world.tanks.filter((t) => t.alive && t.team !== team);
}

export function nearestSeenEnemy(world: WorldState, tank: Tank): Tank | null {
  let best: Tank | null = null;
  let bestD = Infinity;
  for (const foe of livingFoes(world, tank.team)) {
    if (!tankSeesPoint(tank, foe.x, foe.y, world.walls)) continue;
    const d = dist(tank.x, tank.y, foe.x, foe.y);
    if (d < bestD) {
      bestD = d;
      best = foe;
    }
  }
  return best;
}

/** Closest foe currently seen by anyone on this tank's team. */
export function nearestTeamContact(world: WorldState, tank: Tank): Tank | null {
  const mates = world.tanks.filter((t) => t.alive && t.team === tank.team);
  let best: Tank | null = null;
  let bestD = Infinity;
  for (const foe of livingFoes(world, tank.team)) {
    const seen = mates.some((m) => tankSeesPoint(m, foe.x, foe.y, world.walls));
    if (!seen) continue;
    const d = dist(tank.x, tank.y, foe.x, foe.y);
    if (d < bestD) {
      bestD = d;
      best = foe;
    }
  }
  return best;
}

export function visionContributors(world: WorldState): Tank[] {
  const blue = world.tanks.filter((t) => t.alive && t.team === 'blue');
  if (world.shareMode === 'auto') return blue;
  const controlled = blue.find((t) => t.id === world.controlledId);
  return controlled ? [controlled] : [];
}

export function createFog(): { fog: Uint8Array; live: Uint8Array; cols: number; rows: number } {
  const { cols, rows } = fogGridSize();
  const fog = new Uint8Array(cols * rows);
  const live = new Uint8Array(cols * rows);
  const home = homeTerritoryBounds();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cy = row * CONFIG.fogCell + CONFIG.fogCell / 2;
      if (cy >= home.y) fog[row * cols + col] = 1;
    }
  }
  return { fog, live, cols, rows };
}

export function cellExplored(world: WorldState, x: number, y: number): boolean {
  const col = Math.floor(x / CONFIG.fogCell);
  const row = Math.floor(y / CONFIG.fogCell);
  if (col < 0 || row < 0 || col >= world.fogCols || row >= world.fogRows) return false;
  return world.fog[row * world.fogCols + col] === 1;
}

function refreshMarker(markers: Marker[], kind: Marker['kind'], x: number, y: number, label?: string) {
  const fade = CONFIG.markerFadeSeconds;
  for (const m of markers) {
    if (m.kind !== kind) continue;
    if (dist(m.x, m.y, x, y) > 28) continue;
    m.x = x;
    m.y = y;
    m.life = fade;
    if (label) m.label = label;
    return;
  }
  markers.push({ kind, x, y, life: fade, label });
}

/** Reveal cells this tank can see. `fresh` counts cells that were still unexplored. */
export function paintVision(
  world: WorldState,
  tank: Tank,
  persist: boolean,
  mark: boolean,
  writeLive = true,
): { seen: number; fresh: number } {
  const reach = CONFIG.roles[tank.role].visionRadius;
  const cell = CONFIG.fogCell;
  const minC = Math.max(0, Math.floor((tank.x - reach) / cell));
  const maxC = Math.min(world.fogCols - 1, Math.floor((tank.x + reach) / cell));
  const minR = Math.max(0, Math.floor((tank.y - reach) / cell));
  const maxR = Math.min(world.fogRows - 1, Math.floor((tank.y + reach) / cell));
  const r2 = reach * reach;
  let seen = 0;
  let fresh = 0;
  for (let row = minR; row <= maxR; row++) {
    for (let col = minC; col <= maxC; col++) {
      const cx = col * cell + cell / 2;
      const cy = row * cell + cell / 2;
      const dx = cx - tank.x;
      const dy = cy - tank.y;
      if (dx * dx + dy * dy > r2) continue;
      if (segmentHitsWalls(tank.x, tank.y, cx, cy, world.walls)) continue;
      const idx = row * world.fogCols + col;
      if (persist && world.fog[idx] === 0) fresh++;
      if (writeLive) world.live[idx] = 1;
      if (persist) world.fog[idx] = 1;
      seen++;
    }
  }
  if (mark) {
    for (const foe of livingFoes(world, 'blue')) {
      if (tank.team !== 'blue') break;
      if (!tankSeesPoint(tank, foe.x, foe.y, world.walls)) continue;
      refreshMarker(world.markers, 'enemy', foe.x, foe.y);
    }
    for (const wreck of world.wrecks) {
      if (!tankSeesPoint(tank, wreck.x, wreck.y, world.walls)) continue;
      refreshMarker(world.markers, 'wreck', wreck.x, wreck.y, wreck.label);
    }
  }
  return { seen, fresh };
}

export function rebuildSharedVision(world: WorldState) {
  world.live.fill(0);
  const share: ShareMode = world.shareMode;
  for (const tank of visionContributors(world)) {
    paintVision(world, tank, true, share !== 'none' || tank.id === world.controlledId);
  }
}

export function gunsLive(world: WorldState, team: Tank['team'], allowMarkers: boolean): boolean {
  if (anyTeammateSeesEnemy(world, team)) return true;
  if (allowMarkers && team === 'blue' && world.markers.some((m) => m.kind === 'enemy' && m.life > 0)) return true;
  return false;
}
