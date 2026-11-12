import { dist } from "./arena";
import { goalState, stackFor } from "./interrupt-stack";
import { beliefFor } from "./belief";
import { CONFIG, isBaseWar, type RedDifficulty } from "./config";
import { scriptedCommandRecord, type CommandRecord } from "./command-pipeline";
import type { CommandIntent } from "./command-schema";
import { freePointNear } from "./formation";
import { sendOrder } from "./game";
import { spawnBounds } from "./spawn";
import { createRandom, nextRandom, type RandomState } from "./random";
import type { ArenaZone } from "./arena-large";
import type { GoalKind, Tank, TeamContact, TeamId, Vec2, WorldState } from "./types";

export type CommanderDifficulty = RedDifficulty;
export type Opponent = CommanderDifficulty | "off";
/**
 * How the scripted commander spends its order slots. `tactical` is the
 * historical decision maker; the other two are fixed doctrine, for measuring
 * the game against a known opponent instead of tuning one.
 */
export type CommanderProfile = "tactical" | "rusher" | "turtle";

export const COMMANDER_PROFILES: readonly CommanderProfile[] = ["tactical", "rusher", "turtle"];

interface PerceivedContact {
  contact: TeamContact;
  since: number;
  readyAt: number;
  visible: boolean;
}

export interface PendingCommanderOrder {
  record: CommandRecord;
  executeAt: number;
  marker?: Vec2;
}

export interface AiCommanderState {
  team: TeamId;
  difficulty: CommanderDifficulty;
  profile: CommanderProfile;
  seed: number;
  cadence: RandomState;
  decisions: RandomState;
  perception: RandomState;
  acknowledgements: RandomState;
  nextOrderAt: number;
  sequence: number;
  contacts: Record<string, PerceivedContact>;
  deployed: number[];
  assignments: Record<string, { at: number; kind: GoalKind }>;
  pending: PendingCommanderOrder | null;
  ticks: { at: number; skipped?: "busy" | "no_tanks" }[];
  orders: CommandRecord[];
}

const QUALITY = {
  easy: { focus: 0.45, weakest: 0.35, flank: 0.12, waste: 0.10, noise: 36 },
  normal: { focus: 0.72, weakest: 0.70, flank: 0.35, waste: 0.06, noise: 18 },
  hard: { focus: 0.90, weakest: 0.90, flank: 0.58, waste: 0.03, noise: 6 },
};

export function createCommander(
  team: TeamId,
  seed: number,
  difficulty: CommanderDifficulty = "normal",
  now = 0,
  profile: CommanderProfile = "tactical",
): AiCommanderState {
  const cadence = createRandom(seed);
  return {
    team, difficulty, profile, seed: seed >>> 0, cadence,
    decisions: createRandom(seed ^ 0x9e3779b9),
    perception: createRandom(seed ^ 0x85ebca6b),
    acknowledgements: createRandom(seed ^ 0xc2b2ae35),
    nextOrderAt: now + 2 + 2 * nextRandom(cadence),
    sequence: 0, contacts: {}, deployed: [], assignments: {}, pending: null,
    ticks: [], orders: [],
  };
}

export function setCommander(
  world: WorldState,
  team: TeamId,
  difficulty: Opponent,
  seed = world.rngSeed,
  profile: CommanderProfile = "tactical",
): void {
  world.commanders ??= {};
  if (difficulty === "off") delete world.commanders[team];
  else world.commanders[team] = createCommander(team, seed, difficulty, world.time, profile);
}

function observe(world: WorldState, state: AiCommanderState): void {
  const fresh = new Set<string>();
  for (const contact of beliefFor(world, state.team).contacts) {
    if (!contact.observed || world.time - contact.seenAt > 1e-6) continue;
    fresh.add(contact.enemyId);
    const previous = state.contacts[contact.enemyId];
    if (!previous?.visible) {
      state.contacts[contact.enemyId] = {
        contact: structuredClone(contact), since: world.time,
        readyAt: world.time + 0.3 + 0.5 * nextRandom(state.perception), visible: true,
      };
    } else previous.contact = structuredClone(contact);
  }
  for (const [id, contact] of Object.entries(state.contacts)) {
    contact.visible = fresh.has(id);
    if (world.time - contact.contact.seenAt > CONFIG.ai.beliefTtlSec) delete state.contacts[id];
  }
}

