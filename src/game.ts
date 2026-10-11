import {
  CONFIG,
  isMpOffline,
  isMpOnline,
  isMpRules,
  type GameMode,
  type RedDifficulty,
  type ShareMode,
} from "./config";
import {
  buildArena,
  dist,
  rotateToward,
  tryMove,
  angleTo,
  unstickFromWalls,
} from "./arena";
import { updateTankAi } from "./ai";
import { updateTeamBelief } from "./belief";
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
  DeathFx,
  InterpretContext,
  Projectile,
  Tank,
  WorldState,
  Wreck,
} from "./types";

let wreckSeq = 0;
let deathFxSeq = 0;

export function createWorld(
  shareMode: ShareMode = CONFIG.shareModeDefault,
  gameMode: GameMode = CONFIG.gameModeDefault,
  redDifficulty: RedDifficulty = CONFIG.ai.redDifficultyDefault,
  seedOverride?: number,
): WorldState {
  const fog = createFogGrid();
  const seed =
    seedOverride != null
      ? seedOverride >>> 0
      : (Date.now() ^ (Math.random() * 1e9)) >>> 0;
  const tanks = createTeams(seed, gameMode === "ctf", shareMode, gameMode);
  const controlled =
    tanks.find((t) => t.team === "blue" && t.role === "shooter") ??
    tanks.find((t) => t.team === "blue")!;
  const remoteControlled = isMpOnline(gameMode)
    ? (tanks.find((t) => t.team === "red" && t.role === "shooter") ??
      tanks.find((t) => t.team === "red")!)
    : null;

  wreckSeq = 0;
  deathFxSeq = 0;

  const density =
    isMpRules(gameMode) && CONFIG.mpOffline.denseArena ? "dense" : "standard";

  const world: WorldState = {
    time: 0,
    matchLeft: CONFIG.matchDurationSec,
    shareMode,
    gameMode,
    walls: buildArena(density),
    tanks,
    projectiles: [],
    wrecks: [],
    deathFx: [],
    markers: [],
    playerMarks: { blue: null, red: null },
    fogExplored: fog.explored,
    fogCols: fog.cols,
    fogRows: fog.rows,
    controlledId: controlled.id,
    remoteControlledId: remoteControlled?.id ?? null,
    outcome: "ready",
    chat: [],
    events: [],
    nextWreckLabel: 0,
    rngSeed: seed,
    teamBelief: { contacts: [] },
    redDifficulty,
  };

  revealHomeTerritory(world);
  if (isMpOnline(gameMode)) {
    pushEvent(
      world,
      "Multiplayer · Online — two-device TDM. No fog. Host=blue, Join=red. Wipe the enemy team.",
      "sys",
    );
    pushChat(
      world,
      "Stand by. Multiplayer · Online. Host or Join from the panel below.",
      "sys",
    );
  } else if (isMpOffline(gameMode)) {
    pushEvent(
      world,
      "Multiplayer · Offline — local/bot TDM. No fog. Wipe the enemy team. Allies hold until ordered.",
      "sys",
    );
    pushChat(
      world,
      "Stand by. Multiplayer · Offline. Gunners only — hold until radio orders.",
      "sys",
    );
  } else if (gameMode === "tdm") {
    const fogNote =
      shareMode === "clear"
        ? "No fog — full map and enemies visible."
        : "Home strip mapped; push north.";
    pushEvent(
      world,
      `Team Deathmatch — wipe the enemy company. ${fogNote}`,
      "sys",
    );
    pushChat(
      world,
      shareMode === "clear"
        ? "Stand by. TDM No Fog. Confirm radio / LLM, then Start."
        : "Stand by. TDM rules. Confirm radio / LLM, then Start.",
      "sys",
    );
  } else {
    pushEvent(
      world,
      "Capture the Code — debug the enemy code-carrier wreck to win.",
      "sys",
    );
    pushChat(world, "Stand by. Confirm radio / LLM, then Start.", "sys");
  }
  pushEvent(world, "Round ready — review LLM status and press Start.", "sys");
  return world;
}

