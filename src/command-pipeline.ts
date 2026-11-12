/**
 * Radio sentence ? orders, with an experimental local parser in the middle.
 *
 *   1. Phrase reader (planUtterance / move-to-mark). Unchanged.
 *   2. Needle sidecar, only when enabled and the phrase reader did not settle.
 *   3. interpretOrder's phrase reader and optional LLM API. Unsettled keyword
 *      guesses are discarded; a failed parse never retasks a tank.
 *
 * When Needle answers with an accepted or a confident "not a command"
 * reading, it has final authority and step 3 does not run. Every admitted
 * command leaves one comparison record; hot-mic chatter is ignored.
 */
import { CONFIG } from "./config";
import { onOrderEvent, type OrderEvent } from "./interrupt-stack";
import { hasPartialCommandIntent, normalizeRadioText } from "./radio";
import { describeIntent, type CommandIntent, type CommandSource } from "./command-schema";
import { intentsToOrders } from "./command-resolver";
import {
  consultNeedle,
  needleSidecarEnabled,
  type NeedleVerdict,
} from "./needle-sidecar";
import {
  interpretOrder,
  isGoalKind,
  normalizeSpokenNumbers,
  parseMoveToMark,
  phraseReaderHandles,
  planUtterance,
  type OrderPlan,
} from "./orders";
import type {
  InterpretBundle,
  InterpretContext,
  OrderResult,
  Tank,
  TeamId,
  WorldState,
} from "./types";

export interface CommandRecord {
  id: number;
  at: number;
  team: TeamId;
  raw_text: string;
  sidecar: boolean;
  fast_path_result: {
    settled: boolean;
    reading: string | null;
    /** Why the sidecar did not trust a phrase-reader match. */
    vetoed?: string;
  };
  needle_result: (NeedleVerdict & { late?: boolean }) | null;
  llm_result: {
    attempted: boolean;
    ok: boolean | null;
    error?: string;
    reading: string | null;
    ms: number | null;
  };
  which_path_executed: CommandSource;
  source?: "ai_commander";
  issuer?: "ai_commander";
  intent?: CommandIntent;
  tanks?: string[];
  reason?: string;
  issuedAt?: number;
  appliedAt?: number;
  seed?: number;
  goals: string[];
  /** Goal lifecycle reasons, separate from the human parse-only score. */
  orderEvents?: OrderEvent[];
  notice?: string;
  /** Sentence in ? orders out. */
  latency_ms: number;
  /** Sentence in ? goals written on the tanks. */
  command_to_goal_ms: number | null;
  /**
   * "Company: standby" ? the first acknowledgement caption, wall-clock ms.
   * Null when the copy rate limit kept the company silent.
   */
  t_ack_ms: number | null;
  /** Repeats of this sentence to these tanks swallowed by the dedupe gate. */
  repeat_count: number;
  /** Goal interrupts that fired while this command owned the hulls. */
  interrupts: number;
  /** 1 when an addressee was destroyed with its stuck flag on. */
  died_stuck: number;
}

const records: CommandRecord[] = [];
const listeners = new Set<(rec: CommandRecord) => void>();
let nextId = 1;
let observingOrders = false;

