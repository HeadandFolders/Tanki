import { CONFIG, homeTerritoryBounds } from './config';
import { angleDelta, dist, rotateToward, tryMove } from './arena';
import { nearestSeenEnemy, nearestTeamContact } from './fog';
import type { Tank, WorldState } from './types';

const LANES = [88, 500, 872, 460, 500, 88];

function roleSpeed(tank: Tank): number {
  return CONFIG.roles[tank.role].speed;
}

function separation(tank: Tank, world: WorldState, dt: number) {
  let sx = 0;
  let sy = 0;
  for (const other of world.tanks) {
    if (!other.alive || other.id === tank.id) continue;
    const d = dist(tank.x, tank.y, other.x, other.y);
    if (d <= 0.001 || d > CONFIG.separationRadius) continue;
    const push = (1 - d / CONFIG.separationRadius) * CONFIG.separationForce * dt;
    sx += ((tank.x - other.x) / d) * push;
    sy += ((tank.y - other.y) / d) * push;
  }
  return { sx, sy };
}

function applyMove(tank: Tank, world: WorldState, dx: number, dy: number, dt: number) {
  const beforeX = tank.x;
  const beforeY = tank.y;
  const next = tryMove(tank.x, tank.y, dx, dy, CONFIG.tankRadius, world.walls);
  tank.x = next.x;
  tank.y = next.y;
  const moved = dist(beforeX, beforeY, tank.x, tank.y);
  if (moved < 0.35) tank.stillTime += dt;
  else tank.stillTime = 0;
  return moved;
}

function steer(tank: Tank, world: WorldState, tx: number, ty: number, dt: number) {
  const desired = Math.atan2(ty - tank.y, tx - tank.x);
  tank.angle = rotateToward(tank.angle, desired, CONFIG.tankTurnRate * dt);
  const speed = roleSpeed(tank);
  let dx = Math.cos(tank.angle) * speed * dt;
  let dy = Math.sin(tank.angle) * speed * dt;
  const sep = separation(tank, world, dt);
  dx += sep.sx;
  dy += sep.sy;
  if (tank.stillTime > 0.75 && dist(tank.x, tank.y, tx, ty) > CONFIG.arriveRadius) {
    const side = tank.angle + Math.PI / 2;
    dx += Math.cos(side) * 70 * dt;
    dy += Math.sin(side) * 70 * dt;
  }
  applyMove(tank, world, dx, dy, dt);
}

function holdStill(tank: Tank, world: WorldState, dt: number) {
  const sep = separation(tank, world, dt);
  if (Math.hypot(sep.sx, sep.sy) > 0.4) {
    applyMove(tank, world, sep.sx, sep.sy, dt);
    return;
  }
  tank.stillTime += dt;
}

function homePoint(tank: Tank): { x: number; y: number } {
  const home = homeTerritoryBounds();
  if (tank.team === 'blue') {
    return { x: Math.max(80, Math.min(880, tank.x)), y: home.y + home.h * 0.55 };
  }
  return { x: Math.max(80, Math.min(880, tank.x)), y: 70 };
}

function maybeOverrideRetreat(tank: Tank) {
  if (!tank.alive) return;
  if (tank.hp / tank.maxHp >= CONFIG.retreatHpFraction) return;
  const home = homePoint(tank);
  if (dist(tank.x, tank.y, home.x, home.y) < CONFIG.holdRadius + 24) {
    tank.goal = { kind: 'holdPosition', x: home.x, y: home.y, label: 'home' };
    return;
  }
  if (tank.goal.kind === 'retreat') return;
  tank.goal = { kind: 'retreat', x: home.x, y: home.y, label: 'home' };
}

function faceTarget(tank: Tank, x: number, y: number, dt: number) {
  const desired = Math.atan2(y - tank.y, x - tank.x);
  tank.angle = rotateToward(tank.angle, desired, CONFIG.tankTurnRate * dt);
}

