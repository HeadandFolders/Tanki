/**
 * Frozen planner ↔ executor goal contract (roadmap P0).
 * LLM, offline mock, sanitize, and AI brains must only use these kinds.
 */
export const GOAL_KINDS = [
  "moveTo",
  "holdPosition",
  "attackNearest",
  "escort",
  "retreat",
  "reportIn",
  "debug",
  "patrol",
  "spreadOut",
  "scout",
  "idle",
] as const;

export type GoalKind = (typeof GOAL_KINDS)[number];

/** Goals that count as an explicit movement/formation order (high priority). */
export const ORDERED_MOVE_GOALS: ReadonlySet<GoalKind> = new Set([
  "moveTo",
  "spreadOut",
  "holdPosition",
  "escort",
  "scout",
]);

/** Goals that refuse opportunistic combat override (except panic radius). */
export const COMBAT_LOCKED_GOALS: ReadonlySet<GoalKind> = new Set([
  "reportIn",
  "retreat",
]);

export function isGoalKind(value: unknown): value is GoalKind {
  return (
    typeof value === "string" &&
    (GOAL_KINDS as readonly string[]).includes(value)
  );
}

/** Pipe-separated list for LLM system prompts. */
export function goalKindsForPrompt(): string {
  return GOAL_KINDS.filter((g) => g !== "idle").join("|");
}
