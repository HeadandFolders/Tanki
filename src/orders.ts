import { CONFIG, isBaseWar, isMpRules } from "./config";
import { intentsToOrders } from "./command-resolver";
import type { CommandIntent } from "./command-schema";
import { goalKindsForPrompt, isGoalKind } from "./goals";
import type {
  GoalKind,
  InterpretBundle,
  InterpretContext,
  LlmBackend,
  OrderResult,
  Tank,
  TeamId,
  WorldState,
} from "./types";

export type { LlmBackend };
export { GOAL_KINDS, isGoalKind } from "./goals";

/**
 * Radio path: transcript/text → (optional LLM) → goals for bots.
 * Called ONLY on order send / voice final — never every tick.
 */
export async function interpretOrder(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
  ctx: InterpretContext = {},
  team: TeamId = "blue",
): Promise<InterpretBundle> {
  const text = normalizeSpokenNumbers(orderText.trim());
  const t0 = performance.now();
  if (!text) return { results: [], source: "mock", ms: 0 };

  const plan = planUtterance(text, tanks, worldState, team);
  if (plan) {
    const base = ordersFromPlan(plan, tanks, team);
    // Attack plans and the no-key path stay on the keyword result.
    // A move plan may let the model nudge the anchor, not change the goal.
    if (!ctx.apiKey || plan.goal !== "moveTo" || plan.notice) {
      return {
        results: base,
        source: "mock",
        ms: Math.round(performance.now() - t0),
        notice: plan.notice,
      };
    }
    try {
      const llm = await interpretWithLlm(text, tanks, worldState, ctx, team);
      return {
        results: refineMoveAnchors(plan, base, llm, worldState, team),
        source: "llm",
        ms: Math.round(performance.now() - t0),
      };
    } catch (err) {
      const raw = err instanceof Error ? err.message : "LLM error";
      const msg = /401|invalid.?api.?key|incorrect api key/i.test(raw)
        ? `invalid API key (${raw})`
        : raw;
      return {
        results: base,
        source: "mock",
        ms: Math.round(performance.now() - t0),
        llmError: msg,
      };
    }
  }

  const marked = ordersForPlayerMark(text, tanks, worldState, team);
  if (marked) {
    return {
      results: marked.orders,
      source: "mock",
      ms: Math.round(performance.now() - t0),
      notice: marked.notice,
    };
  }

  // Cover / retreat / hold / spread already have a deterministic reading.
  // Do not wait on the LLM for those — "everyone cover me" used to sit on
  // the API for several seconds even though interpretOffline had the answer.
  if (phraseReaderHandles(text)) {
    return {
      results: lockNamedAttack(
        text,
        interpretOffline(text, tanks, worldState, team),
        tanks,
        team,
      ),
      source: "mock",
      ms: Math.round(performance.now() - t0),
    };
  }

  // Both teams: the host interprets with the LLM when a key is present.
  if (ctx.apiKey) {
    try {
      const llm = await interpretWithLlm(text, tanks, worldState, ctx, team);
      if (llm.length) {
        return {
          results: lockNamedAttack(text, llm, tanks, team),
          source: "llm",
          ms: Math.round(performance.now() - t0),
        };
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : "LLM error";
      const msg = /401|invalid.?api.?key|incorrect api key/i.test(raw)
        ? `invalid API key (${raw})`
        : raw;
      const fallback = lockNamedAttack(
        text,
        interpretOffline(text, tanks, worldState, team),
        tanks,
        team,
      );
      return {
        results: fallback,
        source: "mock",
        ms: Math.round(performance.now() - t0),
        llmError: msg,
      };
    }
  }

  return {
    results: lockNamedAttack(
      text,
      interpretOffline(text, tanks, worldState, team),
      tanks,
      team,
    ),
    source: "mock",
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * "3 and 4 attack 2" names allies before the verb and the enemy after it.
 * Drop anyone else so a tank that already has a job is not retasked, and
 * do not treat the enemy number as another friendly addressee.
 */
/** "2 and 3 attack 5" is pure. "2 move south and shoot at will" is not. */
function orderIsPureAttack(text: string): boolean {
  const lower = normalizeSpokenNumbers(text).toLowerCase();
  if (!/\b(attack|engage|hunt)\b/.test(lower)) return false;
  if (
    /\b(move|go|head|take|flank|cover|escort|follow|hold|retreat|south|north|east|west|left|right)\b/.test(
      lower,
    )
  ) {
    return false;
  }
  return true;
}

function lockNamedAttack(
  orderText: string,
  results: OrderResult[],
  tanks: Tank[],
  team: TeamId,
): OrderResult[] {
  // A successful LLM reading of a compound order must not be replaced by attack-only.
  if (!orderIsPureAttack(orderText)) return results;
  const targeted = parseTargetedEnemyAttack(orderText);
  if (!targeted) return results;
  if (!targeted.allyNumbers.length && !targeted.allAllies) return results;
  const allies =
    targeted.allyNumbers.length > 0
      ? friendlies(tanks, team).filter((t) =>
          targeted.allyNumbers.includes(t.number),
        )
      : friendlies(tanks, team);
  if (!allies.length) return results;
  const { params, verb } = attackTargetParams(targeted, tanks, team);
  return allies.map((t) => ({
    tankId: t.id,
    goal: "attackNearest",
    params,
    chatLine: `#${t.number}: ${verb}.`,
  }));
}

const SPOKEN_NUMBERS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
};

/** "two and three attack five" / "4 shoot 2" → digits and an attack verb. */
export function normalizeSpokenNumbers(text: string): string {
  const numbered = text.replace(
    /\b(one|two|three|four|five|six)\b/gi,
    (word) => SPOKEN_NUMBERS[word.toLowerCase()] ?? word,
  );
  return numbered.replace(
    /\b(?:shoot|fire)\s+(?:at\s+)?(?=(?:the\s+)?(?:enemy\s+)?(?:tanks?\s*)?#?[1-6]\b)/gi,
    "attack ",
  );
}

const TANK_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

/** Hull numbers 1–6, with or without a leading "#", or spoken as words. */
function tankNumbersIn(text: string): number[] {
  const nums: number[] = [];
  const re = /(?:#|\b)([1-6])\b|\b(one|two|three|four|five|six)\b/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) nums.push(Number(m[1]));
    else if (m[2]) nums.push(TANK_NUMBER_WORDS[m[2]]!);
  }
  return nums;
}

/**
 * "3 move to the mark" / "tanks #1 and #5 move to the mark".
 * Numbers (or number-words) before the verb are the only addressees.
 */
export function parseMoveToMark(text: string): {
  allyNumbers: number[];
  allAllies: boolean;
} | null {
  const lower = text.toLowerCase();
  if (/\bwreck\b/.test(lower)) return null;
  const verbAt = lower.search(/\b(?:move|go|head|advance|get)\b/);
  if (verbAt < 0) return null;
  const afterVerb = lower.slice(verbAt);
  if (!/\bmark\b/.test(afterVerb)) return null;
  const afterMark = afterVerb.split(/\bmark\b/).slice(1).join(" ");
  if (
    /\b(hold|attack|engage|hunt|retreat|scout|cover|escort|spread|patrol)\b/.test(
      afterMark,
    )
  ) {
    return null;
  }
  const before = lower.slice(0, verbAt);
  const allyNumbers = [...new Set(tankNumbersIn(before))];
  const allAllies = /\b(all|everyone|team|tanks)\b/.test(before);
  return { allyNumbers, allAllies };
}

function ordersForPlayerMark(
  orderText: string,
  tanks: Tank[],
  world: WorldState,
  team: TeamId,
): { orders: OrderResult[]; notice?: string } | null {
  const req = parseMoveToMark(orderText);
  if (!req) return null;
  const mark = world.playerMarks[team];
  if (!mark) {
    return {
      orders: [],
      notice: "No map mark — hold F and click the map.",
    };
  }
  const alive = friendlies(tanks, team);
  let targets: Tank[];
  if (req.allyNumbers.length) {
    targets = alive.filter((t) => req.allyNumbers.includes(t.number));
  } else if (req.allAllies) {
    targets = alive;
  } else {
    const cmd = alive.find((t) => t.id === commanderId(world, team));
    targets = cmd ? [cmd] : alive.slice(0, 1);
  }
  return {
    orders: targets.map((t) => ({
      tankId: t.id,
      goal: "moveTo" as const,
      params: { x: mark.x, y: mark.y, exact: true },
      chatLine: `#${t.number}: ack, moving to the mark.`,
    })),
  };
}

/**
 * Verbs the keyword reader already settles without a best-effort guess.
 * Used so cover/retreat/hold skip Needle and the LLM.
 */
export function phraseReaderHandles(text: string): boolean {
  const lower = normalizeSpokenNumbers(text).toLowerCase();
  if (!lower.trim()) return false;
  if (/\battack\s+(?:(?:the|their|enemy)\s+)*base\b/.test(lower)) return true;
  if (/\b(?:debug|inspect)(?:\s+(?:marked\s+wrecks?|wreck\s+[a-z]))?[.!?]*$/.test(lower)) return true;
  if (
    /\b(escort|cover|protect|follow|guard|retreat|fall\s*back|get\s*out|spread(\s*out)?|fan\s*out|disperse|space\s*out|hold|stay|wait|defend)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}

function friendlies(tanks: Tank[], team: TeamId = "blue"): Tank[] {
  return tanks.filter((t) => t.team === team && t.alive);
}

function foes(tanks: Tank[], team: TeamId): Tank[] {
  return tanks.filter((t) => t.team !== team && t.alive);
}

/** VIP to escort/cover — "me" = commander, or "cover #N" / "escort tank N". */
function resolveEscortVip(
  text: string,
  tanks: Tank[],
  controlledId: string,
  team: TeamId = "blue",
): Tank | undefined {
  const alive = friendlies(tanks, team);
  const lower = text.toLowerCase();
  const controlled = alive.find((t) => t.id === controlledId);

  // "4, cover me" / "follow me" / "guard us" → VIP is the player
  if (
    /\b(me|us|myself|commander)\b/.test(lower) ||
    /\b(cover|follow|protect|guard)\s+me\b/.test(lower)
  ) {
    return controlled;
  }

  // "escort #2" / "cover tank 3" / "protect 1" → that tank is the VIP
  const vipNum = lower.match(
    /\b(?:escort|cover|protect|guard|follow)\s+(?:tank\s*)?#?([1-6])\b/,
  );
  if (vipNum) {
    return alive.find((t) => t.number === Number(vipNum[1])) ?? controlled;
  }

  return controlled;
}

/**
 * "3 and 4 attack 2" / "3, attack enemy tank #2" / "all attack enemy #5".
 * Numbers before the verb are allies. The number after the verb is the enemy,
 * even without the word "enemy" or a "#", so that enemy number is not ordered.
 */
export function parseTargetedEnemyAttack(text: string): {
  allyNumbers: number[];
  enemyNumbers: number[];
  allAllies: boolean;
} | null {
  const lower = text.toLowerCase();
  const attackAt = lower.search(/\b(?:attack|engage|hunt)\b/);
  if (attackAt < 0) return null;
  const after = lower.slice(attackAt);
  const enemyNumbers = [
    ...new Set(
      tankNumbersIn(after.replace(/^(?:attack|engage|hunt)\b/, "")),
    ),
  ];
  if (!enemyNumbers.length) return null;
  const before = lower.slice(0, attackAt);
  const allAllies = /\b(all|everyone|team)\b/.test(before);
  // "#" is not a word character, so \b does not sit in front of "#3".
  // "Tanks #3 and #4" must still name those allies and nobody else.
  const allyNumbers = [...new Set(tankNumbersIn(before))];
  const hasEnemyWord = /\benemy\b/.test(after);
  const hasHash = /#[1-6]/.test(after);
  // "all attack" has no trailing number and stays untargeted. A bare "attack 2"
  // with no named attackers also stays untargeted. "3 and 4 attack 2" does not.
  if (!hasEnemyWord && !hasHash && allyNumbers.length === 0 && !allAllies) {
    return null;
  }
  return { allyNumbers, enemyNumbers, allAllies };
}

function attackTargetParams(
  targeted: { enemyNumbers: number[] },
  tanks: Tank[],
  team: TeamId,
): { params: OrderResult["params"]; verb: string } {
  const ids = targeted.enemyNumbers
    .map(
      (n) => foes(tanks, team).find((t) => t.alive && t.number === n)?.id,
    )
    .filter((id): id is string => id != null);
  const listed = targeted.enemyNumbers.map((n) => `#${n}`).join(" and ");
  if (ids.length > 1) {
    return {
      params: { targetTankId: ids[0], targetTankIds: ids },
      verb: `engaging enemies ${listed}`,
    };
  }
  if (ids.length === 1) {
    return {
      params: { targetTankId: ids[0] },
      verb: `engaging enemy ${listed}`,
    };
  }
  return { params: {}, verb: `hunting enemies ${listed}` };
}

function resolveTargetsWithControl(
  text: string,
  tanks: Tank[],
  controlledId: string,
  team: TeamId = "blue",
): Tank[] {
  const alive = friendlies(tanks, team);
  const lower = text.toLowerCase();

  const targeted = parseTargetedEnemyAttack(text);
  if (targeted) {
    if (targeted.allyNumbers.length) {
      return alive.filter((t) => targeted.allyNumbers.includes(t.number));
    }
    // No addressee (or "all …") → company focus-fire
    return alive;
  }

  if (/\b(all|everyone|team)\b/.test(lower)) return alive;

  const coverVerb = /\b(escort|cover|protect|follow|guard)\b/.test(lower);
  const coverMe = coverVerb && /\b(me|us|myself|commander)\b/.test(lower);
  const vipFromVerb = coverVerb
    ? lower.match(
        /\b(?:escort|cover|protect|guard|follow)\s+(?:tank\s*)?#?([1-6])\b/,
      )
    : null;
  const vipNumber = vipFromVerb ? Number(vipFromVerb[1]) : null;
  const vipId = coverMe
    ? controlledId
    : vipNumber != null
      ? alive.find((t) => t.number === vipNumber)?.id
      : undefined;

  const nums = tankNumbersIn(lower);

  const withoutVip = (list: Tank[]) =>
    vipId ? list.filter((t) => t.id !== vipId) : list;

  if (coverVerb) {
    // Bodyguards = named tanks that are NOT the VIP ("4, cover me" → #4)
    const bodyguardNums = nums.filter((n) => n !== vipNumber);
    if (bodyguardNums.length) {
      return alive.filter((t) => bodyguardNums.includes(t.number));
    }
    // "cover 4" with no other addressee → everyone else covers #4
    if (vipNumber != null && !coverMe) {
      return withoutVip(alive);
    }
  }

  if (nums.length) return alive.filter((t) => nums.includes(t.number));

  if (/\bscouts?\b/.test(lower)) {
    const scouts = alive.filter((t) => t.role === "scout");
    return coverVerb ? withoutVip(scouts) : scouts;
  }
  if (/\bheav(?:y|ies)\b/.test(lower)) {
    const heavies = alive.filter((t) => t.role === "heavy");
    return coverVerb ? withoutVip(heavies) : heavies;
  }
  if (/\b(lights?|shooters?|gunners?)\b/.test(lower)) {
    const guns = alive.filter((t) => t.role === "shooter");
    return coverVerb ? withoutVip(guns) : guns;
  }

  // Formation / company verbs imply the whole living team when no addressee
  if (
    /\b(spread(\s*out)?|fan\s*out|disperse|space\s*out|fall\s*back|retreat)\b/.test(
      lower,
    )
  ) {
    return alive;
  }

  // Bare "cover me" / "follow me" → rest of company sticks to the commander
  if (coverMe) return withoutVip(alive);

  const controlled = alive.find((t) => t.id === controlledId);
  return controlled ? [controlled] : alive.slice(0, 1);
}

/** Map edge inset so moveTo goals sit inside the arena, not in the wall. */
function mapCorner(fx: number, fy: number, name: string): {
  x: number;
  y: number;
  name: string;
} {
  const pad = CONFIG.arenaPadding + CONFIG.tankRadius + 8;
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;
  return {
    x: pad + (W - 2 * pad) * fx,
    y: pad + (H - 2 * pad) * fy,
    name,
  };
}

/**
 * Resolve a place name / corner / direction from free text.
 * Corners first ("bottom left"), then named spots with word boundaries.
 */
function landmark(
  text: string,
  world: WorldState,
): { x: number; y: number; name: string } | null {
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;
  const lower = text.toLowerCase().replace(/-/g, " ");

  // Corners / compass compounds (must beat single-word north/south/etc.)
  const corners: [RegExp, { x: number; y: number; name: string }][] = [
    [
      /\b(bottom|lower|south)\s*(left|west)\b|\b(left|west)\s*(bottom|lower|south)\b|\bsouth\s*west\b|\bsw\b/,
      mapCorner(0.08, 0.92, "bottom-left"),
    ],
    [
      /\b(bottom|lower|south)\s*(right|east)\b|\b(right|east)\s*(bottom|lower|south)\b|\bsouth\s*east\b|\bse\b/,
      mapCorner(0.92, 0.92, "bottom-right"),
    ],
    [
      /\b(top|upper|north)\s*(left|west)\b|\b(left|west)\s*(top|upper|north)\b|\bnorth\s*west\b|\bnw\b/,
      mapCorner(0.08, 0.08, "top-left"),
    ],
    [
      /\b(top|upper|north)\s*(right|east)\b|\b(right|east)\s*(top|upper|north)\b|\bnorth\s*east\b|\bne\b/,
      mapCorner(0.92, 0.08, "top-right"),
    ],
  ];
  for (const [re, spot] of corners) {
    if (re.test(lower)) return spot;
  }

  // Single-axis edges when no corner matched
  if (/\b(bottom|lower)\b/.test(lower) && !/\b(left|right|west|east)\b/.test(lower)) {
    return mapCorner(0.5, 0.92, "bottom");
  }
  if (/\b(top|upper)\b/.test(lower) && !/\b(left|right|west|east)\b/.test(lower)) {
    return mapCorner(0.5, 0.08, "top");
  }
  if (/\bleft\b/.test(lower) && !/\b(top|bottom|upper|lower|north|south)\b/.test(lower)) {
    return mapCorner(0.08, 0.5, "left");
  }
  if (/\bright\b/.test(lower) && !/\b(top|bottom|upper|lower|north|south)\b/.test(lower)) {
    return mapCorner(0.92, 0.5, "right");
  }

  const spots: Record<string, { x: number; y: number; name: string }> = {
    "north choke": { x: W * 0.48, y: H * 0.32, name: "north choke" },
    north: { x: W * 0.5, y: H * 0.2, name: "north" },
    south: { x: W * 0.5, y: H * 0.8, name: "south" },
    east: { x: W * 0.8, y: H * 0.5, name: "east" },
    west: { x: W * 0.2, y: H * 0.5, name: "west" },
    center: { x: W * 0.5, y: H * 0.5, name: "center" },
    middle: { x: W * 0.5, y: H * 0.5, name: "center" },
    choke: { x: W * 0.5, y: H * 0.45, name: "choke" },
    bunker: { x: W * 0.25, y: H * 0.28, name: "bunker" },
    eagle: { x: W * 0.5, y: H - 72, name: "eagle" },
    base: { x: W * 0.5, y: H - 72, name: "base" },
    home: { x: W * 0.5, y: H * 0.88, name: "home" },
  };
  for (const key of Object.keys(spots).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${key.replace(/\s+/g, "\\s+")}\\b`);
    if (re.test(lower)) return spots[key];
  }

  // marked wreck
  const wreckMatch = lower.match(/\bwreck\s*([a-z])\b/);
  if (wreckMatch) {
    const label = wreckMatch[1].toUpperCase();
    const w = world.wrecks.find((wr) => wr.label === label);
    if (w) return { x: w.x, y: w.y, name: `wreck ${label}` };
  }
  return null;
}

function commanderId(world: WorldState, team: TeamId): string {
  if (team === "red") {
    return (
      world.remoteControlledId ??
      world.tanks.find((t) => t.team === "red" && t.alive)?.id ??
      "red-1"
    );
  }
  return world.controlledId;
}

export type FlankSide = "left" | "right";
export type RouteRisk = "normal" | "stealth";

/**
 * One utterance, one plan. Bots share a side of the commander instead of
 * each receiving a map-edge move that can cross the speaker's lane.
 */
export interface OrderPlan {
  goal: "moveTo" | "attackNearest";
  addressedIds: string[];
  side: FlankSide | null;
  landmark: string | null;
  speakerReservedSide: FlankSide | null;
  risk: RouteRisk;
  /** Radians, atan2 toward the enemy cluster (or the commander's hull facing). */
  facing: number;
  anchor: { x: number; y: number } | null;
  reservedAnchor: { x: number; y: number } | null;
  enemyNumbers: number[];
  notice?: string;
}

/** Screen-right of `facing` (y-down atan2). Positive means to the commander's right. */
export function lateralOffset(
  facing: number,
  origin: { x: number; y: number },
  point: { x: number; y: number },
): number {
  const rx = -Math.sin(facing);
  const ry = Math.cos(facing);
  return (point.x - origin.x) * rx + (point.y - origin.y) * ry;
}

function enemyCentroid(
  tanks: Tank[],
  team: TeamId,
): { x: number; y: number } | null {
  const enemy = foes(tanks, team);
  if (!enemy.length) return null;
  const x = enemy.reduce((sum, t) => sum + t.x, 0) / enemy.length;
  const y = enemy.reduce((sum, t) => sum + t.y, 0) / enemy.length;
  return { x, y };
}

function commanderFacing(
  commander: Tank,
  tanks: Tank[],
  team: TeamId,
): number {
  const cluster = enemyCentroid(tanks, team);
  if (!cluster) return commander.angle;
  return Math.atan2(cluster.y - commander.y, cluster.x - commander.x);
}

function clampArena(x: number, y: number): { x: number; y: number } {
  const pad = CONFIG.arenaPadding + CONFIG.tankRadius + 8;
  return {
    x: Math.min(CONFIG.canvasWidth - pad, Math.max(pad, x)),
    y: Math.min(CONFIG.canvasHeight - pad, Math.max(pad, y)),
  };
}

/** Point ahead of the commander, offset to one flank of the enemy cluster. */
function flankAnchor(
  commander: Tank,
  facing: number,
  side: FlankSide,
  tanks: Tank[],
  team: TeamId,
): { x: number; y: number } {
  const cluster = enemyCentroid(tanks, team);
  const distTo = cluster
    ? Math.hypot(cluster.x - commander.x, cluster.y - commander.y)
    : 240;
  const ahead = Math.max(140, Math.min(260, distTo * 0.4));
  const lateral = 190;
  const fx = Math.cos(facing);
  const fy = Math.sin(facing);
  const rx = -Math.sin(facing);
  const ry = Math.cos(facing);
  const sign = side === "right" ? 1 : -1;
  return clampArena(
    commander.x + fx * ahead + rx * lateral * sign,
    commander.y + fy * ahead + ry * lateral * sign,
  );
}

/** "the right" / "flank left", not "bottom left" or compass corners. */
function relativeSide(text: string): FlankSide | null {
  if (/\b(bottom|top|upper|lower|north|south|east|west)\b/.test(text)) {
    return null;
  }
  const m = text.match(/\b(?:the|flank)\s+(left|right)\b/);
  return m ? (m[1] as FlankSide) : null;
}

function idsForNumbers(
  nums: number[],
  tanks: Tank[],
  team: TeamId,
): string[] {
  const alive = friendlies(tanks, team);
  const ids: string[] = [];
  for (const n of nums) {
    const t = alive.find((tank) => tank.number === n);
    if (t && !ids.includes(t.id)) ids.push(t.id);
  }
  return ids;
}

/**
 * Keyword plan for a whole utterance. Null means "use the older clause parser".
 * Relative flanks, stealth moves, shoot-at-will moves, and named attacks match.
 */
export function planUtterance(
  orderText: string,
  tanks: Tank[],
  world: WorldState,
  team: TeamId = "blue",
): OrderPlan | null {
  const text = normalizeSpokenNumbers(orderText);
  const clauses = splitOrderClauses(text);
  const speakerClauses = clauses.filter((c) => isSpeakerClause(c));
  const fireClauses = clauses.filter((c) => isFireAtWillClause(c));
  const rest = clauses.filter(
    (c) => !isSpeakerClause(c) && !isFireAtWillClause(c),
  );
  if (rest.length !== 1) return null;
  const body = rest[0] ?? "";
  const risk: RouteRisk = /\b(stealth(?:ily)?|sneak(?:ily)?|covert(?:ly)?)\b/i.test(
    text,
  )
    ? "stealth"
    : "normal";
  const speakerReservedSide = speakerClauses.reduce<FlankSide | null>(
    (side, clause) => side ?? relativeSide(clause),
    null,
  );
  const cmd = friendlies(tanks, team).find(
    (t) => t.id === commanderId(world, team),
  );
  const facing = cmd ? commanderFacing(cmd, tanks, team) : 0;

  const attack = parseTargetedEnemyAttack(body);
  if (attack && (attack.allyNumbers.length > 0 || attack.allAllies)) {
    const addressedIds = attack.allyNumbers.length
      ? idsForNumbers(attack.allyNumbers, tanks, team)
      : friendlies(tanks, team).map((t) => t.id);
    return {
      goal: "attackNearest",
      addressedIds,
      side: null,
      landmark: null,
      speakerReservedSide: null,
      risk: "normal",
      facing,
      anchor: null,
      reservedAnchor: null,
      enemyNumbers: attack.enemyNumbers,
    };
  }

  const side = relativeSide(body);
  const wantsMove = /\b(move|go|head|take|flank|advance)\b/i.test(body);
  const stealthMove = risk === "stealth" && wantsMove;
  const shootAndMove = fireClauses.length > 0 && wantsMove;
  const flankMove = side != null && wantsMove;
  if (!flankMove && !stealthMove && !shootAndMove) return null;

  const addressedIds = idsForNumbers(tankNumbersIn(body), tanks, team);
  if (!addressedIds.length) return null;

  if (flankMove && side && cmd) {
    return {
      goal: "moveTo",
      addressedIds,
      side,
      landmark: null,
      speakerReservedSide,
      risk,
      facing,
      anchor: flankAnchor(cmd, facing, side, tanks, team),
      reservedAnchor: speakerReservedSide
        ? flankAnchor(cmd, facing, speakerReservedSide, tanks, team)
        : null,
      enemyNumbers: [],
    };
  }

  const spot = landmark(body, world);
  const markPhrase = parseMoveToMark(body);
  if (markPhrase) {
    const mark = world.playerMarks[team];
    if (!mark) {
      return {
        goal: "moveTo",
        addressedIds,
        side: null,
        landmark: "mark",
        speakerReservedSide: null,
        risk,
        facing,
        anchor: null,
        reservedAnchor: null,
        enemyNumbers: [],
        notice: "No map mark — hold F and click the map.",
      };
    }
    return {
      goal: "moveTo",
      addressedIds,
      side: null,
      landmark: "mark",
      speakerReservedSide: null,
      risk,
      facing,
      anchor: { x: mark.x, y: mark.y },
      reservedAnchor: null,
      enemyNumbers: [],
    };
  }

  if (!spot) return null;
  return {
    goal: "moveTo",
    addressedIds,
    side: null,
    landmark: spot.name,
    speakerReservedSide: null,
    risk,
    facing,
    anchor: { x: spot.x, y: spot.y },
    reservedAnchor: null,
    enemyNumbers: [],
  };
}

function ordersFromPlan(
  plan: OrderPlan,
  tanks: Tank[],
  team: TeamId,
): OrderResult[] {
  if (plan.notice || !plan.addressedIds.length) return [];
  const byId = new Map(friendlies(tanks, team).map((t) => [t.id, t]));
  const addressed = plan.addressedIds
    .map((id) => byId.get(id))
    .filter((t): t is Tank => t != null);
  if (!addressed.length) return [];

  if (plan.goal === "attackNearest") {
    const attack = attackTargetParams(
      { enemyNumbers: plan.enemyNumbers },
      tanks,
      team,
    );
    return addressed.map((t) => ({
      tankId: t.id,
      goal: "attackNearest" as const,
      params: attack.params,
      chatLine: `#${t.number}: ${attack.verb}.`,
    }));
  }

  const fx = Math.cos(plan.facing);
  const fy = Math.sin(plan.facing);
  return addressed.map((t, i) => {
    const base = plan.anchor ?? { x: t.x, y: t.y };
    // Stagger along the facing, never across the commander's other lane.
    const x = base.x + fx * i * 28;
    const y = base.y + fy * i * 28;
    const params: OrderResult["params"] = {
      x,
      y,
      risk: plan.risk,
    };
    if (plan.side) params.side = plan.side;
    if (plan.landmark === "mark") params.exact = true;
    const where = plan.side
      ? `the ${plan.side}`
      : (plan.landmark ?? "the point");
    const how = plan.risk === "stealth" ? "stealthily " : "";
    return {
      tankId: t.id,
      goal: "moveTo" as const,
      params,
      chatLine: `#${t.number}: ${how}moving to ${where}.`,
    };
  });
}

function refineMoveAnchors(
  plan: OrderPlan,
  base: OrderResult[],
  llm: OrderResult[],
  world: WorldState,
  team: TeamId,
): OrderResult[] {
  if (plan.goal !== "moveTo" || plan.landmark === "mark" || !plan.anchor) {
    return base;
  }
  const cmd = friendlies(tanksOf(world), team).find(
    (t) => t.id === commanderId(world, team),
  );
  return base.map((order) => {
    const alt = llm.find(
      (o) =>
        o.tankId === order.tankId &&
        o.goal === "moveTo" &&
        o.params?.x != null &&
        o.params?.y != null,
    );
    if (!alt?.params || alt.params.x == null || alt.params.y == null) {
      return order;
    }
    const proposed = { x: alt.params.x, y: alt.params.y };
    if (plan.side && cmd) {
      const lat = lateralOffset(plan.facing, cmd, proposed);
      if (plan.side === "right" && lat <= 0) return order;
      if (plan.side === "left" && lat >= 0) return order;
    }
    return {
      ...order,
      params: {
        ...order.params,
        x: proposed.x,
        y: proposed.y,
        side: plan.side ?? order.params?.side,
        risk: plan.risk,
      },
    };
  });
}

function tanksOf(world: WorldState): Tank[] {
  return world.tanks;
}

function baseOrderIntent(text: string, tanks: Tank[], world: WorldState, team: TeamId): CommandIntent | null {
  if (!isBaseWar(world.gameMode)) return null;
  const match = text.toLowerCase().match(/^(.*?)\b(attack|defend)\s*(?:(?:the|their|our|enemy)\s+)*?(base)?[.!?\s]*$/);
  if (!match || (match[2] === "attack" && !match[3])) return null;
  const numbers = tankNumbersIn(match[1]!);
  const targets = friendlies(tanks, team).filter((t) =>
    numbers.length ? numbers.includes(t.number) : t.id !== commanderId(world, team),
  );
  return { tool: match[2] === "attack" ? "attack_base" : "defend_base", tank_ids: targets.map((t) => t.number) };
}

export function interpretOffline(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
  team: TeamId = "blue",
): OrderResult[] {
  const spoken = normalizeSpokenNumbers(orderText);
  const baseIntent = baseOrderIntent(spoken, tanks, worldState, team);
  if (baseIntent) return intentsToOrders(worldState, team, [baseIntent]).orders;
  const plan = planUtterance(spoken, tanks, worldState, team);
  if (plan) return ordersFromPlan(plan, tanks, team);
  const marked = ordersForPlayerMark(spoken, tanks, worldState, team);
  if (marked) return marked.orders;
  if (isMpRules(worldState.gameMode)) {
    const parts = splitOrderClauses(spoken).filter(
      (clause) => !isSpeakerClause(clause) && !isFireAtWillClause(clause),
    );
    const changed = parts.length !== 1 || parts[0] !== spoken;
    if (changed) {
      if (!parts.length) return [];
      const merged = new Map<string, OrderResult>();
      for (const clause of parts) {
        for (const result of interpretOffline(clause, tanks, worldState, team)) {
          if (!merged.has(result.tankId)) merged.set(result.tankId, result);
        }
      }
      return [...merged.values()];
    }
  }
  return interpretOfflineBody(spoken, tanks, worldState, team);
}

function splitOrderClauses(text: string): string[] {
  const chunks = text.split(/\s*(?:,|;)\s*/).filter(Boolean);
  const parts: string[] = [];
  for (const chunk of chunks) {
    const andParts = chunk.split(/\s+\band\b\s+/i);
    let buf = andParts[0] ?? "";
    for (let i = 1; i < andParts.length; i++) {
      const next = andParts[i] ?? "";
      // "2 and 3 attack 5 and 6" is one order. The numbers after attack
      // are enemies, not a new clause that retasks friendly #6.
      const listSoFar = /^(?:tanks?\s+)?[\d\s#and,]+$/i.test(buf);
      const nextStartsNumber = /^#?\d+\b/.test(next.trim());
      const nextIsOnlyEnemy =
        /^(?:(?:the|enemy|tanks?)\s+)*#?\d+\s*$/i.test(next.trim());
      const bufHasAttack = /\b(?:attack|engage|hunt)\b/i.test(buf);
      if (
        (listSoFar && nextStartsNumber) ||
        (bufHasAttack && nextIsOnlyEnemy)
      ) {
        buf = `${buf} and ${next}`;
      }
      else {
        if (buf.trim()) parts.push(buf.trim());
        buf = next;
      }
    }
    if (buf.trim()) parts.push(buf.trim());
  }
  return parts.length ? parts : [text];
}

function isSpeakerClause(text: string): boolean {
  return /^\s*(i|i'll|ill|i will|i'm|im|me)\b/i.test(text) && !/\b[1-6]\b/.test(text);
}

function isFireAtWillClause(text: string): boolean {
  return (
    /\b(shoot|fire)\b/i.test(text) &&
    /\b(at\s*will|freely|anything)\b/i.test(text) &&
    !/\b[1-6]\b/.test(text)
  );
}

function interpretOfflineBody(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
  team: TeamId = "blue",
): OrderResult[] {
  const lower = orderText.toLowerCase();
  const cmdId = commanderId(worldState, team);
  let targets = resolveTargetsWithControl(
    orderText,
    tanks,
    cmdId,
    team,
  );
  if (!targets.length) {
    return [
      {
        tankId: "blue-1",
        goal: "holdPosition",
        chatLine: "No living tanks to take that order.",
      },
    ];
  }

  let kind: GoalKind = "patrol";
  let params: OrderResult["params"] = {};
  let verb = "keeping mobile";
  let perTankParams = false;

  if (/\b(spread(\s*out)?|fan\s*out|disperse|space\s*out)\b/.test(lower)) {
    kind = "spreadOut";
    verb = "spreading out";
    perTankParams = true;
  } else if (/\b(scout|recon|probe|screen)\b/.test(lower)) {
    kind = "scout";
    verb = "scouting ahead";
    perTankParams = true;
  } else if (
    /\b(keep\s*moving|stay\s*mobile|patrol|roam|keep\s*rolling|don't\s*stop|dont\s*stop)\b/.test(
      lower,
    )
  ) {
    kind = "patrol";
    verb = "patrolling / keeping mobile";
    perTankParams = true;
  } else if (/\b(retreat|fall\s*back|get\s*out)\b/.test(lower)) {
    kind = "retreat";
    verb = "retreating";
  } else if (/\b(report(\s*in)?|radio\s*in)\b/.test(lower)) {
    kind = "reportIn";
    verb = "reporting in";
  } else if (/\b(debug|inspect)\b/.test(lower)) {
    kind = "debug";
    verb = "debugging marked wrecks";
    const wreckMatch = lower.match(/\bwreck\s*([a-z])\b/);
    if (wreckMatch) {
      const label = wreckMatch[1].toUpperCase();
      const w = worldState.wrecks.find((wr) => wr.label === label);
      if (w) params = { wreckId: w.id, x: w.x, y: w.y };
    }
  } else if (/\b(escort|cover|protect|follow|guard)\b/.test(lower)) {
    kind = "escort";
    const vip =
      resolveEscortVip(orderText, tanks, cmdId, team) ??
      friendlies(tanks, team).find((t) => t.id === cmdId);
    // Bodyguards must not be the VIP (bug: "4, cover me" used to self-escort)
    const bodyguards = vip
      ? targets.filter((t) => t.id !== vip.id)
      : targets;
    if (bodyguards.length) targets = bodyguards;
    else if (vip) {
      targets = friendlies(tanks, team).filter((t) => t.id !== vip.id);
    }
    params = { targetTankId: vip?.id };
    verb =
      vip?.id === cmdId
        ? "covering you — facing the threat"
        : `escorting #${vip?.number ?? "?"}`;
  } else if (/\b(attack|engage|hunt|push)\b/.test(lower)) {
    kind = "attackNearest";
    const targeted = parseTargetedEnemyAttack(orderText);
    if (targeted) {
      const attack = attackTargetParams(targeted, tanks, team);
      params = attack.params;
      verb = attack.verb;
      perTankParams = false;
      if (targeted.allyNumbers.length) {
        targets = friendlies(tanks, team).filter((t) =>
          targeted.allyNumbers.includes(t.number),
        );
      } else if (targeted.allAllies || targets.length === 0) {
        targets = friendlies(tanks, team);
      }
    } else {
      verb = "hunting / attacking";
      perTankParams = true;
    }
  } else if (/\b(hold|stay|wait|defend)\b/.test(lower)) {
    kind = "holdPosition";
    verb = isMpRules(worldState.gameMode)
      ? "holding position"
      : "holding (soft — will still fight)";
    const spot = landmark(orderText, worldState);
    if (spot) {
      params = { x: spot.x, y: spot.y };
      verb = `holding ${spot.name}`;
    } else {
      perTankParams = true;
    }
  } else if (/\b(move|go|advance|recon|head|get|take|flank)\b/.test(lower)) {
    kind = "moveTo";
    verb = "moving";
    const spot = landmark(orderText, worldState);
    if (spot) {
      params = { x: spot.x, y: spot.y };
      verb = `moving to ${spot.name}`;
    } else if (isMpRules(worldState.gameMode)) {
      // No destination in the order — do not invent one.
      kind = "holdPosition";
      verb = "holding — that order had no place";
      perTankParams = true;
    } else {
      // Still a move order — advance on the named axis if any, else center push
      kind = "moveTo";
      params = { x: CONFIG.canvasWidth * 0.5, y: CONFIG.canvasHeight * 0.55 };
      verb = "advancing (no clear landmark — pushing center)";
    }
  } else {
    const spot = landmark(orderText, worldState);
    if (spot) {
      kind = "moveTo";
      params = { x: spot.x, y: spot.y };
      verb = `moving to ${spot.name}`;
    } else if (isMpRules(worldState.gameMode)) {
      kind = "holdPosition";
      verb = "holding — that wasn't a move order";
      perTankParams = true;
    } else {
      // Unclear → keep pushing (attack/patrol), not a stuck hold
      kind = "attackNearest";
      verb = "pushing up (best-effort parse)";
      perTankParams = true;
    }
  }

  const homeY = CONFIG.canvasHeight * (1 - CONFIG.homeTerritoryFraction) - 60;
  const spacing = CONFIG.ai.formationSpacing;
  const results: OrderResult[] = [];
  for (const t of targets) {
    let p = { ...params };
    if (perTankParams) {
      if (kind === "spreadOut") {
        // Wide lane across the southern half — not a mid-map pile
        const lane = (t.number - 0.5) / 6;
        p = {
          x: CONFIG.canvasWidth * (0.1 + lane * 0.8),
          y: CONFIG.canvasHeight * (0.55 + (t.number % 3) * 0.1),
        };
      } else if (kind === "holdPosition") {
        if (isMpRules(worldState.gameMode)) {
          p = { x: t.x, y: t.y };
        } else {
          const lane = (t.number - 0.5) / 6;
          p = {
            x: CONFIG.canvasWidth * (0.12 + lane * 0.76),
            y: homeY - (t.number % 2) * 50,
          };
        }
      } else if (
        kind === "patrol" ||
        kind === "attackNearest" ||
        kind === "scout"
      ) {
        p = {
          x: CONFIG.canvasWidth * (0.2 + (t.number % 5) * 0.15),
          y:
            kind === "scout"
              ? CONFIG.canvasHeight * (0.25 + (t.number % 3) * 0.08)
              : homeY - 40 - (t.number % 3) * 50,
        };
      }
    } else if (
      kind === "moveTo" &&
      p.x != null &&
      p.y != null &&
      targets.length > 1
    ) {
      // Fan out wider than separation radius so bots don't shove each other
      const col = (t.number - 1) % 3;
      const row = Math.floor((t.number - 1) / 3);
      const pad = CONFIG.arenaPadding + CONFIG.tankRadius + 8;
      p = {
        x: Math.min(
          CONFIG.canvasWidth - pad,
          Math.max(pad, p.x + (col - 1) * spacing),
        ),
        y: Math.min(
          CONFIG.canvasHeight - pad,
          Math.max(pad, p.y + (row - 0.5) * spacing),
        ),
      };
    }
    const chatLine = `#${t.number}: ack, ${verb}.`;
    results.push({
      tankId: t.id,
      goal: kind,
      params: p,
      chatLine,
    });
  }
  return results;
}

export type LlmProviderChoice = "auto" | LlmBackend;

/** Guess backend from key shape (convenience only — UI can override). */
export function detectLlmProvider(apiKey: string): LlmBackend {
  const k = apiKey.trim();
  if (k.startsWith("AIza") || k.startsWith("AQ.")) return "gemini";
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-or-")) return "openrouter";
  return "openai";
}

/** Resolve Auto → concrete backend; honor explicit provider picks. */
export function resolveLlmBackend(
  apiKey: string,
  choice: LlmProviderChoice = "auto",
): LlmBackend {
  if (choice !== "auto") return choice;
  return detectLlmProvider(apiKey);
}

export function defaultModelFor(backend: LlmBackend): string {
  return CONFIG.llm[backend].model;
}

function modelFor(backend: LlmBackend, override?: string): string {
  const m = override?.trim();
  return m || defaultModelFor(backend);
}

async function fetchOpenAiCompatible(
  backend: "openai" | "openrouter",
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  opts: { temperature: number; maxTokens: number; signal: AbortSignal },
): Promise<Response> {
  const cfg = CONFIG.llm[backend];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (backend === "openrouter") {
    headers["HTTP-Referer"] = "https://localhost/fog-of-war-tank-hunt";
    headers["X-Title"] = "Fog of War Tank Hunt";
    headers["X-OpenRouter-Title"] = "Fog of War Tank Hunt";
  }
  return fetch(cfg.path, {
    method: "POST",
    signal: opts.signal,
    headers,
    body: JSON.stringify({
      model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages,
    }),
  });
}

function geminiGenerateUrl(apiKey: string, model: string): string {
  return `${CONFIG.llm.gemini.path}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

export type LlmProbeResult =
  | { ok: true; provider: LlmBackend; model: string; ms: number }
  | { ok: false; provider?: LlmBackend; model?: string; ms: number; error: string };

export interface LlmProbeOptions {
  /** auto | openrouter | openai | gemini | anthropic */
  provider?: LlmProviderChoice;
  /** Optional model id override (any OpenRouter/OpenAI/Gemini/Anthropic model string). */
  model?: string;
}

/**
 * Live check that the key can reach the chosen backend via Vite `/llm/*` proxies.
 * Provider + model are selectable — not locked to OpenAI.
 */
export async function probeLlmConnection(
  apiKey: string,
  opts: LlmProbeOptions = {},
): Promise<LlmProbeResult> {
  const key = apiKey.trim();
  if (!key) {
    return { ok: false, ms: 0, error: "no API key" };
  }
  const provider = resolveLlmBackend(key, opts.provider ?? "auto");
  const model = modelFor(provider, opts.model);
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    CONFIG.llm.probeTimeoutMs,
  );
  try {
    if (provider === "gemini") {
      const res = await fetch(geminiGenerateUrl(key, model), {
        method: "POST",
        signal: controller.signal,
        headers: geminiHeaders(key),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: 'Reply with JSON: {"ok":true}' }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 16,
            responseMimeType: "application/json",
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Gemini HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
        );
      }
    } else if (provider === "anthropic") {
      const res = await fetch(CONFIG.llm.anthropic.path, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: "user", content: 'Reply with only: {"ok":true}' }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Anthropic HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
        );
      }
    } else {
      // OpenAI-compatible (OpenAI host or OpenRouter) — any Bearer key shape accepted
      const res = await fetchOpenAiCompatible(
        provider,
        key,
        model,
        [{ role: "user", content: 'Reply with JSON: {"ok":true}' }],
        { temperature: 0, maxTokens: 16, signal: controller.signal },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const label = provider === "openrouter" ? "OpenRouter" : "OpenAI";
        throw new Error(
          `${label} HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
        );
      }
    }
    return {
      ok: true,
      provider,
      model,
      ms: Math.round(performance.now() - t0),
    };
  } catch (err) {
    let error = err instanceof Error ? err.message : "probe failed";
    if (err instanceof DOMException && err.name === "AbortError") {
      error = "timed out";
    }
    return {
      ok: false,
      provider,
      model,
      ms: Math.round(performance.now() - t0),
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

const ORDER_SYSTEM = `You are a tank company radio officer. Reply with JSON ONLY: {"orders":[{"tankId":"blue-N","goal":"${goalKindsForPrompt()}","params":{"x":0,"y":0,"targetTankId":"","wreckId":""},"chatLine":"#N: ack..."}]}.
Goals only from that list. Prefer patrol/scout/spreadOut/attackNearest over freezing on hold. tankId must be living blue tanks. You may loosely reinterpret unclear orders and admit that in chatLine. Keep chat short.
Map is top-down: x right, y down; origin top-left. When the order names a place (corner, side, north/south/east/west), set goal moveTo with numeric x,y inside the map for EVERY addressed tank. Example corners: bottom-left ≈ (0.1*W, 0.9*H), top-right ≈ (0.9*W, 0.1*H). Always include x and y for moveTo/holdPosition.
Cover/follow: "4, cover me" / "follow me" → goal escort for the named bodyguard(s), params.targetTankId = the commander's tankId (controlled). Never set a tank to escort itself. "cover 3" → other blues escort tank #3. Scout/recon → goal scout with northward x,y.
Targeted attack: "3, attack enemy tank #2" / "all attack enemy #5" → goal attackNearest for the named blue(s), params.targetTankId = the living red tank id (red-N).`;

const ORDER_SYSTEM_LITERAL = `You are the company commander’s radio officer. Reply with JSON ONLY: {"orders":[{"tankId":"blue-N","goal":"${goalKindsForPrompt()}","params":{"x":0,"y":0,"targetTankId":"","wreckId":"","side":"left|right","risk":"normal|stealth"},"chatLine":"#N: ack..."}]}.
One utterance is one plan. Goals only from that list. tankId must be a living tank of the ordering team (see friendlies). Do not order a tank the speaker did not address. "I / I'll / me" is the human commander (controlledId): never give that tank a goal unless its number is spoken.
If parsedPlan is present, keep its goal, addressed tank ids, side, and risk. You may nudge moveTo x,y. You must not turn that plan into attackNearest. Do not add tanks.
Map is top-down, origin top-left, y increases south. North y≈0.15*H, south y≈0.85*H. "the left" and "the right" are NOT map edges. They are flanks of the commander (commander.x/y, commander.facing) relative to enemyCluster. params.side is "left" or "right". params.risk is "normal" or "stealth". Stealth means prefer a covered route and is still moveTo.
Examples:
- "2 move south and shoot at will" → only #2 moveTo south, risk normal. Bots already fire in range, so do NOT also set attackNearest.
- "3 take the right and I'll take the left" → only #3 moveTo, side right, anchor on the commander's right. The speaker keeps the left. Do not order the commander.
- "4 move stealthily to the mark" → only #4 moveTo the mark, risk stealth, exact.
- "2 and 3 attack 5" → attackNearest only for allies named BEFORE the verb. Numbers AFTER the verb are enemies. Never order an enemy number as a friendly.
- "cover me" → escort, params.targetTankId = controlledId, not the bodyguard.
Keep chat short.`;

/** Exported for the order eval suite (roadmap P0). */
export function sanitizeOrders(
  orders: OrderResult[],
  tanks: Tank[],
  orderText?: string,
  world?: WorldState,
  team: TeamId = "blue",
): OrderResult[] {
  const baseIntent = orderText && world ? baseOrderIntent(normalizeSpokenNumbers(orderText), tanks, world, team) : null;
  if (baseIntent && world) return intentsToOrders(world, team, [baseIntent]).orders;
  const living = new Set(friendlies(tanks, team).map((t) => t.id));
  const spot =
    orderText && world ? landmark(orderText, world) : null;
  const controlledId = world ? commanderId(world, team) : undefined;
  const targeted =
    orderText && world ? parseTargetedEnemyAttack(orderText) : null;
  const foeTarget =
    targeted && world
      ? foes(tanks, team).find(
          (t) => t.alive && t.number === targeted.enemyNumbers[0],
        )
      : undefined;
  const foeIds =
    targeted && world
      ? attackTargetParams(targeted, tanks, team).params?.targetTankIds
      : undefined;
  return orders
    .filter((o) => living.has(o.tankId) && isGoalKind(o.goal))
    .map((o) => {
      const params = { ...(o.params ?? {}) };
      // If LLM chose moveTo/hold without coords, fill from parsed landmark.
      if (
        (o.goal === "moveTo" || o.goal === "holdPosition") &&
        (params.x == null || params.y == null) &&
        spot
      ) {
        params.x = spot.x;
        params.y = spot.y;
      }
      // Escort must name a VIP other than the bodyguard; "cover me" → commander
      if (o.goal === "escort" && world && orderText) {
        const vip = resolveEscortVip(
          orderText,
          tanks,
          controlledId ?? world.controlledId,
          team,
        );
        if (vip && (params.targetTankId == null || params.targetTankId === o.tankId)) {
          params.targetTankId = vip.id;
        }
        if (params.targetTankId === o.tankId && controlledId) {
          params.targetTankId = controlledId;
        }
      }
      // Targeted enemy attack — fill / correct foe targetTankId.
      // Several enemies stay a set; one enemy is focus-fire.
      if (o.goal === "attackNearest" && foeIds && foeIds.length > 1) {
        params.targetTankIds = foeIds;
        params.targetTankId = foeIds[0];
      } else if (o.goal === "attackNearest" && foeTarget && !foeIds) {
        params.targetTankId = foeTarget.id;
      } else if (
        o.goal === "attackNearest" &&
        params.targetTankId &&
        world
      ) {
        const t = world.tanks.find((x) => x.id === params.targetTankId);
        if (!t || !t.alive || t.team === team) {
          delete params.targetTankId;
        }
      }
      return {
        tankId: o.tankId,
        goal: o.goal,
        params,
        chatLine: o.chatLine || `#?: ack.`,
      };
    });
}

