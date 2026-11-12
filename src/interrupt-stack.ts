import { CONFIG, isMpRules } from "./config";
import { beliefFor } from "./belief";
import { canSeeTank } from "./fog";
import { resetRadio } from "./radio";
import type { Goal, Tank, TeamContact, Vec2, WorldState } from "./types";

export type InterruptReason = "panic_melee" | "hp_retreat";
export type OrderReason = InterruptReason | "los_shot_on_path" | "prey_dead_hold" | "prey_lost" |
  "escort_slot_blocked" | "stuck" | "order_received" | "order_replaced" |
  "order_complete" | "order_unsupported" | "escort_lost" | "tank_destroyed" | "match_ended";
export interface OrderEvent {
  t: number;
  tankId: string;
  commandId?: number;
  type: "applied" | "success" | "interrupted" | "resumed" | "expired" | "replaced" | "deviation";
  reason: OrderReason;
  caption: string;
}
export interface HpInterrupt {
  kind: "retreat";
  reason: InterruptReason;
  until: number;
  clearSince: number | null;
}
export interface InterruptStack {
  base: Goal;
  interrupt: HpInterrupt | null;
  blockedUntil: number;
  releasedInClear: boolean;
  hpLatched: boolean;
  hpClearSince: number | null;
  hpUntil: number;
  panicBlockedUntil: number;
  status: "active" | "interrupted" | "success" | "expired" | "replaced";
  preyId?: string;
  lastContact?: TeamContact;
  deviations: OrderReason[];
  lastCopyAt: number;
}
export interface InterruptTransition {
  type: "interrupted" | "resumed" | "expired";
  reason: InterruptReason;
  replacement?: InterruptReason;
}
const listeners = new Set<(event: OrderEvent, world: WorldState) => void>();
export function onOrderEvent(listener: (event: OrderEvent, world: WorldState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function createInterruptStack(base: Goal): InterruptStack {
  return {
    base: structuredClone(base), interrupt: null, blockedUntil: 0, releasedInClear: false,
    hpLatched: false, hpClearSince: null, hpUntil: 0, panicBlockedUntil: 0,
    status: "active", deviations: [], lastCopyAt: -1e9,
  };
}
export function effectiveGoal(stack: InterruptStack): Goal {
  return stack.interrupt ? { kind: stack.interrupt.kind, source: "system" } : stack.base;
}
export function goalState(goal: Goal): Pick<Tank, "goal" | "orderStack"> {
  const stack = createInterruptStack(goal);
  return { goal: stack.base, orderStack: stack };
}
export function restoreGoal(tank: Tank, goal: Goal, stack = createInterruptStack(goal)): void {
  tank.orderStack = stack;
  writeEffective(tank);
}
export function stackFor(tank: Tank): InterruptStack {
  return tank.orderStack ??= createInterruptStack(tank.goal);
}
function writeEffective(tank: Tank): void {
  (tank as { goal: Goal }).goal = effectiveGoal(stackFor(tank));
}
function emit(world: WorldState, tank: Tank, type: OrderEvent["type"], reason: OrderReason, text: string,
  audible = true): void {
  const event: OrderEvent = {
    t: world.time, tankId: tank.id, commandId: stackFor(tank).base.commandId,
    type, reason, caption: `#${tank.number} ${CONFIG.roles[tank.role].label} ${text}`,
  };
  (world.orderEvents ??= []).push(event);
  if (type === "expired") resetRadio(world, tank.team);
  if (audible) {
    world.chat.push({ t: world.time, team: tank.team, text: event.caption,
      kind: type === "expired" || type === "interrupted" ? "warn" : "ally" });
    if (world.chat.length > 80) world.chat.shift();
  }
  for (const listener of listeners) listener(event, world);
}
function hold(tank: Tank, base: Goal): Goal {
  return { kind: "holdPosition", source: base.source ?? "system", commandId: base.commandId,
    commandSource: base.commandSource, issuer: base.issuer, noRetreat: base.noRetreat,
    params: { x: tank.x, y: tank.y } };
}
export function describeGoal(goal: Goal): string {
  switch (goal.kind) {
    case "attackNearest": return `attacking ${goal.params?.targetTankId?.split("-").pop() ?? "assigned targets"}`;
    case "attackBase": return "attacking the base";
    case "moveTo": return "moving";
    case "holdPosition": return "holding";
    case "escort": return "covering";
    case "retreat": return "falling back";
    case "reportIn": return "reporting in";
    case "spreadOut": return "spreading out";
    case "debug": return "checking wreck";
    case "patrol": return "patrolling";
    case "scout": return "scouting";
    case "idle": return "holding";
  }
}
export function orderAcknowledgement(world: WorldState, tank: Tank): string {
  const stack = stackFor(tank);
  if (stack.interrupt) return stack.interrupt.reason === "hp_retreat" ? "negative, low HP" : "negative, close threat";
  if (isMpRules(world.gameMode) && ["debug", "scout", "patrol", "reportIn", "idle"].includes(stack.base.kind)) {
    return "negative, order unsupported in this mode";
  }
  return stack.status === "active" ? `copy, ${describeGoal(stack.base)}` : "order ended; holding";
}
export function assignOrder(world: WorldState, tank: Tank, goal: Goal, shared = false): void {
  const stack = stackFor(tank);
  if (stack.base.source === "player" && ["active", "interrupted"].includes(stack.status)) {
    emit(world, tank, "replaced", "order_replaced", "previous order replaced");
  }
  stack.base = structuredClone(goal);
  stack.status = stack.interrupt ? "interrupted" : "active";
  delete stack.preyId;
  delete stack.lastContact;
  stack.deviations = [];
  writeEffective(tank);
  const before = world.orderEvents?.length ?? 0;
  updateInterruptStack(world, tank);
  const denied = stack.interrupt?.reason;
  const text = orderAcknowledgement(world, tank);
  const negative = text.startsWith("negative");
  if (negative) resetRadio(world, tank.team);
  const justBarked = (world.orderEvents?.length ?? 0) > before;
  const audible = !shared && !justBarked && (negative || world.time - stack.lastCopyAt >= 2);
  emit(world, tank, "applied", denied ?? (negative ? "order_unsupported" : "order_received"), text, audible);
  if (audible && !negative) stack.lastCopyAt = world.time;
}

export function setGoal(world: WorldState, tank: Tank, goal: Goal,
  outcome?: "success" | "expired", reason: OrderReason = "order_complete", text?: string): void {
  const stack = stackFor(tank);
  if (stack.interrupt) return;
  const completing = outcome ?? (stack.base.kind !== goal.kind ? "success" : undefined);
  if (completing && stack.base.source === "player" && stack.status === "active") {
    emit(world, tank, completing, reason, text ?? (completing === "expired" ? "unable, holding" : "order complete, holding"));
    stack.status = completing;
    goal = { ...goal, source: "player", commandId: stack.base.commandId,
      commandSource: stack.base.commandSource, issuer: stack.base.issuer, noRetreat: stack.base.noRetreat };
  }
  stack.base = structuredClone(goal);
  writeEffective(tank);
}
export function finishOrder(world: WorldState, tank: Tank, outcome: "success" | "expired",
  reason: OrderReason, text: string): void {
  const stack = stackFor(tank);
  if (!["active", "interrupted"].includes(stack.status)) return;
  if (stack.interrupt && (reason === "tank_destroyed" || reason === "match_ended")) {
    emit(world, tank, "deviation", stack.interrupt.reason, "interrupt ended; order closed");
    stack.interrupt = null;
  }
  if (stack.base.source === "player") emit(world, tank, outcome, reason, text);
  stack.status = outcome;
  stack.base = hold(tank, stack.base);
  writeEffective(tank);
}
export function noteDeviation(world: WorldState, tank: Tank, reason: OrderReason, active: boolean, text: string): void {
  const stack = stackFor(tank);
  const was = stack.deviations.includes(reason);
  if (!active) stack.deviations = stack.deviations.filter((r) => r !== reason);
  else if (!was && stack.base.source === "player") {
    stack.deviations.push(reason);
    emit(world, tank, "deviation", reason, text);
  }
}

interface InterruptContext {
  now: number;
  hpFraction: number;
  threatNearby: boolean;
  panic?: boolean;
  resumeValid: boolean;
  position: Vec2;
}
export function advanceInterrupts(stack: InterruptStack, context: InterruptContext): InterruptTransition[] {
  const { now, hpFraction, threatNearby } = context;
  const commit = CONFIG.mpOffline.panicCommitSec;
  if (threatNearby) { stack.releasedInClear = false; stack.hpClearSince = null; }
  else stack.hpClearSince ??= now;
  const clear = stack.hpClearSince != null && now - stack.hpClearSince >= commit;
  const exempt = stack.base.noRetreat || stack.base.kind === "retreat" || stack.base.kind === "reportIn";
  if (stack.hpLatched && (exempt || (now >= stack.hpUntil && (hpFraction >= CONFIG.ai.retreatResumeHpFraction || clear)))) {
    stack.hpLatched = false;
    stack.blockedUntil = now + commit;
    stack.releasedInClear = clear && hpFraction < CONFIG.ai.retreatResumeHpFraction;
  }
  if (!stack.hpLatched && !exempt && hpFraction <= CONFIG.ai.retreatHpFraction &&
    now >= stack.blockedUntil && !stack.releasedInClear) {
    stack.hpLatched = true;
    stack.hpUntil = now + commit;
  }
  const current = stack.interrupt;
  const retainPanic = current?.reason === "panic_melee" && (now < current.until || threatNearby ||
    current.clearSince == null || now - current.clearSince < commit);
  if (current?.reason === "panic_melee") {
    if (threatNearby) current.clearSince = null;
    else current.clearSince ??= now;
  }
  const panic = !stack.base.noRetreat && (retainPanic || (context.panic && now >= stack.panicBlockedUntil));
  const wanted: InterruptReason | null = panic ? "panic_melee" : stack.hpLatched ? "hp_retreat" : null;
  if (current?.reason === wanted) return [];
  const transitions: InterruptTransition[] = [];
  if (current) {
    stack.interrupt = null;
    if (current.reason === "panic_melee") stack.panicBlockedUntil = now + commit;
    if (!wanted && !context.resumeValid) {
      stack.base = { ...stack.base, kind: "holdPosition", params: { ...context.position } };
      transitions.push({ type: "expired", reason: current.reason });
    } else transitions.push({ type: "resumed", reason: current.reason, ...(wanted ? { replacement: wanted } : {}) });
  }
  if (wanted) {
    stack.interrupt = { kind: "retreat", reason: wanted, until: now + commit,
      clearSince: threatNearby ? null : now };
    transitions.push({ type: "interrupted", reason: wanted });
  }
  return transitions;
}
export function advanceHpInterrupt(stack: InterruptStack, context: InterruptContext): InterruptTransition | null {
  return advanceInterrupts(stack, context).at(-1) ?? null;
}

export function orderedPrey(world: WorldState, tank: Tank): Tank | null {
  const stack = stackFor(tank);
  const base = stack.base;
  if (base.kind !== "attackNearest") return null;
  const ids = base.params?.targetTankIds ?? (base.params?.targetTankId ? [base.params.targetTankId] : []);
  const clear = world.shareMode === "clear" || isMpRules(world.gameMode);
  const contacts = beliefFor(world, tank.team).contacts;
  const known = world.tanks.filter((e) => e.team !== tank.team && e.alive &&
    (clear || canSeeTank(tank, e, world.walls) || contacts.some((c) => c.enemyId === e.id && world.time - c.seenAt <= CONFIG.ai.beliefTtlSec)));
  if (!stack.preyId) {
    const candidates = known.filter((e) => !ids.length || ids.includes(e.id));
    const position = (e: Tank) => clear || canSeeTank(tank, e, world.walls) ? e : contacts.find((c) => c.enemyId === e.id)!;
    candidates.sort((a, b) => Math.hypot(position(a).x - tank.x, position(a).y - tank.y) -
      Math.hypot(position(b).x - tank.x, position(b).y - tank.y));
    stack.preyId = candidates[0]?.id ?? ids[0];
  }
  const prey = known.find((e) => e.id === stack.preyId);
  const contact = contacts.find((c) => c.enemyId === stack.preyId);
  if (contact) stack.lastContact = structuredClone(contact);
  if (!prey) return null;
  return clear || canSeeTank(tank, prey, world.walls) ? prey : { ...prey, x: contact!.x, y: contact!.y };
}
function lostText(tank: Tank): string {
  const stack = stackFor(tank);
  const last = stack.lastContact;
  let direction = "unknown";
  if (last) {
    const dx = last.x - tank.x, dy = last.y - tank.y;
    direction = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "west" : "east") : (dy < 0 ? "north" : "south");
  }
  return `lost ${stack.preyId?.split("-").pop() ?? "target"}, last seen ${direction}; holding`;
}
export function updateInterruptStack(world: WorldState, tank: Tank): void {
  const stack = stackFor(tank);
  const base = stack.base;
  const prey = base.kind === "attackNearest" && base.source === "player" ? orderedPrey(world, tank) : null;
  const preyDead = !!stack.preyId && world.tanks.some((e) => e.id === stack.preyId && !e.alive);
  const invalidPrey = base.kind === "attackNearest" && base.source === "player" && !prey;
  const foes = world.tanks.filter((e) => e.alive && e.team !== tank.team && canSeeTank(tank, e, world.walls));
  const distance = Math.min(...foes.map((e) => Math.hypot(e.x - tank.x, e.y - tank.y)));
  const transitions = advanceInterrupts(stack, { now: world.time, hpFraction: tank.hp / tank.maxHp,
    threatNearby: distance <= CONFIG.mpOffline.panicClearRadius, panic: distance <= CONFIG.ai.orderThreatRadius,
    resumeValid: true, position: tank });
  for (const transition of transitions) {
    if (transition.type === "interrupted") {
      if (stack.status === "active") stack.status = "interrupted";
      emit(world, tank, "interrupted", transition.reason,
        transition.reason === "hp_retreat" ? "falling back, low HP" : "falling back, close threat");
    } else if (transition.replacement) {
      emit(world, tank, "resumed", transition.reason, `ending ${transition.reason === "hp_retreat" ? "low HP retreat" : "close-threat retreat"}; ${transition.replacement === "hp_retreat" ? "low HP retreat" : "close threat"} takes priority`);
    } else {
      if (stack.status === "interrupted") stack.status = "active";
      if (invalidPrey) finishOrder(world, tank, "expired", preyDead ? "prey_dead_hold" : "prey_lost",
        preyDead ? "retreat clear; target down, holding" : `retreat clear; ${lostText(tank)}`);
      else emit(world, tank, "resumed", transition.reason, `retreat clear, resuming ${describeGoal(stack.base)}`);
    }
  }
  writeEffective(tank);
  if (!stack.interrupt && invalidPrey && stack.status === "active") {
    finishOrder(world, tank, preyDead ? "success" : "expired", preyDead ? "prey_dead_hold" : "prey_lost",
      preyDead ? "target down, holding" : lostText(tank));
  }
  if (!stack.interrupt && stack.base.kind === "attackBase" && !world.bases?.[tank.team === "blue" ? "red" : "blue"]?.alive) {
    finishOrder(world, tank, "success", "order_complete", "base down, holding");
  }
}
