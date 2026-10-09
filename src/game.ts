import { CONFIG, type ShareMode } from "./config";
import {
  buildArena,
  dist,
  rotateToward,
  tryMove,
  angleTo,
  unstickFromWalls,
} from "./arena";
import { updateTankAi } from "./ai";
import {
  applyDiscoveryCells,
  captureVisibleCells,
  createFogGrid,
  revealAround,
  revealHomeTerritory,
  visionTanksForReveal,
  canSeeTank,
} from "./fog";
import { interpretOrder } from "./orders";
import { createTeams } from "./spawn";
import type {
  ChatLine,
  Projectile,
  Tank,
  WorldState,
  Wreck,
} from "./types";

let wreckSeq = 0;

export function createWorld(shareMode: ShareMode = CONFIG.shareModeDefault): WorldState {
  const fog = createFogGrid();
  const seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0;
  const tanks = createTeams(seed);
  const controlled =
    tanks.find((t) => t.team === "blue" && t.role === "shooter") ??
    tanks.find((t) => t.team === "blue")!;

  wreckSeq = 0;

  const world: WorldState = {
    time: 0,
    matchLeft: CONFIG.matchDurationSec,
    shareMode,
    walls: buildArena(),
    tanks,
    projectiles: [],
    wrecks: [],
    markers: [],
    fogExplored: fog.explored,
    fogCols: fog.cols,
    fogRows: fog.rows,
    controlledId: controlled.id,
    outcome: "playing",
    chat: [],
    events: [],
    nextWreckLabel: 0,
    rngSeed: seed,
  };

  revealHomeTerritory(world);
  pushEvent(
    world,
    "Match start. Home strip is mapped — push north and find the enemy code carrier.",
    "sys",
  );
  pushChat(world, "Net open. Southern band is ours; the rest is blank.", "sys");
  return world;
}

export function pushChat(
  world: WorldState,
  text: string,
  kind: ChatLine["kind"] = "ally",
): void {
  world.chat.push({ t: world.time, text, kind });
  if (world.chat.length > 80) world.chat.shift();
}

export function pushEvent(
  world: WorldState,
  text: string,
  kind: ChatLine["kind"] = "sys",
): void {
  world.events.push({ t: world.time, text, kind });
  if (world.events.length > 100) world.events.shift();
}

export function controlledTank(world: WorldState): Tank | undefined {
  return world.tanks.find((t) => t.id === world.controlledId);
}

export function switchToTank(world: WorldState, id: string): void {
  const t = world.tanks.find((x) => x.id === id && x.team === "blue" && x.alive);
  if (!t) return;
  const prev = controlledTank(world);
  world.controlledId = t.id;
  pushEvent(world, `Control → #${t.number} (${t.role})`, "sys");
  if (prev && prev.id !== t.id) {
    // left tank keeps last AI order
    pushChat(world, `#${prev.number}: continuing last order.`, "ally");
  }
}

export function switchToNumber(world: WorldState, n: number): void {
  const t = world.tanks.find(
    (x) => x.team === "blue" && x.number === n && x.alive,
  );
  if (t) switchToTank(world, t.id);
}

function autoSwitchNearest(world: WorldState, from: Tank): void {
  const living = world.tanks.filter((t) => t.team === "blue" && t.alive);
  if (!living.length) return;
  living.sort(
    (a, b) =>
      dist(from.x, from.y, a.x, a.y) - dist(from.x, from.y, b.x, b.y),
  );
  switchToTank(world, living[0].id);
}

export function markWreckAt(world: WorldState, x: number, y: number): boolean {
  const w = world.wrecks.find(
    (wr) => dist(wr.x, wr.y, x, y) <= CONFIG.wreckMarkClickRadius,
  );
  if (!w) return false;
  w.marked = true;
  pushEvent(world, `Marked wreck ${w.label} for debug.`, "sys");
  pushChat(world, `Command: mark wreck ${w.label}.`, "sys");
  return true;
}

