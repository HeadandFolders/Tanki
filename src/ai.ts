import {
  CONFIG,
  homeTerritoryBounds,
  isMpOffline,
  isMpRules,
} from "./config";
import {
  angleTo,
  circleHitsWall,
  dist,
  normalizeAngle,
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
import type { Tank, Wall, WorldState, Wreck } from "./types";

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

  // Multiplayer: every bot holds its spot until a literal order. No push, patrol, or panic.
  if (isMpRules(world.gameMode)) {
    return mpOfflineFriendlyBrain(world, tank, dt);
  }

  if (tank.team === "red") {
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

/** Map-mark orders stop on the X. Other holds keep the looser radius. */
function arriveRadius(tank: Tank): number {
  return tank.goal.params?.exact ? 8 : CONFIG.ai.holdRadius;
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

/** Extra path cost for walking near a living enemy. Finite, so a blocked map still has a route. */
function hazardExtra(
  x: number,
  y: number,
  hazards: { x: number; y: number }[],
): number {
  const radius = 200;
  let extra = 0;
  for (const h of hazards) {
    const d = dist(x, y, h.x, h.y);
    if (d < radius) extra += 48 * (1 - d / radius);
  }
  return extra;
}

function livingFoes(world: WorldState, tank: Tank): { x: number; y: number }[] {
  return world.tanks
    .filter((t) => t.alive && t.team !== tank.team)
    .map((t) => ({ x: t.x, y: t.y }));
}

function segmentHazard(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  hazards: { x: number; y: number }[],
): number {
  if (!hazards.length) return 0;
  let sum = 0;
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    sum += hazardExtra(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, hazards);
  }
  return sum;
}

/**
 * Coarse waypoint around walls. Prefers a longer clear lane over a short
 * lane that runs through enemies. Returns the next steer point, not the full path.
 */
function nextWaypointAroundWalls(
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  walls: Wall[],
  r: number,
  hazards: { x: number; y: number }[] = [],
): { x: number; y: number } {
  const goal = clampMap(gx, gy);
  if (
    pathClear(sx, sy, goal.x, goal.y, walls, r) &&
    segmentHazard(sx, sy, goal.x, goal.y, hazards) < 1
  ) {
    return goal;
  }

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

  // A lane can be open even when the lattice point sits in a wall.
  // Nudge each cell to a free spot so the short corridor stays on the graph.
  const resolved = new Map<string, { x: number; y: number } | null>();
  const nudges: [number, number][] = [
    [0, 0],
    [14, 0],
    [-14, 0],
    [0, 14],
    [0, -14],
    [14, 14],
    [14, -14],
    [-14, 14],
    [-14, -14],
    [22, 0],
    [-22, 0],
    [0, 22],
    [0, -22],
  ];
  const resolveCell = (
    cx: number,
    cy: number,
  ): { x: number; y: number } | null => {
    if (cx < 0 || cy < 0 || cx > maxC || cy > maxR) return null;
    const k = key(cx, cy);
    if (resolved.has(k)) return resolved.get(k) ?? null;
    const base = toWorld(cx, cy);
    for (const [ox, oy] of nudges) {
      const p = clampMap(base.x + ox, base.y + oy);
      if (!circleHitsWall(p.x, p.y, r * 0.9, walls)) {
        resolved.set(k, p);
        return p;
      }
    }
    resolved.set(k, null);
    return null;
  };
  const linked = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): boolean => {
    const body = r * 0.82;
    if (pathClear(a.x, a.y, b.x, b.y, walls, body)) return true;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    for (const off of [16, -16, 26, -26]) {
      const ix = mx + px * off;
      const iy = my + py * off;
      if (
        !circleHitsWall(ix, iy, body, walls) &&
        pathClear(a.x, a.y, ix, iy, walls, body) &&
        pathClear(ix, iy, b.x, b.y, walls, body)
      ) {
        return true;
      }
    }
    return false;
  };

  if (!resolveCell(end.cx, end.cy)) {
    let best: { cx: number; cy: number; d: number } | null = null;
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        const cx = end.cx + dx;
        const cy = end.cy + dy;
        const p = resolveCell(cx, cy);
        if (!p) continue;
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

  if (!resolveCell(start.cx, start.cy)) {
    let bestStart: { cx: number; cy: number; d: number } | null = null;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const cx = start.cx + dx;
        const cy = start.cy + dy;
        const p = resolveCell(cx, cy);
        if (!p) continue;
        const d = dist(p.x, p.y, sx, sy);
        if (!bestStart || d < bestStart.d) bestStart = { cx, cy, d };
      }
    }
    if (bestStart) {
      start.cx = bestStart.cx;
      start.cy = bestStart.cy;
    }
  }

  type Node = { cx: number; cy: number; g: number };
  const startKey = key(start.cx, start.cy);
  const q: Node[] = [{ cx: start.cx, cy: start.cy, g: 0 }];
  const heapPush = (n: Node) => {
    q.push(n);
    let i = q.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (q[p]!.g <= q[i]!.g) break;
      const tmp = q[p]!;
      q[p] = q[i]!;
      q[i] = tmp;
      i = p;
    }
  };
  const heapPop = (): Node => {
    const top = q[0]!;
    const last = q.pop()!;
    if (!q.length) return top;
    q[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      if (l < q.length && q[l]!.g < q[s]!.g) s = l;
      if (r < q.length && q[r]!.g < q[s]!.g) s = r;
      if (s === i) break;
      const tmp = q[s]!;
      q[s] = q[i]!;
      q[i] = tmp;
      i = s;
    }
    return top;
  };
  const best = new Map<string, number>([[startKey, 0]]);
  const came = new Map<string, string | null>([[startKey, null]]);
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
  const limit = 4000;
  let visits = 0;
  while (q.length && visits < limit) {
    const cur = heapPop();
    visits++;
    const ck = key(cur.cx, cur.cy);
    if (cur.g !== best.get(ck)) continue;
    if (cur.cx === end.cx && cur.cy === end.cy) {
      found = cur;
      break;
    }
    const from = resolveCell(cur.cx, cur.cy);
    if (!from) continue;
    for (const [dx, dy] of dirs) {
      const nx = cur.cx + dx;
      const ny = cur.cy + dy;
      const to = resolveCell(nx, ny);
      if (!to || !linked(from, to)) continue;
      const nk = key(nx, ny);
      const stepCost = dx !== 0 && dy !== 0 ? 1.414 : 1;
      const ng = cur.g + stepCost + hazardExtra(to.x, to.y, hazards);
      if (ng >= (best.get(nk) ?? Infinity)) continue;
      best.set(nk, ng);
      came.set(nk, ck);
      heapPush({ cx: nx, cy: ny, g: ng });
    }
  }

  if (!found) {
    // Follow the explored cell closest to the goal instead of cutting across.
    let bestKey: string | null = null;
    let bestD = Infinity;
    for (const k of came.keys()) {
      const [cx, cy] = k.split(",").map(Number);
      const p = resolveCell(cx!, cy!);
      if (!p) continue;
      const d = dist(p.x, p.y, goal.x, goal.y);
      if (d < bestD) {
        bestD = d;
        bestKey = k;
      }
    }
    if (bestKey && bestKey !== startKey) {
      const [cx, cy] = bestKey.split(",").map(Number);
      found = { cx: cx!, cy: cy!, g: best.get(bestKey) ?? 0 };
    }
  }

  if (!found) {
    const ang = angleTo(sx, sy, goal.x, goal.y);
    const side = ((Math.round(sx) + Math.round(sy)) % 2 === 0 ? 1 : -1) as 1 | -1;
    for (const distOff of [step, step * 1.6, step * 2.4]) {
      for (const s of [side, -side] as const) {
        const wx = sx + Math.cos(ang + s * (Math.PI / 2)) * distOff;
        const wy = sy + Math.sin(ang + s * (Math.PI / 2)) * distOff;
        const p = clampMap(wx, wy);
        if (
          !circleHitsWall(p.x, p.y, r, walls) &&
          pathClear(sx, sy, p.x, p.y, walls, r) &&
          segmentHazard(sx, sy, p.x, p.y, hazards) < 1
        ) {
          return p;
        }
      }
    }
    return goal;
  }

  const path: { cx: number; cy: number }[] = [];
  let ck: string | null = key(found.cx, found.cy);
  while (ck) {
    const [cx, cy] = ck.split(",").map(Number);
    path.push({ cx: cx!, cy: cy! });
    ck = came.get(ck) ?? null;
  }
  path.reverse();
  // One cell ahead when skirting enemies, so the shortcut doesn't re-enter them.
  const ahead = hazards.length ? 1 : 2;
  const look = path[Math.min(ahead, path.length - 1)] ?? path[path.length - 1]!;
  return resolveCell(look.cx, look.cy) ?? toWorld(look.cx, look.cy);
}