function extractJsonObject(text: string): { orders?: OrderResult[] } {
  const trimmed = stripJsonFence(text);
  try {
    return JSON.parse(trimmed) as { orders?: OrderResult[] };
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as {
        orders?: OrderResult[];
      };
    }
    throw new Error("LLM returned non-JSON");
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

async function interpretWithLlm(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
  ctx: InterpretContext,
  team: TeamId = "blue",
): Promise<OrderResult[]> {
  const apiKey = ctx.apiKey?.trim();
  if (!apiKey) return interpretOffline(orderText, tanks, worldState, team);

  const alive = friendlies(tanks, team).map((t) => ({
    id: t.id,
    number: t.number,
    role: t.role,
    x: Math.round(t.x),
    y: Math.round(t.y),
    hp: Math.round(t.hp),
  }));
  const enemies = foes(tanks, team).map((t) => ({
    id: t.id,
    number: t.number,
    x: Math.round(t.x),
    y: Math.round(t.y),
    hp: Math.round(t.hp),
  }));
  const wrecks = worldState.wrecks.map((w) => ({
    id: w.id,
    label: w.label,
    marked: w.marked,
    debugged: w.debugged,
  }));

  const cmdTank = friendlies(tanks, team).find(
    (t) => t.id === commanderId(worldState, team),
  );
  const facing = cmdTank
    ? commanderFacing(cmdTank, tanks, team)
    : 0;
  const cluster = enemyCentroid(tanks, team);
  const parsedPlan = planUtterance(orderText, tanks, worldState, team);
  const user = JSON.stringify({
    orderText,
    team,
    controlledId: commanderId(worldState, team),
    commander: cmdTank
      ? {
          id: cmdTank.id,
          number: cmdTank.number,
          x: Math.round(cmdTank.x),
          y: Math.round(cmdTank.y),
          facing,
        }
      : null,
    enemyCluster: cluster
      ? { x: Math.round(cluster.x), y: Math.round(cluster.y) }
      : null,
    parsedPlan: parsedPlan
      ? {
          goal: parsedPlan.goal,
          addressedIds: parsedPlan.addressedIds,
          side: parsedPlan.side,
          landmark: parsedPlan.landmark,
          speakerReservedSide: parsedPlan.speakerReservedSide,
          risk: parsedPlan.risk,
          anchor: parsedPlan.anchor,
          reservedAnchor: parsedPlan.reservedAnchor,
          enemyNumbers: parsedPlan.enemyNumbers,
        }
      : null,
    friendlies: alive,
    enemies,
    wrecks,
    shareMode: worldState.shareMode,
    gameMode: worldState.gameMode,
    matchLeft: Math.round(worldState.matchLeft),
    map: {
      width: CONFIG.canvasWidth,
      height: CONFIG.canvasHeight,
      origin: "top-left",
      yDown: true,
      note: "y increases southward. left/west = small x, right/east = large x.",
      corners: {
        topLeft: mapCorner(0.08, 0.08, "top-left"),
        topRight: mapCorner(0.92, 0.08, "top-right"),
        bottomLeft: mapCorner(0.08, 0.92, "bottom-left"),
        bottomRight: mapCorner(0.92, 0.92, "bottom-right"),
      },
    },
  });

  const provider = ctx.provider ?? detectLlmProvider(apiKey);
  const model = modelFor(provider, ctx.model);
  const content = await fetchLlmJson(
    provider,
    apiKey,
    model,
    isMpRules(worldState.gameMode) ? ORDER_SYSTEM_LITERAL : ORDER_SYSTEM,
    user,
  );
  const parsed = extractJsonObject(content);
  let orders = sanitizeOrders(
    parsed.orders ?? [],
    tanks,
    orderText,
    worldState,
    team,
  );
  if (!orders.length) return interpretOffline(orderText, tanks, worldState, team);
  const movedWithoutCoords = orders.every(
    (o) =>
      (o.goal !== "moveTo" && o.goal !== "holdPosition") ||
      (o.params?.x != null && o.params?.y != null),
  );
  if (!movedWithoutCoords) {
    const offline = interpretOffline(orderText, tanks, worldState, team);
    if (offline.some((o) => o.goal === "moveTo" && o.params?.x != null)) {
      return offline;
    }
  }
  return orders;
}

async function fetchLlmJson(
  provider: LlmBackend,
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.llm.timeoutMs);
  try {
    if (provider === "gemini") {
      const res = await fetch(geminiGenerateUrl(apiKey, model), {
        method: "POST",
        signal: controller.signal,
        headers: geminiHeaders(apiKey),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Gemini HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
        );
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    }

    if (provider === "anthropic") {
      const res = await fetch(CONFIG.llm.anthropic.path, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature: 0.2,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Anthropic HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
        );
      }
      const data = (await res.json()) as {
        content?: { type?: string; text?: string }[];
      };
      const text =
        data.content?.find((c) => c.type === "text")?.text ??
        data.content?.[0]?.text ??
        "{}";
      return text;
    }

    const chatProvider = provider === "openrouter" ? "openrouter" : "openai";
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const res = await fetchOpenAiCompatible(
      chatProvider,
      apiKey,
      model,
      messages,
      {
        temperature: 0.2,
        maxTokens: 1024,
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const label = chatProvider === "openrouter" ? "OpenRouter" : "OpenAI";
      throw new Error(
        `${label} HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
      );
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? "{}";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("LLM timed out");
    }
    if (err instanceof TypeError) {
      throw new Error(`LLM network error (${err.message})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

