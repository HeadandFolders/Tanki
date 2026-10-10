import { CONFIG, type Role } from './config';
import { circleHitsAny, dist, unstick } from './arena';
import type { Goal, Tank, Team, Wall } from './types';

function shuffle<T>(items: T[], rng: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = arr[i] as T;
    const b = arr[j] as T;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}

function makeRoles(rng: () => number): Role[] {
  const roles: Role[] = [];
  for (let i = 0; i < CONFIG.roles.scout.count; i++) roles.push('scout');
  for (let i = 0; i < CONFIG.roles.shooter.count; i++) roles.push('shooter');
  return shuffle(roles, rng);
}

function clearPoint(x: number, y: number, walls: Wall[], tanks: Tank[]): boolean {
  if (circleHitsAny(x, y, CONFIG.tankRadius + 2, walls)) return false;
  for (const t of tanks) {
    if (dist(x, y, t.x, t.y) < CONFIG.tankRadius * 2 + 8) return false;
  }
  const pad = 36;
  if (x < pad || y < pad || x > CONFIG.canvasWidth - pad || y > CONFIG.canvasHeight - pad) return false;
  return true;
}

function findPoint(
  rng: () => number,
  walls: Wall[],
  tanks: Tank[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  avoid?: { x: number; y: number; r: number },
): { x: number; y: number } {
  for (let i = 0; i < 80; i++) {
    const x = x0 + rng() * (x1 - x0);
    const y = y0 + rng() * (y1 - y0);
    if (avoid && dist(x, y, avoid.x, avoid.y) < avoid.r) continue;
    if (!clearPoint(x, y, walls, tanks)) continue;
    return unstick(x, y, CONFIG.tankRadius, walls);
  }
  for (let y = y0; y <= y1; y += 18) {
    for (let x = x0; x <= x1; x += 18) {
      if (avoid && dist(x, y, avoid.x, avoid.y) < avoid.r) continue;
      if (clearPoint(x, y, walls, tanks)) return unstick(x, y, CONFIG.tankRadius, walls);
    }
  }
  return unstick((x0 + x1) / 2, (y0 + y1) / 2, CONFIG.tankRadius, walls);
}

function tank(
  id: number,
  team: Team,
  number: number,
  role: Role,
  x: number,
  y: number,
  angle: number,
  goal: Goal,
  carrier: boolean,
): Tank {
  const stats = CONFIG.roles[role];
  return {
    id,
    team,
    number,
    role,
    x,
    y,
    angle,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    alive: true,
    isCodeCarrier: carrier,
    goal,
    fireCooldown: 0.4 + number * 0.05,
    stillTime: 0,
    reportLatched: false,
    debugProgress: 0,
    debugWreckId: null,
    hurtFlash: 0,
    lastContactChat: -99,
  };
}

export function spawnTeams(walls: Wall[], rng: () => number): Tank[] {
  const tanks: Tank[] = [];
  const blueRoles = makeRoles(rng);
  const redRoles = makeRoles(rng);
  const blueCarrier = 1 + Math.floor(rng() * 6);
  const redCarrier = 1 + Math.floor(rng() * 6);
  const eagle = { x: 480, y: 560, r: 78 };
  const scoutXs = [88, 872];
  let scoutI = 0;

  for (let n = 1; n <= 6; n++) {
    const role = blueRoles[n - 1] ?? 'shooter';
    const side = n <= 3 ? 0 : 1;
    const x0 = side === 0 ? 70 : 590;
    const x1 = side === 0 ? 390 : 890;
    const slot = (n - 1) % 3;
    const y0 = 530 + slot * 8;
    const pt = findPoint(rng, walls, tanks, x0, x1, y0, y0 + 48, eagle);
    let goal: Goal;
    if (role === 'scout') {
      const sx = scoutXs[scoutI] ?? 480;
      scoutI++;
      goal = { kind: 'moveTo', x: sx, y: 455, label: 'front' };
    } else {
      goal = { kind: 'holdPosition', x: pt.x, y: pt.y, label: 'spawn' };
    }
    tanks.push(tank(n, 'blue', n, role, pt.x, pt.y, -Math.PI / 2, goal, n === blueCarrier));
  }

  for (let n = 1; n <= 6; n++) {
    const role = redRoles[n - 1] ?? 'shooter';
    const x0 = 70 + ((n - 1) % 6) * 130;
    const pt = findPoint(rng, walls, tanks, x0, x0 + 110, 46, 78);
    const goal: Goal = { kind: 'attackNearest', label: 'advance' };
    tanks.push(tank(6 + n, 'red', n, role, pt.x, pt.y, Math.PI / 2, goal, n === redCarrier));
  }

  return tanks;
}

export function firstGunnerId(tanks: Tank[]): number {
  const gun = tanks.find((t) => t.team === 'blue' && t.role === 'shooter');
  return gun?.id ?? tanks.find((t) => t.team === 'blue')?.id ?? 1;
}