export async function sendOrder(
  world: WorldState,
  orderText: string,
  apiKey?: string,
): Promise<void> {
  if (world.outcome !== "playing") return;
  pushEvent(world, `Order: ${orderText}`, "sys");
  const results = await interpretOrder(orderText, world.tanks, world, {
    apiKey,
  });
  for (const r of results) {
    const tank = world.tanks.find((t) => t.id === r.tankId);
    if (!tank || !tank.alive) continue;
    tank.goal = { kind: r.goal, params: r.params ?? {} };
    tank.lastOrderChat = r.chatLine;
    pushChat(world, r.chatLine, "ally");
    const px = r.params?.x;
    const py = r.params?.y;
    pushEvent(
      world,
      `Interpret #${tank.number}: ${r.goal}${
        px != null && py != null ? ` @(${Math.round(px)},${Math.round(py)})` : ""
      }`,
      "sys",
    );
  }
}

interface InputState {
  keys: Set<string>;
  mouseX: number;
  mouseY: number;
  shooting: boolean;
}

export function stepWorld(world: WorldState, dt: number, input: InputState): void {
  if (world.outcome !== "playing") return;

  world.time += dt;
  world.matchLeft -= dt;
  if (world.matchLeft <= 0) {
    world.matchLeft = 0;
    world.outcome = "draw";
    pushEvent(world, "Time expired — draw.", "warn");
    pushChat(world, "Clock zero. No code confirmed. Draw.", "warn");
    return;
  }

  // Expire markers
  world.markers = world.markers.filter(
    (m) => world.time - m.createdAt < CONFIG.markerFadeSeconds,
  );

  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    tank.cooldown = Math.max(0, tank.cooldown - dt);

    const isControlled =
      tank.team === "blue" && tank.id === world.controlledId;

    if (isControlled) {
      updatePlayer(world, tank, dt, input);
    } else {
      const ai = updateTankAi(world, tank, dt, false);
      if (ai.wantShoot && CONFIG.roles[tank.role].canShoot) {
        tryShoot(world, tank, ai.aimAngle, false);
      }
    }

    const moved = dist(tank.x, tank.y, tank.lastKnownPos.x, tank.lastKnownPos.y);
    if (moved < CONFIG.debugStandStillSpeed * dt + 0.5) {
      tank.standStillTimer += dt;
    } else {
      tank.standStillTimer = 0;
      tank.reportProgress = 0;
      // movement interrupts debug
      if (tank.debugProgress > 0 && tank.goal.kind === "debug") {
        // soft decay only when moving far
        if (moved > 2) tank.debugProgress = Math.max(0, tank.debugProgress - dt * 0.5);
      }
    }
    tank.lastKnownPos = { x: tank.x, y: tank.y };

    handleReportIn(world, tank);
    handleDebug(world, tank, dt);
  }

  updateProjectiles(world, dt);
  updateVision(world);
  updateSightings(world);
  checkOutcome(world);
}

function updatePlayer(
  world: WorldState,
  tank: Tank,
  dt: number,
  input: InputState,
): void {
  const freed = unstickFromWalls(
    tank.x,
    tank.y,
    CONFIG.tankRadius,
    world.walls,
  );
  tank.x = freed.x;
  tank.y = freed.y;

  const speed = CONFIG.roles[tank.role].speed;
  let mx = 0;
  let my = 0;
  if (input.keys.has("arrowup")) my -= 1;
  if (input.keys.has("arrowdown")) my += 1;
  if (input.keys.has("arrowleft")) mx -= 1;
  if (input.keys.has("arrowright")) mx += 1;
  if (mx || my) {
    const len = Math.hypot(mx, my);
    mx = (mx / len) * speed * dt;
    my = (my / len) * speed * dt;
    const pos = tryMove(tank.x, tank.y, mx, my, CONFIG.tankRadius, world.walls);
    tank.x = pos.x;
    tank.y = pos.y;
  }

  const aim = angleTo(tank.x, tank.y, input.mouseX, input.mouseY);
  tank.angle = rotateToward(tank.angle, aim, CONFIG.tankTurnRate * 1.4 * dt);

  const wantShoot =
    input.shooting || input.keys.has(" ") || input.keys.has("spacebar");
  if (wantShoot) tryShoot(world, tank, tank.angle, true);

  // Player can debug / report by standing near marked wreck or with report goal
  // Also allow player to contribute to debug when near marked wreck standing still
  if (tank.goal.kind !== "debug") {
    const near = world.wrecks.find(
      (w) =>
        w.marked &&
        !w.debugged &&
        dist(tank.x, tank.y, w.x, w.y) <= CONFIG.debugRange,
    );
    if (near && tank.standStillTimer > 0.2) {
      tank.debugTargetId = near.id;
      // piggyback debug without forcing goal
      tickDebug(world, tank, near, dt);
    }
  }
}