function perceivedTank(contact: TeamContact): Tank {
  const observed = contact.observed!;
  return {
    ...observed, id: contact.enemyId, x: contact.x, y: contact.y,
    alive: true, cooldown: 0, nukeCooldown: 0, ...goalState({ kind: "idle", source: "system" }),
    standStillTimer: 0, reportProgress: 0, debugProgress: 0,
    debugTargetId: null, lastKnownPos: { x: contact.x, y: contact.y },
    isCodeCarrier: false, lastShotAt: -999,
  };
}

// The resolver and normal bot brain receive snapshots, never hidden live enemy objects.
export function commanderView(world: WorldState, state: AiCommanderState): WorldState {
  const friends = world.tanks.filter((tank) => tank.team === state.team);
  const contacts = Object.values(state.contacts)
    .filter((c) => c.visible && world.time >= c.readyAt)
    .map((c) => c.contact);
  const leader = friends.find((tank) => tank.alive);
  return {
    ...world,
    tanks: [...friends, ...contacts.map(perceivedTank)],
    controlledId: state.team === "blue" && !isBaseWar(world.gameMode) ? (leader?.id ?? world.controlledId) : world.controlledId,
    remoteControlledId: state.team === "red" ? (leader?.id ?? null) : world.remoteControlledId,
    teamBelief: { contacts },
    redTeamBelief: { contacts },
  };
}

function ended(tank: Tank, state: AiCommanderState, enemies: Tank[]): boolean {
  const assignment = state.assignments[tank.id];
  const stack = stackFor(tank);
  const goal = stack.base;
  if (!assignment || goal.issuer !== "ai_commander") return true;
  if (!["active", "interrupted"].includes(stack.status)) return true;
  if (stack.interrupt) return false;
  if (goal.kind !== assignment.kind) return true;
  if (goal.kind === "idle" || goal.kind === "holdPosition") return true;
  const target = goal.params?.targetTankId;
  if (goal.kind === "attackNearest" && target && !enemies.some((e) => e.id === target)) return true;
  if (goal.kind === "moveTo") {
    return dist(tank.x, tank.y, goal.params?.x ?? tank.x, goal.params?.y ?? tank.y) <=
      (goal.params?.exact ? 8 : CONFIG.ai.holdRadius);
  }
  return false;
}

interface Decision {
  intent: CommandIntent;
  reason: string;
  marker?: Vec2;
  score: number;
}

function center(tanks: Tank[]): Vec2 {
  return {
    x: tanks.reduce((sum, t) => sum + t.x, 0) / tanks.length,
    y: tanks.reduce((sum, t) => sum + t.y, 0) / tanks.length,
  };
}