export function onCommandRecord(fn: (rec: CommandRecord) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function commandLog(): readonly CommandRecord[] {
  return records;
}

function publish(rec: CommandRecord): void {
  for (const fn of listeners) fn(rec);
}

/** Republish without appending another history row; the panel updates in place. */
export function refreshCommandRecord(record: CommandRecord): void {
  publish(record);
}

/** The record a lifecycle `commandId` belongs to; negative ids are scripted. */
function findCommandRecord(world: WorldState, commandId: number): CommandRecord | undefined {
  return commandId < 0
    ? Object.values(world.commanders ?? {}).flatMap((state) => state.orders).findLast((r) => r.id === commandId)
    : world.humanCommands?.findLast((r) => r.id === commandId);
}

/** Update the already-published command, never append another history row. */
export function recordReason(event: OrderEvent, world: WorldState): void {
  if (event.commandId == null) return;
  const record = findCommandRecord(world, event.commandId);
  if (!record) return; // Initial events are attached by game apply before completion.
  const events = record.orderEvents ??= [];
  if (events.some((e) => e === event || (
    e.t === event.t && e.tankId === event.tankId && e.type === event.type &&
    e.reason === event.reason && e.caption === event.caption
  ))) return;
  events.push({ ...event });
  if (event.type === "interrupted") record.interrupts += 1;
  publish(record);
}

/** A hull destroyed with its stuck flag on: the order died stalled, not fighting. */
export function markDiedStuck(world: WorldState, commandId: number | undefined): void {
  if (commandId == null) return;
  const record = findCommandRecord(world, commandId);
  if (!record || record.died_stuck) return;
  record.died_stuck = 1;
  publish(record);
}

function remember(rec: CommandRecord): void {
  records.push(rec);
  while (records.length > CONFIG.needle.logSize) records.shift();
  console.debug("[command]", rec);
  publish(rec);
}

function describePlan(plan: OrderPlan): string {
  const who = plan.addressedIds.join(",");
  if (plan.goal === "attackNearest") {
    return `attackNearest([${who}] → enemy ${plan.enemyNumbers.join(",")})`;
  }
  const where = plan.side ? `${plan.side} flank` : (plan.landmark ?? "point");
  return `moveTo([${who}] → ${where}${plan.risk === "stealth" ? ", stealth" : ""})`;
}

/** Group identical goals: "#4,#6 attackNearest(red-2)". */
export function describeOrders(orders: OrderResult[], tanks: Tank[]): string[] {
  const groups = new Map<string, number[]>();
  for (const o of orders) {
    const p = o.params ?? {};
    const detail = p.targetTankIds?.length
      ? p.targetTankIds.join("+")
      : p.targetTankId
        ? p.targetTankId
        : p.x != null && p.y != null
          ? `${Math.round(p.x)},${Math.round(p.y)}${p.side ? ` ${p.side}` : ""}`
          : "";
    const key = `${o.goal}(${detail})`;
    const n = tanks.find((t) => t.id === o.tankId)?.number ?? 0;
    const list = groups.get(key) ?? [];
    list.push(n);
    groups.set(key, list);
  }
  return [...groups].map(([goal, nums]) => `#${nums.join(",#")} ${goal}`);
}

/**
 * A phrase-reader match the sidecar does not trust: "6 take the left of 5"
 * reads #5 as a second addressee instead of the tank being flanked.
 */
function fastPathVeto(text: string, plan: OrderPlan | null): string | undefined {
  if (plan?.goal !== "moveTo") return undefined;
  if (/\b(?:left|right|side|flank)\s+of\s+#?[1-6]\b/i.test(text)) {
    return "relative to another tank; the phrase reader would order that tank too";
  }
  return undefined;
}

/** Mirrors interpretOrder's branches: when does it call the API? */
function llmWouldRun(
  ctx: InterpretContext,
  plan: OrderPlan | null,
  markMatched: boolean,
  keywordHandled: boolean,
): boolean {
  if (!ctx.apiKey) return false;
  if (plan) return plan.goal === "moveTo" && !plan.notice;
  if (markMatched || keywordHandled) return false;
  return true;
}

function sourceOf(bundle: InterpretBundle): CommandSource {
  if (bundle.source === "llm") return "llm_api";
  if (bundle.source === "needle") return bundle.results.length ? "needle" : "none";
  return bundle.results.length ? "phrase_reader" : "none";
}

/** Explicit offline phrases that interpretOrder handles without inventing a goal.
 * In particular, "all attack" has no numbered target and is not an OrderPlan.
 */
function explicitOfflinePhrase(text: string): boolean {
  const body = normalizeRadioText(text).replace(
    /^(?:(?:please|all|everyone|team|tanks?|scouts?|heavies|heavy|lights?|shooters?|gunners?|[1-6]|and)\s+)+/,
    "",
  );
  if (/^(?:attack|engage|hunt|push)(?: (?:the |nearest )?(?:enemy|enemies|base))?$/.test(body)) return true;
  if (/^(?:keep moving|keep rolling|stay mobile|patrol|roam|scout|recon|probe|screen|report(?: in)?|radio in)$/.test(body)) return true;
  return /^(?:(?:move|go|head|advance|take|flank) (?:to |to the |the )?)?(?:(?:top|bottom|upper|lower|north|south) )?(?:north|south|east|west|left|right|center|middle|choke|bunker|eagle|base|home|top|bottom|north choke)$/.test(body);
}

export async function interpretCommand(
  orderText: string,
  tanks: Tank[],
  world: WorldState,
  ctx: InterpretContext = {},
  team: TeamId = "blue",
): Promise<{ bundle: InterpretBundle; record: CommandRecord }> {
  const t0 = performance.now();
  const sidecar = needleSidecarEnabled();
  const hasIntent = hasPartialCommandIntent(orderText);
  const text = hasIntent ? normalizeSpokenNumbers(orderText.trim()).replace(
    /^(?:(?:tanks?\s+)?#?[1-6]\b(?:\s*(?:,|\band\b)\s*)?)+/i,
    (address) => address.replace(/,\s*/g, " "),
  ) : "";
  const plan = text ? planUtterance(text, tanks, world, team) : null;
  const markMatched = text ? parseMoveToMark(text) != null : false;
  const keywordHandled = text ? phraseReaderHandles(text) : false;
  const explicitPhrase = text ? explicitOfflinePhrase(text) : false;
  const settled = plan != null || markMatched || keywordHandled || explicitPhrase;
  const vetoed = sidecar ? fastPathVeto(text, plan) : undefined;

  const record: CommandRecord = {
    id: nextId++,
    at: Date.now(),
    team,
    raw_text: orderText,
    sidecar,
    fast_path_result: {
      settled,
      reading: plan
        ? describePlan(plan)
        : markMatched
          ? "moveTo(mark)"
          : keywordHandled || explicitPhrase
            ? "phrase"
            : null,
      vetoed,
    },
    needle_result: null,
    llm_result: { attempted: false, ok: null, reading: null, ms: null },
    which_path_executed: "none",
    goals: [],
    latency_ms: 0,
    command_to_goal_ms: null,
    t_ack_ms: null,
    repeat_count: 0,
    interrupts: 0,
    died_stuck: 0,
  };

  // Chatter must never reach either deterministic or asynchronous readers.
  if (!hasIntent) {
    record.reason = "no_command";
    return { bundle: { results: [], source: "mock", ms: 0 }, record };
  }

  let bundle: InterpretBundle | null = null;

  try {
    if (sidecar && text && (!settled || vetoed)) {
      const verdict = await consultNeedle(text, world, team, (late) => {
        record.needle_result = { ...late, late: true };
        console.debug("[command] late needle answer", record.id, late);
        publish(record);
      });
      record.needle_result = verdict;
      if (verdict.status === "accepted") {
        const resolved = intentsToOrders(world, team, verdict.intents);
        bundle = {
          results: resolved.orders,
          source: "needle",
          ms: Math.round(performance.now() - t0),
          notice: resolved.notice,
        };
      } else if (verdict.status === "no_command") {
        bundle = {
          results: [],
          source: "needle",
          ms: Math.round(performance.now() - t0),
          notice: "Not an order — nothing sent.",
        };
      }
    } else if (sidecar && text) {
      record.needle_result = {
        status: "skipped_fast_path",
        confidence: null,
        calls: [],
        suppressed: [],
        intents: [],
        ms: null,
      };
    }

    if (!bundle) {
      const attempted = llmWouldRun(ctx, plan, markMatched, keywordHandled);
      bundle = await interpretOrder(text, tanks, world, ctx, team);
      record.llm_result = {
        attempted,
        ok: bundle.source === "llm" ? true : bundle.llmError ? false : attempted ? false : null,
        error: bundle.llmError,
        reading: bundle.source === "llm" ? describeOrders(bundle.results, tanks).join("; ") : null,
        ms: attempted ? bundle.ms : null,
      };
    }
  } catch (error) {
    bundle = {
      results: [], source: "mock", ms: Math.round(performance.now() - t0),
      notice: error instanceof Error ? error.message : "Unable to parse order.",
    };
  }

  // interpretOrder retains legacy keyword guesses for other callers. Radio must
  // not execute those after an unsettled read or a failed/empty model response.
  if (bundle.source === "mock" && (!settled || vetoed)) {
    bundle = { ...bundle, results: [], notice: "Order not understood — nothing sent." };
  }
  bundle.results = bundle.results.filter((r) =>
    isGoalKind(r.goal) &&
    tanks.some((t) => t.id === r.tankId && t.team === team && t.alive) &&
    r.chatLine !== "No living tanks to take that order." &&
    (r.params?.x == null || Number.isFinite(r.params.x)) &&
    (r.params?.y == null || Number.isFinite(r.params.y)) &&
    (r.goal !== "moveTo" || (Number.isFinite(r.params?.x) && Number.isFinite(r.params?.y))),
  );
  if (!bundle.results.length) record.reason = "parse_failed";
  record.which_path_executed = sourceOf(bundle);
  record.notice = bundle.notice;
  record.latency_ms = Math.round((performance.now() - t0) * 10) / 10;
  for (const r of bundle.results) r.commandSource = record.which_path_executed;
  return { bundle, record };
}

export function scriptedCommandRecord(
  team: TeamId,
  intent: CommandIntent,
  reason: string,
  issuedAt: number,
  seed: number,
  sequence: number,
): CommandRecord {
  return {
    id: -(sequence * 2 + (team === "red" ? 1 : 0)),
    at: issuedAt * 1000,
    team,
    raw_text: describeIntent(intent),
    sidecar: false,
    fast_path_result: { settled: true, reading: describeIntent(intent) },
    needle_result: null,
    llm_result: { attempted: false, ok: null, reading: null, ms: null },
    which_path_executed: "ai_commander",
    source: "ai_commander",
    issuer: "ai_commander",
    intent: structuredClone(intent),
    tanks: [],
    reason,
    issuedAt,
    seed,
    goals: [],
    latency_ms: 0,
    command_to_goal_ms: null,
    t_ack_ms: null,
    repeat_count: 0,
    interrupts: 0,
    died_stuck: 0,
  };
}

export function recordMatchOutcome(
  world: WorldState,
  outcome: "win" | "lose" | "draw",
  reason: string,
): void {
  const record: CommandRecord = {
    id: nextId++,
    at: Date.now(),
    team: "blue",
    raw_text: `Match outcome: ${outcome} — ${reason}`,
    sidecar: false,
    fast_path_result: { settled: true, reading: reason },
    needle_result: null,
    llm_result: { attempted: false, ok: null, reading: null, ms: null },
    which_path_executed: "none",
    reason: "match_outcome",
    goals: [outcome, reason],
    appliedAt: world.time,
    latency_ms: 0,
    command_to_goal_ms: 0,
    t_ack_ms: null,
    repeat_count: 0,
    interrupts: 0,
    died_stuck: 0,
  };
  remember(record);
}

/** Called once the goals are on the tanks. */
export function completeCommandRecord(
  world: WorldState,
  record: CommandRecord,
  applied: OrderResult[],
  tanks: Tank[],
  commandToGoalMs: number,
): void {
  if (!observingOrders) {
    onOrderEvent(recordReason);
    observingOrders = true;
  }
  record.goals = describeOrders(applied, tanks);
  if (!applied.length && !record.reason) record.reason = "no_valid_orders";
  record.command_to_goal_ms = Math.round(commandToGoalMs * 10) / 10;
  if (record.source !== "ai_commander") {
    const commands = world.humanCommands ??= [];
    commands.push(record);
    while (commands.length > CONFIG.needle.logSize) commands.shift();
  }
  remember(record);
}

/** Intent text for the overlay, independent of how the orders came out. */
export function describeNeedleReading(v: NeedleVerdict): string {
  if (v.intents.length) return v.intents.map(describeIntent).join("; ");
  const calls = v.calls.length ? v.calls : v.suppressed;
  return calls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join("; ");
}