function tryShoot(
  world: WorldState,
  tank: Tank,
  aimAngle: number,
  isPlayer: boolean,
): void {
  if (tank.cooldown > 0 || !tank.alive) return;
  if (!CONFIG.roles[tank.role].canShoot) return;
  const stats = CONFIG.roles[tank.role];

  // AI: only open fire if this tank can see someone (player may always shoot).
  if (!isPlayer) {
    const sees = world.tanks.some(
      (e) =>
        e.team !== tank.team &&
        e.alive &&
        dist(tank.x, tank.y, e.x, e.y) < CONFIG.roles[tank.role].visionRadius + 40,
    );
    if (!sees) return;
  }

  tank.cooldown = stats.fireCooldown;
  tank.lastShotAt = world.time;
  const id = `p-${tank.id}-${world.time}`;
  const proj: Projectile = {
    id,
    team: tank.team,
    ownerId: tank.id,
    x: tank.x + Math.cos(aimAngle) * (CONFIG.tankRadius + 4),
    y: tank.y + Math.sin(aimAngle) * (CONFIG.tankRadius + 4),
    vx: Math.cos(aimAngle) * stats.projectileSpeed,
    vy: Math.sin(aimAngle) * stats.projectileSpeed,
    damage: stats.damage,
    life: stats.projectileLife,
    fromShooter: tank.role === "shooter",
  };
  world.projectiles.push(proj);
}

function updateProjectiles(world: WorldState, dt: number): void {
  const next: Projectile[] = [];
  for (const p of world.projectiles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.life <= 0) continue;

    // wall collide
    let hitWall = false;
    for (const w of world.walls) {
      if (
        p.x >= w.x &&
        p.x <= w.x + w.w &&
        p.y >= w.y &&
        p.y <= w.y + w.h
      ) {
        hitWall = true;
        break;
      }
    }
    if (hitWall) continue;

    let hit = false;
    for (const t of world.tanks) {
      if (!t.alive) continue;
      if (t.team === p.team && !CONFIG.friendlyFire) continue;
      if (dist(p.x, p.y, t.x, t.y) <= CONFIG.tankRadius + CONFIG.bulletRadius) {
        applyDamage(world, t, p.damage, p.ownerId);
        hit = true;
        break;
      }
    }
    if (!hit) next.push(p);
  }
  world.projectiles = next;
}

function applyDamage(
  world: WorldState,
  tank: Tank,
  damage: number,
  _sourceId: string,
): void {
  tank.hp -= damage;
  tank.debugProgress = 0; // damage interrupts debug
  tank.reportProgress = 0;
  if (tank.hp <= 0) {
    tank.hp = 0;
    tank.alive = false;
    spawnWreck(world, tank);
    pushEvent(
      world,
      `${tank.team === "blue" ? "Friendly" : "Enemy"} #${tank.number} destroyed.`,
      "warn",
    );
    if (tank.team === "blue") {
      pushChat(world, `#${tank.number}: …signal lost.`, "warn");
      if (tank.id === world.controlledId) autoSwitchNearest(world, tank);
    }
  }
}

function spawnWreck(world: WorldState, tank: Tank): void {
  const label = String.fromCharCode(65 + (world.nextWreckLabel % 26));
  world.nextWreckLabel++;
  wreckSeq++;
  const wreck: Wreck = {
    id: `wreck-${wreckSeq}`,
    label,
    team: tank.team,
    tankNumber: tank.number,
    x: tank.x,
    y: tank.y,
    wasCodeCarrier: tank.isCodeCarrier,
    marked: false,
    debugged: false,
    debugResult: null,
  };
  world.wrecks.push(wreck);

  // Immediate faded marker for the player if enemy wreck in live vision
  if (tank.team === "red") {
    const viewers = world.tanks.filter((t) => t.team === "blue" && t.alive);
    const seen = viewers.some((v) =>
      dist(v.x, v.y, wreck.x, wreck.y) <= CONFIG.roles[v.role].visionRadius,
    );
    if (seen) addMarker(world, "wreck", wreck.x, wreck.y, `Wreck ${label}`);
  }
}

