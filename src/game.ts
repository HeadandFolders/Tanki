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
import {
  armoredDamage,
  armorBand,
  driveSpeedOf,
  fireCooldownOf,
  getRespawnRate,
  hasRoundInAir,
  middleZoneGeometry,
  RESPAWN,
  TANK_TYPES,
  turnRateOf,
  turretTurnRateOf,
  type ArmorBand,
  type NukeSpec,
} from "./config/balance";
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
import { assignOrder, finishOrder, orderAcknowledgement, restoreGoal, setGoal, stackFor } from "./interrupt-stack";
import { beginUtterance, failRadio, resetRadio, type UtteranceMeter } from "./radio";
import type {
  BaseState,
  ChatLine,
  DeathFx,
  InterpretContext,
  OrderResult,
  Projectile,
  Tank,
  TeamId,
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
  // Multiplayer rules take the default map unless one was picked; TDM / CTF /
  // No Fog keep the reference screenshot layout.
  const arenaId: ArenaId =
    arena ?? (isMpRules(gameMode) ? CONFIG.arenaDefault : "reference");
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
    middleZone: {
      ...middleZoneGeometry(CONFIG.canvasWidth, CONFIG.canvasHeight),
      holder: null,
      contested: false,
    },
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
    pushEvent(world, "Base War — destroy the enemy base. Killing their hulls only stops them until they respawn at base. Ten-minute limit.", "sys");
    pushChat(world, "Stand by. Base War. Allies hold until ordered; defend your base.", "sys");
  } else if (isMpOffline(gameMode)) {
    pushEvent(
      world,
      "Multiplayer · Offline — local/bot TDM. No fog. Wipe the enemy team; hulls respawn at base. Allies hold until ordered.",
      "sys",
    );
    pushChat(
      world,
      "Stand by. Multiplayer · Offline. Five hull types a side — hold until radio orders.",
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
    pushEvent(world, `Control → #${t.number} (${CONFIG.roles[t.role].label})`, "sys");
    if (prev && prev.id !== t.id) {
      pushChat(
        world,
        `#${prev.number} ${CONFIG.roles[prev.role].label}: continuing last order.`,
        "ally",
      );
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
    const caller = `#${tank.number} ${CONFIG.roles[tank.role].label}`;
    if (acknowledgement.startsWith("negative")) {
      resetRadio(world, team);
      acknowledgements.push(`${caller} ${acknowledgement}`);
    } else if (stack.status === "active" && routineCopyDue) {
      acknowledgements.push(`${caller} ${acknowledgement}`);
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

/** A hull that asked to fire this step, kept so its shot can be retried once its round lands. */
interface ShotRequest {
  tank: Tank;
  aimAngle: number;
  isPlayer: boolean;
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

  // Who asked to fire this step. A round is spent by collision and collisions
  // resolve at the end of the step, so these hulls get a second attempt once the
  // round they last fired is gone — see the retry after `updateProjectiles`.
  const shotRequests: ShotRequest[] = [];

  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    tank.cooldown = Math.max(0, tank.cooldown - dt);
    tank.nukeCooldown = Math.max(0, tank.nukeCooldown - dt);

    const isLocalControlled =
      tank.team === "blue" && tank.id === world.controlledId && !world.commanders?.blue;
    const isRemoteControlled =
      !!guestInput &&
      !!world.remoteControlledId &&
      tank.team === "red" &&
      tank.id === world.remoteControlledId && !world.commanders?.red;

    if (isLocalControlled) {
      updatePlayer(world, tank, dt, localInput, shotRequests);
    } else if (isRemoteControlled && guestInput) {
      updatePlayer(world, tank, dt, guestInput, shotRequests);
    } else {
      const ai = updateTankAi(botViews[tank.team], tank, dt, false);
      const armed = ai.wantShoot && TANK_TYPES[tank.role].canShoot;
      slewTurret(tank, armed ? ai.aimAngle : tank.angle, dt);
      if (armed) {
        tryShoot(world, tank, ai.aimAngle, false);
        shotRequests.push({ tank, aimAngle: ai.aimAngle, isPlayer: false });
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

  updateMiddleZone(world);
  updateRespawns(world, dt);
  updateDeathFx(world);
  updateRepairs(world, dt);
  updateProjectiles(world, dt);
  // A round that collided this step just freed its gun. Anything slower than
  // its own flight — a gunner at range — has already paid its reload, so it
  // fires now instead of a tick later; `tryShoot` re-runs every gate, so a hull
  // that already shot, is dead, or is still reloading gets nothing.
  for (const request of shotRequests) {
    tryShoot(world, request.tank, request.aimAngle, request.isPlayer);
  }
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

/**
 * Who is standing in the middle zone. Two hulls of one side and none of the
 * other is the whole rule, and it is what decides each team's respawn clock;
 * both sides present cancel each other out, and an empty zone is simply open.
 */
function updateMiddleZone(world: WorldState): void {
  const zone = world.middleZone;
  const inside: Record<TeamId, number> = { blue: 0, red: 0 };
  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    if (dist(tank.x, tank.y, zone.x, zone.y) > zone.radius) continue;
    inside[tank.team] += 1;
  }
  zone.contested = inside.blue > 0 && inside.red > 0;
  zone.holder = zone.contested
    ? null
    : inside.blue > 0
      ? "blue"
      : inside.red > 0
        ? "red"
        : null;
}

/**
 * Slow respawn, multiplayer rules only — the wreck modes leave a hull dead for
 * good. Each waiting hull counts down at its team's respawn rate, which is the
 * one number the middle zone moves.
 */
function updateRespawns(world: WorldState, dt: number): void {
  if (!isMpRules(world.gameMode)) return;
  for (const tank of world.tanks) {
    if (tank.alive || tank.respawnLeft === undefined) continue;
    tank.respawnLeft -= dt * getRespawnRate(tank.team, world.middleZone);
    if (tank.respawnLeft <= 0) respawnTank(world, tank);
  }
}

/** The hull comes back whole, same type and number, holding at its own base. */
function respawnTank(world: WorldState, tank: Tank): void {
  const stats = TANK_TYPES[tank.role];
  const at = tank.spawnPos ?? { x: tank.x, y: tank.y };
  tank.alive = true;
  tank.respawnLeft = undefined;
  tank.hp = tank.maxHp;
  tank.x = at.x;
  tank.y = at.y;
  tank.angle = tank.team === "blue" ? -Math.PI / 2 : Math.PI / 2;
  tank.turretAngle = tank.angle;
  tank.lastKnownPos = { x: at.x, y: at.y };
  tank.cooldown = 0;
  // A respawned carrier warms its round up again rather than arriving with one live.
  tank.nukeCooldown = stats.nuke?.warmupSec ?? 0;
  tank.killedBy = undefined;
  tank.spawnProtectionUntil = world.time + RESPAWN.protectionSec;
  tank.lastShotAt = -999;
  tank.standStillTimer = 0;
  tank.reportProgress = 0;
  tank.debugProgress = 0;
  tank.debugTargetId = null;
  tank.routeCommit = undefined;
  tank.driveTrack = undefined;
  tank.stuckState = undefined;
  // Whatever order it was following died with it; it holds base until named again.
  restoreGoal(tank, { kind: "holdPosition", source: "system", params: { x: at.x, y: at.y } });
  pushEvent(
    world,
    `${tank.team === "blue" ? "Friendly" : "Enemy"} #${tank.number} ` +
    `${CONFIG.roles[tank.role].label} respawned at base.`,
    "sys",
  );
}

/**
 * The hulls a team currently has in the ground and the seconds left on each.
 * The HUD reads this; nothing in the simulation does.
 */
export function respawnQueue(
  world: WorldState,
  team: "blue" | "red",
): { tank: Tank; secondsLeft: number }[] {
  return world.tanks
    .filter((tank) => tank.team === team && !tank.alive && tank.respawnLeft !== undefined)
    .map((tank) => ({ tank, secondsLeft: Math.max(0, tank.respawnLeft!) }));
}

/**
 * Engineers heal the company: slow, close range, friendly hulls only, and never
 * themselves. A wounded tank has somewhere to go instead of only a retreat.
 */
function updateRepairs(world: WorldState, dt: number): void {
  for (const hull of world.tanks) {
    if (!hull.alive) continue;
    const stats = TANK_TYPES[hull.role];
    if (!stats.repairRate || !stats.repairRange) continue;
    for (const ally of world.tanks) {
      if (ally === hull || !ally.alive || ally.team !== hull.team) continue;
      if (ally.hp >= ally.maxHp) continue;
      if (dist(hull.x, hull.y, ally.x, ally.y) > stats.repairRange) continue;
      ally.hp = Math.min(ally.maxHp, ally.hp + stats.repairRate * dt);
    }
  }
}

function updatePlayer(
  world: WorldState,
  tank: Tank,
  dt: number,
  input: InputState,
  shotRequests: ShotRequest[],
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
  const speed = driveSpeedOf(tank, world.time);
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
  // The barrel follows the cursor on its own track, so the muzzle reads as the
  // aim even while the hull is still swinging round.
  slewTurret(tank, aim, dt);
  // Snap aim when firing so shots track the cursor; otherwise turn smoothly.
  if (wantShoot) {
    tank.angle = aim;
    tryShoot(world, tank, aim, true);
    shotRequests.push({ tank, aimAngle: aim, isPlayer: true });
  } else {
    tank.angle = rotateToward(tank.angle, aim, turnRateOf(tank.role) * 1.4 * dt);
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

/** The gun trails what the hull is aimed at; a shot still snaps it onto the round. */
function slewTurret(tank: Tank, targetAngle: number, dt: number): void {
  tank.turretAngle = rotateToward(
    tank.turretAngle,
    targetAngle,
    turretTurnRateOf(tank.role) * dt,
  );
}

function tryShoot(
  world: WorldState,
  tank: Tank,
  aimAngle: number,
  isPlayer: boolean,
): void {
  if (tank.cooldown > 0 || !tank.alive) return;
  const stats = TANK_TYPES[tank.role];
  if (!stats.canShoot) return;
  // One round per hull in the field: the gun does not cycle again until the
  // last one it fired hits something.
  if (hasRoundInAir(world.projectiles, tank.id)) return;

  // The nuke is the carrier's real weapon and it is aimed at a base. A human
  // spends it on the round they are pointing at; a bot only commits it when the
  // enemy base is inside launch reach with a clear line, so it is never wasted
  // on a hull. Both then fall back to the deck gun for the long cooldown.
  const nuke = stats.nuke;
  if (nuke && tank.nukeCooldown <= 0 && (isPlayer || baseInRange(world, tank, nuke.range))) {
    launchNuke(world, tank, aimAngle, nuke);
    return;
  }

  // AI: only open fire if this tank can see someone (player may always shoot).
  if (!isPlayer) {
    // Each hull gates on its own gun reach. A shared number made a short-barrel
    // type shoot at things it should not have been able to hit, and clipped a
    // long one.
    const sees = world.tanks.some(
      (e) =>
        e.team !== tank.team &&
        e.alive &&
        dist(tank.x, tank.y, e.x, e.y) < stats.range,
    );
    if (!sees && !baseInRange(world, tank, stats.range)) return;
  }

  tank.cooldown = fireCooldownOf(tank.role);
  tank.lastShotAt = world.time;
  tank.turretAngle = aimAngle;
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
    fromShooter: tank.role === "shooter",
  };
  world.projectiles.push(proj);
}

/** Enemy base this hull may shoot at right now: ordered to, alive, in reach, clear line. */
function baseInRange(world: WorldState, tank: Tank, range: number): boolean {
  if (tank.goal.kind !== "attackBase") return false;
  const base = world.bases?.[tank.team === "blue" ? "red" : "blue"];
  return !!base?.alive && baseShotClear(tank, base, world.walls, range);
}

function launchNuke(
  world: WorldState,
  tank: Tank,
  aimAngle: number,
  nuke: NukeSpec,
): void {
  tank.cooldown = fireCooldownOf(tank.role);
  tank.nukeCooldown = nuke.cooldownSec;
  tank.lastShotAt = world.time;
  tank.turretAngle = aimAngle;
  world.projectiles.push({
    id: `nuke-${tank.id}-${world.time}`,
    team: tank.team,
    ownerId: tank.id,
    x: tank.x + Math.cos(aimAngle) * (CONFIG.tankRadius + 4),
    y: tank.y + Math.sin(aimAngle) * (CONFIG.tankRadius + 4),
    vx: Math.cos(aimAngle) * nuke.speed,
    vy: Math.sin(aimAngle) * nuke.speed,
    damage: nuke.damageVsTank,
    fromShooter: false,
    nuke: {
      blastRadius: nuke.blastRadius,
      damageVsTank: nuke.damageVsTank,
      damageVsBase: nuke.damageVsBase,
    },
  });
  pushEvent(
    world,
    `${tank.team === "blue" ? "Friendly" : "Enemy"} #${tank.number} ${TANK_TYPES[tank.role].label} launched a nuke.`,
    "warn",
  );
}

/**
 * Which face of `target` a round arriving along its own travel direction
 * strikes. A round with no direction (a test fixture dropped on a hull) is not
 * aimed at any face, so it pays the un-armoured side multiplier.
 */
function bandOfHit(
  target: Tank,
  shot: { vx: number; vy: number },
): ArmorBand {
  if (shot.vx === 0 && shot.vy === 0) return "side";
  return armorBand(target, Math.atan2(-shot.vy, -shot.vx));
}

/** Everything the blast touches, from the round's last position outward. */
function detonate(world: WorldState, round: Projectile): void {
  const blast = round.nuke!;
  const base = Object.values(world.bases ?? {}).find(
    (candidate) =>
      candidate.alive &&
      candidate.team !== round.team &&
      dist(round.x, round.y, candidate.x + candidate.w / 2, candidate.y + candidate.h / 2) <=
        blast.blastRadius + Math.max(candidate.w, candidate.h) / 2,
  );
  if (base) applyBaseDamage(world, base, blast.damageVsBase, round.team, true);
  for (const tank of world.tanks) {
    if (!tank.alive || tank.team === round.team) continue;
    if (dist(round.x, round.y, tank.x, tank.y) > blast.blastRadius + CONFIG.tankRadius) continue;
    let rel = 1;
    if (blast.blastRadius > 0) {
      rel = Math.max(0.35, 1 - dist(round.x, round.y, tank.x, tank.y) / blast.blastRadius);
    }
    applyDamage(world, tank, blast.damageVsTank * rel, round.ownerId, bandFromPoint(tank, round));
  }
}

/** A blast hits from wherever it is, not along a barrel. */
function bandFromPoint(target: Tank, at: { x: number; y: number }): ArmorBand {
  if (at.x === target.x && at.y === target.y) return "side";
  return armorBand(target, Math.atan2(at.y - target.y, at.x - target.x));
}

function updateProjectiles(world: WorldState, dt: number): void {
  const next: Projectile[] = [];
  for (const p of world.projectiles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const base = Object.values(world.bases ?? {}).find((candidate) =>
      candidate.alive &&
      p.x >= candidate.x - CONFIG.bulletRadius &&
      p.x <= candidate.x + candidate.w + CONFIG.bulletRadius &&
      p.y >= candidate.y - CONFIG.bulletRadius &&
      p.y <= candidate.y + candidate.h + CONFIG.bulletRadius,
    );
    if (base) {
      if (p.nuke) detonate(world, p);
      else applyBaseDamage(world, base, p.damage, p.team);
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
    if (hitWall) {
      if (p.nuke) detonate(world, p);
      continue;
    }

    let hit = false;
    for (const t of world.tanks) {
      if (!t.alive) continue;
      if (t.team === p.team && !CONFIG.friendlyFire) continue;
      if (dist(p.x, p.y, t.x, t.y) <= CONFIG.tankRadius + CONFIG.bulletRadius) {
        if (p.nuke) detonate(world, p);
        else applyDamage(world, t, p.damage, p.ownerId, bandOfHit(t, p));
        hit = true;
        break;
      }
    }
    if (hit) continue;
    // A round is spent by collision, never by distance, so every arena has to
    // be able to stop one. The stone border normally does; this catches a step
    // that jumps clean over it, which would otherwise fly forever and leave its
    // hull disarmed for the rest of the match.
    if (
      p.x < 0 ||
      p.y < 0 ||
      p.x > CONFIG.canvasWidth ||
      p.y > CONFIG.canvasHeight
    ) {
      if (p.nuke) detonate(world, p);
      continue;
    }
    next.push(p);
  }
  world.projectiles = next;
}

export function applyBaseDamage(
  world: WorldState,
  base: BaseState,
  damage: number,
  sourceTeam: "blue" | "red",
  direct = false,
): void {
  if (!base.alive) return;
  base.lastHitAt = world.time;
  if (sourceTeam === base.team) return;
  base.lastDamagedAt = world.time;
  if (world.time - base.lastAlertAt >= CONFIG.baseAttackAlertCooldownSec) base.lastAlertAt = world.time;
  // A nuke is rated in base HP already; shells pay the anti-structure reduction.
  base.hp = Math.max(0, base.hp - (direct ? damage : damage * CONFIG.baseDamageMultiplier));
  if (base.hp > 0) return;
  base.alive = false;
  base.destroyedAt = world.time;
  pushEvent(world, `${base.team === "blue" ? "Friendly" : "Enemy"} base destroyed.`, "warn");
}

function applyDamage(
  world: WorldState,
  tank: Tank,
  damage: number,
  sourceId: string,
  band: ArmorBand = "side",
): void {
  // Spawn protection: a hull that just returned cannot be shot down again.
  if (tank.spawnProtectionUntil !== undefined && world.time < tank.spawnProtectionUntil) return;
  // Directional armour: the same shell hurts far less off the nose plate than
  // off the engine deck, so facing your attacker is a real defence.
  tank.hp -= armoredDamage(tank.role, damage, band);
  tank.debugProgress = 0; // damage interrupts debug
  tank.reportProgress = 0;
  if (tank.hp <= 0) {
    tank.hp = 0;
    tank.alive = false;
    tank.killedBy = sourceId;
    // Read the command id before finishOrder mutates the stack.
    const commandId = stackFor(tank).base.commandId;
    if (tank.stuckState?.stuck) markDiedStuck(world, commandId);
    delete tank.stuckState;
    finishOrder(world, tank, "expired", "tank_destroyed", "tank down, order ended");
    if (isMpRules(world.gameMode)) {
      spawnDeathFx(world, tank);
      tank.respawnLeft = RESPAWN.delaySec;
    } else {
      spawnWreck(world, tank);
    }
    pushEvent(
      world,
      `${tank.team === "blue" ? "Friendly" : "Enemy"} #${tank.number} ` +
      `${CONFIG.roles[tank.role].label} destroyed.`,
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
      dist(v.x, v.y, wreck.x, wreck.y) <= CONFIG.roles[v.role].visionRange,
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

  const hull = CONFIG.roles[tank.role].label;
  pushEvent(
    world,
    n > 0
      ? `#${tank.number} ${hull}: report in — ${n} cells logged.`
      : `#${tank.number} ${hull}: report in — nothing new.`,
    "sys",
  );

  // Sightings → markers + event log only (no chat spam)
  for (const e of world.tanks) {
    if (e.team !== "red" || !e.alive) continue;
    if (canSeeTank(tank, e, world.walls)) {
      addMarker(world, "enemy", e.x, e.y, `Enemy #${e.number}?`);
      pushEvent(
        world,
        `#${tank.number} ${hull}: contact near (${Math.round(e.x)},${Math.round(e.y)}).`,
        "sys",
      );
    }
  }
  for (const w of world.wrecks) {
    if (dist(tank.x, tank.y, w.x, w.y) <= CONFIG.roles[tank.role].visionRange) {
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
      CONFIG.roles[t.role].visionRange,
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
      if (dist(v.x, v.y, w.x, w.y) <= CONFIG.roles[v.role].visionRange) {
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
  const blueBaseAlive = world.bases!.blue.alive;
  const redBaseAlive = world.bases!.red.alive;
  // Only a destroyed base wins. A side with no hulls left simply cannot act —
  // its dead are counting down at base, and the match runs to the clock.
  if (!blueBaseAlive && !redBaseAlive) {
    finishBaseWar(world, "draw", "Simultaneous destruction");
    return;
  }
  if (!redBaseAlive) {
    finishBaseWar(world, "win", "Base destroyed");
    return;
  }
  if (!blueBaseAlive) {
    finishBaseWar(world, "lose", "Base destroyed");
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
