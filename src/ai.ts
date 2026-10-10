import {
  CONFIG,
  homeTerritoryBounds,
  isMpOffline,
  isMpOnline,
  isMpRules,
} from "./config";
import {
  angleTo,
  circleHitsWall,
  dist,
  rotateToward,
  segmentHitsWall,
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
import type { Goal, Tank, Wall, WorldState, Wreck } from "./types";

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

  // Online: guest's red bots use the same hold-until-ordered brain as blue.
  if (tank.team === "red") {
    if (isMpOnline(world.gameMode)) {
      return mpOfflineFriendlyBrain(world, tank, dt);
    }
    return enemyBrain(world, tank, dt);
  }
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

/** True if a tank-sized body can travel the segment without hitting walls. */
function pathClear(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  walls: Wall[],
  r: number,
): boolean {
  if (segmentHitsWall(x0, y0, x1, y1, walls)) return false;
  const d = dist(x0, y0, x1, y1);
  const steps = Math.max(1, Math.ceil(d / Math.max(8, r * 0.75)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (circleHitsWall(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, walls)) {
      return false;
    }
  }
  return true;
}

/**
 * Coarse BFS waypoint around walls. Returns the next steer point toward goal
 * (not the full path) so escorts/attacks can route through chokes.
 */
function nextWaypointAroundWalls(
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  walls: Wall[],
  r: number,
): { x: number; y: number } {
  const goal = clampMap(gx, gy);
  if (pathClear(sx, sy, goal.x, goal.y, walls, r)) return goal;

  const step = CONFIG.ai.pathStep;
  const pad = CONFIG.tileSize * 3;
  const minX = pad;
  const maxX = CONFIG.canvasWidth - pad;
  const minY = pad;
  const maxY = CONFIG.canvasHeight - pad;
  const toCell = (x: number, y: number) => ({
    cx: Math.round((x - minX) / step),
    cy: Math.round((y - minY) / step),
  });
  const toWorld = (cx: number, cy: number) =>
    clampMap(minX + cx * step, minY + cy * step);
  const key = (cx: number, cy: number) => `${cx},${cy}`;

  const start = toCell(sx, sy);
  const end = toCell(goal.x, goal.y);
  const maxC = Math.ceil((maxX - minX) / step);
  const maxR = Math.ceil((maxY - minY) / step);

  const walkable = (cx: number, cy: number): boolean => {
    if (cx < 0 || cy < 0 || cx > maxC || cy > maxR) return false;
    const p = toWorld(cx, cy);
    return !circleHitsWall(p.x, p.y, r, walls);
  };

  if (!walkable(end.cx, end.cy)) {
    // Softened goal: nearest walkable cell near the target
    let best: { cx: number; cy: number; d: number } | null = null;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const cx = end.cx + dx;
        const cy = end.cy + dy;
        if (!walkable(cx, cy)) continue;
        const p = toWorld(cx, cy);
        const d = dist(p.x, p.y, goal.x, goal.y);
        if (!best || d < best.d) best = { cx, cy, d };
      }
    }
    if (best) {
      end.cx = best.cx;
      end.cy = best.cy;
    } else {
      return goal;
    }
  }

  type Node = { cx: number; cy: number };
  const q: Node[] = [{ cx: start.cx, cy: start.cy }];
  const came = new Map<string, string | null>();
  came.set(key(start.cx, start.cy), null);
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  let found: Node | null = null;
  const limit = 900;
  let visits = 0;
  while (q.length && visits < limit) {
    const cur = q.shift()!;
    visits++;
    if (cur.cx === end.cx && cur.cy === end.cy) {
      found = cur;
      break;
    }
    const from = toWorld(cur.cx, cur.cy);
    for (const [dx, dy] of dirs) {
      const nx = cur.cx + dx;
      const ny = cur.cy + dy;
      const k = key(nx, ny);
      if (came.has(k) || !walkable(nx, ny)) continue;
      const to = toWorld(nx, ny);
      // Require clear step so diagonal doesn't clip corners
      if (!pathClear(from.x, from.y, to.x, to.y, walls, r * 0.92)) continue;
      came.set(k, key(cur.cx, cur.cy));
      q.push({ cx: nx, cy: ny });
    }
  }

  if (!found) {
    // Fallback: lateral detours when BFS fails
    const ang = angleTo(sx, sy, goal.x, goal.y);
    const side = ((Math.round(sx) + Math.round(sy)) % 2 === 0 ? 1 : -1) as 1 | -1;
    for (const distOff of [step, step * 1.6, step * 2.4]) {
      for (const s of [side, -side] as const) {
        const wx = sx + Math.cos(ang + s * (Math.PI / 2)) * distOff;
        const wy = sy + Math.sin(ang + s * (Math.PI / 2)) * distOff;
        const p = clampMap(wx, wy);
        if (
          !circleHitsWall(p.x, p.y, r, walls) &&
          pathClear(sx, sy, p.x, p.y, walls, r)
        ) {
          return p;
        }
      }
    }
    return goal;
  }

  // Walk back to the step after start
  const path: Node[] = [];
  let ck: string | null = key(found.cx, found.cy);
  while (ck) {
    const [cx, cy] = ck.split(",").map(Number);
    path.push({ cx: cx!, cy: cy! });
    ck = came.get(ck) ?? null;
  }
  path.reverse();
  // Steer toward a point 1–2 cells ahead (smoother than only the next cell)
  const look = path[Math.min(2, path.length - 1)] ?? path[path.length - 1]!;
  return toWorld(look.cx, look.cy);
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
  const r = CONFIG.tankRadius;
  // Reuse a recent waypoint when the goal hasn’t moved much — stops BFS flicker.
  const cached = steerWpCache.get(tank.id);
  let waypoint: { x: number; y: number };
  if (
    cached &&
    cached.until > world.time &&
    dist(cached.gx, cached.gy, tx, ty) < 28 &&
    dist(tank.x, tank.y, cached.x, cached.y) > 10
  ) {
    waypoint = { x: cached.x, y: cached.y };
  } else {
    waypoint = nextWaypointAroundWalls(
      tank.x,
      tank.y,
      tx,
      ty,
      world.walls,
      r,
    );
    steerWpCache.set(tank.id, {
      x: waypoint.x,
      y: waypoint.y,
      gx: tx,
      gy: ty,
      until: world.time + 0.22,
    });
  }
  const ang = angleTo(tank.x, tank.y, waypoint.x, waypoint.y);
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
  // Blocked — try slides + longer laterals so bots clear wall corners
  const side = tank.number % 2 === 0 ? 1 : -1;
  const mag = Math.hypot(moveX, moveY) || 1;
  const nx = moveX / mag;
  const ny = moveY / mag;
  const attempts: [number, number][] = [
    [-moveY * side, moveX * side],
    [moveY * side, -moveX * side],
    [-moveY * side * 1.4, moveX * side * 1.4],
    [moveY * side * 1.4, -moveX * side * 1.4],
    [-ny * side * mag * 1.8, nx * side * mag * 1.8],
    [ny * side * mag * 1.8, -nx * side * mag * 1.8],
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
 * Combat overlay: close to fight range, soft kite if too close, stand-and-shoot
 * in the fight band (no orbit strafe — stops 1-target pile-on jitter).
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
  if (d < CONFIG.ai.kiteRange * 0.75) {
    // Only kite when truly on top of the target — softer step, no separation tug
    const away = angleTo(enemy.x, enemy.y, tank.x, tank.y);
    const s = steerTo(
      tank,
      tank.x + Math.cos(away) * 55,
      tank.y + Math.sin(away) * 55,
      speed * 0.85,
      dt,
      world,
      { separate: false },
    );
    moveX = s.moveX;
    moveY = s.moveY;
  } else if (d > fightRange) {
    const s = steerTo(tank, enemy.x, enemy.y, speed, dt, world, {
      separate: false,
    });
    moveX = s.moveX;
    moveY = s.moveY;
  } else {
    // In fight band: hold station and shoot — no lateral orbit dance
    moveX = 0;
    moveY = 0;
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

/** Panic commitment clock — prevents frame-flip flee/approach thrash. */
const panicUntil = new Map<string, number>();
/** Red AI sticky focus so nearest-of-many blues doesn’t flip every tick. */
const redFocusUntil = new Map<string, { id: string; until: number }>();
/** Short-lived steer waypoint cache to calm BFS cell flicker. */
const steerWpCache = new Map<
  string,
  { x: number; y: number; gx: number; gy: number; until: number }
>();

/**
 * Panic when surrounded (2+ nearby) or under true melee pressure.
 * Player attack/escort only panics when surrounded — otherwise they can’t fight
 * inside fightRange. Hysteresis + commit time stop 1-red thrash.
 */
function shouldPanicEscape(
  world: WorldState,
  tank: Tank,
  liveEnemies: Tank[],
): boolean {
  const {
    meleePanicRadius,
    surroundRadius,
    surroundEnemyCount,
    panicClearRadius,
    panicCommitSec,
  } = CONFIG.mpOffline;
  const now = world.time;
  const committed = panicUntil.get(tank.id) ?? 0;

  let near = 0;
  let melee = false;
  let anyInsideClear = false;
  for (const e of liveEnemies) {
    const d = dist(tank.x, tank.y, e.x, e.y);
    if (d <= meleePanicRadius) melee = true;
    if (d <= surroundRadius) near++;
    if (d <= panicClearRadius) anyInsideClear = true;
  }
  const surrounded = near >= surroundEnemyCount;

  if (committed > now) {
    if (anyInsideClear || surrounded || melee) return true;
    panicUntil.delete(tank.id);
    return false;
  }

  // Any player order: only peel when surrounded (2+). A single last red in
  // melee must not cancel spread/hold/attack — that caused the 1-red freeze.
  if (isPlayerOrder(tank)) {
    if (!surrounded) return false;
  } else if (!surrounded && !melee) {
    return false;
  }

  panicUntil.set(tank.id, now + panicCommitSec);
  return true;
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

function stickyFocus(
  map: Map<string, { id: string; until: number }>,
  tankId: string,
  now: number,
  candidates: Tank[],
  x: number,
  y: number,
  stickSec: number,
): Tank | null {
  const cur = map.get(tankId);
  if (cur && now < cur.until) {
    const still = candidates.find((c) => c.id === cur.id && c.alive);
    if (still) return still;
  }
  const n = nearest(candidates, x, y);
  if (n) map.set(tankId, { id: n.id, until: now + stickSec });
  else map.delete(tankId);
  return n;
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
  // Hysteresis + surround/melee gates stop 1-red fight-range thrash.
  if (nearestLive && shouldPanicEscape(world, tank, liveEnemies)) {
    const resume: Goal = {
      kind: tank.goal.kind,
      params: { ...tank.goal.params },
      source: tank.goal.source,
    };
    const flee = fleePoint(tank, liveEnemies);
    const s = steerTo(tank, flee.x, flee.y, speed * 1.15, dt, world, {
      separate: false,
    });
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
      const dBuddy = dist(tank.x, tank.y, buddy.x, buddy.y);
      if (dSlot > CONFIG.ai.escortSlotRadius) {
        const sprint =
          dBuddy > CONFIG.ai.escortCatchup
            ? 1.25
            : dSlot > CONFIG.ai.escortDistance
              ? 1.1
              : 1;
        const s = steerTo(tank, slot.x, slot.y, speed * sprint, dt, world, {
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
    // Player-ordered attack: close distance even without LOS; shoot when hittable.
    const specificId = tank.goal.params?.targetTankId;
    const specific =
      specificId != null
        ? world.tanks.find(
            (t) => t.id === specificId && t.alive && t.team !== tank.team,
          )
        : null;
    const hunt =
      specific ??
      nearestLive ??
      nearest(
        world.tanks.filter((t) => t.team !== tank.team && t.alive),
        tank.x,
        tank.y,
      );
    if (hunt) {
      const seesHunt = canSeeTank(tank, hunt, world.walls);
      const dHunt = dist(tank.x, tank.y, hunt.x, hunt.y);
      const fightRange = CONFIG.roles[tank.role].fightRange;
      // Distance-gated (not LOS-gated) so wall-corner LOS flicker can’t
      // flip approach ↔ combat every frame when one red remains.
      if (dHunt <= fightRange + 36) {
        const fight = combatManeuver(world, tank, hunt, speed, dt);
        moveX = fight.moveX;
        moveY = fight.moveY;
        wantShoot = seesHunt;
        aimAngle = seesHunt
          ? fight.aimAngle
          : angleTo(tank.x, tank.y, hunt.x, hunt.y);
      } else {
        // Approach on a clear per-tank ring slot (fallback to hunt pos)
        const slotAng = ((tank.number - 1) / 6) * Math.PI * 2;
        const slotR = Math.min(fightRange * 0.8, 64);
        let ax = hunt.x + Math.cos(slotAng) * slotR;
        let ay = hunt.y + Math.sin(slotAng) * slotR;
        if (circleHitsWall(ax, ay, CONFIG.tankRadius, world.walls)) {
          ax = hunt.x;
          ay = hunt.y;
        }
        const s = steerTo(tank, ax, ay, speed, dt, world, {
          separate: dHunt > 180,
        });
        moveX = s.moveX;
        moveY = s.moveY;
        aimAngle = seesHunt
          ? angleTo(tank.x, tank.y, hunt.x, hunt.y)
          : s.aimAngle;
        if (seesHunt) wantShoot = true;
      }
    }
  } else if (activeGoal === "retreat") {
    const home = homeTerritoryBounds(tank.team);
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
  // Online: both teams use hold-until-ordered brains for non-human tanks.
  if (isMpRules(world.gameMode)) {
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
    const specificId = tank.goal.params?.targetTankId;
    const specific =
      specificId != null
        ? world.tanks.find(
            (t) => t.id === specificId && t.alive && t.team !== tank.team,
          )
        : null;
    const focus = specific ?? nearestLive ?? nearestKnown;
    if (specific && canSeeTank(tank, specific, world.walls)) {
      const fight = combatManeuver(world, tank, specific, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = fight.wantShoot;
      aimAngle = fight.aimAngle;
    } else if (specific) {
      const s = steerTo(tank, specific.x, specific.y, speed, dt, world);
      moveX = s.moveX;
      moveY = s.moveY;
      aimAngle = s.aimAngle;
    } else if (nearestLive) {
      const fight = combatManeuver(world, tank, nearestLive, speed, dt);
      moveX = fight.moveX;
      moveY = fight.moveY;
      wantShoot = fight.wantShoot;
      aimAngle = fight.aimAngle;
    } else if (focus) {
      // Hunt last team-belief contact under fog
      const s = steerTo(tank, focus.x, focus.y, speed * 0.95, dt, world);
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
          params: { ...p, targetTankId: tank.goal.params?.targetTankId },
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
  // Sticky focus — with one red left, nearest-blue flipping caused perpetual spin.
  const focusPlayer = stickyFocus(
    redFocusUntil,
    tank.id,
    world.time,
    players,
    tank.x,
    tank.y,
    1.25,
  );
  const engageMul = tier.engageRangeMul;

  let moveX = 0;
  let moveY = 0;
  let wantShoot = false;
  let aimAngle = tank.angle;

  if (tank.hp / tank.maxHp < CONFIG.ai.retreatHpFraction && focusPlayer) {
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
    aimAngle = angleTo(tank.x, tank.y, focusPlayer.x, focusPlayer.y);
    wantShoot = true;
  } else if (focusPlayer) {
    const fight = combatManeuver(world, tank, focusPlayer, speed, dt);
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
