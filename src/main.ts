import './style.css';
import { CONFIG, type ShareMode } from './config';
import {
  applyOrderResults,
  controlledTank,
  createMatch,
  markWreck,
  pick,
  pushChat,
  pushEvent,
  setShareMode,
  step,
  switchToTank,
} from './game';
import { interpretOrder, loadLocalApiKey } from './orders';
import { render } from './render';
import type { PlayerInput } from './types';
import { createRadio, speechSupported } from './voice';

const canvas = document.querySelector<HTMLCanvasElement>('#view');
const timerEl = document.querySelector<HTMLElement>('#timer');
const statusEl = document.querySelector<HTMLElement>('#status');
const shareEl = document.querySelector<HTMLSelectElement>('#share');
const restartEl = document.querySelector<HTMLButtonElement>('#restart');
const rosterEl = document.querySelector<HTMLElement>('#roster');
const formEl = document.querySelector<HTMLFormElement>('#order-form');
const orderEl = document.querySelector<HTMLInputElement>('#order');
const radioEl = document.querySelector<HTMLButtonElement>('#radio');
const radioHintEl = document.querySelector<HTMLElement>('#radio-hint');
const keyEl = document.querySelector<HTMLInputElement>('#apikey');
const chatEl = document.querySelector<HTMLElement>('#chat');
const logEl = document.querySelector<HTMLElement>('#log');

if (!canvas || !timerEl || !statusEl || !shareEl || !restartEl || !rosterEl || !formEl || !orderEl || !radioEl || !radioHintEl || !keyEl || !chatEl || !logEl) {
  throw new Error('HUD markup missing');
}

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas unsupported');

const keys = new Set<string>();
let shooting = false;
let aimX = CONFIG.canvasWidth / 2;
let aimY = CONFIG.canvasHeight / 2;
let world = createMatch(readShare());
let chatSeen = -1;
let eventSeen = -1;
let rosterSig = '';
let localKey = '';
let orderBusy = false;

function readShare(): ShareMode {
  const value = shareEl?.value;
  if (value === 'auto' || value === 'none' || value === 'report') return value;
  return CONFIG.shareModeDefault;
}

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function canvasPoint(ev: MouseEvent) {
  const rect = canvas!.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) * canvas!.width) / rect.width,
    y: ((ev.clientY - rect.top) * canvas!.height) / rect.height,
  };
}