function decideBaseWar(world: WorldState, state: AiCommanderState, enemyCount: number): Decision | null {
  const friends = world.tanks.filter((t) => t.team === state.team && t.alive &&
    (state.team === "blue" && world.controlledId ? t.id !== world.controlledId : t.number !== 6));
  const enemies = world.tanks.filter((t) => t.team !== state.team && t.alive);
  const ready = friends.filter((t) => {
    const assignment = state.assignments[t.id];
    if (!assignment || world.time - assignment.at >= 5) return true;
    if (t.goal.kind === "holdPosition" && assignment.kind === "holdPosition") return false;
    return ended(t, state, enemies);
  }).sort((a, b) => (state.assignments[a.id]?.at ?? -999) - (state.assignments[b.id]?.at ?? -999) || a.number - b.number);
  if (!ready.length) return null;
  const home = world.bases![state.team];
  const enemy = world.bases![state.team === "blue" ? "red" : "blue"];
  const random = () => nextRandom(state.decisions);
  const quality = QUALITY[state.difficulty];
  const order = (tool: "attack_base" | "defend_base", tanks: Tank[], reason: string, score: number): Decision => ({
    intent: { tool, tank_ids: tanks.map((t) => t.number) }, reason, score,
  });
  const unopened = ready.filter((t) => !state.deployed.includes(t.number));
  if (unopened.length) {
    return state.deployed.length === 0
      ? order("attack_base", unopened.slice(0, 3), "base_open_attackers", 200)
      : order("defend_base", unopened.slice(0, 2), "base_open_defenders", 200);
  }
  const group = ready.slice(0, 1 + Math.floor(random() * 3));
  if (random() < quality.waste) return order("defend_base", group.slice(0, 1), "wasted_hold", 0);
  const mass = ready.length === friends.length ? ready : group;
  const candidates = [order("attack_base", group, "base_advance", 50)];
  if (home.hp / home.maxHp <= 0.3) candidates.push(order("defend_base", mass, "base_all_defend", 300));
  if (enemy.hp / enemy.maxHp <= 0.35 || world.tanks.filter((t) => t.team === state.team && t.alive).length > enemyCount) {
    candidates.push(order("attack_base", mass, "base_all_in", 160));
  }
  const attacked = world.time - home.lastDamagedAt < 8;
  const intruders = enemies.filter((t) => dist(t.x, t.y, home.x + home.w / 2, home.y + home.h / 2) < 320);
  if (attacked) {
    candidates.push(order("defend_base", group, "base_recall", 140));
    if (intruders.length) {
      const target = intruders.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.number - b.number)[0]!;
      candidates.push({ intent: { tool: "attack", tank_ids: group.map((t) => t.number), target_id: target.number }, reason: "base_intercept", score: 180 });
    }
  }
  if (enemies.length && random() < quality.focus) {
    const origin = center(group);
    const weakest = random() < quality.weakest;
    const target = [...enemies].sort((a, b) =>
      (weakest ? a.hp / a.maxHp - b.hp / b.maxHp : 0) ||
      dist(a.x, a.y, origin.x, origin.y) - dist(b.x, b.y, origin.x, origin.y) || a.number - b.number)[0]!;
    candidates.push({ intent: { tool: "attack", tank_ids: group.map((t) => t.number), target_id: target.number },
      reason: weakest ? "focus_fire_weakest" : "focus_fire_nearest", score: 90 });
  }
  if (ready.length >= 2 && random() < quality.flank) {
    const sign = state.team === "blue" ? 1 : -1;
    const marker = freePointNear({
      x: CONFIG.canvasWidth * (state.team === "blue" ? 0.22 : 0.78),
      y: enemy.y + enemy.h / 2 + sign * 180,
    }, world.walls);
    candidates.push({ intent: { tool: "move_to", tank_ids: ready.slice(0, 2).map((t) => t.number), ref: { type: "marker" } },
      marker, reason: "base_flank_alternate", score: 80 });
  }
  if (ready.length === friends.length && random() < 0.08) candidates.push(order("attack_base", ready, "base_everyone_push", 100));
  for (const candidate of candidates) candidate.score += random() * quality.noise;
  return candidates.sort((a, b) => b.score - a.score)[0]!;
}

/**
 * Lane targets read off the arena's named zones: a staging anchor in our half
 * per lane, and the mirrored anchor the lane is meant to reach. Band maps
 * carry no zones, so callers keep the fractional model there.
 */
interface LanePlan {
  staging: Vec2[];
  push: Vec2[];
  advance: (lane: number, from: Vec2, commit: boolean) => Vec2;
}

