import { CONFIG } from "./config";
import type {
  GoalKind,
  InterpretContext,
  OrderResult,
  Tank,
  WorldState,
} from "./types";

/**
 * interpretOrder(orderText, tanks, worldState) -> order results.
 * Uses LLM JSON-only API when apiKey set; otherwise offline keyword mock.
 * Called ONLY on order send — never every tick.
 */
export async function interpretOrder(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
  ctx: InterpretContext = {},
): Promise<OrderResult[]> {
  const text = orderText.trim();
  if (!text) return [];

  if (ctx.apiKey) {
    try {
      const llm = await interpretWithLlm(text, tanks, worldState, ctx.apiKey);
      if (llm.length) return llm;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "LLM error";
      return [
        {
          tankId: worldState.controlledId,
          goal: "holdPosition",
          params: {},
          chatLine: `Command net: LLM failed (${msg}). Falling back to keyword parse.`,
        },
        ...interpretOffline(text, tanks, worldState),
      ];
    }
  }

  return interpretOffline(text, tanks, worldState);
}

function friendlies(tanks: Tank[]): Tank[] {
  return tanks.filter((t) => t.team === "blue" && t.alive);
}

function resolveTargetsWithControl(
  text: string,
  tanks: Tank[],
  controlledId: string,
): Tank[] {
  const alive = friendlies(tanks);
  const lower = text.toLowerCase();
  if (/\b(all|everyone|team)\b/.test(lower)) return alive;

  const nums = [...lower.matchAll(/\b(?:tank\s*)?#?([1-6])\b/g)].map((m) =>
    Number(m[1]),
  );
  if (nums.length) return alive.filter((t) => nums.includes(t.number));

  if (/\bscouts?\b/.test(lower)) return alive.filter((t) => t.role === "scout");
  if (/\bshooters?\b/.test(lower))
    return alive.filter((t) => t.role === "shooter");

  const controlled = alive.find((t) => t.id === controlledId);
  return controlled ? [controlled] : alive.slice(0, 1);
}

function landmark(
  text: string,
  world: WorldState,
): { x: number; y: number; name: string } | null {
  const W = CONFIG.canvasWidth;
  const H = CONFIG.canvasHeight;
  const lower = text.toLowerCase();
  const spots: Record<string, { x: number; y: number; name: string }> = {
    north: { x: W * 0.5, y: H * 0.2, name: "north" },
    south: { x: W * 0.5, y: H * 0.8, name: "south" },
    east: { x: W * 0.8, y: H * 0.5, name: "east" },
    west: { x: W * 0.2, y: H * 0.5, name: "west" },
    center: { x: W * 0.5, y: H * 0.5, name: "center" },
    choke: { x: W * 0.5, y: H * 0.45, name: "choke" },
    "north choke": { x: W * 0.48, y: H * 0.32, name: "north choke" },
    bunker: { x: W * 0.25, y: H * 0.28, name: "bunker" },
    eagle: { x: W * 0.5, y: H - 72, name: "eagle" },
    base: { x: W * 0.5, y: H - 72, name: "base" },
    home: { x: W * 0.5, y: H * 0.88, name: "home" },
  };
  for (const key of Object.keys(spots).sort((a, b) => b.length - a.length)) {
    if (lower.includes(key)) return spots[key];
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

export function interpretOffline(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
): OrderResult[] {
  const lower = orderText.toLowerCase();
  const targets = resolveTargetsWithControl(
    orderText,
    tanks,
    worldState.controlledId,
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

  let kind: GoalKind = "holdPosition";
  let params: OrderResult["params"] = {};
  let verb = "holding";

  if (/\b(retreat|fall\s*back|get\s*out)\b/.test(lower)) {
    kind = "retreat";
    verb = "retreating";
  } else if (/\b(report(\s*in)?|radio\s*in)\b/.test(lower)) {
    kind = "reportIn";
    verb = "reporting in";
  } else if (/\b(debug|inspect|scan)\b/.test(lower)) {
    kind = "debug";
    verb = "debugging marked wrecks";
    const wreckMatch = lower.match(/\bwreck\s*([a-z])\b/);
    if (wreckMatch) {
      const label = wreckMatch[1].toUpperCase();
      const w = worldState.wrecks.find((wr) => wr.label === label);
      if (w) params = { wreckId: w.id, x: w.x, y: w.y };
    }
  } else if (/\b(escort|cover|protect)\b/.test(lower)) {
    kind = "escort";
    verb = "escorting";
    const num = lower.match(/escort\s*(?:tank\s*)?#?([1-6])/);
    const n = num ? Number(num[1]) : targets[0].number;
    const escortTarget =
      friendlies(tanks).find((t) => t.number === n) ?? targets[0];
    params = { targetTankId: escortTarget.id };
  } else if (/\b(attack|engage|hunt|push)\b/.test(lower)) {
    kind = "attackNearest";
    verb = "attacking nearest visible";
  } else if (/\b(hold|stay|wait|defend)\b/.test(lower)) {
    kind = "holdPosition";
    verb = "holding";
    const spot = landmark(orderText, worldState);
    if (spot) {
      params = { x: spot.x, y: spot.y };
      verb = `holding ${spot.name}`;
    } else {
      params = { x: targets[0].x, y: targets[0].y };
    }
  } else if (/\b(move|go|advance|scout|recon)\b/.test(lower)) {
    kind = "moveTo";
    verb = "moving";
    const spot = landmark(orderText, worldState);
    if (spot) {
      params = { x: spot.x, y: spot.y };
      verb = `moving to ${spot.name}`;
    } else {
      params = {
        x: CONFIG.canvasWidth * 0.5,
        y: CONFIG.canvasHeight * 0.5,
      };
      verb = "moving to center";
    }
  } else {
    // loose default
    const spot = landmark(orderText, worldState);
    if (spot) {
      kind = "moveTo";
      params = { x: spot.x, y: spot.y };
      verb = `moving to ${spot.name}`;
    } else {
      kind = "holdPosition";
      params = { x: targets[0].x, y: targets[0].y };
      verb = "holding (unclear order)";
    }
  }

  const results: OrderResult[] = [];
  for (const t of targets) {
    let chatLine = `#${t.number}: ack, ${verb}.`;
    if (Math.random() < CONFIG.ai.pushbackChance && kind === "attackNearest") {
      chatLine = `#${t.number}: that's hot — pushing anyway.`;
    } else if (
      Math.random() < CONFIG.ai.pushbackChance &&
      t.role === "scout" &&
      kind === "attackNearest"
    ) {
      chatLine = `#${t.number}: I'm a scout, not a hammer… still moving up.`;
    }
    results.push({
      tankId: t.id,
      goal: kind,
      params: { ...params },
      chatLine,
    });
  }
  return results;
}

async function interpretWithLlm(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
  apiKey: string,
): Promise<OrderResult[]> {
  const alive = friendlies(tanks).map((t) => ({
    id: t.id,
    number: t.number,
    role: t.role,
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

  const system = `You are a tank company radio officer. Reply with JSON ONLY: {"orders":[{"tankId":"blue-N","goal":"moveTo|holdPosition|attackNearest|escort|retreat|reportIn|debug","params":{"x":0,"y":0,"targetTankId":"","wreckId":""},"chatLine":"#N: ack..."}]}.
Goals only from that list. tankId must be living blue tanks. You may loosely reinterpret unclear orders and admit that in chatLine. Keep chat short.`;

  const user = JSON.stringify({
    orderText,
    controlledId: worldState.controlledId,
    tanks: alive,
    wrecks,
    shareMode: worldState.shareMode,
    matchLeft: Math.round(worldState.matchLeft),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.llm.timeoutMs);
  try {
    const res = await fetch(CONFIG.llm.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.llm.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as { orders?: OrderResult[] };
    const orders = parsed.orders ?? [];
    const living = new Set(friendlies(tanks).map((t) => t.id));
    const goals = new Set<GoalKind>([
      "moveTo",
      "holdPosition",
      "attackNearest",
      "escort",
      "retreat",
      "reportIn",
      "debug",
      "idle",
    ]);
    return orders
      .filter((o) => living.has(o.tankId) && goals.has(o.goal))
      .map((o) => ({
        tankId: o.tankId,
        goal: o.goal,
        params: o.params ?? {},
        chatLine: o.chatLine || `#?: ack.`,
      }));
  } finally {
    clearTimeout(timer);
  }
}