function remainingLabel(secondsLeft: number) {
  const s = Math.max(0, Math.ceil(secondsLeft));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function syncHud() {
  const left = CONFIG.matchSeconds - world.time;
  timerEl!.textContent = remainingLabel(left);
  timerEl!.classList.toggle('warn', world.phase === 'playing' && left <= 30);
  const controlled = controlledTank(world);
  const who = controlled ? `#${controlled.number}` : '–';
  const phase = world.phase === 'playing' ? world.shareMode : world.phase;
  statusEl!.textContent = `Control ${who} · ${phase}`;
  if (shareEl!.value !== world.shareMode) shareEl!.value = world.shareMode;

  const nextRoster = world.tanks
    .filter((t) => t.team === 'blue')
    .map((t) => `${t.id}:${t.alive ? Math.ceil(t.hp) : 'x'}:${t.goal.kind}:${t.id === world.controlledId ? 1 : 0}`)
    .join('|');
  if (nextRoster !== rosterSig) {
    rosterSig = nextRoster;
    rosterEl!.replaceChildren();
    for (const tank of world.tanks) {
      if (tank.team !== 'blue') continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      const star = tank.isCodeCarrier ? ' ★' : '';
      const role = tank.role === 'scout' ? 'S scout' : 'G gunner';
      const hp = tank.alive ? `${Math.max(0, Math.ceil(tank.hp))}hp` : 'down';
      btn.textContent = `#${tank.number} ${role}${star}  ${hp}  ${tank.goal.kind}`;
      if (tank.id === world.controlledId && tank.alive) btn.classList.add('on');
      if (!tank.alive) btn.classList.add('dead');
      btn.addEventListener('click', () => switchToTank(world, tank.id));
      const li = document.createElement('li');
      li.append(btn);
      rosterEl!.append(li);
    }
  }

  if (world.chatRev !== chatSeen) {
    chatSeen = world.chatRev;
    chatEl!.replaceChildren();
    for (const line of world.chat) {
      const div = document.createElement('div');
      div.className = line.kind;
      div.textContent = line.text;
      chatEl!.append(div);
    }
    chatEl!.scrollTop = chatEl!.scrollHeight;
  }
  if (world.eventRev !== eventSeen) {
    eventSeen = world.eventRev;
    logEl!.replaceChildren();
    for (const line of world.events) {
      const div = document.createElement('div');
      div.textContent = line;
      logEl!.append(div);
    }
    logEl!.scrollTop = logEl!.scrollHeight;
  }
}

async function sendOrder(text: string) {
  const orderText = text.trim();
  if (!orderText || world.phase !== 'playing' || orderBusy) return;
  orderBusy = true;
  const matchId = world.matchId;
  pushEvent(world, `Order: ${orderText}`);
  const apiKey = keyEl!.value.trim() || localKey;
  if (apiKey) pushEvent(world, 'LLM radio call sent…');
  try {
    const batch = await interpretOrder(orderText, world.tanks, world, { apiKey });
    if (world.matchId !== matchId) return;
    if (batch.meta.warning) {
      pushChat(world, 'warn', `Radio net glitched (${batch.meta.warning}). Keyword mock used.`);
      pushEvent(world, `LLM failed — keyword mock (${batch.meta.ms} ms).`);
    } else if (batch.meta.source === 'llm') {
      pushEvent(world, `LLM radio answered in ${batch.meta.ms} ms.`);
    } else {
      pushEvent(world, 'Keyword mock interpreted the order.');
    }
    applyOrderResults(world, batch);
  } catch (err) {
    if (world.matchId === matchId) {
      const message = err instanceof Error ? err.message : 'order failed';
      pushChat(world, 'warn', `Order dropped: ${message}`);
    }
  } finally {
    orderBusy = false;
    syncHud();
  }
}

function bootMatch(mode: ShareMode) {
  world = createMatch(mode);
  chatSeen = -1;
  eventSeen = -1;
  rosterSig = '';
  shooting = false;
  syncHud();
}

const radio = createRadio({
  onFinal: (text) => {
    orderEl!.value = text;
    void sendOrder(text);
  },
  onInterim: (text) => {
    orderEl!.value = text;
  },
  onState: (live, hint) => {
    radioEl!.textContent = live ? 'Radio: LIVE' : 'Radio: off';
    radioEl!.classList.toggle('live', live);
    radioHintEl!.textContent = hint;
  },
});

if (!speechSupported()) radioEl.disabled = true;
radioEl.addEventListener('click', () => radio.toggle());

shareEl.addEventListener('change', () => setShareMode(world, readShare()));
restartEl.addEventListener('click', () => bootMatch(readShare()));
formEl.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = orderEl.value;
  orderEl.value = '';
  void sendOrder(text);
});

window.addEventListener('keydown', (ev) => {
  if (typingTarget(ev.target)) return;
  if (ev.key === ' ' || ev.key.startsWith('Arrow')) ev.preventDefault();
  keys.add(ev.key);
  if (world.phase !== 'playing') return;
  if (ev.key >= '1' && ev.key <= '6') {
    const num = Number(ev.key);
    const tank = world.tanks.find((t) => t.team === 'blue' && t.number === num);
    if (tank) switchToTank(world, tank.id);
  }
});

window.addEventListener('keyup', (ev) => {
  keys.delete(ev.key);
});

window.addEventListener('blur', () => {
  keys.clear();
  shooting = false;
});

canvas.addEventListener('mousemove', (ev) => {
  const p = canvasPoint(ev);
  aimX = p.x;
  aimY = p.y;
});

canvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0 || world.phase !== 'playing') return;
  const p = canvasPoint(ev);
  aimX = p.x;
  aimY = p.y;
  const hit = pick(world, p.x, p.y);
  if (hit.kind === 'tank' && hit.id) {
    switchToTank(world, hit.id);
    return;
  }
  if (hit.kind === 'wreck' && hit.id) {
    markWreck(world, hit.id);
    return;
  }
  shooting = true;
});

window.addEventListener('mouseup', () => {
  shooting = false;
});

function inputFrame(): PlayerInput {
  return {
    ax: (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0),
    ay: (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0),
    shoot: shooting || keys.has(' '),
    aimX,
    aimY,
  };
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(world, inputFrame(), dt);
  render(ctx!, world, aimX, aimY);
  syncHud();
  requestAnimationFrame(frame);
}

void loadLocalApiKey().then((key) => {
  localKey = key;
  if (key && !keyEl!.value) keyEl!.placeholder = 'local key loaded — override to replace';
});

syncHud();
requestAnimationFrame(frame);
