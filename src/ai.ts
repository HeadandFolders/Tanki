import { CONFIG, homeTerritoryBounds } from "./config";
import {
  angleTo,
  dist,
  rotateToward,
  tryMove,
  unstickFromWalls,
} from "./arena";
import { canSeeTank } from "./fog";
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

  if (tank.team === "red") return enemyBrain(world, tank, dt);
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
  opts: { separate?: boolean } = {},
): { moveX: number; moveY: number; aimAngle: number } {
  const ang = angleTo(tank.x, tank.y, tx, ty);
  tank.angle = rotateToward(tank.angle, ang, CONFIG.tankTurnRate * 1.8 * dt);
  const d = dist(tank.x, tank.y, tx, ty);
  if (d < 12) return { moveX: 0, moveY: 0, aimAngle: tank.angle };

  let vx = Math.cos(ang) * speed;
  let vy = Math.sin(ang) * speed;

  // Soft separation — capped so it can't cancel seek and cause corner-shiver
  if (opts.separate !== false) {
    const sepR = CONFIG.ai.separationRadius;
    let sx = 0;
    let sy = 0;
    for (const o of world.tanks) {
      if (o.id === tank.id || !o.alive || o.team !== tank.team) continue;
      const dd = dist(tank.x, tank.y, o.x, o.y);
      if (dd < sepR && dd > 0.1) {
        const force = CONFIG.ai.separation * (1 - dd / sepR);
        sx += ((tank.x - o.x) / dd) * force;
        sy += ((tank.y - o.y) / dd) * force;
      }
    }
    const sepMag = Math.hypot(sx, sy);
    const sepCap = speed * 0.45;
    if (sepMag > sepCap && sepMag > 0) {
      sx = (sx / sepMag) * sepCap;
      sy = (sy / sepMag) * sepCap;
    }
    vx += sx;
    vy += sy;
  }

  return { moveX: vx * dt, moveY: vy * dt, aimAngle: ang };
}

function applyMove(
  tank: Tank,
  moveX: number,
  moveY: number,
  world: WorldState,
): void {
  if (!moveX && !moveY) return;
  const pos = tryMove(
    tank.x,
    tank.y,
    moveX,
    moveY,
    CONFIG.tankRadius,
    world.walls,
  );
  // If blocked straight on, try a sidestep so AI doesn't freeze on walls
  if (pos.x === tank.x && pos.y === tank.y) {
    const side = tank.number % 2 === 0 ? 1 : -1;
    const alt = tryMove(
      tank.x,
      tank.y,
      -moveY * side * 0.8,
      moveX * side * 0.8,
      CONFIG.tankRadius,
      world.walls,
    );
    tank.x = alt.x;
    tank.y = alt.y;
    return;
  }
  tank.x = pos.x;
  tank.y = pos.y;
}

function clampMap(x: number, y: number): { x: number; y: number } {
  const pad = CONFIG.tileSize * 3;
  return {
    x: Math.min(CONFIG.canvasWidth - pad, Math.max(pad, x)),
    y: Math.min(CONFIG.canvasHeight - pad, Math.max(pad, y)),
  };
}

function newPatrolPoint(tank: Tank, world: WorldState): { x: number; y: number } {
  const home = homeTerritoryBounds("blue");
  const marker = world.markers.find((m) => m.kind === "enemy");
  const baseX = marker?.x ?? CONFIG.canvasWidth * (0.2 + (tank.number % 5) * 0.15);
  const baseY =
    marker?.y ??
    home.y0 - 40 - (tank.number % 4) * 35 - Math.random() * 80;
  const jitter = CONFIG.ai.patrolRadius;
  return clampMap(
    baseX + (Math.random() - 0.5) * jitter,
    baseY + (Math.random() - 0.5) * jitter * 0.7,
  );
}

function spreadSlot(tank: Tank): { x: number; y: number } {
  const lane = (tank.number - 0.5) / 6;
  return clampMap(
    CONFIG.canvasWidth * (0.1 + lane * 0.8),
    CONFIG.canvasHeight * (0.55 + (tank.number % 3) * 0.1),
  );
}

/**
 * Combat overlay: close to fight range, kite if too close, always shoot when
 * an enemy is visible. Returns null if no combat action.
 */
