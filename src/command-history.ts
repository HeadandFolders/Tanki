/**
 * Recognized radio commands, tagged with the reader that handled them.
 * Shown in the sidebar Janna eval list and kept as a post-mortem log that outlives the
 * tab: localStorage (postmortem.html) and, under the dev server, a text file
 * at logs/command-postmortem.log.
 */
import {
  commandLog,
  onCommandRecord,
  type CommandRecord,
} from "./command-pipeline";
import type { CommandIntent, CommandSource } from "./command-schema";
import type { GameMode } from "./config";
import type { OrderEvent } from "./interrupt-stack";

/**
 * Parser: the deterministic phrase reader settled the sentence.
 * Keyword: legacy saved records from the former best-effort fallback.
 */
export type CommandHandler = "Needle" | "API" | "Parser" | "Keyword" | "Commander" | "Match" | "Failed";

export type JannaEval = "pass" | "fail";

export interface PostmortemEntry {
  id: string;
  at: string;
  mode: GameMode;
  team: string;
  text: string;
  handler: CommandHandler;
  goals: string[];
  ms: number;
  source?: CommandSource;
  intent?: CommandIntent;
  tanks?: string[];
  reason?: string;
  orderEvents?: OrderEvent[];
  issuedAt?: number;
  seed?: number;
  /** Set from the in-game checkbox. Missing = not scored yet. */
  jannaEval?: JannaEval | null;
  /** "Company: standby" → first acknowledgement caption, wall-clock ms. Null when the copy rate limit stayed silent. */
  t_ack_ms?: number | null;
  /** Repeats of this sentence to these tanks swallowed by the dedupe gate. */
  repeat_count?: number;
  /** Goal interrupts that fired while this command owned the hulls. */
  interrupts?: number;
  /** 1 when an addressee was destroyed with its stuck flag on. */
  died_stuck?: number;
}

export const POSTMORTEM_KEY = "tanki-command-postmortem-v1";
const POSTMORTEM_CAP = 1000;
const PANEL_ROWS = 40;

export function handlerFor(
  source: CommandSource,
  fastPathSettled = true,
): CommandHandler | null {
  if (source === "needle") return "Needle";
  if (source === "llm_api") return "API";
  if (source === "phrase_reader") return fastPathSettled ? "Parser" : "Keyword";
  return null;
}

function asEntry(raw: unknown, index: number): PostmortemEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<PostmortemEntry>;
  if (typeof e.text !== "string" || typeof e.handler !== "string") return null;
  const evalRaw = e.jannaEval;
  const jannaEval =
    evalRaw === "pass" || evalRaw === "fail" ? evalRaw : null;
  return {
    id:
      typeof e.id === "string" && e.id
        ? e.id
        : `${e.at ?? "t"}-${index}-${e.text.slice(0, 24)}`,
    at: typeof e.at === "string" ? e.at : "",
    mode: (e.mode as GameMode) ?? "tdm-nofog",
    team: typeof e.team === "string" ? e.team : "blue",
    text: e.text,
    handler: e.handler as CommandHandler,
    goals: Array.isArray(e.goals) ? e.goals.map(String) : [],
    ms: typeof e.ms === "number" ? e.ms : 0,
    source: e.source,
    intent: e.intent,
    tanks: e.tanks,
    reason: e.reason,
    orderEvents: Array.isArray(e.orderEvents) ? e.orderEvents : undefined,
    issuedAt: e.issuedAt,
    seed: e.seed,
    jannaEval: e.source === "ai_commander" ? null : jannaEval,
    t_ack_ms: typeof e.t_ack_ms === "number" ? e.t_ack_ms : (e.t_ack_ms ?? null),
    repeat_count: typeof e.repeat_count === "number" ? e.repeat_count : 0,
    interrupts: typeof e.interrupts === "number" ? e.interrupts : 0,
    died_stuck: typeof e.died_stuck === "number" ? e.died_stuck : 0,
  };
}

export function readPostmortem(): PostmortemEntry[] {
  try {
    const raw = localStorage.getItem(POSTMORTEM_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row, i) => asEntry(row, i))
      .filter((row): row is PostmortemEntry => row != null);
  } catch {
    return [];
  }
}

function writePostmortem(all: PostmortemEntry[]): void {
  try {
    localStorage.setItem(POSTMORTEM_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked; the disk log below still gets the line.
  }
}

function savePostmortem(entry: PostmortemEntry): void {
  const all = readPostmortem();
  const index = all.findIndex((e) => e.id === entry.id);
  if (index < 0) all.push(entry);
  else {
    // Lifecycle updates and late parser answers must preserve the human score,
    // including a score changed in the post-mortem tab since this row mounted.
    entry.jannaEval = all[index]!.jannaEval;
    all[index] = entry;
  }
  while (all.length > POSTMORTEM_CAP) all.shift();
  writePostmortem(all);
  void fetch("/__command-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
    keepalive: true,
  }).catch(() => {});
}

/** Persist a Janna mark. `null` means unreported. */
export function setJannaEval(id: string, value: JannaEval | null): void {
  const all = readPostmortem();
  const entry = all.find((e) => e.id === id);
  if (!entry || entry.source === "ai_commander") return;
  entry.jannaEval = value;
  writePostmortem(all);
}

function cycleJannaEval(cur: JannaEval | null | undefined): JannaEval | null {
  if (cur !== "fail" && cur !== "pass") return "fail";
  if (cur === "fail") return "pass";
  return null;
}