function addMarker(
  world: WorldState,
  kind: "enemy" | "wreck",
  x: number,
  y: number,
  label: string,
): void {
  // refresh similar marker
  const existing = world.markers.find(
    (m) => m.kind === kind && dist(m.x, m.y, x, y) < 28,
  );
  if (existing) {
    existing.createdAt = world.time;
    existing.x = x;
    existing.y = y;
    existing.label = label;
    return;
  }
  world.markers.push({
    id: `m-${world.time}-${x}`,
    kind,
    x,
    y,
    createdAt: world.time,
    label,
  });
}

function handleReportIn(world: WorldState, tank: Tank): void {
  if (tank.team !== "blue" || !tank.alive) return;
  if (world.shareMode !== "report") return;
  if (tank.id === world.controlledId) return; // controlled already live
  if (tank.goal.kind !== "reportIn" && tank.standStillTimer < 0.5) return;

  // "exposed" = standing still
  if (tank.standStillTimer < 0.05) return;

  const need =
    tank.goal.kind === "reportIn" ? CONFIG.reportInSeconds : CONFIG.reportInSeconds * 1.4;
  tank.reportProgress += 1 / 60; // accumulated in step via stand timer check below
  // Use standStillTimer directly
  if (tank.standStillTimer < need) return;

  const cells = captureVisibleCells(world, tank);
  const n = applyDiscoveryCells(world, cells);
  tank.reportProgress = 0;
  tank.standStillTimer = 0;
  if (tank.goal.kind === "reportIn") {
    tank.goal = { kind: "holdPosition", params: { x: tank.x, y: tank.y } };
  }
  const line = `#${tank.number}: report in — ${n} cells logged.`;
  pushChat(world, line, "ally");
  pushEvent(world, line, "ally");

  // Also report enemy sightings currently visible
  for (const e of world.tanks) {
    if (e.team !== "red" || !e.alive) continue;
    if (canSeeTank(tank, e, world.walls)) {
      addMarker(world, "enemy", e.x, e.y, `Enemy #${e.number}?`);
      pushChat(
        world,
        `#${tank.number}: contact near (${Math.round(e.x)},${Math.round(e.y)}).`,
        "ally",
      );
    }
  }
  for (const w of world.wrecks) {
    if (dist(tank.x, tank.y, w.x, w.y) <= CONFIG.roles[tank.role].visionRadius) {
      addMarker(world, "wreck", w.x, w.y, `Wreck ${w.label}`);
    }
  }
}

function handleDebug(world: WorldState, tank: Tank, dt: number): void {
  if (!tank.alive) return;
  if (tank.goal.kind !== "debug" && tank.team === "blue") return;

  let wreck: Wreck | undefined;
  if (tank.debugTargetId) {
    wreck = world.wrecks.find((w) => w.id === tank.debugTargetId);
  }
  if (!wreck && tank.goal.params?.wreckId) {
    wreck = world.wrecks.find((w) => w.id === tank.goal.params?.wreckId);
  }
  if (!wreck) {
    // nearest marked (blue) or enemy debugging blue wrecks
    if (tank.team === "blue") {
      wreck = world.wrecks
        .filter((w) => w.marked && !w.debugged)
        .sort(
          (a, b) => dist(tank.x, tank.y, a.x, a.y) - dist(tank.x, tank.y, b.x, b.y),
        )[0];
    } else {
      wreck = world.wrecks
        .filter((w) => w.team === "blue" && !w.debugged)
        .sort(
          (a, b) => dist(tank.x, tank.y, a.x, a.y) - dist(tank.x, tank.y, b.x, b.y),
        )[0];
    }
  }
  if (!wreck || wreck.debugged) return;
  if (dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange) return;
  if (tank.standStillTimer < 0.15) return;

  tickDebug(world, tank, wreck, dt);
}

