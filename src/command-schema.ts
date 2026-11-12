/**
 * Shared command intents. One shape for every parser path: the phrase reader,
 * the local Needle sidecar, and the LLM API can all describe a sentence with
 * these tool calls. Game code (command-resolver, formation) turns an intent
 * into world coordinates and goals; no parser ever emits coordinates.
 */

export type CommandSource = "phrase_reader" | "needle" | "llm_api" | "none" | "ai_commander";

export type FlankSide = "left" | "right";
export type RelativeDirection = "left" | "right" | "forward" | "back";

export interface MarkerRef {
  type: "marker";
}

export interface RelativeRef {
  type: "relative";
  anchor: "player";
  direction: RelativeDirection;
}

export type PlaceRef = MarkerRef | RelativeRef;

export type CommandIntent =
  | { tool: "attack"; tank_ids: number[]; target_id: number }
  | { tool: "attack_base"; tank_ids: number[] }
  | { tool: "defend_base"; tank_ids: number[] }
  | { tool: "cover"; tank_ids: number[]; protect: "player" }
  | { tool: "move_to"; tank_ids: number[]; ref: PlaceRef }
  | { tool: "flank"; tank_ids: number[]; reference_id: number; side: FlankSide }
  | { tool: "surround"; tank_ids: number[]; target_id: number };

export type ToolName = CommandIntent["tool"];

export const TOOL_NAMES: readonly ToolName[] = [
  "attack",
  "attack_base",
  "defend_base",
  "cover",
  "move_to",
  "flank",
  "surround",
];

const tankIds = {
  type: "array",
  description: "Hull numbers 1-6 of the friendly bots being ordered.",
  items: { type: "integer", minimum: 1, maximum: 6 },
} as const;

const hull = (description: string) =>
  ({ type: "integer", minimum: 1, maximum: 6, description }) as const;

/**
 * JSON Schema per tool. Needle compiles these into its decoding grammar, so a
 * call always has this shape. Flat objects and enums only: the engine supports
 * a subset of JSON Schema.
 */
export const TOOL_SCHEMAS = {
  attack: {
    description:
      "Friendly bots attack one enemy tank. Numbers before the verb are friendly bots; the number after it is the enemy.",
    inputSchema: {
      type: "object",
      properties: {
        tank_ids: tankIds,
        target_id: hull("Hull number of the enemy tank to attack."),
      },
      required: ["tank_ids", "target_id"],
    },
  },
  attack_base: {
    description: "Friendly bots attack the enemy base in Base War.",
    inputSchema: { type: "object", properties: { tank_ids: tankIds }, required: ["tank_ids"] },
  },
  defend_base: {
    description: "Friendly bots hold defensive anchors near their own base.",
    inputSchema: { type: "object", properties: { tank_ids: tankIds }, required: ["tank_ids"] },
  },
  cover: {
    description:
      "Friendly bots escort and protect the player (the speaker, 'me').",
    inputSchema: {
      type: "object",
      properties: {
        tank_ids: tankIds,
        protect: { type: "string", enum: ["player"] },
      },
      required: ["tank_ids", "protect"],
    },
  },
  move_to: {
    description:
      "Friendly bots move to a place: the player's map marker, or a direction relative to the player.",
    inputSchema: {
      type: "object",
      properties: {
        tank_ids: tankIds,
        ref: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["marker", "relative"] },
            anchor: { type: "string", enum: ["player"] },
            direction: {
              type: "string",
              enum: ["left", "right", "forward", "back"],
            },
          },
          required: ["type"],
        },
      },
      required: ["tank_ids", "ref"],
    },
  },
  flank: {
    description:
      "Friendly bots take one side (left or right) of a reference tank. Only for bots, never the speaker.",
    inputSchema: {
      type: "object",
      properties: {
        tank_ids: tankIds,
        reference_id: hull("Hull number of the tank being flanked."),
        side: { type: "string", enum: ["left", "right"] },
      },
      required: ["tank_ids", "reference_id", "side"],
    },
  },
  surround: {
    description:
      "Friendly bots surround one enemy tank from opposite sides.",
    inputSchema: {
      type: "object",
      properties: {
        tank_ids: tankIds,
        target_id: hull("Hull number of the enemy tank to surround."),
      },
      required: ["tank_ids", "target_id"],
    },
  },
} as const;

function isHull(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 6;
}

function hullList(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: number[] = [];
  for (const v of value) {
    if (!isHull(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Validate one raw tool call against the schema. Returns null for anything
 * that does not fit exactly; the caller treats null as "no intent".
 */
export function parseIntent(
  name: string,
  args: Record<string, unknown>,
): CommandIntent | null {
  const ids = hullList(args.tank_ids);
  if (!ids) return null;
  switch (name) {
    case "attack_base":
    case "defend_base":
      return { tool: name, tank_ids: ids };
    case "attack":
    case "surround": {
      if (!isHull(args.target_id)) return null;
      return { tool: name, tank_ids: ids, target_id: args.target_id };
    }
    case "cover": {
      if (args.protect !== "player") return null;
      return { tool: "cover", tank_ids: ids, protect: "player" };
    }
    case "flank": {
      if (!isHull(args.reference_id)) return null;
      if (args.side !== "left" && args.side !== "right") return null;
      return {
        tool: "flank",
        tank_ids: ids,
        reference_id: args.reference_id,
        side: args.side,
      };
    }
    case "move_to": {
      const ref = args.ref as Record<string, unknown> | undefined;
      if (!ref || typeof ref !== "object") return null;
      if (ref.type === "marker") {
        return { tool: "move_to", tank_ids: ids, ref: { type: "marker" } };
      }
      const dir = ref.direction;
      if (
        ref.type === "relative" &&
        (dir === "left" || dir === "right" || dir === "forward" || dir === "back")
      ) {
        return {
          tool: "move_to",
          tank_ids: ids,
          ref: { type: "relative", anchor: "player", direction: dir },
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/** One-line human summary for logs and the overlay. */
export function describeIntent(intent: CommandIntent): string {
  const who = intent.tank_ids.join(",");
  switch (intent.tool) {
    case "attack_base":
      return `attack_base([${who}] → enemy base)`;
    case "defend_base":
      return `defend_base([${who}] → home base)`;
    case "attack":
      return `attack([${who}] → enemy ${intent.target_id})`;
    case "surround":
      return `surround([${who}] → enemy ${intent.target_id})`;
    case "cover":
      return `cover([${who}] → player)`;
    case "flank":
      return `flank([${who}] ${intent.side} of ${intent.reference_id})`;
    case "move_to":
      return intent.ref.type === "marker"
        ? `move_to([${who}] → marker)`
        : `move_to([${who}] → player ${intent.ref.direction})`;
  }
}