/** Enter the pre-match countdown (from the game menu). */
export function beginCountdown(world: WorldState): void {
  if (world.outcome !== "ready") return;
  world.outcome = "countdown";
  pushEvent(world, "Countdown…", "sys");
}

/** Begin the live match after countdown finishes. */
export function startMatch(world: WorldState): void {
  if (world.outcome !== "ready" && world.outcome !== "countdown") return;
  world.outcome = "playing";
  world.time = 0;
  world.matchLeft = CONFIG.matchDurationSec;
  pushEvent(world, "Match started.", "warn");
  pushChat(world, "Net live. Give orders.", "sys");
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

export function switchToTank(
  world: WorldState,
  id: string,
  team: "blue" | "red" = "blue",
): void {
  const t = world.tanks.find((x) => x.id === id && x.team === team && x.alive);
  if (!t) return;
  if (team === "blue") {
    const prev = controlledTank(world);
    world.controlledId = t.id;
    pushEvent(world, `Control → #${t.number} (${t.role})`, "sys");
    if (prev && prev.id !== t.id) {
      pushChat(world, `#${prev.number}: continuing last order.`, "ally");
    }
  } else {
    world.remoteControlledId = t.id;
    pushEvent(world, `Remote control → red #${t.number}`, "sys");
  }
}

export function switchToNumber(
  world: WorldState,
  n: number,
  team: "blue" | "red" = "blue",
): void {
  const t = world.tanks.find(
    (x) => x.team === team && x.number === n && x.alive,
  );
  if (t) switchToTank(world, t.id, team);
}

function autoSwitchNearest(world: WorldState, from: Tank): void {
  const living = world.tanks.filter((t) => t.team === from.team && t.alive);
  if (!living.length) return;
  living.sort(
    (a, b) =>
      dist(from.x, from.y, a.x, a.y) - dist(from.x, from.y, b.x, b.y),
  );
  switchToTank(world, living[0]!.id, from.team);
}

/** Drop or move this team's map X. Later clicks replace the previous mark. */
export function placePlayerMark(
  world: WorldState,
  team: "blue" | "red",
  x: number,
  y: number,
): { x: number; y: number } {
  const pad = 8;
  const px = Math.min(CONFIG.canvasWidth - pad, Math.max(pad, x));
  const py = Math.min(CONFIG.canvasHeight - pad, Math.max(pad, y));
  world.playerMarks[team] = { x: px, y: py };
  pushEvent(
    world,
    `Map mark (${Math.round(px)}, ${Math.round(py)}).`,
    "sys",
  );
  pushChat(world, "Mark set.", "ally");
  return { x: px, y: py };
}

export function markWreckAt(world: WorldState, x: number, y: number): boolean {
  // No wreck / Capture-the-Code debugging in Multiplayer · Offline.
  if (isMpRules(world.gameMode)) return false;
  const w = world.wrecks.find(
    (wr) => dist(wr.x, wr.y, x, y) <= CONFIG.wreckMarkClickRadius,
  );
  if (!w) return false;
  w.marked = true;
  pushEvent(world, `Marked wreck ${w.label} for debug.`, "sys");
  pushChat(world, `Command: mark wreck ${w.label}.`, "sys");
  return true;
}

/** Total blink-out duration for mp-offline death VFX. */
function deathFxDurationSec(): number {
  const { deathBlinkCount, deathBlinkHalfPeriodSec } = CONFIG.mpOffline;
  // visible + hidden per blink → 2 half-periods each
  return deathBlinkCount * 2 * deathBlinkHalfPeriodSec;
}

export async function sendOrder(
  world: WorldState,
  orderText: string,
  ctx: InterpretContext = {},
  team: "blue" | "red" = "blue",
): Promise<void> {
  if (world.outcome !== "playing") return;
  pushEvent(world, `Order (${team}): ${orderText}`, "sys");
  const bundle = await interpretOrder(
    orderText,
    world.tanks,
    world,
    ctx,
    team,
  );
  if (bundle.notice) {
    pushEvent(world, bundle.notice, "warn");
    pushChat(world, bundle.notice, "warn");
  }
  if (bundle.llmError) {
    // Event log only — keep team chat free of API noise
    pushEvent(
      world,
      `LLM unavailable (${bundle.llmError}) — keyword parse.`,
      "warn",
    );
  }
  pushEvent(
    world,
    `Radio parse: ${bundle.source.toUpperCase()} (${bundle.ms}ms) → ${bundle.results.length} tank(s)`,
    "sys",
  );

  // One company ack in chat; per-tank detail stays in the event log
  const living = bundle.results.filter((r) => {
    const tank = world.tanks.find((t) => t.id === r.tankId);
    return tank && tank.alive;
  });
  if (living.length) {
    const sample = living[0];
    const sameGoal = living.every((r) => r.goal === sample.goal);
    const ack = sameGoal
      ? `Company: ${living.length} tank(s) — ${sample.chatLine.replace(/^#\d+:\s*/, "")}`
      : `Company: ${living.length} tank(s) ack.`;
    pushChat(world, ack, "ally");
  }

  for (const r of living) {
    const tank = world.tanks.find((t) => t.id === r.tankId)!;
    tank.goal = {
      kind: r.goal,
      params: r.params ?? {},
      source: "player",
    };
    tank.lastOrderChat = r.chatLine;
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

export interface InputState {
  keys: Set<string> | string[];
  mouseX: number;
  mouseY: number;
  shooting: boolean;
}

function asKeySet(keys: Set<string> | string[]): Set<string> {
  return keys instanceof Set ? keys : new Set(keys);
}

export function stepWorld(
  world: WorldState,
  dt: number,
  input: InputState,
  remoteInput?: InputState | null,
): void {
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

  // AI team belief before brains (share modes feed contacts, not only player map)
  updateTeamBelief(world);

  // Expire markers
  world.markers = world.markers.filter(
    (m) => world.time - m.createdAt < CONFIG.markerFadeSeconds,
  );

  const localInput: InputState = {
    keys: asKeySet(input.keys),
    mouseX: input.mouseX,
    mouseY: input.mouseY,
    shooting: input.shooting,
  };
  const guestInput: InputState | null = remoteInput
    ? {
        keys: asKeySet(remoteInput.keys),
        mouseX: remoteInput.mouseX,
        mouseY: remoteInput.mouseY,
        shooting: remoteInput.shooting,
      }
    : null;

  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    tank.cooldown = Math.max(0, tank.cooldown - dt);

    const isLocalControlled =
      tank.team === "blue" && tank.id === world.controlledId;
    const isRemoteControlled =
      !!guestInput &&
      !!world.remoteControlledId &&
      tank.team === "red" &&
      tank.id === world.remoteControlledId;

    if (isLocalControlled) {
      updatePlayer(world, tank, dt, localInput);
    } else if (isRemoteControlled && guestInput) {
      updatePlayer(world, tank, dt, guestInput);
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
    if (!isMpRules(world.gameMode)) {
      handleDebug(world, tank, dt);
    }
  }

  updateDeathFx(world);
  updateProjectiles(world, dt);
  updateVision(world);
  updateSightings(world);
  checkOutcome(world);
}

function updateDeathFx(world: WorldState): void {
  const dur = deathFxDurationSec();
  world.deathFx = world.deathFx.filter((fx) => world.time - fx.startedAt < dur);
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

  const keys = asKeySet(input.keys);
  const speed = CONFIG.roles[tank.role].speed;
  let mx = 0;
  let my = 0;
  if (keys.has("arrowup")) my -= 1;
  if (keys.has("arrowdown")) my += 1;
  if (keys.has("arrowleft")) mx -= 1;
  if (keys.has("arrowright")) mx += 1;
  if (mx || my) {
    const len = Math.hypot(mx, my);
    mx = (mx / len) * speed * dt;
    my = (my / len) * speed * dt;
    const pos = tryMove(tank.x, tank.y, mx, my, CONFIG.tankRadius, world.walls);
    tank.x = pos.x;
    tank.y = pos.y;
  }

  const aim = angleTo(tank.x, tank.y, input.mouseX, input.mouseY);
  const wantShoot =
    input.shooting || keys.has(" ") || keys.has("spacebar");
  // Snap aim when firing so shots track the cursor; otherwise turn smoothly.
  if (wantShoot) {
    tank.angle = aim;
    tryShoot(world, tank, aim, true);
  } else {
    tank.angle = rotateToward(tank.angle, aim, CONFIG.tankTurnRate * 1.4 * dt);
  }

  // Player can debug / report by standing near marked wreck (not in mp-offline)
  if (!isMpRules(world.gameMode) && tank.goal.kind !== "debug") {
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
    if (isMpRules(world.gameMode)) {
      spawnDeathFx(world, tank);
    } else {
      spawnWreck(world, tank);
    }
    pushEvent(
      world,
      `${tank.team === "blue" ? "Friendly" : "Enemy"} #${tank.number} destroyed.`,
      "warn",
    );
    if (tank.team === "blue" && tank.id === world.controlledId) {
      autoSwitchNearest(world, tank);
    } else if (
      tank.team === "red" &&
      world.remoteControlledId &&
      tank.id === world.remoteControlledId
    ) {
      autoSwitchNearest(world, tank);
    }
  }
}

/** Blink twice then vanish — no persistent wreck gameplay in mp-offline. */
function spawnDeathFx(world: WorldState, tank: Tank): void {
  deathFxSeq++;
  const fx: DeathFx = {
    id: `death-${deathFxSeq}`,
    team: tank.team,
    tankNumber: tank.number,
    role: tank.role,
    x: tank.x,
    y: tank.y,
    angle: tank.angle,
    startedAt: world.time,
  };
  world.deathFx.push(fx);
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
  // Only the explicit reportIn order dumps fog — never auto-spam while idle.
  if (world.shareMode !== "report" && world.shareMode !== "clear") return;
  if (tank.goal.kind !== "reportIn") return;
  if (tank.id === world.controlledId) return; // controlled already live
  if (tank.standStillTimer < CONFIG.reportInSeconds) return;

  const cells = captureVisibleCells(world, tank);
  const n = applyDiscoveryCells(world, cells);
  tank.reportProgress = 0;
  tank.standStillTimer = 0;
  tank.goal = {
    kind: "holdPosition",
    params: { x: tank.x, y: tank.y },
    source: "system",
  };

  pushEvent(
    world,
    n > 0
      ? `#${tank.number}: report in — ${n} cells logged.`
      : `#${tank.number}: report in — nothing new.`,
    "sys",
  );

  // Sightings → markers + event log only (no chat spam)
  for (const e of world.tanks) {
    if (e.team !== "red" || !e.alive) continue;
    if (canSeeTank(tank, e, world.walls)) {
      addMarker(world, "enemy", e.x, e.y, `Enemy #${e.number}?`);
      pushEvent(
        world,
        `#${tank.number}: contact near (${Math.round(e.x)},${Math.round(e.y)}).`,
        "sys",
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
  if (isMpRules(world.gameMode)) return;
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

  if (wreck.wasCodeCarrier && world.gameMode === "ctf") {
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
  } else if (wreck.wasCodeCarrier) {
    // TDM: carrier is flavor only
    wreck.debugResult = "clean";
    const line = `#${tank.number}: wreck ${wreck.label} checked (TDM — no code win)`;
    if (tank.team === "blue") {
      pushChat(world, line, "ally");
      pushEvent(world, line, "ally");
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
  // Clear / no-fog: units are drawn directly — skip drifting enemy markers.
  if (world.shareMode === "clear") return;

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

  // Skip contact spam in clear (everyone is already visible).
  // In none/report, others are chat-only — occasional contact lines when AI sees enemies
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
    return;
  }
  if (!redAlive) {
    if (world.gameMode === "tdm" || isMpRules(world.gameMode)) {
      world.outcome = "win";
      pushEvent(
        world,
        isMpOnline(world.gameMode)
          ? "Enemy company wiped — Multiplayer · Online victory."
          : isMpOffline(world.gameMode)
            ? "Enemy company wiped — Multiplayer · Offline victory."
            : "Enemy company wiped — Team Deathmatch victory.",
        "warn",
      );
      pushChat(world, "All hostiles down. We win.", "ally");
      return;
    }
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
    }
  }
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