function lanePlan(world: WorldState, team: TeamId): LanePlan | null {
  if (!world.zones.length) return null;
  const base = (t: TeamId): Vec2 => {
    const b = spawnBounds(world.arenaId, t);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  };
  const own = base(team);
  const foe = base(team === "blue" ? "red" : "blue");
  const len = Math.max(1, dist(own.x, own.y, foe.x, foe.y));
  const dir = { x: (foe.x - own.x) / len, y: (foe.y - own.y) / len };
  const perp = { x: -dir.y, y: dir.x };
  const laneAim = (reach: number, side: number): Vec2 => ({
    x: own.x + dir.x * len * reach + perp.x * (side - 1) * len * 0.26,
    y: own.y + dir.y * len * reach + perp.y * (side - 1) * len * 0.26,
  });
  const ours = world.zones.filter((z) => {
    const dOwn = dist(z.x, z.y, own.x, own.y);
    return dOwn <= dist(z.x, z.y, foe.x, foe.y) && dOwn > len * 0.2;
  });
  const chosen: (ArenaZone | null)[] = [null, null, null];
  const pool = [...ours];
  for (const lane of [0, 2, 1]) {
    if (!pool.length) break;
    const aim = laneAim(0.45, lane);
    let at = 0;
    let best = Infinity;
    pool.forEach((z, i) => {
      const d = dist(z.x, z.y, aim.x, aim.y);
      if (d < best) {
        best = d;
        at = i;
      }
    });
    chosen[lane] = pool.splice(at, 1)[0]!;
  }
  const mirrorOf = (z: ArenaZone): Vec2 => {
    const m = world.zones.find((o) => o.id === z.mirrorOf && o.id !== z.id);
    return m ? { x: m.x, y: m.y } : foe;
  };
  const staging: Vec2[] = [];
  const push: Vec2[] = [];
  for (let lane = 0; lane < 3; lane++) {
    const z = chosen[lane];
    if (z) {
      staging.push({ x: z.x, y: z.y });
      push.push(mirrorOf(z));
    } else {
      staging.push(laneAim(0.45, lane));
      push.push(laneAim(0.85, lane));
    }
  }
  const routes = staging.map((s, lane) => {
    const pts = [s, push[lane]!, foe];
    const legs: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = dist(pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y);
      legs.push(d);
      total += d;
    }
    return { pts, legs, total: Math.max(1, total) };
  });
  type Route = (typeof routes)[number];
  const at = (r: Route, u: number): Vec2 => {
    let rem = Math.max(0, Math.min(1, u)) * r.total;
    for (let i = 0; i < r.legs.length; i++) {
      const L = Math.max(1, r.legs[i]!);
      if (rem <= L) {
        const a = r.pts[i]!, b = r.pts[i + 1]!;
        return { x: a.x + (b.x - a.x) * (rem / L), y: a.y + (b.y - a.y) * (rem / L) };
      }
      rem -= L;
    }
    return { ...foe };
  };
  /** How far along the lane the group already is, as 0..1 of the route length. */
  const along = (r: Route, from: Vec2): number => {
    let best = Infinity;
    let found = 0;
    let acc = 0;
    for (let i = 0; i < r.legs.length; i++) {
      const L = Math.max(1, r.legs[i]!);
      const a = r.pts[i]!, b = r.pts[i + 1]!;
      const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
      const step = Math.max(0, Math.min(L, (from.x - a.x) * ux + (from.y - a.y) * uy));
      const qx = a.x + ux * step - from.x;
      const qy = a.y + uy * step - from.y;
      const d = qx * qx + qy * qy;
      if (d < best) {
        best = d;
        found = (acc + step) / r.total;
      }
      acc += L;
    }
    return found;
  };
  return {
    staging,
    push,
    advance: (lane, from, commit) => {
      const r = routes[lane % 3]!;
      if (commit) return r.pts[1]!;
      return at(r, along(r, from) + 0.17);
    },
  };
}

