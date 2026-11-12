import { normalizeSpokenNumbers } from "./orders";
import type { ChatLine, TeamId, WorldState } from "./types";

const DEDUPE_MS = 1500;
const ADDRESS = /^(?:(?:all|everyone|everybody|company|team|tanks?|scouts?|heavies|heavy|lights?|shooters?|gunners?)\b|\d+\b)/;
const ACTION = /^(?:attack|engage|hunt|push|move|go|head|take|flank|advance|cover|escort|protect|follow|guard|retreat|fall back|get out|spread|fan out|disperse|space out|hold|stay|wait|defend|keep moving|keep rolling|patrol|roam|scout|recon|probe|screen|report|radio in|debug|inspect|shoot|fire|stop|cancel|resume)\b/;

/** Formatting/STT differences must not turn one sentence into two orders. */
export function normalizeRadioText(text: string): string {
  return normalizeSpokenNumbers(text.normalize("NFKC"))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function commandClauses(text: string): string[] {
  const parts = text.split(/[;,.!?]|\band\s+(?=(?:tanks?\s+)?#?(?:[1-6]|one|two|three|four|five|six)\b)/i)
    .map(normalizeRadioText)
    .map((s) => s.replace(/^(?:(?:please|have|tell|ask|maybe)\s+|(?:can|could|would) you\s+)+/, ""))
    .filter(Boolean);
  const clauses: string[] = [];
  const addressOnly = /^(?:(?:all|everyone|everybody|company|team|tanks?|scouts?|heavies|heavy|lights?|shooters?|gunners?|[1-6]|and)\s*)+$/;
  for (const part of parts) {
    const previous = clauses.at(-1);
    // Commas in "2, 3, move north" separate addressees, not new commands.
    if (previous && addressOnly.test(previous)) clauses[clauses.length - 1] = `${previous} ${part}`;
    else clauses.push(part);
  }
  return clauses;
}

/** Intake only, not a parser: an address or imperative is enough for standby. */
export function hasPartialCommandIntent(text: string): boolean {
  return commandClauses(text).some((s) => ADDRESS.test(s) || ACTION.test(s));
}

/** Resolve just the addressee context, without guessing or assigning any goal. */
function addresseeKey(world: WorldState, text: string, team: TeamId): string {
  const alive = world.tanks.filter((t) => t.team === team && t.alive);
  const commander = team === "red"
    ? world.remoteControlledId ?? alive[0]?.id
    : world.controlledId;
  const ids = new Set<string>();
  for (const clause of commandClauses(text)) {
    if (!ADDRESS.test(clause) && !ACTION.test(clause)) continue;
    const words = clause.split(" ");
    const verbAt = words.findIndex((_, i) => ACTION.test(words.slice(i).join(" ")));
    const prefix = verbAt < 0 ? clause : words.slice(0, verbAt).join(" ");
    const numbers = [...prefix.matchAll(/\b([1-6])\b/g)].map((m) => Number(m[1]));
    let targets = numbers.length
      ? alive.filter((t) => numbers.includes(t.number))
      : /\b(all|everyone|everybody|company|team|tanks)\b/.test(prefix)
        ? alive
        : /\bscouts?\b/.test(prefix)
          ? alive.filter((t) => t.role === "scout")
          : /\b(heavy|heavies)\b/.test(prefix)
            ? alive.filter((t) => t.role === "heavy")
            : /\b(lights?|shooters?|gunners?)\b/.test(prefix)
              ? alive.filter((t) => t.role === "shooter")
              : /^(?:cover|escort|protect|follow|guard)\s+(?:me|us|myself|commander)\b/.test(clause)
                ? alive.filter((t) => t.id !== commander)
                : /^(?:spread|fan out|disperse|space out|retreat|fall back)\b/.test(clause)
                  ? alive
                  : alive.filter((t) => t.id === commander);
    // Bare "cover 4" addresses the rest of the company, not the VIP.
    const vip = clause.match(/^(?:cover|escort|protect|follow|guard)\s+(?:tank\s+)?([1-6])\b/);
    if (vip) targets = alive.filter((t) => t.number !== Number(vip[1]));
    for (const tank of targets) ids.add(tank.id);
  }
  return [...ids].sort().join(",");
}

/** Team-scoped radio captions; callers own acknowledgement wording. */
export function caption(
  world: WorldState,
  text: string,
  team: TeamId,
  kind: ChatLine["kind"] = "ally",
): void {
  world.chat.push({ t: world.time, text, kind, team });
  if (world.chat.length > 80) world.chat.splice(0, world.chat.length - 80);
}

interface TeamGate {
  texts: Map<string, UtteranceMeter>;
  /** Full IDs include a recognition-session prefix; never expire within a session. */
  segments: Set<string>;
}

/**
 * Counts the repeats the dedupe gate swallowed for one admitted sentence.
 * The gate stores the caller's object, so a repeat that lands while the
 * parser is still awaiting shows up in the count the record seeds itself from.
 */
export interface UtteranceMeter {
  at: number;
  count: number;
  attach?: (count: number) => void;
}

/** A fresh gate and injected monotonic clock keep tests independent of real time. */
export function createRadioGate(clock: () => number = () => performance.now()) {
  const worlds = new WeakMap<WorldState, Map<TeamId, TeamGate>>();
  function beginUtterance(
    world: WorldState,
    text: string,
    team: TeamId,
    segmentId?: string,
    meter?: UtteranceMeter,
  ): boolean {
    if (!hasPartialCommandIntent(text)) return false;
    let teams = worlds.get(world);
    if (!teams) worlds.set(world, teams = new Map());
    let gate = teams.get(team);
    if (!gate) teams.set(team, gate = { texts: new Map(), segments: new Set() });
    if (segmentId && gate.segments.has(segmentId)) return false;
    const now = clock();
    for (const [key, entry] of gate.texts) {
      if (now - entry.at >= DEDUPE_MS) gate.texts.delete(key);
    }
    const key = `${normalizeRadioText(text)}\n${addresseeKey(world, text, team)}`;
    // Remember a duplicated recognizer segment as well, so a late replay of it
    // cannot escape the text window. Failure clears both forms of dedupe.
    if (segmentId) gate.segments.add(segmentId);
    const seen = gate.texts.get(key);
    if (seen) {
      seen.count += 1;
      seen.attach?.(seen.count);
      return false;
    }
    const entry = meter ?? { at: now, count: 0 };
    entry.at = now;
    entry.count = 0;
    gate.texts.set(key, entry);
    caption(world, "Company: standby", team);
    return true;
  }
  function resetRadio(world: WorldState, team: TeamId): void {
    worlds.get(world)?.delete(team);
  }
  function failRadio(world: WorldState, team: TeamId): void {
    resetRadio(world, team);
    caption(world, "Company: say again", team, "warn");
  }
  return { beginUtterance, failRadio, resetRadio };
}

const radioGate = createRadioGate();
export const beginUtterance = radioGate.beginUtterance;
export const failRadio = radioGate.failRadio;
export const resetRadio = radioGate.resetRadio;
