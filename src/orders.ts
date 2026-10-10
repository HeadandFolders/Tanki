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
      const raw = err instanceof Error ? err.message : "LLM error";
      const msg = /401|invalid.?api.?key|incorrect api key/i.test(raw)
        ? `invalid API key (${raw})`
        : raw;
      const fallback = interpretOffline(text, tanks, worldState);
      return {
        results: fallback,
        source: "mock",
        ms: Math.round(performance.now() - t0),
        llmError: msg,
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

/** VIP to escort/cover — "me" = commander, or "cover #N" / "escort tank N". */
function resolveEscortVip(
  text: string,
  tanks: Tank[],
  controlledId: string,
): Tank | undefined {
  const alive = friendlies(tanks);
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

function resolveTargetsWithControl(
  text: string,
  tanks: Tank[],
  controlledId: string,
): Tank[] {
  const alive = friendlies(tanks);
  const lower = text.toLowerCase();
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

  const nums = [...lower.matchAll(/\b(?:tank\s*)?#?([1-6])\b/g)].map((m) =>
    Number(m[1]),
  );

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
  if (/\b(shooters?|gunners?)\b/.test(lower)) {
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

export function interpretOffline(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
): OrderResult[] {
  const lower = orderText.toLowerCase();
  let targets = resolveTargetsWithControl(
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
  } else if (/\b(escort|cover|protect|follow|guard)\b/.test(lower)) {
    kind = "escort";
    const vip =
      resolveEscortVip(orderText, tanks, worldState.controlledId) ??
      friendlies(tanks).find((t) => t.id === worldState.controlledId);
    // Bodyguards must not be the VIP (bug: "4, cover me" used to self-escort)
    const bodyguards = vip
      ? targets.filter((t) => t.id !== vip.id)
      : targets;
    if (bodyguards.length) targets = bodyguards;
    else if (vip) {
      targets = friendlies(tanks).filter((t) => t.id !== vip.id);
    }
    params = { targetTankId: vip?.id };
    verb =
      vip?.id === worldState.controlledId
        ? "covering you — on your six"
        : `escorting #${vip?.number ?? "?"}`;
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
  } else if (/\b(move|go|advance|recon|head|get)\b/.test(lower)) {
    kind = "moveTo";
    verb = "moving";
    const spot = landmark(orderText, worldState);
    if (spot) {
      params = { x: spot.x, y: spot.y };
      verb = `moving to ${spot.name}`;
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
  // Gemini: classic AIza… and new AI Studio auth keys AQ.…
  if (k.startsWith("AIza") || k.startsWith("AQ.")) return "gemini";
  if (k.startsWith("sk-ant-")) return "anthropic";
  // OpenAI (sk-…) and unknown → OpenAI-compatible path
  return "openai";
}

function geminiGenerateUrl(apiKey: string, model: string): string {
  return `${CONFIG.llm.gemini.path}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

/** Gemini accepts classic AIza… and new AQ.… auth keys via query and/or header. */
function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

export type LlmProbeResult =
  | { ok: true; provider: LlmProvider; ms: number }
  | { ok: false; provider?: LlmProvider; ms: number; error: string };

/**
 * Live check that the key can reach the provider via Vite `/llm/*` proxies.
 * Call from the round gate before Start — not on every order.
 */
export async function probeLlmConnection(
  apiKey: string,
): Promise<LlmProbeResult> {
  const key = apiKey.trim();
  if (!key) {
    return { ok: false, ms: 0, error: "no API key" };
  }
  const provider = detectLlmProvider(key);
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    CONFIG.llm.probeTimeoutMs,
  );
  try {
    if (provider === "gemini") {
      const model = CONFIG.llm.gemini.model;
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
          model: CONFIG.llm.anthropic.model,
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: "user", content: 'Reply with only: {"ok":true}' }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`,
        );
      }
    } else {
      if (!key.startsWith("sk-")) {
        throw new Error(
          `Key looks like ${key.startsWith("AQ.") ? "Gemini (AQ.…)" : "a non-OpenAI key"} — expected OpenAI sk-…, Gemini AIza…/AQ.…, or Anthropic sk-ant-…`,
        );
      }
      const res = await fetch(CONFIG.llm.openai.path, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: CONFIG.llm.openai.model,
          temperature: 0,
          max_tokens: 16,
          messages: [{ role: "user", content: 'Reply with JSON: {"ok":true}' }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `OpenAI HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`,
        );
      }
    }
    return {
      ok: true,
      provider,
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
      ms: Math.round(performance.now() - t0),
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

const ORDER_SYSTEM = `You are a tank company radio officer. Reply with JSON ONLY: {"orders":[{"tankId":"blue-N","goal":"moveTo|holdPosition|attackNearest|escort|retreat|reportIn|debug|patrol|spreadOut","params":{"x":0,"y":0,"targetTankId":"","wreckId":""},"chatLine":"#N: ack..."}]}.
Goals only from that list. Prefer patrol/spreadOut/attackNearest over freezing on hold. tankId must be living blue tanks. You may loosely reinterpret unclear orders and admit that in chatLine. Keep chat short.
Map is top-down: x right, y down; origin top-left. When the order names a place (corner, side, north/south/east/west), set goal moveTo with numeric x,y inside the map for EVERY addressed tank. Example corners: bottom-left ≈ (0.1*W, 0.9*H), top-right ≈ (0.9*W, 0.1*H). Always include x and y for moveTo/holdPosition.
Cover/follow: "4, cover me" / "follow me" → goal escort for the named bodyguard(s), params.targetTankId = the commander's tankId (controlled). Never set a tank to escort itself. "cover 3" → other blues escort tank #3.`;

function sanitizeOrders(
  orders: OrderResult[],
  tanks: Tank[],
  orderText?: string,
  world?: WorldState,
): OrderResult[] {
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
  const spot =
    orderText && world ? landmark(orderText, world) : null;
  const controlledId = world?.controlledId;
  return orders
    .filter((o) => living.has(o.tankId) && goals.has(o.goal))
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
        const vip = resolveEscortVip(orderText, tanks, world.controlledId);
        if (vip && (params.targetTankId == null || params.targetTankId === o.tankId)) {
          params.targetTankId = vip.id;
        }
        if (params.targetTankId === o.tankId && controlledId) {
          params.targetTankId = controlledId;
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
    map: {
      width: CONFIG.canvasWidth,
      height: CONFIG.canvasHeight,
      origin: "top-left",
      yDown: true,
      corners: {
        topLeft: mapCorner(0.08, 0.08, "top-left"),
        topRight: mapCorner(0.92, 0.08, "top-right"),
        bottomLeft: mapCorner(0.08, 0.92, "bottom-left"),
        bottomRight: mapCorner(0.92, 0.92, "bottom-right"),
      },
    },
  });

  const provider = detectLlmProvider(apiKey);
  const content = await fetchLlmJson(provider, apiKey.trim(), ORDER_SYSTEM, user);
  const parsed = extractJsonObject(content);
  let orders = sanitizeOrders(parsed.orders ?? [], tanks, orderText, worldState);
  // Empty / useless LLM result → fall back to offline so corners still work
  if (!orders.length) return interpretOffline(orderText, tanks, worldState);
  const movedWithoutCoords = orders.every(
    (o) =>
      (o.goal !== "moveTo" && o.goal !== "holdPosition") ||
      (o.params?.x != null && o.params?.y != null),
  );
  if (!movedWithoutCoords) {
    const offline = interpretOffline(orderText, tanks, worldState);
    if (offline.some((o) => o.goal === "moveTo" && o.params?.x != null)) {
      return offline;
    }
  }
  return orders;
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

