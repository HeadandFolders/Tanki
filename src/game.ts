import {
  CONFIG,
  isBaseWar,
  isMpOffline,
  isMpOnline,
  isMpRules,
  type ArenaId,
  type GameMode,
  type RedDifficulty,
  type ShareMode,
} from "./config";
import {
  buildArena,
  arenaZones,
  dist,
  rotateToward,
  tryMove,
  angleTo,
  unstickFromWalls,
} from "./arena";
import { baseShotClear, createBaseStates } from "./arena-bases";
import { beginAiFrame, updateTankAi, warmRoutePlanner } from "./ai";
import { commanderView, setCommander, updateCommander, type Opponent, type PendingCommanderOrder } from "./ai-commander";
import { intentsToOrders } from "./command-resolver";
import type { CommandRecord } from "./command-pipeline";
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
import { completeCommandRecord, interpretCommand, markDiedStuck, recordMatchOutcome, refreshCommandRecord } from "./command-pipeline";
import { createTeams } from "./spawn";
import { createRandom, nextRandom } from "./random";
import { assignOrder, finishOrder, orderAcknowledgement, setGoal, stackFor } from "./interrupt-stack";
import { beginUtterance, failRadio, resetRadio, type UtteranceMeter } from "./radio";
import type {
  BaseState,
  ChatLine,
  DeathFx,
  InterpretContext,
  OrderResult,
  Projectile,
  Tank,
  WorldState,
  Wreck,
} from "./types";

export function createWorld(
  shareMode: ShareMode = CONFIG.shareModeDefault,
  gameMode: GameMode = CONFIG.gameModeDefault,
  redDifficulty: RedDifficulty = CONFIG.ai.redDifficultyDefault,
  seedOverride?: number,
  opponent: Opponent = "normal",
  arena?: ArenaId,
  arenaSeed: number = CONFIG.largeArena.seed,
): WorldState {
  // Screenshot layout for TDM / CTF / No Fog. Multiplayer keeps the dense maze
  // unless the host picked another MP arena.
  const arenaId: ArenaId =
    arena ??
    (isMpRules(gameMode) && CONFIG.mpOffline.denseArena ? "dense" : "reference");
  // Walls first: buildArena sets the world size the fog grid is sized from.
  const walls = buildArena(arenaId, { seed: arenaSeed, baseWar: isBaseWar(gameMode) });
  warmRoutePlanner(walls);
  const fog = createFogGrid();
  const seed =
    seedOverride != null
      ? seedOverride >>> 0
      : (Date.now() ^ (Math.random() * 1e9)) >>> 0;
  const random = createRandom(seed);
  const tanks = createTeams(
    () => nextRandom(random),
    gameMode === "ctf",
    shareMode,
    gameMode,
    walls,
    arenaId,
  );
  const controlled =
    tanks.find((t) => t.team === "blue" && t.role === "shooter") ??
    tanks.find((t) => t.team === "blue")!;
  const remoteControlled = isMpOnline(gameMode)
    ? (tanks.find((t) => t.team === "red" && t.role === "shooter") ??
      tanks.find((t) => t.team === "red")!)
    : null;

  const world: WorldState = {
    time: 0,
    matchLeft: isBaseWar(gameMode) ? CONFIG.matchTimeLimitSec : CONFIG.matchDurationSec,
    shareMode,
    gameMode,
    arenaId,
    arenaSeed,
    zones: arenaZones(arenaId, arenaSeed),
    walls,
    bases: isBaseWar(gameMode) ? createBaseStates(arenaId) : undefined,
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
    outcomeReason: null,
    chat: [],
    events: [],
    orderEvents: [],
    nextWreckLabel: 0,
    rngSeed: seed,
    random,
    wreckSeq: 0,
    deathFxSeq: 0,
    teamBelief: { contacts: [] },
    redTeamBelief: { contacts: [] },
    redDifficulty,
  };
  if (isMpOffline(gameMode)) setCommander(world, "red", opponent);

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
  } else if (isBaseWar(gameMode)) {
    pushEvent(world, "Base War — destroy the enemy base or eliminate all enemy tanks. Ten-minute limit.", "sys");
    pushChat(world, "Stand by. Base War. Allies hold until ordered; defend your base.", "sys");
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
  world.matchLeft = isBaseWar(world.gameMode) ? CONFIG.matchTimeLimitSec : CONFIG.matchDurationSec;
  world.outcomeReason = null;
  for (const team of ["blue", "red"] as const) {
    const commander = world.commanders?.[team];
    if (commander) setCommander(world, team, commander.difficulty, commander.seed, commander.profile);
  }
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
  parsed?: PendingCommanderOrder & { view: WorldState },
  utterance?: { segmentId?: string },
): Promise<void> {
  if (world.outcome !== "playing") return;
  if (parsed) {
    const { record, view } = parsed;
    const resolved = intentsToOrders(view, team, [record.intent!], "ai_commander");
    record.notice = resolved.notice;
    record.appliedAt = world.time;
    record.latency_ms = (parsed.executeAt - record.issuedAt!) * 1000;
    const living = applyResolvedOrders(world, resolved.orders, record, team, view);
    record.tanks = living.map((order) => order.tankId);
    pushEvent(world, `AI commander (${team}): ${record.raw_text} — ${record.reason}`, "sys");
    completeCommandRecord(world, record, living, world.tanks, (world.time - record.issuedAt!) * 1000);
    return;
  }
  const meter: UtteranceMeter = { at: performance.now(), count: 0 };
  if (!beginUtterance(world, orderText, team, utterance?.segmentId, meter)) return;
  const intakeAt = meter.at;
  pushEvent(world, `Order (${team}): ${orderText}`, "sys");
  const { bundle, record } = await interpretCommand(
    orderText,
    world.tanks,
    world,
    ctx,
    team,
  );
  if (world.outcome !== "playing") return;
  record.repeat_count = meter.count;
  meter.attach = (count) => {
    record.repeat_count = count;
    refreshCommandRecord(record);
  };
  if (bundle.notice) pushEvent(world, bundle.notice, "warn");
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

  const living = applyResolvedOrders(world, bundle.results, record, team, undefined, intakeAt);
  if (!living.length) {
    failRadio(world, team);
    // "Company: say again" is the answer to the utterance; it counts as the ack.
    record.t_ack_ms = Math.round((performance.now() - intakeAt) * 10) / 10;
  }
  completeCommandRecord(world, record, living, world.tanks, performance.now() - intakeAt);
}