function paintJannaBox(
  row: HTMLElement,
  box: HTMLButtonElement,
  value: JannaEval | null | undefined,
  command: string,
): void {
  if (value === "pass" || value === "fail") row.dataset.janna = value;
  else delete row.dataset.janna;
  const label =
    value === "pass"
      ? "parse correct"
      : value === "fail"
        ? "parse incorrect"
        : "parse unscored";
  box.title = `Janna (parse only): ${label}. Click to cycle blank → incorrect → correct. Not a tank outcome score.`;
  box.setAttribute("aria-label", `Janna parse-only score for "${command}": ${label}`);
}

function rowFor(entry: PostmortemEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "command-history-row";
  const box = document.createElement("button");
  box.type = "button";
  box.className = "janna-eval-box";
  box.tabIndex = -1;
  paintJannaBox(row, box, entry.jannaEval, entry.text);
  box.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
  });
  box.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const next = cycleJannaEval(entry.jannaEval);
    entry.jannaEval = next;
    setJannaEval(entry.id, next);
    paintJannaBox(row, box, next, entry.text);
  });
  const text = document.createElement("span");
  text.className = "command-history-text";
  text.textContent = entry.text;
  text.title = entry.goals.join("; ");
  const tag = document.createElement("span");
  tag.className = `command-history-tag handler-${entry.handler.toLowerCase()}`;
  tag.textContent = entry.handler;
  const reasons = document.createElement("span");
  reasons.className = "command-history-reasons";
  const events = entry.orderEvents ?? [];
  const codes: string[] = [...new Set([...events].reverse().map((e) => e.reason))];
  if (entry.reason) codes.unshift(entry.reason);
  reasons.textContent = codes.join(" · ");
  reasons.title = [entry.reason, ...events.map((e) => `${e.tankId} ${e.type}:${e.reason} — ${e.caption}`)]
    .filter(Boolean).join("\n");
  const metrics = document.createElement("span");
  metrics.className = "command-history-metrics";
  const metricParts: string[] = [];
  if (entry.t_ack_ms != null) metricParts.push(`ack ${entry.t_ack_ms}ms`);
  const total = 1 + (entry.repeat_count ?? 0);
  if (total > 1) metricParts.push(`×${total}`);
  if ((entry.interrupts ?? 0) > 0) metricParts.push(`int ${entry.interrupts}`);
  if (entry.died_stuck === 1) metricParts.push("stuck-dead");
  metrics.textContent = metricParts.length ? metricParts.join(" · ") : "";
  metrics.title = [
    `t_ack_ms: ${entry.t_ack_ms ?? "—"}`,
    `repeat_count: ${entry.repeat_count ?? 0}`,
    `interrupts: ${entry.interrupts ?? 0}`,
    `died_stuck: ${entry.died_stuck ?? 0}`,
  ].join("\n");
  row.append(box, reasons, metrics, text, tag);
  return row;
}

export function mountCommandHistory(
  list: HTMLElement,
  gameMode: () => GameMode,
): void {
  const mounted = new WeakMap<CommandRecord, { entry: PostmortemEntry; row?: HTMLElement }>();
  const add = (rec: CommandRecord) => {
    // Late answers may arrive before game apply has published the record.
    if (!commandLog().includes(rec)) return;
    const handler = handlerFor(
      rec.which_path_executed,
      rec.fast_path_result.settled && !rec.fast_path_result.vetoed,
    );
    const scripted = rec.which_path_executed === "ai_commander";
    const outcome = rec.reason === "match_outcome";
    const failed = rec.which_path_executed === "none" && rec.reason !== "no_command";
    if (!handler && !scripted && !outcome && !failed) return;
    const previous = mounted.get(rec);
    const at = scripted ? Date.now() : rec.at;
    const entry: PostmortemEntry = {
      id: previous?.entry.id ?? `${at}-${rec.id}`,
      at: previous?.entry.at ?? new Date(at).toISOString(),
      mode: previous?.entry.mode ?? gameMode(),
      team: rec.team,
      text: rec.raw_text.trim(),
      handler: outcome ? "Match" : scripted ? "Commander" : (handler ?? "Failed"),
      goals: rec.goals,
      ms: rec.latency_ms,
      source: rec.which_path_executed,
      intent: rec.intent,
      tanks: rec.tanks,
      reason: rec.reason,
      orderEvents: rec.orderEvents?.map((e) => ({ ...e })),
      issuedAt: rec.issuedAt,
      seed: rec.seed,
      jannaEval: previous?.entry.jannaEval ?? null,
      t_ack_ms: rec.t_ack_ms,
      repeat_count: rec.repeat_count,
      interrupts: rec.interrupts,
      died_stuck: rec.died_stuck,
    };
    savePostmortem(entry);
    if (scripted || outcome) {
      mounted.set(rec, { entry });
      return;
    }
    // Update in place. An old record trimmed from the panel stays trimmed.
    let row = previous?.row;
    if (!previous || row?.parentElement === list) {
      const replacement = rowFor(entry);
      if (row) row.replaceWith(replacement);
      else list.appendChild(replacement);
      row = replacement;
    }
    mounted.set(rec, { entry, row });
    while (list.children.length > PANEL_ROWS) list.firstElementChild?.remove();
    if (!previous) list.scrollTop = list.scrollHeight;
  };
  onCommandRecord(add);
}
