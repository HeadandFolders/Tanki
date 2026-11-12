/**
 * EXPERIMENTAL local parser: Cactus Needle, run between the phrase reader and
 * the LLM API. This module owns the engine handle, the timeout, the
 * confidence gate, and the checks against the words actually spoken. It
 * never writes goals; accepted intents go to command-resolver.
 */
import { CONFIG } from "./config";
import {
  TOOL_SCHEMAS,
  parseIntent,
  type CommandIntent,
} from "./command-schema";
import { commanderOf } from "./command-resolver";
import type { TeamId, WorldState } from "./types";

export interface NeedleCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** The subset of Needle's completion envelope the sidecar reads. */
export interface NeedleRawResult {
  type: string;
  success: boolean;
  error: string | null;
  confidence: number | null;
  function_calls: NeedleCall[];
  suppressed_calls: NeedleCall[];
}

/** Anything that can answer like Needle: the browser worker, Node, or a test double. */
export interface NeedleEngine {
  complete(text: string): Promise<NeedleRawResult>;
}

export type NeedleStatus =
  | "disabled"
  | "skipped_fast_path"
  | "not_ready"
  | "busy"
  | "timeout"
  | "error"
  | "low_confidence"
  | "invalid"
  | "ungrounded"
  | "no_command"
  | "accepted";

export interface NeedleVerdict {
  status: NeedleStatus;
  confidence: number | null;
  /** What Needle emitted, before any checks. */
  calls: NeedleCall[];
  suppressed: NeedleCall[];
  /** Validated, grounded intents. Executed only when status is "accepted". */
  intents: CommandIntent[];
  reason?: string;
  ms: number | null;
}

/** Facts given to the model with every sentence. */
export const NEEDLE_SYSTEM =
  "Tank radio. Friendly bots are hull numbers 1-6. The speaker is the player; 'me', 'I', 'I'll' mean the player. Enemy tanks are also numbered 1-6.";

/** Tool definitions in the shape `tool()` from cactus-needle accepts. */
export function needleToolOptions(): {
  [K in keyof typeof TOOL_SCHEMAS]: {
    description: string;
    inputSchema: (typeof TOOL_SCHEMAS)[K]["inputSchema"];
  };
} {
  return TOOL_SCHEMAS;
}

type EngineState =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "ready"; engine: NeedleEngine }
  | { kind: "failed"; error: string };

let state: EngineState = { kind: "off" };
let enabled: boolean = CONFIG.needle.use_needle_sidecar;
let inFlight = false;

export function needleSidecarEnabled(): boolean {
  return enabled;
}

export function setNeedleSidecarEnabled(on: boolean): void {
  enabled = on;
}

export function needleEngineState(): EngineState["kind"] {
  return state.kind;
}

export function setNeedleEngineLoading(): void {
  state = { kind: "loading" };
}

export function setNeedleEngine(engine: NeedleEngine | null, error?: string): void {
  state = engine
    ? { kind: "ready", engine }
    : error
      ? { kind: "failed", error }
      : { kind: "off" };
  inFlight = false;
}

function verdict(
  status: NeedleStatus,
  ms: number | null,
  raw?: NeedleRawResult,
  reason?: string,
  intents: CommandIntent[] = [],
): NeedleVerdict {
  return {
    status,
    confidence: raw?.confidence ?? null,
    calls: raw?.function_calls ?? [],
    suppressed: raw?.suppressed_calls ?? [],
    intents,
    reason,
    ms,
  };
}

/**
 * Ask Needle. Resolves within the timeout; a slower answer is passed to
 * `onLate` instead and is never executed. One sentence at a time: while an
 * answer is outstanding, the next sentence skips Needle.
 */
export function consultNeedle(
  text: string,
  world: WorldState,
  team: TeamId,
  onLate: (late: NeedleVerdict) => void,
): Promise<NeedleVerdict> {
  if (state.kind === "loading" || state.kind === "off") {
    return Promise.resolve(verdict("not_ready", null, undefined, `engine ${state.kind}`));
  }
  if (state.kind === "failed") {
    return Promise.resolve(verdict("error", null, undefined, state.error));
  }
  if (inFlight) {
    return Promise.resolve(verdict("busy", null, undefined, "previous sentence still decoding"));
  }
  const engine = state.engine;
  const t0 = performance.now();
  inFlight = true;
  const answer = engine.complete(text).then(
    (raw) => {
      inFlight = false;
      return judge(raw, text, world, team, Math.round(performance.now() - t0));
    },
    (err: unknown) => {
      inFlight = false;
      const msg = err instanceof Error ? err.message : String(err);
      return verdict("error", Math.round(performance.now() - t0), undefined, msg);
    },
  );
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(
        verdict("timeout", null, undefined, `no answer within ${CONFIG.needle.timeoutMs}ms`),
      );
    }, CONFIG.needle.timeoutMs);
    void answer.then((v) => {
      if (settled) {
        onLate(v);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(v);
    });
  });
}

