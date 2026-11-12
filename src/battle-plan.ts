/**
 * One utterance, one battle plan.
 *
 * "Take the left, I'll take the right" is a single lane split. The speaker's
 * lane is reserved and given to nobody. Addressed tanks share the other lane,
 * spread from where the friendlies and enemies already are. A later order
 * rewrites only the tanks it names.
 *
 * The order parser should call `battleIntentsFromUtterance` and pass the
 * result to `applyBattlePlan`. This module does not parse attacks, marks,
 * or routes.
 */
import { circleHitsWall, dist } from "./arena";
import { CONFIG } from "./config";
import { assignOrder } from "./interrupt-stack";
import type { Tank, TeamId, Wall, WorldState } from "./types";

export type FlankSide = "left" | "right";
export type RouteRisk = "normal" | "stealth";

/** What a moveTo goal carries after a flank plan is applied. */
export interface MoveGoalParams {
  x: number;
  y: number;
  side: FlankSide;
  risk: RouteRisk;
}

/**
 * One clause, before lanes are assigned. Hull numbers only — the speaker
 * is never an addressee. The order parser can build these itself or call
 * `battleIntentsFromUtterance`.
 */
export interface BattleIntent {
  tankNumbers: number[];
  /** Lane the speaker claimed. Reserved, assigned to nobody. */
  speakerSide: FlankSide | null;
  /** Side spoken for the addressed tanks, before complement is applied. */
  namedSide: FlankSide | null;
  goal: "moveTo" | "holdPosition";
  risk: RouteRisk;
}

export interface LaneAssignment {
  tankId: string;
  side: FlankSide;
  risk: RouteRisk;
  x: number;
  y: number;
}

export interface HoldAssignment {
  tankId: string;
  x: number;
  y: number;
}

/** The lane split for a single utterance. */
export interface BattlePlan {
  utterance: string;
  facing: number;
  /** Speaker lane. Null when the speaker did not claim a side. */
  reservedSide: FlankSide | null;
  /** Free tile on the reserved lane. Not written onto any tank. */
  reservedAnchor: { x: number; y: number } | null;
  assignments: LaneAssignment[];
  holds: HoldAssignment[];
  /** Tanks this utterance names. Everyone else keeps their current goal. */
  addressedIds: string[];
}

const SPOKEN: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
};

const AHEAD = 168;
const LATERAL = 160;
const AHEAD_MIN = 120;
const AHEAD_MAX = 220;
const SIDE_CLEARANCE = 48;
const SEARCH_RING = 24;

/** Pure: radio text → clause intents. No world, no goals. */
export function battleIntentsFromUtterance(utterance: string): BattleIntent[] {
  const text = utterance.replace(
    /\b(one|two|three|four|five|six)\b/gi,
    (word) => SPOKEN[word.toLowerCase()] ?? word,
  );
  const risk = routeRisk(text);
  const drafts = splitClauses(text)
    .map((clause) => parseClause(clause, risk))
    .filter((d): d is BattleIntent => d != null);
  const speakerSide = drafts.find((d) => d.speakerSide)?.speakerSide ?? null;
  return drafts.filter((d) => {
    if (d.speakerSide) return true;
    if (d.goal === "holdPosition") return true;
    if (d.namedSide) return true;
    return speakerSide != null && d.goal === "moveTo" && d.tankNumbers.length > 0;
  });
}

/**
 * Write this utterance's goals. Tanks the utterance does not name keep
 * the goal they already have, including an earlier flank.
 */
export function applyBattlePlan(
  world: WorldState,
  utterance: string,
  intents: BattleIntent[],
): BattlePlan {
  const resolved = intents.length > 0 ? intents : battleIntentsFromUtterance(utterance);
  const plan = buildBattlePlan(world, utterance, resolved);
  commitBattlePlan(world, plan);
  return plan;
}

