import { CONFIG } from './config';
import type { Goal, GoalKind, OrderBatch, OrderResult, Tank, WorldState } from './types';

const GOAL_SET = new Set<GoalKind>([
  'moveTo',
  'holdPosition',
  'attackNearest',
  'escort',
  'retreat',
  'reportIn',
  'debug',
  'idle',
]);

interface Landmark {
  id: string;
  x: number;
  y: number;
  aliases: string[];
}

const LANDMARKS: Landmark[] = [
  { id: 'north choke', x: 480, y: 150, aliases: ['north choke', 'northern choke'] },
  { id: 'choke', x: 480, y: 300, aliases: ['choke', 'center choke'] },
  { id: 'north', x: 480, y: 110, aliases: ['north'] },
  { id: 'south', x: 480, y: 560, aliases: ['south'] },
  { id: 'east', x: 840, y: 320, aliases: ['east', 'right flank'] },
  { id: 'west', x: 120, y: 320, aliases: ['west', 'left flank'] },
  { id: 'center', x: 480, y: 360, aliases: ['center', 'mid', 'middle'] },
  { id: 'bunker', x: 120, y: 200, aliases: ['bunker', 'left bunker'] },
  { id: 'right bunker', x: 840, y: 200, aliases: ['right bunker'] },
  { id: 'eagle', x: 480, y: 555, aliases: ['eagle', 'nest'] },
  { id: 'base', x: 480, y: 580, aliases: ['base'] },
  { id: 'home', x: 480, y: 575, aliases: ['home'] },
];

const VERBS: { kind: GoalKind; re: RegExp; aggressive?: boolean }[] = [
  { kind: 'retreat', re: /\b(retreat|fall back|fallback|pull back)\b/ },
  { kind: 'reportIn', re: /\b(report in|radio in|send report|report)\b/ },
  { kind: 'debug', re: /\b(debug|inspect|scan|search the wreck|check wreck)\b/ },
  { kind: 'escort', re: /\b(escort|cover|protect|shadow)\b/ },
  { kind: 'attackNearest', re: /\b(attack|engage|hunt|push|assault)\b/, aggressive: true },
  { kind: 'holdPosition', re: /\b(hold|stay|wait|defend|guard)\b/ },
  { kind: 'moveTo', re: /\b(move|go|advance|scout|recon|head|flank)\b/ },
];

function livingBlue(tanks: Tank[]): Tank[] {
  return tanks.filter((t) => t.alive && t.team === 'blue');
}

function findLandmark(text: string): Landmark | null {
  const sorted = LANDMARKS.flatMap((lm) => lm.aliases.map((a) => ({ lm, a }))).sort((a, b) => b.a.length - a.a.length);
  for (const { lm, a } of sorted) {
    if (text.includes(a)) return lm.id === 'bunker' && text.includes('right bunker') ? LANDMARKS.find((l) => l.id === 'right bunker') ?? lm : lm;
  }
  return null;
}

