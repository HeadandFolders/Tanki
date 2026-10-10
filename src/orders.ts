import { CONFIG } from "./config";
import type {
  GoalKind,
  InterpretBundle,
  InterpretContext,
  OrderResult,
  Tank,
  WorldState,
} from "./types";

/**
 * Radio path: transcript/text → (optional LLM) → goals for bots.
 * Called ONLY on order send / voice final — never every tick.
 */
export async function interpretOrder(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
  ctx: InterpretContext = {},
): Promise<InterpretBundle> {
  const text = orderText.trim();
  const t0 = performance.now();
  if (!text) return { results: [], source: "mock", ms: 0 };

  if (ctx.apiKey) {
    try {
      const llm = await interpretWithLlm(text, tanks, worldState, ctx.apiKey);
      if (llm.length) {
        return {
          results: llm,
          source: "llm",
          ms: Math.round(performance.now() - t0),
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "LLM error";
      const fallback = interpretOffline(text, tanks, worldState);
      return {
        results: [
          {
            tankId: worldState.controlledId,
            goal: "patrol",
            params: {},
            chatLine: `Command net: LLM failed (${msg}). Falling back to keyword parse.`,
          },
          ...fallback,
        ],
        source: "mock",
        ms: Math.round(performance.now() - t0),
      };
    }
  }

  return {
    results: interpretOffline(text, tanks, worldState),
    source: "mock",
    ms: Math.round(performance.now() - t0),
  };
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

  let kind: GoalKind = "patrol";
  let params: OrderResult["params"] = {};
  let verb = "keeping mobile";
  let perTankParams = false;

  if (/\b(spread(\s*out)?|fan\s*out|disperse|space\s*out)\b/.test(lower)) {
    kind = "spreadOut";
    verb = "spreading out";
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
    verb = "hunting / attacking";
    perTankParams = true;
  } else if (/\b(hold|stay|wait|defend)\b/.test(lower)) {
    kind = "holdPosition";
    verb = "holding (soft — will still fight)";
    const spot = landmark(orderText, worldState);
    if (spot) {
      params = { x: spot.x, y: spot.y };
      verb = `holding ${spot.name}`;
    } else {
      perTankParams = true;
    }
  } else if (/\b(move|go|advance|recon)\b/.test(lower)) {
    kind = "moveTo";
    verb = "moving";
    const spot = landmark(orderText, worldState);
    if (spot) {
      params = { x: spot.x, y: spot.y };
      verb = `moving to ${spot.name}`;
    } else {
      kind = "patrol";
      verb = "advancing on patrol";
      perTankParams = true;
    }
  } else {
    const spot = landmark(orderText, worldState);
    if (spot) {
      kind = "moveTo";
      params = { x: spot.x, y: spot.y };
      verb = `moving to ${spot.name}`;
    } else {
      // Unclear → keep them mobile rather than freezing
      kind = "patrol";
      verb = "patrolling (unclear order — staying mobile)";
      perTankParams = true;
    }
  }

  const homeY = CONFIG.canvasHeight * (1 - CONFIG.homeTerritoryFraction) - 60;
  const results: OrderResult[] = [];
  for (const t of targets) {
    let p = { ...params };
    if (perTankParams) {
      if (kind === "spreadOut" || kind === "holdPosition") {
        const lane = (t.number - 0.5) / 6;
        p = {
          x: CONFIG.canvasWidth * (0.12 + lane * 0.76),
          y: homeY - (t.number % 2) * 50,
        };
      } else if (kind === "patrol" || kind === "attackNearest") {
        p = {
          x: CONFIG.canvasWidth * (0.2 + (t.number % 5) * 0.15),
          y: homeY - 40 - (t.number % 3) * 50,
        };
      }
    }
    let chatLine = `#${t.number}: ack, ${verb}.`;
    if (Math.random() < CONFIG.ai.pushbackChance && kind === "attackNearest") {
      chatLine = `#${t.number}: copy — pushing up.`;
    }
    results.push({
      tankId: t.id,
      goal: kind,
      params: p,
      chatLine,
    });
  }
  return results;
}

type LlmProvider = "openai" | "gemini" | "anthropic";

/** Pick provider from common key prefixes (Gemini / Anthropic / OpenAI). */
export function detectLlmProvider(apiKey: string): LlmProvider {
  const k = apiKey.trim();
  if (k.startsWith("AIza")) return "gemini";
  if (k.startsWith("sk-ant-")) return "anthropic";
  return "openai";
}

const ORDER_SYSTEM = `You are a tank company radio officer. Reply with JSON ONLY: {"orders":[{"tankId":"blue-N","goal":"moveTo|holdPosition|attackNearest|escort|retreat|reportIn|debug|patrol|spreadOut","params":{"x":0,"y":0,"targetTankId":"","wreckId":""},"chatLine":"#N: ack..."}]}.
Goals only from that list. Prefer patrol/spreadOut/attackNearest over freezing on hold. tankId must be living blue tanks. You may loosely reinterpret unclear orders and admit that in chatLine. Keep chat short.`;

function sanitizeOrders(orders: OrderResult[], tanks: Tank[]): OrderResult[] {
  const living = new Set(friendlies(tanks).map((t) => t.id));
  const goals = new Set<GoalKind>([
    "moveTo",
    "holdPosition",
    "attackNearest",
    "escort",
    "retreat",
    "reportIn",
    "debug",
    "patrol",
    "spreadOut",
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

  const user = JSON.stringify({
    orderText,
    controlledId: worldState.controlledId,
    tanks: alive,
    wrecks,
    shareMode: worldState.shareMode,
    gameMode: worldState.gameMode,
    matchLeft: Math.round(worldState.matchLeft),
  });

  const provider = detectLlmProvider(apiKey);
  const content = await fetchLlmJson(provider, apiKey.trim(), ORDER_SYSTEM, user);
  const parsed = extractJsonObject(content);
  return sanitizeOrders(parsed.orders ?? [], tanks);
}

async function fetchLlmJson(
  provider: LlmProvider,
  apiKey: string,
  system: string,
  user: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.llm.timeoutMs);
  try {
    if (provider === "gemini") {
      const model = CONFIG.llm.gemini.model;
      const url = `${CONFIG.llm.gemini.path}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
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
          model: CONFIG.llm.anthropic.model,
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

    // OpenAI + OpenAI-compatible keys (sk-…) via Vite proxy
    const res = await fetch(CONFIG.llm.openai.path, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.llm.openai.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `OpenAI HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
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
      // Typical browser CORS / network failure before the proxy existed
      throw new Error(`LLM network error (${err.message})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