export function buildBattlePlan(
  world: WorldState,
  utterance: string,
  intents: BattleIntent[],
): BattlePlan {
  const commander = commanderOf(world);
  const empty: BattlePlan = {
    utterance,
    facing: commander?.angle ?? 0,
    reservedSide: null,
    reservedAnchor: null,
    assignments: [],
    holds: [],
    addressedIds: [],
  };
  if (!commander) return empty;

  const team = commander.team;
  const facing = commander.angle;
  const friends = living(world, team);
  const enemies = living(world, team === "blue" ? "red" : "blue");
  const cluster = centroid(enemies);
  let reservedSide: FlankSide | null = null;
  for (const intent of intents) {
    if (intent.speakerSide) reservedSide = intent.speakerSide;
  }

  type Action =
    | { kind: "move"; side: FlankSide; risk: RouteRisk }
    | { kind: "hold" };
  const actions = new Map<string, Action>();
  for (const intent of intents) {
    if (intent.goal === "holdPosition") {
      for (const tank of tanksByNumber(friends, intent.tankNumbers)) {
        actions.set(tank.id, { kind: "hold" });
      }
      continue;
    }
    const side = reservedSide ? complement(reservedSide) : intent.namedSide;
    if (!side || side === reservedSide) continue;
    for (const tank of tanksByNumber(friends, intent.tankNumbers)) {
      actions.set(tank.id, { kind: "move", side, risk: intent.risk });
    }
  }

  const occupied: { x: number; y: number }[] = [];
  for (const tank of enemies) occupied.push({ x: tank.x, y: tank.y });
  occupied.push({ x: commander.x, y: commander.y });
  for (const tank of friends) {
    if (!actions.has(tank.id)) occupied.push({ x: tank.x, y: tank.y });
  }

  const reservedAnchor = reservedSide
    ? placeAnchor(world, commander, facing, reservedSide, cluster, 0, occupied)
    : null;
  if (reservedAnchor) occupied.push(reservedAnchor);

  const movers = friends
    .filter((tank) => actions.get(tank.id)?.kind === "move")
    .sort(
      (a, b) =>
        forwardOf(commander, facing, a) - forwardOf(commander, facing, b),
    );

  const bySide = new Map<FlankSide, Tank[]>();
  for (const tank of movers) {
    const action = actions.get(tank.id);
    if (!action || action.kind !== "move") continue;
    const group = bySide.get(action.side) ?? [];
    group.push(tank);
    bySide.set(action.side, group);
  }

  const assignments: LaneAssignment[] = [];
  for (const [side, group] of bySide) {
    const spacing = CONFIG.ai.formationSpacing;
    group.forEach((tank, index) => {
      const action = actions.get(tank.id);
      if (!action || action.kind !== "move") return;
      const along = (index - (group.length - 1) / 2) * spacing;
      const anchor = placeAnchor(
        world,
        commander,
        facing,
        side,
        cluster,
        along,
        occupied,
      );
      if (!anchor) return;
      occupied.push(anchor);
      assignments.push({
        tankId: tank.id,
        side,
        risk: action.risk,
        x: anchor.x,
        y: anchor.y,
      });
    });
  }

  const holds: HoldAssignment[] = [];
  for (const tank of friends) {
    if (actions.get(tank.id)?.kind !== "hold") continue;
    holds.push({ tankId: tank.id, x: tank.x, y: tank.y });
  }

  const addressedIds = [
    ...assignments.map((a) => a.tankId),
    ...holds.map((h) => h.tankId),
  ];
  return {
    utterance,
    facing,
    reservedSide,
    reservedAnchor,
    assignments,
    holds,
    addressedIds,
  };
}

function commitBattlePlan(world: WorldState, plan: BattlePlan): void {
  const byId = new Map(world.tanks.map((tank) => [tank.id, tank]));
  for (const assignment of plan.assignments) {
    const tank = byId.get(assignment.tankId);
    if (!tank || !tank.alive) continue;
    const params: MoveGoalParams = {
      x: assignment.x,
      y: assignment.y,
      side: assignment.side,
      risk: assignment.risk,
    };
    assignOrder(world, tank, {
      kind: "moveTo",
      source: "player",
      params,
    });
    tank.lastOrderChat = `#${tank.number}: taking the ${assignment.side}.`;
  }
  for (const hold of plan.holds) {
    const tank = byId.get(hold.tankId);
    if (!tank || !tank.alive) continue;
    assignOrder(world, tank, {
      kind: "holdPosition",
      source: "player",
      params: { x: hold.x, y: hold.y },
    });
    tank.lastOrderChat = `#${tank.number}: holding.`;
  }
}