const EVERYONE = /\b(everyone|everybody|all|team|company|squad)\b/i;

function spokenCounts(text: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const m of text.matchAll(/(?:#|\b)([1-6])\b/g)) {
    const n = Number(m[1]);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}

function referenceOf(intent: CommandIntent): number | null {
  if (intent.tool === "attack" || intent.tool === "surround") return intent.target_id;
  if (intent.tool === "flank") return intent.reference_id;
  return null;
}

function mergeKey(intent: CommandIntent): string {
  switch (intent.tool) {
    case "attack":
    case "surround":
      return `${intent.tool}|${intent.target_id}`;
    case "attack_base":
    case "defend_base":
      return intent.tool;
    case "cover":
      return "cover";
    case "flank":
      return `flank|${intent.reference_id}|${intent.side}`;
    case "move_to":
      return intent.ref.type === "marker"
        ? "move_to|marker"
        : `move_to|${intent.ref.direction}`;
  }
}

/**
 * Gate one Needle answer. Confidence first, then schema, then every number in
 * every call must have been spoken. A call that only names the player's own
 * unspoken hull is the player's clause and is dropped. Anything else that
 * was not spoken rejects the whole answer.
 */
export function judge(
  raw: NeedleRawResult,
  text: string,
  world: WorldState,
  team: TeamId,
  ms: number,
): NeedleVerdict {
  if (!raw.success) return verdict("error", ms, raw, raw.error ?? "engine error");
  const threshold = CONFIG.needle.threshold;
  if (raw.confidence == null || raw.confidence < threshold) {
    return verdict(
      "low_confidence",
      ms,
      raw,
      `confidence ${raw.confidence ?? "none"} < ${threshold}`,
    );
  }

  const parsed: CommandIntent[] = [];
  for (const call of raw.function_calls) {
    const intent = parseIntent(call.name, call.arguments);
    if (!intent) return verdict("invalid", ms, raw, `${call.name} does not fit the schema`);
    parsed.push(intent);
  }

  const spoken = spokenCounts(text);
  const everyone = EVERYONE.test(text);
  const player = commanderOf(world, team);
  const bots = world.tanks
    .filter((t) => t.team === team && t.alive && t.id !== player?.id)
    .map((t) => t.number);

  const grounded: CommandIntent[] = [];
  for (const intent of parsed) {
    const ref = referenceOf(intent);
    if (ref != null && !spoken.has(ref)) {
      return verdict("ungrounded", ms, raw, `#${ref} was not spoken`);
    }
    let ids: number[];
    if (everyone && !intent.tank_ids.some((n) => spoken.has(n))) {
      ids = bots;
    } else {
      ids = [];
      for (const n of intent.tank_ids) {
        if (spoken.has(n)) ids.push(n);
        else if (n === player?.number) continue;
        else return verdict("ungrounded", ms, raw, `#${n} was not spoken`);
      }
      if (ref != null && ids.includes(ref) && (spoken.get(ref) ?? 0) < 2) {
        return verdict(
          "ungrounded",
          ms,
          raw,
          `#${ref} is both an addressee and the ${intent.tool} reference`,
        );
      }
    }
    if (!ids.length) continue;
    grounded.push({ ...intent, tank_ids: ids });
  }

  const merged = new Map<string, CommandIntent>();
  for (const intent of grounded) {
    const key = mergeKey(intent);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, intent);
      continue;
    }
    const ids = [...prev.tank_ids];
    for (const n of intent.tank_ids) if (!ids.includes(n)) ids.push(n);
    merged.set(key, { ...prev, tank_ids: ids });
  }

  const intents = [...merged.values()];
  if (!intents.length) {
    return verdict("no_command", ms, raw, "no bot command in this sentence");
  }
  return verdict("accepted", ms, raw, undefined, intents);
}
