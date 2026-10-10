import { CONFIG, homeTerritoryBounds, isMpOffline } from "./config";
import {
  angleTo,
  dist,
  rotateToward,
  tryMove,
  unstickFromWalls,
} from "./arena";
import {
  freshestContact,
  knownEnemyTanks,
  liveVisibleEnemies,
} from "./belief";
import { canSeeTank } from "./fog";
import { COMBAT_LOCKED_GOALS, ORDERED_MOVE_GOALS } from "./goals";
import type { Goal, Tank, WorldState, Wreck } from "./types";

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

function isPlayerOrder(tank: Tank): boolean {
  return tank.goal.source === "player";
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
  if (pos.x !== tank.x || pos.y !== tank.y) {
    tank.x = pos.x;
    tank.y = pos.y;
    return;
  }
  // Blocked — try several slides so bots don't freeze / shiver on corners
  const side = tank.number % 2 === 0 ? 1 : -1;
  const attempts: [number, number][] = [
    [-moveY * side, moveX * side],
    [moveY * side, -moveX * side],
    [-moveY * side * 1.2, moveX * side * 1.2],
    [moveX * 0.35, moveY * 0.35],
    [-moveX * 0.5, moveY * 0.8],
    [moveX * 0.8, -moveY * 0.5],
  ];
  for (const [ax, ay] of attempts) {
    const alt = tryMove(
      tank.x,
      tank.y,
      ax,
      ay,
      CONFIG.tankRadius,
      world.walls,
    );
    if (alt.x !== tank.x || alt.y !== tank.y) {
      tank.x = alt.x;
      tank.y = alt.y;
      return;
    }
  }
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
  const contact = freshestContact(world);
  const baseX =
    contact?.x ??
    marker?.x ??
    CONFIG.canvasWidth * (0.2 + (tank.number % 5) * 0.15);
  const baseY =
    contact?.y ??
    marker?.y ??
    home.y0 - 40 - (tank.number % 4) * 35 - Math.random() * 80;
  const jitter = CONFIG.ai.patrolRadius;
  return clampMap(
    baseX + (Math.random() - 0.5) * jitter,
    baseY + (Math.random() - 0.5) * jitter * 0.7,
  );
}