function tickDebug(
  world: WorldState,
  tank: Tank,
  wreck: Wreck,
  dt: number,
): void {
  if (wreck.debugged) return;
  const rate = CONFIG.roles[tank.role].debugRate;
  tank.debugProgress += rate * dt;
  if (tank.debugProgress < 1) return;

  wreck.debugged = true;
  tank.debugProgress = 0;
  tank.debugTargetId = null;

  if (wreck.wasCodeCarrier) {
    wreck.debugResult = "code";
    const line = `#${tank.number}: found the code on wreck ${wreck.label}!`;
    if (tank.team === "blue") {
      pushChat(world, line, "ally");
      pushEvent(world, line, "warn");
      world.outcome = "win";
      pushEvent(world, "Victory — enemy code carrier debugged.", "warn");
    } else {
      pushChat(world, `Enemy debugged wreck ${wreck.label} — they have our code!`, "warn");
      pushEvent(world, "Defeat — your code carrier was debugged.", "warn");
      world.outcome = "lose";
    }
  } else {
    wreck.debugResult = "clean";
    const line = `#${tank.number}: wreck ${wreck.label} is clean`;
    if (tank.team === "blue") {
      pushChat(world, line, "ally");
      pushEvent(world, line, "ally");
    } else {
      pushEvent(world, `Enemy finished debug on wreck ${wreck.label} (clean).`, "sys");
    }
    if (tank.goal.kind === "debug") {
      // continue to next marked
      const more = world.wrecks.some((w) => w.marked && !w.debugged);
      if (!more) {
        tank.goal = { kind: "holdPosition", params: { x: tank.x, y: tank.y } };
      }
    }
  }
}

function updateVision(world: WorldState): void {
  const revealers = visionTanksForReveal(world, "blue");
  for (const t of revealers) {
    revealAround(
      world,
      t.x,
      t.y,
      CONFIG.roles[t.role].visionRadius,
      world.walls,
    );
  }

  // In none/report, non-controlled don't live-reveal (already handled).
  // auto already included all friendlies.
}

function updateSightings(world: WorldState): void {
  // Live sightings from tanks that contribute vision
  const viewers =
    world.shareMode === "auto"
      ? world.tanks.filter((t) => t.team === "blue" && t.alive)
      : world.tanks.filter(
          (t) => t.team === "blue" && t.alive && t.id === world.controlledId,
        );

  for (const v of viewers) {
    for (const e of world.tanks) {
      if (e.team !== "red" || !e.alive) continue;
      if (canSeeTank(v, e, world.walls)) {
        addMarker(world, "enemy", e.x, e.y, `Enemy`);
      }
    }
    for (const w of world.wrecks) {
      if (w.team !== "red") continue;
      if (dist(v.x, v.y, w.x, w.y) <= CONFIG.roles[v.role].visionRadius) {
        addMarker(world, "wreck", w.x, w.y, `Wreck ${w.label}`);
      }
    }
  }

  // In "none", others are chat-only — occasional contact lines when AI sees enemies
  if (world.shareMode === "none" || world.shareMode === "report") {
    for (const t of world.tanks) {
      if (t.team !== "blue" || !t.alive || t.id === world.controlledId) continue;
      for (const e of world.tanks) {
        if (e.team !== "red" || !e.alive) continue;
        if (!canSeeTank(t, e, world.walls)) continue;
        // throttle chat contacts
        if (Math.random() < 0.002) {
          pushChat(
            world,
            `#${t.number}: contact! grid ${Math.round(e.x)},${Math.round(e.y)}`,
            "ally",
          );
        }
      }
    }
  }
}

function checkOutcome(world: WorldState): void {
  if (world.outcome !== "playing") return;
  const blueAlive = world.tanks.some((t) => t.team === "blue" && t.alive);
  const redAlive = world.tanks.some((t) => t.team === "red" && t.alive);
  if (!blueAlive) {
    world.outcome = "lose";
    pushEvent(world, "All friendly tanks lost.", "warn");
    pushChat(world, "Company wiped. Defeat.", "warn");
  } else if (!redAlive) {
    // Still need to debug code carrier wreck if carrier died
    const carrierWreck = world.wrecks.find(
      (w) => w.team === "red" && w.wasCodeCarrier,
    );
    if (carrierWreck?.debugged && carrierWreck.debugResult === "code") {
      world.outcome = "win";
    } else if (carrierWreck && !carrierWreck.debugged) {
      pushEvent(
        world,
        "Enemy team down — debug their code-carrier wreck to win.",
        "sys",
      );
    } else if (!carrierWreck) {
      // carrier still alive somehow? ignore
    }
  }
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