export function alignForShot(tank: Tank, world: WorldState, dt: number): boolean {
  const seen = nearestSeenEnemy(world, tank);
  if (!seen) return false;
  const desired = Math.atan2(seen.y - tank.y, seen.x - tank.x);
  const delta = Math.abs(angleDelta(tank.angle, desired));
  const turningGoal =
    tank.goal.kind === 'holdPosition' ||
    tank.goal.kind === 'attackNearest' ||
    tank.goal.kind === 'idle' ||
    tank.goal.kind === 'retreat';
  if (delta > 0.42 && turningGoal) faceTarget(tank, seen.x, seen.y, dt);
  return Math.abs(angleDelta(tank.angle, desired)) < 0.42;
}

function updateFriendly(tank: Tank, world: WorldState, dt: number) {
  maybeOverrideRetreat(tank);
  const goal = tank.goal;

  if (goal.kind === 'retreat') {
    const hx = goal.x ?? homePoint(tank).x;
    const hy = goal.y ?? homePoint(tank).y;
    if (dist(tank.x, tank.y, hx, hy) < CONFIG.arriveRadius) {
      tank.goal = { kind: 'holdPosition', x: hx, y: hy, label: 'home' };
      holdStill(tank, world, dt);
      return;
    }
    steer(tank, world, hx, hy, dt);
    return;
  }

  if (goal.kind === 'reportIn') {
    holdStill(tank, world, dt);
    return;
  }

  if (goal.kind === 'debug') {
    const wreck =
      world.wrecks.find((w) => w.id === goal.wreckId && !w.debugged) ??
      nearestMarkedWreck(tank, world);
    if (!wreck) {
      tank.goal = { kind: 'holdPosition', x: tank.x, y: tank.y, label: 'hold' };
      holdStill(tank, world, dt);
      return;
    }
    tank.goal.wreckId = wreck.id;
    wreck.marked = true;
    if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange * 0.75) {
      steer(tank, world, wreck.x, wreck.y, dt);
      return;
    }
    holdStill(tank, world, dt);
    return;
  }

  if (goal.kind === 'escort') {
    const target = world.tanks.find((t) => t.id === goal.targetId && t.alive);
    if (!target) {
      tank.goal = { kind: 'holdPosition', x: tank.x, y: tank.y };
      holdStill(tank, world, dt);
      return;
    }
    const d = dist(tank.x, tank.y, target.x, target.y);
    if (d > CONFIG.escortDistance + 10) {
      steer(tank, world, target.x, target.y, dt);
      return;
    }
    if (d < CONFIG.escortDistance - 18) {
      const away = Math.atan2(tank.y - target.y, tank.x - target.x);
      steer(tank, world, tank.x + Math.cos(away) * 40, tank.y + Math.sin(away) * 40, dt);
      return;
    }
    const side = world.time * 0.4 + tank.number;
    steer(
      tank,
      world,
      target.x + Math.cos(side) * CONFIG.escortDistance,
      target.y + Math.sin(side) * (CONFIG.escortDistance * 0.6),
      dt,
    );
    return;
  }

  if (goal.kind === 'attackNearest') {
    const contact = nearestTeamContact(world, tank) ?? nearestSeenEnemy(world, tank);
    if (contact) {
      const d = dist(tank.x, tank.y, contact.x, contact.y);
      if (d > CONFIG.roles[tank.role].visionRadius * 0.72) {
        steer(tank, world, contact.x, contact.y, dt);
      } else {
        faceTarget(tank, contact.x, contact.y, dt);
        holdStill(tank, world, dt);
      }
      return;
    }
    const marker = world.markers.find((m) => m.kind === 'enemy' && m.life > 0);
    if (marker) {
      steer(tank, world, marker.x, marker.y, dt);
      return;
    }
    steer(tank, world, laneX(tank), 360, dt);
    return;
  }

  if (goal.kind === 'moveTo') {
    const tx = goal.x ?? tank.x;
    const ty = goal.y ?? tank.y;
    if (dist(tank.x, tank.y, tx, ty) <= CONFIG.arriveRadius) {
      tank.goal = { kind: 'holdPosition', x: tx, y: ty, label: goal.label };
      holdStill(tank, world, dt);
      return;
    }
    steer(tank, world, tx, ty, dt);
    return;
  }

  if (goal.kind === 'holdPosition' || goal.kind === 'idle') {
    const hx = goal.x ?? tank.x;
    const hy = goal.y ?? tank.y;
    if (dist(tank.x, tank.y, hx, hy) > CONFIG.holdRadius) {
      steer(tank, world, hx, hy, dt);
      return;
    }
    const seen = nearestSeenEnemy(world, tank);
    if (seen) {
      faceTarget(tank, seen.x, seen.y, dt);
      holdStill(tank, world, dt);
      return;
    }
    // Stand long enough to report, then take a short patrol leg.
    if (tank.stillTime > 8) {
      const ang = tank.number * 1.3 + world.time;
      tank.goal = {
        kind: 'moveTo',
        x: Math.max(64, Math.min(896, hx + Math.cos(ang) * 70)),
        y: Math.max(64, Math.min(600, hy + Math.sin(ang) * 48)),
        label: goal.label ?? 'patrol',
      };
      return;
    }
    holdStill(tank, world, dt);
  }
}