function combatManeuver(
  world: WorldState,
  tank: Tank,
  enemy: Tank,
  speed: number,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const fightRange = CONFIG.roles[tank.role].fightRange;
  const d = dist(tank.x, tank.y, enemy.x, enemy.y);
  const aimAngle = angleTo(tank.x, tank.y, enemy.x, enemy.y);
  tank.angle = rotateToward(tank.angle, aimAngle, CONFIG.tankTurnRate * 2 * dt);

  let moveX = 0;
  let moveY = 0;
  if (d < CONFIG.ai.kiteRange) {
    // Back off while shooting
    const away = angleTo(enemy.x, enemy.y, tank.x, tank.y);
    const s = steerTo(
      tank,
      tank.x + Math.cos(away) * 80,
      tank.y + Math.sin(away) * 80,
      speed * 1.05,
      dt,
      world,
    );
    moveX = s.moveX;
    moveY = s.moveY;
  } else if (d > fightRange) {
    const s = steerTo(tank, enemy.x, enemy.y, speed, dt, world);
    moveX = s.moveX;
    moveY = s.moveY;
  } else {
    // Strafe in band
    const side = tank.number % 2 === 0 ? 1 : -1;
    const s = steerTo(
      tank,
      tank.x + Math.cos(aimAngle + side * 1.2) * 40,
      tank.y + Math.sin(aimAngle + side * 1.2) * 40,
      speed * 0.55,
      dt,
      world,
    );
    moveX = s.moveX;
    moveY = s.moveY;
  }

  return { moveX, moveY, wantShoot: true, aimAngle };
}

function friendlyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const speed = CONFIG.roles[tank.role].speed;
  const enemies = visibleEnemies(world, tank);
  const nearestEnemy = nearest(enemies, tank.x, tank.y);

  let wantShoot = false;
  let aimAngle = tank.angle;
  let moveX = 0;
  let moveY = 0;
  const goal = tank.goal.kind;
  const orderedMove =
    goal === "moveTo" ||
    goal === "spreadOut" ||
    goal === "holdPosition" ||
    goal === "escort";

  // Low HP → fall back, but don't cancel an explicit move/spread/hold/escort order
  if (
    !orderedMove &&
    tank.hp / tank.maxHp < CONFIG.ai.retreatHpFraction &&
    tank.goal.kind !== "retreat" &&
    tank.goal.kind !== "reportIn"
  ) {
    tank.goal = { kind: "retreat" };
  }

  // Combat: only fully override ordered moves when the threat is on top of us
  const allowCombat =
    goal !== "reportIn" &&
    goal !== "retreat" &&
    !(goal === "debug" && tank.standStillTimer > 0.3);
  if (nearestEnemy && allowCombat) {
    const dEnemy = dist(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y);
    const fight = combatManeuver(world, tank, nearestEnemy, speed, dt);
    const abandonOrder =
      !orderedMove &&
      (dEnemy < CONFIG.ai.attackAggro ||
        goal === "attackNearest" ||
        goal === "idle");
    const panic =
      orderedMove && dEnemy < CONFIG.ai.orderThreatRadius;
    if (abandonOrder || panic) {
      applyMove(tank, fight.moveX, fight.moveY, world);
      return {
        moveX: fight.moveX,
        moveY: fight.moveY,
        wantShoot: fight.wantShoot,
        aimAngle: fight.aimAngle,
      };
    }
    // Distant contact while under orders: keep moving, still shoot
    wantShoot = true;
    aimAngle = fight.aimAngle;
  }

  if (goal === "attackNearest") {
    if (nearestEnemy) {
      const fight = combatManeuver(world, tank, nearestEnemy, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = fight.wantShoot;
      aimAngle = fight.aimAngle;
    } else {
      // Hunt: keep advancing / patrol toward fog of war
      ensureWaypoint(tank, world);
      const tx = tank.goal.params?.x ?? tank.x;
      const ty = tank.goal.params?.y ?? tank.y;
      if (dist(tank.x, tank.y, tx, ty) < 28) {
        const p = newPatrolPoint(tank, world);
        tank.goal = { kind: "attackNearest", params: p };
      }
      const s = steerTo(
        tank,
        tank.goal.params!.x!,
        tank.goal.params!.y!,
        speed * 0.95,
        dt,
        world,
      );
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  } else if (goal === "holdPosition") {
    const hx = tank.goal.params?.x ?? tank.x;
    const hy = tank.goal.params?.y ?? tank.y;
    // Soft hold: return if drifted; idle when on station (no orbit shiver)
    if (dist(tank.x, tank.y, hx, hy) > CONFIG.ai.holdRadius) {
      const s = steerTo(tank, hx, hy, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    } else {
      moveX = 0;
      moveY = 0;
    }
  } else if (goal === "moveTo") {
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      // Arrived → hold station (don't flip to jittery patrol)
      tank.goal = { kind: "holdPosition", params: { x: tx, y: ty } };
      moveX = 0;
      moveY = 0;
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  } else if (goal === "patrol" || goal === "idle") {
    if (goal === "idle") tank.goal = { kind: "patrol", params: newPatrolPoint(tank, world) };
    ensureWaypoint(tank, world);
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, tx, ty) < 24) {
      tank.goal = { kind: "patrol", params: newPatrolPoint(tank, world) };
    }
    const s = steerTo(
      tank,
      tank.goal.params!.x!,
      tank.goal.params!.y!,
      speed * 0.9,
      dt,
      world,
    );
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = s.aimAngle;
  } else if (goal === "spreadOut") {
    const slot = spreadSlot(tank);
    const tx = tank.goal.params?.x ?? slot.x;
    const ty = tank.goal.params?.y ?? slot.y;
    if (!tank.goal.params?.x) tank.goal.params = { x: tx, y: ty };
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      tank.goal = { kind: "holdPosition", params: { x: tx, y: ty } };
      moveX = 0;
      moveY = 0;
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  } else if (goal === "escort") {
    const tid = tank.goal.params?.targetTankId;
    const buddy = world.tanks.find((t) => t.id === tid && t.alive);
    if (buddy && buddy.id !== tank.id) {
      // Trail on the VIP's six so we stick close while they drive
      const trailAng = buddy.angle + Math.PI;
      const slot = CONFIG.ai.escortDistance;
      const tx = buddy.x + Math.cos(trailAng) * slot;
      const ty = buddy.y + Math.sin(trailAng) * slot;
      const dBuddy = dist(tank.x, tank.y, buddy.x, buddy.y);
      const catchup = CONFIG.ai.escortCatchup ?? slot * 2;
      const sprint = dBuddy > catchup ? 1.2 : dBuddy > slot * 1.35 ? 1.05 : 1;
      const s = steerTo(tank, tx, ty, speed * sprint, dt, world, {
        separate: true,
      });
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = nearestEnemy
        ? angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y)
        : buddy.angle;
      if (nearestEnemy) wantShoot = true;
    } else {
      tank.goal = { kind: "patrol", params: newPatrolPoint(tank, world) };
    }
  } else if (goal === "retreat") {
    const home = homeTerritoryBounds("blue");
    const homeX = CONFIG.canvasWidth * (0.15 + (tank.number % 5) * 0.15);
    const homeY = (home.y0 + home.y1) / 2;
    const s = steerTo(tank, homeX, homeY, speed * 1.1, dt, world);
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = nearestEnemy
      ? angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y)
      : s.aimAngle;
    if (nearestEnemy) wantShoot = true;
    if (dist(tank.x, tank.y, homeX, homeY) < 45) {
      tank.goal = { kind: "patrol", params: newPatrolPoint(tank, world) };
    }
  } else if (goal === "reportIn") {
    // Stand for radio — but break to kite if enemy is on top of us
    if (
      nearestEnemy &&
      dist(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y) < CONFIG.ai.kiteRange + 20
    ) {
      const fight = combatManeuver(world, tank, nearestEnemy, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = true;
      aimAngle = fight.aimAngle;
    } else {
      moveX = 0;
      moveY = 0;
      if (nearestEnemy) {
        aimAngle = angleTo(tank.x, tank.y, nearestEnemy.x, nearestEnemy.y);
        wantShoot = true;
      }
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
    } else {
      tank.goal = { kind: "patrol", params: newPatrolPoint(tank, world) };
    }
  }

  applyMove(tank, moveX, moveY, world);
  return { moveX, moveY, wantShoot, aimAngle };
}

