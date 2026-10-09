import { CONFIG, homeTerritoryBounds } from "./config";
import {
  angleTo,
  dist,
  rotateToward,
  tryMove,
  unstickFromWalls,
} from "./arena";
import { anyTeammateSees, canSeeTank } from "./fog";
import type { Tank, WorldState, Wreck } from "./types";

export function updateTankAi(
  world: WorldState,
  tank: Tank,
  dt: number,
  isPlayerControlled: boolean,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  if (!tank.alive) {
    return { moveX: 0, moveY: 0, wantShoot: false, aimAngle: tank.angle };
  }

  // Recover if wedged in geometry
  const freed = unstickFromWalls(
    tank.x,
    tank.y,
    CONFIG.tankRadius,
    world.walls,
  );
  tank.x = freed.x;
  tank.y = freed.y;

  if (isPlayerControlled) {
    return { moveX: 0, moveY: 0, wantShoot: false, aimAngle: tank.angle };
  }

  if (tank.team === "red") {
    return enemyBrain(world, tank, dt);
  }
  return friendlyBrain(world, tank, dt);
}

function visibleEnemies(world: WorldState, tank: Tank): Tank[] {
  return world.tanks.filter(
    (e) => e.team !== tank.team && e.alive && canSeeTank(tank, e, world.walls),
  );
}

function nearest<T extends { x: number; y: number }>(
  list: T[],
  x: number,
  y: number,
): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const item of list) {
    const d = dist(x, y, item.x, item.y);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/** Move toward a point even while the hull is still turning. */
function steerTo(
  tank: Tank,
  tx: number,
  ty: number,
  speed: number,
  dt: number,
  world: WorldState,
): { moveX: number; moveY: number; aimAngle: number } {
  const ang = angleTo(tank.x, tank.y, tx, ty);
  tank.angle = rotateToward(tank.angle, ang, CONFIG.tankTurnRate * 1.6 * dt);
  const d = dist(tank.x, tank.y, tx, ty);
  if (d < 10) return { moveX: 0, moveY: 0, aimAngle: tank.angle };

  // Travel along desired bearing (not stuck waiting for full turn)
  let vx = Math.cos(ang) * speed;
  let vy = Math.sin(ang) * speed;

  for (const o of world.tanks) {
    if (o.id === tank.id || !o.alive) continue;
    const dd = dist(tank.x, tank.y, o.x, o.y);
    if (dd < CONFIG.tankRadius * 3.2 && dd > 0.1) {
      vx += ((tank.x - o.x) / dd) * CONFIG.separationForce;
      vy += ((tank.y - o.y) / dd) * CONFIG.separationForce;
    }
  }

  return { moveX: vx * dt, moveY: vy * dt, aimAngle: ang };
}

function applyMove(tank: Tank, moveX: number, moveY: number, world: WorldState): void {
  if (!moveX && !moveY) return;
  const pos = tryMove(
    tank.x,
    tank.y,
    moveX,
    moveY,
    CONFIG.tankRadius,
    world.walls,
  );
  tank.x = pos.x;
  tank.y = pos.y;
}

function friendlyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const speed = CONFIG.roles[tank.role].speed;
  const enemies = visibleEnemies(world, tank);
  const nearestEnemy = nearest(enemies, tank.x, tank.y);

  if (
    tank.hp / tank.maxHp < CONFIG.ai.retreatHpFraction &&
    tank.goal.kind !== "retreat"
  ) {
    tank.goal = { kind: "retreat" };
  }

  let wantShoot = false;
  let aimAngle = tank.angle;
  let moveX = 0;
  let moveY = 0;
  const goal = tank.goal.kind;

  if (goal === "attackNearest" || (nearestEnemy && goal === "idle")) {
    if (nearestEnemy) {
      aimAngle = angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y);
      tank.angle = rotateToward(tank.angle, aimAngle, CONFIG.tankTurnRate * dt);
      if (dist(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y) > 90) {
        const s = steerTo(tank, nearestEnemy.x, nearestEnemy.y, speed, dt, world);
        moveX = s.moveX;
        moveY = s.moveY;
      }
      wantShoot = canShootTarget(world, tank, nearestEnemy);
    } else {
      const marker = world.markers.find((m) => m.kind === "enemy");
      const home = homeTerritoryBounds("blue");
      const tx = marker?.x ?? CONFIG.canvasWidth * (0.35 + (tank.number % 3) * 0.15);
      const ty = marker?.y ?? home.y0 - 80;
      const s = steerTo(tank, tx, ty, speed * 0.9, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  } else if (goal === "holdPosition") {
    const hx = tank.goal.params?.x ?? tank.x;
    const hy = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, hx, hy) > CONFIG.ai.holdRadius) {
      const s = steerTo(tank, hx, hy, speed, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
    if (nearestEnemy) {
      aimAngle = angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y);
      tank.angle = rotateToward(tank.angle, aimAngle, CONFIG.tankTurnRate * dt);
      wantShoot = canShootTarget(world, tank, nearestEnemy);
    }
  } else if (goal === "moveTo") {
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      tank.goal = { kind: "holdPosition", params: { x: tx, y: ty } };
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
    if (nearestEnemy) {
      aimAngle = angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y);
      wantShoot = canShootTarget(world, tank, nearestEnemy);
    }
  } else if (goal === "escort") {
    const tid = tank.goal.params?.targetTankId;
    const buddy = world.tanks.find((t) => t.id === tid && t.alive);
    if (buddy) {
      const ang = angleTo(buddy.x, buddy.y, tank.x, tank.y);
      const tx = buddy.x + Math.cos(ang) * CONFIG.ai.escortDistance;
      const ty = buddy.y + Math.sin(ang) * CONFIG.ai.escortDistance;
      const s = steerTo(tank, tx, ty, speed, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = nearestEnemy
        ? angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y)
        : s.aimAngle;
      if (nearestEnemy) wantShoot = canShootTarget(world, tank, nearestEnemy);
    }
  } else if (goal === "retreat") {
    const home = homeTerritoryBounds("blue");
    const homeX = CONFIG.canvasWidth * (0.2 + (tank.number % 3) * 0.25);
    const homeY = (home.y0 + home.y1) / 2;
    const s = steerTo(tank, homeX, homeY, speed * 1.05, dt, world);
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = s.aimAngle;
    if (dist(tank.x, tank.y, homeX, homeY) < 40) {
      tank.goal = { kind: "holdPosition", params: { x: homeX, y: homeY } };
    }
  } else if (goal === "reportIn") {
    moveX = 0;
    moveY = 0;
    if (nearestEnemy) {
      aimAngle = angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y);
      wantShoot = canShootTarget(world, tank, nearestEnemy);
    }
  } else if (goal === "debug") {
    const wreck = pickDebugWreck(world, tank);
    if (wreck) {
      tank.debugTargetId = wreck.id;
      if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange * 0.7) {
        const s = steerTo(tank, wreck.x, wreck.y, speed, dt, world);
        moveX = s.moveX;
        moveY = s.moveY;
        aimAngle = s.aimAngle;
      }
    } else if (nearestEnemy) {
      aimAngle = angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y);
      wantShoot = canShootTarget(world, tank, nearestEnemy);
      if (dist(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y) > 100) {
        const s = steerTo(
          tank,
          nearestEnemy.x,
          nearestEnemy.y,
          speed,
          dt,
          world,
        );
        moveX = s.moveX;
        moveY = s.moveY;
      }
    } else {
      tank.goal = { kind: "holdPosition", params: { x: tank.x, y: tank.y } };
    }
  }

  applyMove(tank, moveX, moveY, world);
  return { moveX, moveY, wantShoot, aimAngle };
}