function placeAnchor(
  world: WorldState,
  commander: Tank,
  facing: number,
  side: FlankSide,
  cluster: { x: number; y: number } | null,
  along: number,
  occupied: { x: number; y: number }[],
): { x: number; y: number } | null {
  const ideal = lanePoint(commander, facing, side, cluster, along);
  return nearestFreeTile(world.walls, ideal, commander, facing, side, occupied);
}

/** Ahead toward the enemy cluster, then off to one side of the hull. */
function lanePoint(
  commander: Tank,
  facing: number,
  side: FlankSide,
  cluster: { x: number; y: number } | null,
  along: number,
): { x: number; y: number } {
  const sign = side === "right" ? 1 : -1;
  const fx = Math.cos(facing);
  const fy = Math.sin(facing);
  const rx = -Math.sin(facing);
  const ry = Math.cos(facing);
  let ahead = AHEAD;
  let lateral = LATERAL;
  if (cluster) {
    const ep = frameOf(commander, facing, cluster);
    ahead = Math.max(
      AHEAD_MIN,
      Math.min(AHEAD_MAX, AHEAD + ep.forward * 0.15),
    );
    if (ep.lateral * sign > 0) {
      const room = Math.abs(ep.lateral) - CONFIG.tankRadius * 4;
      if (room > 72) lateral = Math.min(lateral, room);
    }
  }
  const depth = ahead + along;
  return {
    x: commander.x + fx * depth + rx * lateral * sign,
    y: commander.y + fy * depth + ry * lateral * sign,
  };
}