function nearestMarkedWreck(tank: Tank, world: WorldState) {
  let best: (typeof world.wrecks)[number] | null = null;
  let bestD = Infinity;
  for (const w of world.wrecks) {
    if (w.debugged || w.team === tank.team || !w.marked) continue;
    const d = dist(tank.x, tank.y, w.x, w.y);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

function laneX(tank: Tank): number {
  return LANES[(tank.number - 1) % LANES.length] ?? 480;
}

function updateEnemy(tank: Tank, world: WorldState, dt: number) {
  maybeOverrideRetreat(tank);
  if (tank.hp / tank.maxHp < CONFIG.retreatHpFraction && tank.goal.kind === 'holdPosition') {
    const seen = nearestSeenEnemy(world, tank);
    if (seen) faceTarget(tank, seen.x, seen.y, dt);
    holdStill(tank, world, dt);
    return;
  }
  if (tank.goal.kind === 'retreat') {
    const hx = tank.goal.x ??  tank.x;
    const hy = tank.goal.y ?? 70;
    if (dist(tank.x, tank.y, hx, hy) < CONFIG.arriveRadius) {
      tank.goal = { kind: 'attackNearest' };
      holdStill(tank, world, dt);
      return;
    }
    steer(tank, world, hx, hy, dt);
    return;
  }

  const seen = nearestSeenEnemy(world, tank);
  if (seen) {
    tank.goal = { kind: 'attackNearest' };
    const d = dist(tank.x, tank.y, seen.x, seen.y);
    if (d > 78) steer(tank, world, seen.x, seen.y, dt);
    else {
      faceTarget(tank, seen.x, seen.y, dt);
      holdStill(tank, world, dt);
    }
    return;
  }

  let wreck = world.wrecks.find((w) => w.id === tank.goal.wreckId && !w.debugged && w.team === 'blue');
  if (!wreck) {
    let bestD = Infinity;
    for (const w of world.wrecks) {
      if (w.team !== 'blue' || w.debugged) continue;
      const d = dist(tank.x, tank.y, w.x, w.y);
      if (d < bestD) {
        bestD = d;
        wreck = w;
      }
    }
  }
  if (wreck) {
    tank.goal = { kind: 'debug', wreckId: wreck.id, label: wreck.label };
    if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange * 0.75) {
      steer(tank, world, wreck.x, wreck.y, dt);
    } else {
      holdStill(tank, world, dt);
    }
    return;
  }

  tank.goal = { kind: 'attackNearest', label: 'south' };
  const home = homeTerritoryBounds();
  const targetY = home.y - 28;
  if (tank.y > targetY - 8) {
    holdStill(tank, world, dt);
    return;
  }
  steer(tank, world, laneX(tank), targetY, dt);
}

export function updateBots(world: WorldState, dt: number) {
  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    if (tank.team === 'blue' && tank.id === world.controlledId) continue;
    if (tank.team === 'blue') updateFriendly(tank, world, dt);
    else updateEnemy(tank, world, dt);
  }
}