function pickDebugWreck(world: WorldState, tank: Tank): Wreck | null {
  if (tank.goal.params?.wreckId) {
    const specific = world.wrecks.find(
      (w) => w.id === tank.goal.params?.wreckId && !w.debugged,
    );
    if (specific) return specific;
  }
  const marked = world.wrecks.filter((w) => w.marked && !w.debugged);
  const visibleThreat = visibleEnemies(world, tank).some(
    (e) => dist(tank.x, tank.y, e.x, e.y) < 140,
  );
  if (visibleThreat) return null;
  return nearest(marked, tank.x, tank.y);
}

function canShootTarget(
  world: WorldState,
  shooter: Tank,
  target: Tank,
): boolean {
  if (!CONFIG.roles[shooter.role].canShoot) return false;
  return anyTeammateSees(world, shooter.team, target);
}

function enemyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const speed = CONFIG.roles[tank.role].speed;
  const players = world.tanks.filter(
    (t) => t.team === "blue" && t.alive && canSeeTank(tank, t, world.walls),
  );
  const nearestPlayer = nearest(players, tank.x, tank.y);

  let moveX = 0;
  let moveY = 0;
  let wantShoot = false;
  let aimAngle = tank.angle;

  if (nearestPlayer) {
    tank.goal = { kind: "attackNearest" };
    aimAngle = angleTo(tank.x, tank.y, nearestPlayer.x, nearestPlayer.y);
    tank.angle = rotateToward(tank.angle, aimAngle, CONFIG.tankTurnRate * dt);
    if (dist(tank.x, tank.y, nearestPlayer.x, nearestPlayer.y) > 85) {
      const s = steerTo(tank, nearestPlayer.x, nearestPlayer.y, speed, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
    }
    wantShoot = canShootTarget(world, tank, nearestPlayer);
  } else {
    const playerWrecks = world.wrecks.filter(
      (w) => w.team === "blue" && !w.debugged,
    );
    const wreck = nearest(playerWrecks, tank.x, tank.y);
    if (wreck) {
      tank.goal = { kind: "debug", params: { wreckId: wreck.id } };
      tank.debugTargetId = wreck.id;
      if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange * 0.7) {
        const s = steerTo(tank, wreck.x, wreck.y, speed, dt, world);
        moveX = s.moveX;
        moveY = s.moveY;
        aimAngle = s.aimAngle;
      }
    } else {
      // Advance into the map toward the friendly frontline
      const home = homeTerritoryBounds("blue");
      const lane = 0.2 + (tank.number % 3) * 0.25;
      const s = steerTo(
        tank,
        CONFIG.canvasWidth * lane,
        home.y0 - 30,
        speed * 0.85,
        dt,
        world,
      );
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  }

  applyMove(tank, moveX, moveY, world);
  return { moveX, moveY, wantShoot, aimAngle };
}