function newScoutPoint(tank: Tank): { x: number; y: number } {
  const lane = 0.15 + ((tank.number - 1) % 5) * 0.17;
  return clampMap(
    CONFIG.canvasWidth * lane + (Math.random() - 0.5) * 60,
    CONFIG.canvasHeight * (0.22 + Math.random() * 0.28),
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
 * an enemy is visible.
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

/**
 * Soft AI: under fog, system-hold gunners peel toward team-belief contacts.
 * Never steals a player order.
 */
function maybeEngageFromBelief(world: WorldState, tank: Tank): void {
  if (isPlayerOrder(tank)) return;
  if (world.shareMode === "clear") return;
  if (tank.role !== "shooter") return;
  const g = tank.goal.kind;
  if (g !== "holdPosition" && g !== "patrol" && g !== "idle") return;

  const contact = freshestContact(world);
  if (!contact) return;
  const d = dist(tank.x, tank.y, contact.x, contact.y);
  if (d > CONFIG.ai.beliefEngageRadius) return;

  tank.goal = {
    kind: "attackNearest",
    source: "system",
    params: { x: contact.x, y: contact.y },
  };
}

/**
 * Cover-me slot: stand toward enemy fire (threat arc), spread across it.
 * Falls back to a full circle around the VIP when no contacts are known.
 */
function escortCoverSlot(
  world: WorldState,
  tank: Tank,
  vip: Tank,
): { x: number; y: number; faceAngle: number } {
  const guards = world.tanks
    .filter(
      (t) =>
        t.alive &&
        t.team === vip.team &&
        t.id !== vip.id &&
        t.goal.kind === "escort" &&
        t.goal.params?.targetTankId === vip.id,
    )
    .sort((a, b) => a.number - b.number);
  const n = Math.max(1, guards.length);
  let index = guards.findIndex((g) => g.id === tank.id);
  if (index < 0) index = Math.max(0, tank.number - 1) % n;

  // Threat direction from VIP → enemy cluster (belief + live)
  let threatX = 0;
  let threatY = 0;
  let threatCount = 0;
  for (const e of knownEnemyTanks(world, vip)) {
    threatX += e.x;
    threatY += e.y;
    threatCount++;
  }
  for (const c of world.teamBelief.contacts) {
    // Weight markers even if tank ref missing
    if (world.tanks.some((t) => t.id === c.enemyId && t.alive)) continue;
    threatX += c.x;
    threatY += c.y;
    threatCount++;
  }

  const radius = CONFIG.ai.escortDistance;
  let faceAngle: number;
  let slotAngle: number;

  if (threatCount > 0) {
    const cx = threatX / threatCount;
    const cy = threatY / threatCount;
    faceAngle = angleTo(vip.x, vip.y, cx, cy);
    // Spread bodyguards across an arc facing the threat (not all on one point)
    const spread = CONFIG.ai.escortArcSpread;
    const t = n === 1 ? 0.5 : index / (n - 1);
    slotAngle = faceAngle - spread / 2 + t * spread;
  } else {
    // No contacts: ring around VIP so they don't pile south of facing
    faceAngle = vip.angle;
    slotAngle = faceAngle + (index / n) * Math.PI * 2 + Math.PI / n;
  }

  const raw = {
    x: vip.x + Math.cos(slotAngle) * radius,
    y: vip.y + Math.sin(slotAngle) * radius,
  };
  const clamped = clampMap(raw.x, raw.y);
  return { x: clamped.x, y: clamped.y, faceAngle };
}

/** Close/surrounded threat → panic escape without waiting for orders. */
function shouldPanicEscape(tank: Tank, liveEnemies: Tank[]): boolean {
  const { panicRadius, surroundRadius, surroundEnemyCount } = CONFIG.mpOffline;
  let near = 0;
  for (const e of liveEnemies) {
    const d = dist(tank.x, tank.y, e.x, e.y);
    if (d <= panicRadius) return true;
    if (d <= surroundRadius) near++;
  }
  return near >= surroundEnemyCount;
}

function fleePoint(tank: Tank, threats: Tank[]): { x: number; y: number } {
  let ax = 0;
  let ay = 0;
  for (const e of threats) {
    const d = dist(tank.x, tank.y, e.x, e.y) || 1;
    ax += (tank.x - e.x) / d;
    ay += (tank.y - e.y) / d;
  }
  const mag = Math.hypot(ax, ay) || 1;
  const distFlee = CONFIG.mpOffline.escapeDistance;
  return clampMap(
    tank.x + (ax / mag) * distFlee,
    tank.y + (ay / mag) * distFlee,
  );
}

/**
 * Multiplayer · Offline teammate AI:
 * - Default hold until voice/text orders (no autonomous patrol/scout)
 * - Shoot while holding if enemy in range + LOS
 * - Panic escape when surrounded / under close attack, then resume hold/last order
 */
function mpOfflineFriendlyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const speed = CONFIG.roles[tank.role].speed;
  const liveEnemies = liveVisibleEnemies(world, tank);
  const nearestLive = nearest(liveEnemies, tank.x, tank.y);

  // Never invent patrol/scout/idle wander — force system soft goals back to hold.
  if (
    !isPlayerOrder(tank) &&
    (tank.goal.kind === "patrol" ||
      tank.goal.kind === "scout" ||
      tank.goal.kind === "idle" ||
      tank.goal.kind === "attackNearest" ||
      tank.goal.kind === "debug")
  ) {
    tank.goal = {
      kind: "holdPosition",
      source: "system",
      params: { x: tank.x, y: tank.y },
    };
  }

  let wantShoot = false;
  let aimAngle = tank.angle;
  let moveX = 0;
  let moveY = 0;

  // Panic escape: flee without waiting for orders, then resume last goal.
  if (nearestLive && shouldPanicEscape(tank, liveEnemies)) {
    const resume: Goal = {
      kind: tank.goal.kind,
      params: { ...tank.goal.params },
      source: tank.goal.source,
    };
    const flee = fleePoint(tank, liveEnemies);
    const s = steerTo(tank, flee.x, flee.y, speed * 1.15, dt, world);
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y);
    wantShoot = true;
    applyMove(tank, moveX, moveY, world);
    // Keep ordered goals; after clear, hold/move resumes naturally next frames.
    if (!isPlayerOrder(tank) && resume.kind === "holdPosition") {
      // Snap hold station to post-escape spot once threat clears (below).
      tank.goal = {
        kind: "holdPosition",
        source: "system",
        params: { x: flee.x, y: flee.y },
      };
    }
    return { moveX, moveY, wantShoot, aimAngle };
  }

  // Shoot-while-holding (and while executing any order): fire if hittable.
  if (nearestLive) {
    aimAngle = angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y);
    tank.angle = rotateToward(tank.angle, aimAngle, CONFIG.tankTurnRate * 2 * dt);
    wantShoot = true;
  }

  const activeGoal = tank.goal.kind;

  if (activeGoal === "holdPosition") {
    const hx = tank.goal.params?.x ?? tank.x;
    const hy = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, hx, hy) > CONFIG.ai.holdRadius) {
      const s = steerTo(tank, hx, hy, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      if (!nearestLive) aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "moveTo") {
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      tank.goal = {
        kind: "holdPosition",
        params: { x: tx, y: ty },
        source: tank.goal.source ?? "system",
      };
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      if (!nearestLive) aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "spreadOut") {
    const slot = spreadSlot(tank);
    const tx = tank.goal.params?.x ?? slot.x;
    const ty = tank.goal.params?.y ?? slot.y;
    if (!tank.goal.params?.x) tank.goal.params = { x: tx, y: ty };
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      tank.goal = {
        kind: "holdPosition",
        params: { x: tx, y: ty },
        source: tank.goal.source ?? "system",
      };
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      if (!nearestLive) aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "escort") {
    const tid = tank.goal.params?.targetTankId;
    const buddy = world.tanks.find((t) => t.id === tid && t.alive);
    if (buddy && buddy.id !== tank.id) {
      const slot = escortCoverSlot(world, tank, buddy);
      const dSlot = dist(tank.x, tank.y, slot.x, slot.y);
      if (dSlot > CONFIG.ai.escortSlotRadius) {
        const s = steerTo(tank, slot.x, slot.y, speed, dt, world, {
          separate: true,
        });
        moveX = s.moveX;
        moveY = s.moveY;
      }
      if (!nearestLive) aimAngle = slot.faceAngle;
    } else {
      tank.goal = {
        kind: "holdPosition",
        source: "system",
        params: { x: tank.x, y: tank.y },
      };
    }
  } else if (activeGoal === "attackNearest" && isPlayerOrder(tank)) {
    // Only when player ordered attack — no autonomous aggro.
    if (nearestLive) {
      const fight = combatManeuver(world, tank, nearestLive, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = fight.wantShoot;
      aimAngle = fight.aimAngle;
    }
  } else if (activeGoal === "retreat") {
    const home = homeTerritoryBounds("blue");
    const homeX = CONFIG.canvasWidth * (0.15 + (tank.number % 5) * 0.15);
    const homeY = (home.y0 + home.y1) / 2;
    if (dist(tank.x, tank.y, homeX, homeY) < 45) {
      tank.goal = {
        kind: "holdPosition",
        source: "system",
        params: { x: homeX, y: homeY },
      };
    } else {
      const s = steerTo(tank, homeX, homeY, speed * 1.1, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
      if (!nearestLive) aimAngle = s.aimAngle;
    }
  } else {
    // Any other goal in this mode collapses to hold (no debug/scout/patrol).
    tank.goal = {
      kind: "holdPosition",
      source: isPlayerOrder(tank) ? "player" : "system",
      params: {
        x: tank.goal.params?.x ?? tank.x,
        y: tank.goal.params?.y ?? tank.y,
      },
    };
  }

  applyMove(tank, moveX, moveY, world);
  return { moveX, moveY, wantShoot, aimAngle };
}

function friendlyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  if (isMpOffline(world.gameMode)) {
    return mpOfflineFriendlyBrain(world, tank, dt);
  }

  const speed = CONFIG.roles[tank.role].speed;
  const liveEnemies = liveVisibleEnemies(world, tank);
  const known = knownEnemyTanks(world, tank);
  const nearestLive = nearest(liveEnemies, tank.x, tank.y);
  const nearestKnown = nearest(known, tank.x, tank.y);

  let wantShoot = false;
  let aimAngle = tank.angle;
  let moveX = 0;
  let moveY = 0;

  maybeEngageFromBelief(world, tank);

  let goal = tank.goal.kind;
  const orderedMove = ORDERED_MOVE_GOALS.has(goal) && isPlayerOrder(tank);
  const softOrdered = ORDERED_MOVE_GOALS.has(goal);

  // Low HP → fall back, but don't cancel an explicit player move/spread/hold/escort
  if (
    !orderedMove &&
    tank.hp / tank.maxHp < CONFIG.ai.retreatHpFraction &&
    tank.goal.kind !== "retreat" &&
    tank.goal.kind !== "reportIn"
  ) {
    tank.goal = { kind: "retreat", source: "system" };
    goal = "retreat";
  }

  // Combat: only fully override ordered moves when the threat is on top of us
  const allowCombat =
    !COMBAT_LOCKED_GOALS.has(goal) &&
    !(goal === "debug" && tank.standStillTimer > 0.3);
  if (nearestLive && allowCombat) {
    const dEnemy = dist(tank.x, tank.y, nearestLive.x, nearestLive.y);
    const fight = combatManeuver(world, tank, nearestLive, speed, dt);
    const abandonOrder =
      !softOrdered &&
      (dEnemy < CONFIG.ai.attackAggro ||
        goal === "attackNearest" ||
        goal === "idle");
    // Player orders: only panic radius. System holds/scouts: same panic.
    const panic = softOrdered && dEnemy < CONFIG.ai.orderThreatRadius;
    if (abandonOrder || panic) {
      applyMove(tank, fight.moveX, fight.moveY, world);
      return {
        moveX: fight.moveX,
        moveY: fight.moveY,
        wantShoot: fight.wantShoot,
        aimAngle: fight.aimAngle,
      };
    }
    // Distant contact while under orders: keep moving, still shoot if LOS
    wantShoot = true;
    aimAngle = fight.aimAngle;
  }

  const activeGoal = tank.goal.kind;

  if (activeGoal === "attackNearest") {
    if (nearestLive) {
      const fight = combatManeuver(world, tank, nearestLive, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = fight.wantShoot;
      aimAngle = fight.aimAngle;
    } else if (nearestKnown) {
      // Hunt last team-belief contact under fog
      const s = steerTo(
        tank,
        nearestKnown.x,
        nearestKnown.y,
        speed * 0.95,
        dt,
        world,
      );
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    } else {
      ensureWaypoint(tank, world);
      const tx = tank.goal.params?.x ?? tank.x;
      const ty = tank.goal.params?.y ?? tank.y;
      if (dist(tank.x, tank.y, tx, ty) < 28) {
        const p = newPatrolPoint(tank, world);
        tank.goal = {
          kind: "attackNearest",
          source: tank.goal.source ?? "system",
          params: p,
        };
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
  } else if (activeGoal === "holdPosition") {
    const hx = tank.goal.params?.x ?? tank.x;
    const hy = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, hx, hy) > CONFIG.ai.holdRadius) {
      const s = steerTo(tank, hx, hy, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    } else {
      moveX = 0;
      moveY = 0;
    }
  } else if (activeGoal === "moveTo") {
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      tank.goal = {
        kind: "holdPosition",
        params: { x: tx, y: ty },
        source: tank.goal.source ?? "system",
      };
      moveX = 0;
      moveY = 0;
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "scout") {
    ensureScoutWaypoint(tank);
    const tx = tank.goal.params!.x!;
    const ty = tank.goal.params!.y!;
    if (dist(tank.x, tank.y, tx, ty) < 28) {
      // Arrived probe point → report in under report mode, else next probe
      if (world.shareMode === "report" && !isPlayerOrder(tank)) {
        tank.goal = { kind: "reportIn", source: "system" };
      } else {
        tank.goal = {
          kind: "scout",
          source: tank.goal.source ?? "system",
          params: newScoutPoint(tank),
        };
      }
    }
    const s = steerTo(tank, tx, ty, speed * 0.95, dt, world, {
      separate: true,
    });
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = nearestLive
      ? angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y)
      : s.aimAngle;
    if (nearestLive) wantShoot = true;
  } else if (activeGoal === "patrol" || activeGoal === "idle") {
    if (activeGoal === "idle") {
      tank.goal = {
        kind: "patrol",
        source: "system",
        params: newPatrolPoint(tank, world),
      };
    }
    ensureWaypoint(tank, world);
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, tx, ty) < 24) {
      tank.goal = {
        kind: "patrol",
        source: tank.goal.source ?? "system",
        params: newPatrolPoint(tank, world),
      };
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
  } else if (activeGoal === "spreadOut") {
    const slot = spreadSlot(tank);
    const tx = tank.goal.params?.x ?? slot.x;
    const ty = tank.goal.params?.y ?? slot.y;
    if (!tank.goal.params?.x) tank.goal.params = { x: tx, y: ty };
    if (dist(tank.x, tank.y, tx, ty) < CONFIG.ai.holdRadius) {
      tank.goal = {
        kind: "holdPosition",
        params: { x: tx, y: ty },
        source: tank.goal.source ?? "system",
      };
      moveX = 0;
      moveY = 0;
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, { separate: true });
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "escort") {
    const tid = tank.goal.params?.targetTankId;
    const buddy = world.tanks.find((t) => t.id === tid && t.alive);
    if (buddy && buddy.id !== tank.id) {
      const slot = escortCoverSlot(world, tank, buddy);
      const dSlot = dist(tank.x, tank.y, slot.x, slot.y);
      const dBuddy = dist(tank.x, tank.y, buddy.x, buddy.y);
      const catchup = CONFIG.ai.escortCatchup;
      // On station: hold still (no trail-orbit shiver / pile-up nudge)
      if (dSlot <= CONFIG.ai.escortSlotRadius) {
        moveX = 0;
        moveY = 0;
      } else {
        const sprint =
          dBuddy > catchup ? 1.25 : dSlot > CONFIG.ai.escortDistance ? 1.1 : 1;
        const s = steerTo(tank, slot.x, slot.y, speed * sprint, dt, world, {
          separate: true,
        });
        moveX = s.moveX;
        moveY = s.moveY;
      }
      // Face threat / fire lane, not the VIP's rear
      if (nearestLive) {
        aimAngle = angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y);
        wantShoot = true;
      } else if (nearestKnown) {
        aimAngle = angleTo(tank.x, tank.y, nearestKnown.x, nearestKnown.y);
      } else {
        aimAngle = slot.faceAngle;
      }
      tank.angle = rotateToward(
        tank.angle,
        aimAngle,
        CONFIG.tankTurnRate * 2 * dt,
      );
    } else {
      tank.goal = {
        kind: "patrol",
        source: "system",
        params: newPatrolPoint(tank, world),
      };
    }
  } else if (activeGoal === "retreat") {
    const home = homeTerritoryBounds("blue");
    const homeX = CONFIG.canvasWidth * (0.15 + (tank.number % 5) * 0.15);
    const homeY = (home.y0 + home.y1) / 2;
    const s = steerTo(tank, homeX, homeY, speed * 1.1, dt, world);
    moveX = s.moveX;
    moveY = s.moveY;
    aimAngle = nearestLive
      ? angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y)
      : s.aimAngle;
    if (nearestLive) wantShoot = true;
    if (dist(tank.x, tank.y, homeX, homeY) < 45) {
      tank.goal = {
        kind: "patrol",
        source: "system",
        params: newPatrolPoint(tank, world),
      };
    }
  } else if (activeGoal === "reportIn") {
    if (
      nearestLive &&
      dist(tank.x, tank.y, nearestLive.x, nearestLive.y) <
        CONFIG.ai.kiteRange + 20
    ) {
      const fight = combatManeuver(world, tank, nearestLive, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = true;
      aimAngle = fight.aimAngle;
    } else {
      moveX = 0;
      moveY = 0;
      if (nearestLive) {
        aimAngle = angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y);
        wantShoot = true;
      }
    }
  } else if (activeGoal === "debug") {
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
      tank.goal = {
        kind: "patrol",
        source: "system",
        params: newPatrolPoint(tank, world),
      };
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

function ensureScoutWaypoint(tank: Tank): void {
  if (tank.goal.params?.x == null || tank.goal.params?.y == null) {
    tank.goal.params = { ...tank.goal.params, ...newScoutPoint(tank) };
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
  const visibleThreat = liveVisibleEnemies(world, tank).some(
    (e) => dist(tank.x, tank.y, e.x, e.y) < 140,
  );
  if (visibleThreat) return null;
  return nearest(marked, tank.x, tank.y);
}

function redTier(world: WorldState) {
  return CONFIG.ai.redDifficulty[world.redDifficulty] ?? CONFIG.ai.redDifficulty.normal;
}

function enemyBrain(
  world: WorldState,
  tank: Tank,
  dt: number,
): { moveX: number; moveY: number; wantShoot: boolean; aimAngle: number } {
  const tier = redTier(world);
  const speed = CONFIG.roles[tank.role].speed * tier.speedMul;
  const players = world.tanks.filter(
    (t) => t.team === "blue" && t.alive && canSeeTank(tank, t, world.walls),
  );
  const nearestPlayer = nearest(players, tank.x, tank.y);
  const engageMul = tier.engageRangeMul;

  let moveX = 0;
  let moveY = 0;
  let wantShoot = false;
  let aimAngle = tank.angle;

  if (tank.hp / tank.maxHp < CONFIG.ai.retreatHpFraction && nearestPlayer) {
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
    // Hard: stick closer; easy: hang back a bit
    const scale = tier.aggroMul;
    moveX = fight.moveX * Math.min(1.15, 0.85 + 0.15 * scale);
    moveY = fight.moveY * Math.min(1.15, 0.85 + 0.15 * scale);
    wantShoot = fight.wantShoot;
    aimAngle = fight.aimAngle;
  } else {
    let huntedWreck = false;
    if (!isMpOffline(world.gameMode)) {
      const playerWrecks = world.wrecks.filter(
        (w) => w.team === "blue" && !w.debugged,
      );
      const wreck = nearest(playerWrecks, tank.x, tank.y);
      if (wreck && dist(tank.x, tank.y, wreck.x, wreck.y) < 280 * engageMul) {
        huntedWreck = true;
        tank.debugTargetId = wreck.id;
        if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange * 0.7) {
          const s = steerTo(tank, wreck.x, wreck.y, speed, dt, world);
          moveX = s.moveX;
          moveY = s.moveY;
          aimAngle = s.aimAngle;
        }
      }
    }
    if (!huntedWreck) {
      const home = homeTerritoryBounds("blue");
      const lane = 0.18 + (tank.number % 5) * 0.16;
      const push = 20 + 40 * tier.aggroMul;
      const targetY =
        home.y0 - push - ((world.time * 8 + tank.number * 40) % 120);
      const s = steerTo(
        tank,
        CONFIG.canvasWidth * lane +
          Math.sin(world.time * 0.4 + tank.number) * 30,
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
