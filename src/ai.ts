import { CONFIG } from "./config";
import {
  angleTo,
  dist,
  rotateToward,
  tryMove,
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

function steerTo(
  tank: Tank,
  tx: number,
  ty: number,
  speed: number,
  dt: number,
  world: WorldState,
): { moveX: number; moveY: number; aimAngle: number } {
  const ang = angleTo(tank.x, tank.y, tx, ty);
  tank.angle = rotateToward(tank.angle, ang, CONFIG.tankTurnRate * dt);
  const d = dist(tank.x, tank.y, tx, ty);
  if (d < 8) return { moveX: 0, moveY: 0, aimAngle: tank.angle };
  const vx = Math.cos(tank.angle) * speed;
  const vy = Math.sin(tank.angle) * speed;
  // soft separation
  let sx = 0;
  let sy = 0;
  for (const o of world.tanks) {
    if (o.id === tank.id || !o.alive) continue;
    const dd = dist(tank.x, tank.y, o.x, o.y);
    if (dd < CONFIG.tankRadius * 3 && dd > 0.1) {
      sx += ((tank.x - o.x) / dd) * CONFIG.separationForce;
      sy += ((tank.y - o.y) / dd) * CONFIG.separationForce;
    }
  }
  return {
    moveX: (vx + sx) * dt,
    moveY: (vy + sy) * dt,
    aimAngle: ang,
  };
}

function friendlyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const speed = CONFIG.roles[tank.role].speed;
  const enemies = visibleEnemies(world, tank);
  const nearestEnemy = nearest(enemies, tank.x, tank.y);

  // Auto-flee if nearly dead unless already retreating
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
      const d = dist(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y);
      if (d > 90) {
        const s = steerTo(tank, nearestEnemy.x, nearestEnemy.y, speed, dt, world);
        moveX = s.moveX;
        moveY = s.moveY;
      }
      wantShoot = canShootTarget(world, tank, nearestEnemy);
    } else {
      // hunt toward center / last markers
      const marker = world.markers.find((m) => m.kind === "enemy");
      const tx = marker?.x ?? CONFIG.canvasWidth * 0.55;
      const ty = marker?.y ?? CONFIG.canvasHeight * 0.5;
      const s = steerTo(tank, tx, ty, speed * 0.85, dt, world);
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
    const homeX = 120;
    const homeY = tank.number <= 3 ? 200 : 400;
    const s = steerTo(tank, homeX, homeY, speed * 1.05, dt, world);
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = s.aimAngle;
    if (dist(tank.x, tank.y, homeX, homeY) < 40) {
      tank.goal = { kind: "holdPosition", params: { x: homeX, y: homeY } };
    }
  } else if (goal === "reportIn") {
    // stand still exposed
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
      const d = dist(tank.x, tank.y, wreck.x, wreck.y);
      if (d > CONFIG.debugRange * 0.7) {
        const s = steerTo(tank, wreck.x, wreck.y, speed, dt, world);
        moveX = s.moveX;
        moveY = s.moveY;
        aimAngle = s.aimAngle;
      } else {
        moveX = 0;
        moveY = 0;
      }
    } else if (nearestEnemy) {
      // interrupt to fight nearby visible enemy
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

  // Apply movement with collision
  if (moveX || moveY) {
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
  // Prefer nearest; if nearby visible enemy, AI layer skips — caller handles
  const visibleThreat = visibleEnemies(world, tank).some(
    (e) => dist(tank.x, tank.y, e.x, e.y) < 140,
  );
  if (visibleThreat) return null;
  return nearest(marked, tank.x, tank.y);
}

function canShootTarget(world: WorldState, shooter: Tank, target: Tank): boolean {
  if (shooter.role === "scout") {
    // scouts can plink but not meaningful — still allow tiny damage
    return canSeeTank(shooter, target, world.walls);
  }
  // Shooters may only target enemies visible to ANY teammate
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
    const d = dist(tank.x, tank.y, nearestPlayer.x, nearestPlayer.y);
    if (d > 85) {
      const s = steerTo(tank, nearestPlayer.x, nearestPlayer.y, speed, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
    }
    wantShoot =
      tank.role === "scout"
        ? true
        : anyTeammateSees(world, "red", nearestPlayer);
  } else {
    // Debug player wrecks when no player tank visible
    const playerWrecks = world.wrecks.filter(
      (w) => w.team === "blue" && !w.debugged,
    );
    const wreck = nearest(playerWrecks, tank.x, tank.y);
    if (wreck) {
      tank.goal = { kind: "debug", params: { wreckId: wreck.id } };
      tank.debugTargetId = wreck.id;
      const d = dist(tank.x, tank.y, wreck.x, wreck.y);
      if (d > CONFIG.debugRange * 0.7) {
        const s = steerTo(tank, wreck.x, wreck.y, speed, dt, world);
        moveX = s.moveX;
        moveY = s.moveY;
        aimAngle = s.aimAngle;
      }
    } else {
      // patrol toward player side
      const s = steerTo(
        tank,
        280 + (tank.number % 3) * 40,
        200 + tank.number * 30,
        speed * 0.7,
        dt,
        world,
      );
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  }

  if (moveX || moveY) {
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

  return { moveX, moveY, wantShoot, aimAngle };
}