function nearestFreeTile(
  walls: Wall[],
  ideal: { x: number; y: number },
  commander: Tank,
  facing: number,
  side: FlankSide,
  occupied: { x: number; y: number }[],
): { x: number; y: number } | null {
  const origin = tileOf(ideal.x, ideal.y);
  const body = CONFIG.tankRadius * 2 + 8;
  let best: { x: number; y: number; d: number } | null = null;
  for (let dy = -SEARCH_RING; dy <= SEARCH_RING; dy++) {
    for (let dx = -SEARCH_RING; dx <= SEARCH_RING; dx++) {
      const col = origin.col + dx;
      const row = origin.row + dy;
      if (!tileFree(col, row, walls)) continue;
      const p = tileCenter(col, row);
      const lateral = lateralOf(commander, facing, p);
      if (side === "left" && lateral > -SIDE_CLEARANCE) continue;
      if (side === "right" && lateral < SIDE_CLEARANCE) continue;
      if (occupied.some((o) => dist(o.x, o.y, p.x, p.y) < body)) continue;
      const d = dist(p.x, p.y, ideal.x, ideal.y);
      if (!best || d < best.d) best = { x: p.x, y: p.y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

function tileFree(col: number, row: number, walls: Wall[]): boolean {
  const tile = CONFIG.tileSize;
  const pad = CONFIG.arenaPadding + CONFIG.tankRadius;
  const p = tileCenter(col, row);
  if (p.x < pad || p.y < pad) return false;
  if (p.x > CONFIG.canvasWidth - pad || p.y > CONFIG.canvasHeight - pad) return false;
  const x = col * tile;
  const y = row * tile;
  for (const wall of walls) {
    const overlaps =
      x < wall.x + wall.w &&
      x + tile > wall.x &&
      y < wall.y + wall.h &&
      y + tile > wall.y;
    if (overlaps) return false;
    const cx = wall.x + wall.w / 2;
    const cy = wall.y + wall.h / 2;
    if (Math.abs(p.x - cx) < 0.75 && Math.abs(p.y - cy) < 0.75) return false;
  }
  if (circleHitsWall(p.x, p.y, CONFIG.tankRadius, walls)) return false;
  return true;
}

function tileOf(x: number, y: number): { col: number; row: number } {
  const tile = CONFIG.tileSize;
  return { col: Math.floor(x / tile), row: Math.floor(y / tile) };
}

function tileCenter(col: number, row: number): { x: number; y: number } {
  const tile = CONFIG.tileSize;
  return { x: col * tile + tile / 2, y: row * tile + tile / 2 };
}

function frameOf(
  origin: { x: number; y: number },
  facing: number,
  point: { x: number; y: number },
): { forward: number; lateral: number } {
  return {
    forward: forwardOf(origin, facing, point),
    lateral: lateralOf(origin, facing, point),
  };
}

function forwardOf(
  origin: { x: number; y: number },
  facing: number,
  point: { x: number; y: number },
): number {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return dx * Math.cos(facing) + dy * Math.sin(facing);
}

function lateralOf(
  origin: { x: number; y: number },
  facing: number,
  point: { x: number; y: number },
): number {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return dx * -Math.sin(facing) + dy * Math.cos(facing);
}

function complement(side: FlankSide): FlankSide {
  return side === "left" ? "right" : "left";
}

function commanderOf(world: WorldState): Tank | null {
  return (
    world.tanks.find((tank) => tank.alive && tank.id === world.controlledId) ??
    null
  );
}

function living(world: WorldState, team: TeamId): Tank[] {
  return world.tanks.filter((tank) => tank.alive && tank.team === team);
}

function centroid(tanks: Tank[]): { x: number; y: number } | null {
  if (!tanks.length) return null;
  let x = 0;
  let y = 0;
  for (const tank of tanks) {
    x += tank.x;
    y += tank.y;
  }
  return { x: x / tanks.length, y: y / tanks.length };
}

function tanksByNumber(tanks: Tank[], numbers: number[]): Tank[] {
  const out: Tank[] = [];
  for (const n of numbers) {
    const tank = tanks.find((t) => t.number === n);
    if (tank && !out.includes(tank)) out.push(tank);
  }
  return out;
}

function routeRisk(text: string): RouteRisk {
  return /\b(stealth(?:ily)?|sneak(?:ily)?|covert(?:ly)?)\b/i.test(text)
    ? "stealth"
    : "normal";
}

function splitClauses(text: string): string[] {
  const pieces = text
    .split(/\s*(?:,|;|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const clauses: string[] = [];
  let pending = "";
  for (const piece of pieces) {
    if (/^(?:tanks?\s+)?#?\d+$/i.test(piece)) {
      pending = pending ? `${pending} and ${piece}` : piece;
      continue;
    }
    clauses.push(pending ? `${pending} and ${piece}` : piece);
    pending = "";
  }
  if (pending) clauses.push(pending);
  return clauses.length ? clauses : [text.trim()];
}

function parseClause(clause: string, risk: RouteRisk): BattleIntent | null {
  const side = relativeSide(clause);
  if (isSpeakerOnly(clause)) {
    if (!side) return null;
    return {
      tankNumbers: [],
      speakerSide: side,
      namedSide: null,
      goal: "moveTo",
      risk,
    };
  }
  const tankNumbers = uniqueNumbers(clause);
  if (!tankNumbers.length) return null;
  if (/\b(hold|stay|wait|defend)\b/i.test(clause)) {
    return {
      tankNumbers,
      speakerSide: null,
      namedSide: null,
      goal: "holdPosition",
      risk,
    };
  }
  const move = /\b(move|go|head|take|flank|advance)\b/i.test(clause);
  if (!move && !side) return null;
  return {
    tankNumbers,
    speakerSide: null,
    namedSide: side,
    goal: "moveTo",
    risk,
  };
}

function isSpeakerOnly(text: string): boolean {
  return (
    /^(?:i|i'll|ill|i will|i'm|im|me)\b/i.test(text.trim()) &&
    !/\b[1-6]\b/.test(text)
  );
}

function relativeSide(text: string): FlankSide | null {
  if (/\b(bottom|top|upper|lower|north|south|east|west)\b/i.test(text)) return null;
  const match = text.match(/\b(?:on\s+the|to\s+the|the|flank)\s+(left|right)\b/i);
  return match ? (match[1]!.toLowerCase() as FlankSide) : null;
}

function uniqueNumbers(text: string): number[] {
  const nums: number[] = [];
  for (const match of text.matchAll(/\b([1-6])\b/g)) {
    const n = Number(match[1]);
    if (!nums.includes(n)) nums.push(n);
  }
  return nums;
}