function wreckLabel(text: string): string | null {
  const m = text.match(/\bwreck\s*([a-z])\b/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

function numbersIn(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(/#\s*([1-6])\b/g)) found.add(Number(m[1]));
  for (const m of text.matchAll(/\btank\s*([1-6])\b/g)) found.add(Number(m[1]));
  return [...found];
}

function resolveTargets(text: string, tanks: Tank[], controlledId: number): Tank[] {
  const blue = livingBlue(tanks);
  const nums = numbersIn(text);
  const wantsAll = /\b(all|everyone|everybody|company|team)\b/.test(text);
  const wantsScout = /\bscouts?\b/.test(text);
  const wantsShooter = /\b(shooters?|gunners?|guns)\b/.test(text);
  let pool = blue;
  if (nums.length && !wantsAll) pool = pool.filter((t) => nums.includes(t.number));
  if (wantsScout && !wantsShooter) pool = pool.filter((t) => t.role === 'scout');
  else if (wantsShooter && !wantsScout) pool = pool.filter((t) => t.role === 'shooter');
  if (wantsAll && nums.length === 0) pool = blue.filter((t) => (wantsScout ? t.role === 'scout' : wantsShooter ? t.role === 'shooter' : true));
  if (!wantsAll && nums.length === 0 && !wantsScout && !wantsShooter) {
    return blue.filter((t) => t.id === controlledId);
  }
  return pool;
}

function clampArena(x: number, y: number) {
  return {
    x: Math.max(48, Math.min(CONFIG.canvasWidth - 48, x)),
    y: Math.max(48, Math.min(CONFIG.canvasHeight - 48, y)),
  };
}

function ack(tank: Tank, goal: Goal, unclear = false): string {
  const tag = `#${tank.number}`;
  if (unclear) return `${tag}: holding (unclear order).`;
  switch (goal.kind) {
    case 'moveTo':
      return `${tag}: ack, moving to ${goal.label ?? 'waypoint'}.`;
    case 'holdPosition':
      return `${tag}: ack, holding ${goal.label ?? 'here'}.`;
    case 'attackNearest':
      return `${tag}: ack, engaging.`;
    case 'escort':
      return `${tag}: ack, escorting #${goal.label ?? '?'}.`;
    case 'retreat':
      return `${tag}: ack, falling back.`;
    case 'reportIn':
      return `${tag}: ack, reporting in.`;
    case 'debug':
      return `${tag}: ack, debugging wreck ${goal.label ?? ''}.`.trim();
    default:
      return `${tag}: ack.`;
  }
}

function mockOrders(orderText: string, tanks: Tank[], world: WorldState): OrderResult[] {
  const text = orderText.toLowerCase().replace(/\s+/g, ' ').trim();
  const verb = VERBS.find((v) => v.re.test(text));
  const landmark = findLandmark(text);
  const letter = wreckLabel(text);
  let targets = resolveTargets(text, tanks, world.controlledId);
  if (targets.length === 0) targets = livingBlue(tanks).filter((t) => t.id === world.controlledId);

  const escortNums = numbersIn(text);
  const results: OrderResult[] = [];
  const aggressive = Boolean(verb?.aggressive);

  for (const tank of targets) {
    let kind: GoalKind = verb?.kind ?? (landmark ? 'moveTo' : 'holdPosition');
    const unclear = !verb && !landmark && !letter;
    if (unclear) kind = 'holdPosition';
    const goal: Goal = { kind };

    if (kind === 'moveTo' || (kind === 'holdPosition' && landmark)) {
      if (landmark) {
        const p = clampArena(landmark.x, landmark.y);
        goal.x = p.x;
        goal.y = p.y;
        goal.label = landmark.id;
      } else if (kind === 'moveTo') {
        goal.x = tank.x;
        goal.y = Math.max(80, tank.y - 140);
        goal.label = 'ahead';
      } else {
        goal.x = tank.x;
        goal.y = tank.y;
        goal.label = 'here';
      }
    }

    if (kind === 'holdPosition' && !landmark) {
      goal.x = tank.x;
      goal.y = tank.y;
      goal.label = 'here';
    }

    if (kind === 'retreat') {
      goal.x = Math.max(80, Math.min(880, tank.x));
      goal.y = 575;
      goal.label = 'home';
    }

    if (kind === 'debug') {
      const wreck = letter
        ? world.wrecks.find((w) => w.label === letter)
        : world.wrecks.find((w) => w.marked && !w.debugged && w.team === 'red') ??
          world.wrecks.find((w) => !w.debugged && w.team === 'red');
      if (wreck) {
        goal.wreckId = wreck.id;
        goal.label = wreck.label;
        goal.x = wreck.x;
        goal.y = wreck.y;
      } else {
        goal.kind = 'holdPosition';
        goal.x = tank.x;
        goal.y = tank.y;
        goal.label = 'no wreck';
      }
    }

    if (kind === 'escort') {
      const other = escortNums.find((n) => n !== tank.number);
      const escortNum = other ?? escortNums[0];
      const buddy = livingBlue(tanks).find((t) => t.number === escortNum && t.id !== tank.id);
      if (buddy) {
        goal.targetId = buddy.id;
        goal.label = String(buddy.number);
      } else {
        const nearest = livingBlue(tanks)
          .filter((t) => t.id !== tank.id)
          .sort((a, b) => Math.hypot(a.x - tank.x, a.y - tank.y) - Math.hypot(b.x - tank.x, b.y - tank.y))[0];
        if (nearest) {
          goal.targetId = nearest.id;
          goal.label = String(nearest.number);
        } else {
          goal.kind = 'holdPosition';
          goal.x = tank.x;
          goal.y = tank.y;
        }
      }
    }

    let chatLine = ack(tank, goal, unclear || goal.label === 'no wreck');
    if (goal.label === 'no wreck') chatLine = `#${tank.number}: no enemy wreck to debug.`;
    results.push({ tankId: tank.id, goal, chatLine });
  }

  if (aggressive && results.length && Math.random() < CONFIG.pushbackChance) {
    const pick = results[Math.floor(Math.random() * results.length)];
    if (pick) {
      const who = tanks.find((t) => t.id === pick.tankId);
      pick.chatLine = `#${who?.number ?? '?'}: pushing — fog's thick, call contacts.`;
    }
  }

  if (results.length === 0) {
    const self = tanks.find((t) => t.id === world.controlledId && t.alive);
    if (self) {
      results.push({
        tankId: self.id,
        goal: { kind: 'holdPosition', x: self.x, y: self.y, label: 'here' },
        chatLine: `#${self.number}: holding (unclear order).`,
      });
    }
  }
  return results;
}

function snapshot(tanks: Tank[], world: WorldState): string {
  const lines = livingBlue(tanks).map((t) => {
    const star = t.isCodeCarrier ? ' carrier' : '';
    return `#${t.number} ${t.role}${star} hp=${Math.ceil(t.hp)} pos=${Math.round(t.x)},${Math.round(t.y)} goal=${t.goal.kind}${t.id === world.controlledId ? ' CONTROLLED' : ''}`;
  });
  const wrecks = world.wrecks.map((w) => `${w.label}:${w.team}${w.debugged ? ':done' : ''}${w.marked ? ':marked' : ''}@${Math.round(w.x)},${Math.round(w.y)}`);
  const marks = LANDMARKS.map((l) => `${l.id}=${l.x},${l.y}`).join('; ');
  return `Tanks:\n${lines.join('\n')}\nWrecks: ${wrecks.join(', ') || 'none'}\nLandmarks: ${marks}`;
}

async function llmOrders(orderText: string, tanks: Tank[], world: WorldState, apiKey: string): Promise<OrderResult[]> {
  const system = [
    'You are the radio officer for a 6-tank company in a fog-of-war tank hunt.',
    'Reply with JSON only: {"orders":[{"tank":1,"goal":"moveTo","x":480,"y":120,"label":"north","wreck":"A","escort":3,"chat":"#1: ack, moving north."}]}',
    'Goals: moveTo, holdPosition, attackNearest, escort, retreat, reportIn, debug, idle.',
    'tank is the blue tank number 1-6. Only order living blue tanks.',
    'Use landmark coordinates when the order names a place. wreck is a letter when debugging.',
    'escort is the tank number to follow. Keep chat short, radio style, one line.',
    'One object per tank you are tasking. Do not invent tanks.',
  ].join(' ');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.llmModel,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${snapshot(tanks, world)}\n\nOrder: ${orderText}` },
      ],
    }),
    signal: AbortSignal.timeout(CONFIG.llmTimeoutMs),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content ?? '';
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned) as { orders?: Record<string, unknown>[] };
  const list = Array.isArray(parsed.orders) ? parsed.orders : [];
  const blue = livingBlue(tanks);
  const results: OrderResult[] = [];
  for (const item of list) {
    const num = Number(item.tank ?? item.tankId ?? item.number);
    const goalKind = String(item.goal ?? '') as GoalKind;
    if (!GOAL_SET.has(goalKind)) continue;
    const tank = blue.find((t) => t.number === num || t.id === num);
    if (!tank) continue;
    const goal: Goal = { kind: goalKind };
    if (typeof item.x === 'number' && typeof item.y === 'number') {
      const p = clampArena(item.x, item.y);
      goal.x = p.x;
      goal.y = p.y;
    }
    if (typeof item.label === 'string') goal.label = item.label;
    if (typeof item.wreck === 'string') {
      const wreck = world.wrecks.find((w) => w.label.toUpperCase() === item.wreck?.toString().toUpperCase());
      if (wreck) {
        goal.wreckId = wreck.id;
        goal.label = wreck.label;
        goal.x = wreck.x;
        goal.y = wreck.y;
      }
    }
    if (goalKind === 'escort') {
      const escortNum = Number(item.escort ?? item.target);
      const buddy = blue.find((t) => t.number === escortNum && t.id !== tank.id);
      if (buddy) {
        goal.targetId = buddy.id;
        goal.label = String(buddy.number);
      }
    }
    if (goalKind === 'retreat') {
      goal.x = goal.x ?? tank.x;
      goal.y = goal.y ?? 575;
      goal.label = goal.label ?? 'home';
    }
    if ((goalKind === 'moveTo' || goalKind === 'holdPosition') && goal.x === undefined) {
      const lm = findLandmark(orderText.toLowerCase());
      if (lm) {
        goal.x = lm.x;
        goal.y = lm.y;
        goal.label = lm.id;
      } else if (goalKind === 'holdPosition') {
        goal.x = tank.x;
        goal.y = tank.y;
      }
    }
    const chatLine = typeof item.chat === 'string' && item.chat.trim() ? item.chat.trim() : ack(tank, goal);
    results.push({ tankId: tank.id, goal, chatLine });
  }
  if (results.length === 0) throw new Error('LLM returned no valid orders');
  return results;
}

export async function interpretOrder(
  orderText: string,
  tanks: Tank[],
  worldState: WorldState,
  options?: { apiKey?: string },
): Promise<OrderBatch> {
  const started = performance.now();
  const key = options?.apiKey?.trim() ?? '';
  if (key) {
    try {
      const orders = await llmOrders(orderText, tanks, worldState, key);
      const batch = orders as OrderBatch;
      batch.meta = { source: 'llm', ms: Math.round(performance.now() - started) };
      return batch;
    } catch (err) {
      const warning = err instanceof Error ? err.message : 'LLM failed';
      const orders = mockOrders(orderText, tanks, worldState);
      const batch = orders as OrderBatch;
      batch.meta = { source: 'mock', ms: Math.round(performance.now() - started), warning };
      return batch;
    }
  }
  const orders = mockOrders(orderText, tanks, worldState);
  const batch = orders as OrderBatch;
  batch.meta = { source: 'mock', ms: Math.round(performance.now() - started) };
  return batch;
}

export async function loadLocalApiKey(): Promise<string> {
  const mods = import.meta.glob('./api-key.local.ts');
  const path = Object.keys(mods)[0];
  if (!path) return '';
  const loader = mods[path];
  if (!loader) return '';
  const mod = (await loader()) as { LOCAL_API_KEY?: string };
  return mod.LOCAL_API_KEY?.trim() ?? '';
}