function applyResolvedOrders(
  world: WorldState,
  results: OrderResult[],
  record: CommandRecord,
  team: "blue" | "red",
  view: WorldState = world,
  intakeAt?: number,
): OrderResult[] {
  const living = results.filter((r) => {
    const tank = world.tanks.find((t) => t.id === r.tankId);
    return tank && tank.alive && tank.team === team;
  });
  const eventStart = world.orderEvents?.length ?? 0;
  const acknowledgements: string[] = [];
  for (const r of living) {
    const tank = world.tanks.find((t) => t.id === r.tankId)!;
    const stack = stackFor(tank);
    const routineCopyDue = world.time - stack.lastCopyAt >= 2;
    assignOrder(view, tank, {
      kind: r.goal,
      params: r.params ?? {},
      source: "player",
      commandId: record.id,
      noRetreat: r.noRetreat,
      commandSource: record.which_path_executed,
      ...(record.issuer === "ai_commander" ? { issuer: "ai_commander" as const } : {}),
    }, true);
    const acknowledgement = orderAcknowledgement(view, tank);
    if (acknowledgement.startsWith("negative")) {
      resetRadio(world, team);
      acknowledgements.push(`#${tank.number} ${acknowledgement}`);
    } else if (stack.status === "active" && routineCopyDue) {
      acknowledgements.push(`#${tank.number} ${acknowledgement}`);
      stack.lastCopyAt = world.time;
    }
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
  if (acknowledgements.length) {
    world.chat.push({ t: world.time, team, text: `Company: ${acknowledgements.join("; ")}`, kind: "ally" });
    if (world.chat.length > 80) world.chat.shift();
    // The first captioned answer is the ack; stamp once.
    if (record.t_ack_ms == null && intakeAt != null) {
      record.t_ack_ms = Math.round((performance.now() - intakeAt) * 10) / 10;
    }
  }
  record.orderEvents = (world.orderEvents ?? []).slice(eventStart).filter((event) => event.commandId === record.id);
  record.interrupts = record.orderEvents.filter((event) => event.type === "interrupted").length;
  return living;
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
  beginAiFrame();
  world.matchLeft -= dt;
  if (world.matchLeft <= 0) {
    world.matchLeft = 0;
    if (isBaseWar(world.gameMode)) resolveBaseWarTimeout(world);
    else {
      world.outcome = "draw";
      pushEvent(world, "Time expired — draw.", "warn");
      pushChat(world, "Clock zero. No code confirmed. Draw.", "warn");
    }
    closeMatchOrders(world);
    return;
  }

  // AI team belief before brains (share modes feed contacts, not only player map)
  updateTeamBelief(world);
  for (const team of ["blue", "red"] as const) {
    const commander = world.commanders?.[team];
    if (commander) updateCommander(world, commander);
  }
  const botViews = {
    blue: world.commanders?.blue ? commanderView(world, world.commanders.blue) : world,
    red: world.commanders?.red ? commanderView(world, world.commanders.red) : world,
  };

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
      tank.team === "blue" && tank.id === world.controlledId && !world.commanders?.blue;
    const isRemoteControlled =
      !!guestInput &&
      !!world.remoteControlledId &&
      tank.team === "red" &&
      tank.id === world.remoteControlledId && !world.commanders?.red;

    if (isLocalControlled) {
      updatePlayer(world, tank, dt, localInput);
    } else if (isRemoteControlled && guestInput) {
      updatePlayer(world, tank, dt, guestInput);
    } else {
      const ai = updateTankAi(botViews[tank.team], tank, dt, false);
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
  for (const tank of world.tanks.filter((t) => t.alive)) {
    const stack = stackFor(tank);
    if (stack.interrupt) continue;
    if (stack.base.kind === "attackNearest" && stack.preyId && world.tanks.some((t) => t.id === stack.preyId && !t.alive)) {
      finishOrder(world, tank, "success", "prey_dead_hold", "target down, holding");
    } else if (stack.base.kind === "attackBase" && !world.bases?.[tank.team === "blue" ? "red" : "blue"]?.alive) {
      finishOrder(world, tank, "success", "order_complete", "base down, holding");
    }
  }
  checkOutcome(world);
  if (world.outcome !== "playing") closeMatchOrders(world);
}

function closeMatchOrders(world: WorldState): void {
  for (const tank of world.tanks) finishOrder(world, tank, "expired", "match_ended", "match ended, order closed");
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
    // Fog modes gate on vision. No-fog multiplayer already gated the chosen shot
    // on range + line of sight in the brain, so gate on the same gun range: a
    // tighter number here meant hulls aimed at enemies they refused to shoot.
    const reach = isMpRules(world.gameMode)
      ? Math.max(stats.fightRange, CONFIG.mpOffline.shootRange)
      : stats.visionRadius + 40;
    const sees = world.tanks.some(
      (e) =>
        e.team !== tank.team &&
        e.alive &&
        dist(tank.x, tank.y, e.x, e.y) < reach,
    );
    const base = world.bases?.[tank.team === "blue" ? "red" : "blue"];
    const seesBase = tank.goal.kind === "attackBase" && base &&
      baseShotClear(tank, base, world.walls, CONFIG.mpOffline.shootRange);
    if (!sees && !seesBase) return;
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

    const base = Object.values(world.bases ?? {}).find((candidate) =>
      candidate.alive &&
      p.x >= candidate.x - CONFIG.bulletRadius &&
      p.x <= candidate.x + candidate.w + CONFIG.bulletRadius &&
      p.y >= candidate.y - CONFIG.bulletRadius &&
      p.y <= candidate.y + candidate.h + CONFIG.bulletRadius,
    );
    if (base) {
      applyBaseDamage(world, base, p.damage, p.team);
      continue;
    }

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

export function applyBaseDamage(
  world: WorldState,
  base: BaseState,
  damage: number,
  sourceTeam: "blue" | "red",
): void {
  if (!base.alive) return;
  base.lastHitAt = world.time;
  if (sourceTeam === base.team) return;
  base.lastDamagedAt = world.time;
  if (world.time - base.lastAlertAt >= CONFIG.baseAttackAlertCooldownSec) base.lastAlertAt = world.time;
  base.hp = Math.max(0, base.hp - damage * CONFIG.baseDamageMultiplier);
  if (base.hp > 0) return;
  base.alive = false;
  base.destroyedAt = world.time;
  pushEvent(world, `${base.team === "blue" ? "Friendly" : "Enemy"} base destroyed.`, "warn");
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
    // Read the command id before finishOrder mutates the stack.
    const commandId = stackFor(tank).base.commandId;
    if (tank.stuckState?.stuck) markDiedStuck(world, commandId);
    delete tank.stuckState;
    finishOrder(world, tank, "expired", "tank_destroyed", "tank down, order ended");
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
  world.deathFxSeq++;
  const fx: DeathFx = {
    id: `death-${world.deathFxSeq}`,
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
  world.wreckSeq++;
  const wreck: Wreck = {
    id: `wreck-${world.wreckSeq}`,
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
  setGoal(world, tank, {
    kind: "holdPosition",
    params: { x: tank.x, y: tank.y },
    source: "system",
  }, "success", "order_complete", "report complete, holding");

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
        setGoal(world, tank, { kind: "holdPosition", params: { x: tank.x, y: tank.y } }, "success", "order_complete", "wreck checked, holding");
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
        if (nextRandom(world.random) < 0.002) {
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

function finishBaseWar(
  world: WorldState,
  outcome: "win" | "lose" | "draw",
  reason: string,
): void {
  world.outcome = outcome;
  world.outcomeReason = reason;
  pushEvent(world, `${reason} — ${outcome === "draw" ? "draw" : outcome === "win" ? "victory" : "defeat"}.`, "warn");
  pushChat(world, `${reason} ${outcome === "draw" ? "Draw." : outcome === "win" ? "We win." : "Defeat."}`, "warn");
  recordMatchOutcome(world, outcome, reason);
}

function resolveBaseWarTimeout(world: WorldState): void {
  const blueBase = world.bases!.blue;
  const redBase = world.bases!.red;
  const blueHp = blueBase.hp / blueBase.maxHp;
  const redHp = redBase.hp / redBase.maxHp;
  if (Math.abs(blueHp - redHp) > 1e-9) {
    finishBaseWar(world, blueHp > redHp ? "win" : "lose", "Time up: base HP");
    return;
  }
  const blueAlive = world.tanks.filter((tank) => tank.team === "blue" && tank.alive).length;
  const redAlive = world.tanks.filter((tank) => tank.team === "red" && tank.alive).length;
  if (blueAlive !== redAlive) {
    finishBaseWar(world, blueAlive > redAlive ? "win" : "lose", "Time up: surviving tanks");
    return;
  }
  finishBaseWar(world, "draw", "Time up: draw");
}

function checkBaseWarOutcome(world: WorldState): void {
  const blueAlive = world.tanks.some((tank) => tank.team === "blue" && tank.alive);
  const redAlive = world.tanks.some((tank) => tank.team === "red" && tank.alive);
  const blueBaseAlive = world.bases!.blue.alive;
  const redBaseAlive = world.bases!.red.alive;
  const blueWins = !redAlive || !redBaseAlive;
  const redWins = !blueAlive || !blueBaseAlive;
  if (blueWins && redWins) {
    finishBaseWar(world, "draw", "Simultaneous destruction");
    return;
  }
  if (blueWins) {
    finishBaseWar(world, "win", redBaseAlive ? "All tanks eliminated" : "Base destroyed");
    return;
  }
  if (redWins) {
    finishBaseWar(world, "lose", blueBaseAlive ? "All tanks eliminated" : "Base destroyed");
  }
}

function checkOutcome(world: WorldState): void {
  if (world.outcome !== "playing") return;
  if (isBaseWar(world.gameMode)) {
    checkBaseWarOutcome(world);
    return;
  }
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