function ensureWaypoint(tank: Tank, world: WorldState): void {
  if (tank.goal.params?.x == null || tank.goal.params?.y == null) {
    const p = newPatrolPoint(tank, world);
    tank.goal.params = { ...tank.goal.params, ...p };
  }
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

  if (tank.hp / tank.maxHp < CONFIG.ai.retreatHpFraction && nearestPlayer) {
    // Kite south→north toward their home
    const redHome = homeTerritoryBounds("red");
    const s = steerTo(
      tank,
      CONFIG.canvasWidth * (0.2 + (tank.number % 3) * 0.25),
      (redHome.y0 + redHome.y1) / 2,
      speed * 1.05,
      dt,
      world,
    );
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = angleTo(tank.x, tank.y, nearestPlayer.x, nearestPlayer.y);
    wantShoot = true;
  } else if (nearestPlayer) {
    const fight = combatManeuver(world, tank, nearestPlayer, speed, dt);
    moveX = fight.moveX;
    moveY = fight.moveY;
    wantShoot = fight.wantShoot;
    aimAngle = fight.aimAngle;
  } else {
    const playerWrecks = world.wrecks.filter(
      (w) => w.team === "blue" && !w.debugged,
    );
    const wreck = nearest(playerWrecks, tank.x, tank.y);
    if (wreck && dist(tank.x, tank.y, wreck.x, wreck.y) < 280) {
      tank.debugTargetId = wreck.id;
      if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange * 0.7) {
        const s = steerTo(tank, wreck.x, wreck.y, speed, dt, world);
        moveX = s.moveX;
        moveY = s.moveY;
        aimAngle = s.aimAngle;
      }
    } else {
      const home = homeTerritoryBounds("blue");
      const lane = 0.18 + (tank.number % 5) * 0.16;
      const targetY = home.y0 - 20 - (world.time * 8 + tank.number * 40) % 120;
      const s = steerTo(
        tank,
        CONFIG.canvasWidth * lane + Math.sin(world.time * 0.4 + tank.number) * 30,
        targetY,
        speed * 0.9,
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