function decide(world: WorldState, state: AiCommanderState, enemyCount: number): Decision | null {
  if (isBaseWar(world.gameMode)) return decideBaseWar(world, state, enemyCount);
  const friends = world.tanks.filter((t) => t.team === state.team && t.alive);
  if (!friends.length) return null;
  const enemies = world.tanks.filter((t) => t.team !== state.team);
  const ready = friends.filter((t) => ended(t, state, enemies) ||
    world.time - state.assignments[t.id]!.at >= 5);
  if (!ready.length) return null;
  const priority = (tank: Tank) =>
    (ended(tank, state, enemies) ? 100 : 0) + Math.min(30, world.time - (state.assignments[tank.id]?.at ?? -30));
  ready.sort((a, b) => priority(b) - priority(a) || a.number - b.number);
  const quality = QUALITY[state.difficulty];
  const random = () => nextRandom(state.decisions);
  const facing = state.team === "blue" ? -1 : 1;
  const homeFacingPoint = (x: number, progress: number): Vec2 => ({
    x: state.team === "blue" ? x : CONFIG.canvasWidth - x,
    y: CONFIG.canvasHeight * (state.team === "blue" ? 1 - progress : progress),
  });
  const move = (tanks: Tank[], marker: Vec2, reason: string, score: number): Decision => ({
    intent: { tool: "move_to", tank_ids: tanks.map((t) => t.number), ref: { type: "marker" } },
    marker: freePointNear(marker, world.walls), reason, score,
  });
  const unopened = ready.filter((t) => !state.deployed.includes(t.number));
  if (unopened.length) {
    const pair = unopened.slice(0, 2);
    const lane = Math.floor((pair[0]!.number - 1) / 2);
    const zones = lanePlan(world, state.team);
    return move(
      pair,
      zones
        ? zones.staging[lane % 3]!
        : homeFacingPoint(CONFIG.canvasWidth * (0.22 + (lane % 3) * 0.28), 0.42),
      "open_lane",
      200,
    );
  }
  const group = ready.slice(0, 2 + (random() < 0.5 ? 1 : 0));
  if (random() < quality.waste) {
    return move(group.slice(0, 1), group[0]!, "wasted_hold", 0);
  }
  const candidates: Decision[] = [];
  const centroid = center(friends);
  const groupCenter = center(group);
  candidates.push(move(group, groupCenter, "hold_angle", enemies.length ? 18 : 12));
  const lost = Object.values(state.contacts).some((c) => !c.visible);
  const nearbyFoes = enemies.filter((e) => dist(e.x, e.y, groupCenter.x, groupCenter.y) < 330);
  const support = friends.filter((t) => dist(t.x, t.y, groupCenter.x, groupCenter.y) < 300);
  if (lost || nearbyFoes.length > support.length) {
    candidates.push(move(group, { x: centroid.x, y: centroid.y - facing * 70 }, "regroup",
      nearbyFoes.length > support.length ? 125 : 65));
  }
  if (enemies.length) {
    const weakest = random() < quality.weakest;
    const ranked = [...enemies].sort((a, b) =>
      (weakest ? a.hp / a.maxHp - b.hp / b.maxHp : 0) ||
      dist(a.x, a.y, groupCenter.x, groupCenter.y) - dist(b.x, b.y, groupCenter.x, groupCenter.y) ||
      a.number - b.number);
    const target = ranked[0]!;
    if (random() < quality.focus) {
      const attackers = [...ready].sort((a, b) =>
        priority(b) - priority(a) || dist(a.x, a.y, target.x, target.y) - dist(b.x, b.y, target.x, target.y))
        .slice(0, group.length);
      candidates.push({
        intent: { tool: "attack", tank_ids: attackers.map((t) => t.number), target_id: target.number },
        reason: weakest ? "focus_fire_weakest" : "focus_fire_nearest", score: 95,
      });
    }
    if (ready.length >= 2 && random() < quality.flank) {
      const side = (groupCenter.x < target.x) === (state.team === "blue") ? "right" : "left";
      candidates.push({
        intent: { tool: "flank", tank_ids: group.slice(0, 2).map((t) => t.number), reference_id: target.number, side },
        reason: "flank_alternate", score: friends.filter((t) =>
          t.goal.kind === "attackNearest" && t.goal.params?.targetTankId === target.id).length >= 2 ? 110 : 88,
      });
    }
    const leader = friends[0]!;
    const guards = ready.filter((t) => t.id !== leader.id).slice(0, 2);
    if (guards.length) candidates.push({
      intent: { tool: "cover", tank_ids: guards.map((t) => t.number), protect: "player" },
      reason: "cover", score: leader.hp / leader.maxHp < 0.5 ? 110 : 40,
    });
    candidates[0]!.score += 30;
  } else {
    const everyone = ready.length === friends.length && friends.length > 3 && random() < 0.08;
    const movers = everyone ? ready : group;
    const lane = Math.floor((group[0]!.number - 1) / 2) % 3;
    const zones = lanePlan(world, state.team);
    const target = zones
      ? zones.advance(everyone ? 0 : lane, groupCenter, everyone)
      : (() => {
          const localX = state.team === "blue" ? centroid.x : CONFIG.canvasWidth - centroid.x;
          const laneX = everyone
            ? CONFIG.canvasWidth * 0.22
            : CONFIG.canvasWidth * (0.22 + lane * 0.28);
          const progress = state.team === "blue"
            ? 1 - groupCenter.y / CONFIG.canvasHeight
            : groupCenter.y / CONFIG.canvasHeight;
          return homeFacingPoint(everyone ? laneX : (laneX + localX) / 2,
            Math.min(0.85, progress + 0.17));
        })();
    candidates.push(move(movers, target, everyone ? "everyone_push_left" : "advance_lane", lost ? 42 : 60));
  }
  for (const candidate of candidates) candidate.score += random() * quality.noise;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!;
}

/**
 * Bells-of-the-arena fallback: with no base to storm or guard, the objective
 * is the enemy spawn box centre, which is where their home strip sits.
 */