function steerTo(
  tank: Tank,
  tx: number,
  ty: number,
  speed: number,
  dt: number,
  world: WorldState,
  opts: { separate?: boolean; avoid?: { x: number; y: number }[] } = {},
): { moveX: number; moveY: number; aimAngle: number } {
  const r = CONFIG.tankRadius;
  const avoid = opts.avoid ?? [];
  const avoidKey = avoid
    .map((p) => `${Math.round(p.x / 48)},${Math.round(p.y / 48)}`)
    .join("|");
  // Reuse a recent waypoint when the goal hasn’t moved much — stops path flicker.
  const cached = steerWpCache.get(tank.id);
  let waypoint: { x: number; y: number };
  if (
    cached &&
    cached.until > world.time &&
    cached.avoidKey === avoidKey &&
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
      avoid,
    );
    steerWpCache.set(tank.id, {
      x: waypoint.x,
      y: waypoint.y,
      gx: tx,
      gy: ty,
      until: world.time + 0.22,
      avoidKey,
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
 * Cover-me slot: stand in front of the VIP, on the line between the VIP and
 * the enemies they are aiming at. Never a ring behind the barrel.
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

  // No-fog multiplayer: everyone is on the map. Fog modes only use known contacts.
  const enemies = isMpRules(world.gameMode)
    ? world.tanks.filter((e) => e.alive && e.team !== vip.team)
    : knownEnemyTanks(world, vip);
  const aim = vip.angle;
  const ahead = enemies.filter((e) => {
    const bearing = angleTo(vip.x, vip.y, e.x, e.y);
    return Math.abs(normalizeAngle(bearing - aim)) < (Math.PI * 2) / 3;
  });
  const pool = ahead.length ? ahead : [];
  const threat = pool.length ? nearest(pool, vip.x, vip.y) : null;
  const faceAngle = threat
    ? angleTo(vip.x, vip.y, threat.x, threat.y)
    : aim;

  let radius: number = CONFIG.ai.escortDistance;
  if (threat) {
    const d = dist(vip.x, vip.y, threat.x, threat.y);
    radius = Math.min(110, Math.max(40, d * 0.55));
    if (radius > d - 26) radius = Math.max(28, d * 0.42);
  }

  const spread = Math.min(CONFIG.ai.escortArcSpread, 1.35);
  const t = n === 1 ? 0.5 : index / (n - 1);
  const slotAngle = faceAngle - spread / 2 + t * spread;

  const place = (ang: number, rad: number) =>
    clampMap(
      vip.x + Math.cos(ang) * rad,
      vip.y + Math.sin(ang) * rad,
    );
  let raw = place(slotAngle, radius);
  const nudges = [0, 0.28, -0.28, 0.55, -0.55];
  const scales = [1, 0.72, 1.2, 0.5];
  let placed = false;
  for (const scale of scales) {
    for (const nudge of nudges) {
      const p = place(slotAngle + nudge, radius * scale);
      if (!circleHitsWall(p.x, p.y, CONFIG.tankRadius, world.walls)) {
        raw = p;
        placed = true;
        break;
      }
    }
    if (placed) break;
  }
  return { x: raw.x, y: raw.y, faceAngle };
}

/** Red AI sticky focus so nearest-of-many blues doesn’t flip every tick. */
const redFocusUntil = new Map<string, { id: string; until: number }>();
/** Short-lived steer waypoint cache to calm BFS cell flicker. */
const steerWpCache = new Map<
  string,
  { x: number; y: number; gx: number; gy: number; until: number; avoidKey: string }
>();

function orderedPreyIds(tank: Tank): string[] {
  if (tank.goal.kind !== "attackNearest") return [];
  const many = tank.goal.params?.targetTankIds;
  if (many?.length) return many;
  const one = tank.goal.params?.targetTankId;
  return one ? [one] : [];
}

/** Nearest living enemy among the ones this attack order named. */
function nearestOrderedPrey(world: WorldState, tank: Tank): Tank | null {
  const ids = new Set(orderedPreyIds(tank));
  if (!ids.size) return null;
  return nearest(
    world.tanks.filter(
      (t) => t.alive && t.team !== tank.team && ids.has(t.id),
    ),
    tank.x,
    tank.y,
  );
}

/** Nearest enemy inside shoot range with a clear shot. Prefer the ordered target. */
function shotTarget(world: WorldState, tank: Tank): Tank | null {
  const range = Math.max(
    CONFIG.roles[tank.role].fightRange,
    isMpRules(world.gameMode) ? CONFIG.mpOffline.shootRange : 0,
  );
  const preferredIds = new Set(orderedPreyIds(tank));
  let preferred: Tank | null = null;
  let preferredD = Infinity;
  let closest: Tank | null = null;
  let closestD = range;
  for (const e of world.tanks) {
    if (!e.alive || e.team === tank.team) continue;
    const d = dist(tank.x, tank.y, e.x, e.y);
    if (d > range) continue;
    if (segmentHitsWall(tank.x, tank.y, e.x, e.y, world.walls)) continue;
    if (preferredIds.has(e.id) && d < preferredD) {
      preferred = e;
      preferredD = d;
    }
    if (d < closestD) {
      closestD = d;
      closest = e;
    }
  }
  return preferred ?? closest;
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
 * Multiplayer bot AI (offline and online):
 * - Hold the current spot until a player order says otherwise
 * - Shoot in place if an enemy is in range; do not chase, flee, or patrol
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

  // Shoot in place. Movement comes only from the current order.
  if (nearestLive) {
    aimAngle = angleTo(tank.x, tank.y, nearestLive.x, nearestLive.y);
    tank.angle = rotateToward(tank.angle, aimAngle, CONFIG.tankTurnRate * 2 * dt);
    wantShoot = true;
  }

  const activeGoal = tank.goal.kind;

  if (activeGoal === "holdPosition") {
    const hx = tank.goal.params?.x ?? tank.x;
    const hy = tank.goal.params?.y ?? tank.y;
    if (dist(tank.x, tank.y, hx, hy) > arriveRadius(tank)) {
      const s = steerTo(tank, hx, hy, speed, dt, world, {
        separate: false,
        avoid: livingFoes(world, tank),
      });
      moveX = s.moveX;
      moveY = s.moveY;
      if (!nearestLive) aimAngle = s.aimAngle;
    }
  } else if (activeGoal === "moveTo") {
    const tx = tank.goal.params?.x ?? tank.x;
    const ty = tank.goal.params?.y ?? tank.y;
    const exact = tank.goal.params?.exact === true;
    if (dist(tank.x, tank.y, tx, ty) < arriveRadius(tank)) {
      tank.goal = {
        kind: "holdPosition",
        params: { x: tx, y: ty, exact },
        source: tank.goal.source ?? "system",
      };
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, {
        separate: !exact,
        avoid: livingFoes(world, tank),
      });
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
          separate: false,
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
    const specific = nearestOrderedPrey(world, tank);
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
      const avoid = world.tanks
        .filter(
          (t) => t.alive && t.team !== tank.team && t.id !== hunt.id,
        )
        .map((t) => ({ x: t.x, y: t.y }));
      // Stop and shoot only when the shot line is actually clear.
      // A short Euclidean distance through a wall is not "in range".
      if (seesHunt && dHunt <= fightRange) {
        const fight = combatManeuver(world, tank, hunt, speed, dt);
        moveX = fight.moveX;
        moveY = fight.moveY;
        wantShoot = true;
        aimAngle = fight.aimAngle;
      } else {
        const s = steerTo(tank, hunt.x, hunt.y, speed, dt, world, {
          separate: false,
          avoid,
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

  const shot = shotTarget(world, tank);
  if (shot) {
    wantShoot = true;
    aimAngle = angleTo(tank.x, tank.y, shot.x, shot.y);
    tank.angle = rotateToward(
      tank.angle,
      aimAngle,
      CONFIG.tankTurnRate * 2.6 * dt,
    );
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
    const specific = nearestOrderedPrey(world, tank);
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
          params: {
            ...p,
            targetTankId: tank.goal.params?.targetTankId,
            targetTankIds: tank.goal.params?.targetTankIds,
          },
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
    if (dist(tank.x, tank.y, hx, hy) > arriveRadius(tank)) {
      const s = steerTo(tank, hx, hy, speed, dt, world, {
        separate: tank.goal.params?.exact !== true,
      });
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
    const exact = tank.goal.params?.exact === true;
    if (dist(tank.x, tank.y, tx, ty) < arriveRadius(tank)) {
      tank.goal = {
        kind: "holdPosition",
        params: { x: tx, y: ty, exact },
        source: tank.goal.source ?? "system",
      };
      moveX = 0;
      moveY = 0;
    } else {
      const s = steerTo(tank, tx, ty, speed, dt, world, { separate: !exact });
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