function spawnCenter(world: WorldState, team: TeamId): Vec2 {
  const b = spawnBounds(world.arenaId, team);
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

/** The bots this commander owns. Base War leaves the spare hull out, as the tactical profile does. */
function commandedBots(world: WorldState, state: AiCommanderState): Tank[] {
  if (!isBaseWar(world.gameMode)) return world.tanks.filter((t) => t.team === state.team && t.alive);
  return world.tanks.filter((t) => t.team === state.team && t.alive &&
    (state.team === "blue" && world.controlledId ? t.id !== world.controlledId : t.number !== 6));
}

/**
 * Fixed-doctrine readiness: an unfinished order or a hold this commander put
 * there is not re-issued, so a rusher keeps driving and a turtle stays put.
 * Everything else follows the same `ended` rules as the tactical profile.
 */
function readyBots(world: WorldState, state: AiCommanderState, enemies: Tank[]): Tank[] {
  return commandedBots(world, state).filter((tank) => {
    const assignment = state.assignments[tank.id];
    if (!assignment) return true;
    if (tank.goal.kind === "holdPosition" && assignment.kind === "holdPosition") return false;
    return ended(tank, state, enemies) || world.time - assignment.at >= 5;
  });
}

/** Every living bot drives at the enemy base and stays on it. No lanes, no regrouping. */
function decideRusher(world: WorldState, state: AiCommanderState): Decision | null {
  const enemies = world.tanks.filter((t) => t.team !== state.team && t.alive);
  const ready = readyBots(world, state, enemies);
  if (!ready.length) return null;
  const tank_ids = ready.map((t) => t.number);
  const foeBase = world.bases?.[state.team === "blue" ? "red" : "blue"];
  if (foeBase?.alive) {
    return { intent: { tool: "attack_base", tank_ids }, reason: "rusher_all_in", score: 200 };
  }
  return {
    intent: { tool: "move_to", tank_ids, ref: { type: "marker" } },
    marker: freePointNear(spawnCenter(world, state.team === "blue" ? "red" : "blue"), world.walls),
    reason: "rusher_all_in",
    score: 200,
  };
}

/** Every living bot holds at its own base. This profile never issues an attack intent. */
function decideTurtle(world: WorldState, state: AiCommanderState): Decision | null {
  const ownBase = world.bases?.[state.team];
  if (!ownBase?.alive) return null;
  const enemies = world.tanks.filter((t) => t.team !== state.team && t.alive);
  const ready = readyBots(world, state, enemies);
  if (!ready.length) return null;
  return {
    intent: { tool: "defend_base", tank_ids: ready.map((t) => t.number) },
    reason: "turtle_garrison",
    score: 200,
  };
}

function decideByProfile(world: WorldState, state: AiCommanderState, enemyCount: number): Decision | null {
  switch (state.profile) {
    case "rusher": return decideRusher(world, state);
    case "turtle": return decideTurtle(world, state);
    default: return decide(world, state, enemyCount);
  }
}

export function updateCommander(world: WorldState, state: AiCommanderState): void {
  if (world.outcome !== "playing") return;
  observe(world, state);
  if (state.pending && world.time + 1e-9 >= state.pending.executeAt) {
    const pending = state.pending;
    state.pending = null;
    const view = commanderView(world, state);
    if (pending.marker) view.playerMarks = { ...world.playerMarks, [state.team]: pending.marker };
    void sendOrder(world, pending.record.raw_text, {}, state.team, { ...pending, view });
    state.orders.push(pending.record);
    for (const id of pending.record.tanks ?? []) {
      const tank = world.tanks.find((t) => t.id === id)!;
      state.assignments[id] = { at: world.time, kind: stackFor(tank).base.kind };
    }
  }
  if (world.time + 1e-9 < state.nextOrderAt) return;
  const at = state.nextOrderAt;
  state.nextOrderAt += 2 + 2 * nextRandom(state.cadence);
  const view = commanderView(world, state);
  const decision = decideByProfile(view, state, world.tanks.filter((t) => t.team !== state.team && t.alive).length);
  if (!decision) {
    state.ticks.push({ at, skipped: view.tanks.some((t) => t.team === state.team && t.alive) ? "busy" : "no_tanks" });
    return;
  }
  state.ticks.push({ at });
  state.sequence++;
  const record = scriptedCommandRecord(state.team, decision.intent, decision.reason, at, state.seed, state.sequence);
  const executeAt = at + 0.3 + 0.5 * nextRandom(state.acknowledgements);
  state.pending = { record, executeAt, marker: decision.marker };
  if (decision.reason === "open_lane" || decision.reason.startsWith("base_open_")) state.deployed.push(...decision.intent.tank_ids);
}
