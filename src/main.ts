import { CONFIG, type ShareMode } from "./config";
import {
  controlledTank,
  createWorld,
  formatTime,
  markWreckAt,
  sendOrder,
  stepWorld,
  switchToNumber,
  switchToTank,
} from "./game";
import { renderWorld } from "./render";
import type { WorldState } from "./types";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const ctx = canvas.getContext("2d")!;
const timerEl = document.querySelector("#timer")!;
const matchStateEl = document.querySelector("#match-state")!;
const rosterEl = document.querySelector("#roster")!;
const chatEl = document.querySelector("#chat")!;
const eventsEl = document.querySelector("#events")!;
const orderForm = document.querySelector<HTMLFormElement>("#order-form")!;
const orderInput = document.querySelector<HTMLInputElement>("#order-input")!;
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key")!;
const shareSelect = document.querySelector<HTMLSelectElement>("#share-mode")!;
const restartBtn = document.querySelector<HTMLButtonElement>("#restart")!;

let world: WorldState = createWorld(shareSelect.value as ShareMode);

const keys = new Set<string>();
let mouseX = CONFIG.canvasWidth / 2;
let mouseY = CONFIG.canvasHeight / 2;
let shooting = false;
let lastTs = performance.now();
let chatCursor = 0;
let eventCursor = 0;

function canvasCoords(ev: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * CONFIG.canvasWidth;
  const y = ((ev.clientY - rect.top) / rect.height) * CONFIG.canvasHeight;
  return { x, y };
}

canvas.addEventListener("mousemove", (ev) => {
  const p = canvasCoords(ev);
  mouseX = p.x;
  mouseY = p.y;
});

canvas.addEventListener("mousedown", (ev) => {
  canvas.focus();
  const p = canvasCoords(ev);
  mouseX = p.x;
  mouseY = p.y;

  if (ev.button === 0) {
    // Click friendly to switch
    const friendly = world.tanks.find(
      (t) =>
        t.team === "blue" &&
        t.alive &&
        Math.hypot(t.x - p.x, t.y - p.y) <= CONFIG.tankRadius + 6,
    );
    if (friendly) {
      switchToTank(world, friendly.id);
      refreshRoster();
      return;
    }
    // Click wreck to mark
    if (markWreckAt(world, p.x, p.y)) {
      flushLogs();
      return;
    }
    shooting = true;
  }
});

window.addEventListener("mouseup", () => {
  shooting = false;
});

window.addEventListener("keydown", (ev) => {
  const tag = (ev.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const k = ev.key.toLowerCase();
  if (
    k === "arrowup" ||
    k === "arrowdown" ||
    k === "arrowleft" ||
    k === "arrowright"
  ) {
    ev.preventDefault();
  }
  keys.add(k);
  if (ev.key >= "1" && ev.key <= "6") {
    switchToNumber(world, Number(ev.key));
    refreshRoster();
  }
});

window.addEventListener("keyup", (ev) => {
  keys.delete(ev.key.toLowerCase());
});

shareSelect.addEventListener("change", () => {
  world.shareMode = shareSelect.value as ShareMode;
});

restartBtn.addEventListener("click", () => {
  world = createWorld(shareSelect.value as ShareMode);
  chatCursor = 0;
  eventCursor = 0;
  chatEl.innerHTML = "";
  eventsEl.innerHTML = "";
  refreshRoster();
  flushLogs();
});

orderForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = orderInput.value.trim();
  if (!text) return;
  orderInput.value = "";
  const key = apiKeyInput.value.trim() || undefined;
  await sendOrder(world, text, key);
  flushLogs();
  refreshRoster();
});

function refreshRoster(): void {
  const blues = world.tanks
    .filter((t) => t.team === "blue")
    .sort((a, b) => a.number - b.number);
  rosterEl.innerHTML = blues
    .map((t) => {
      const carrier = t.isCodeCarrier ? " ★" : "";
      const goal = t.alive ? t.goal.kind : "wreck";
      const roleClass = t.role === "scout" ? "scout" : "shooter";
      const roleLabel = t.role === "scout" ? "S scout" : "G gunner";
      return `<li class="${t.id === world.controlledId ? "active" : ""} ${
        t.alive ? "" : "dead"
      }" data-id="${t.id}">
        <span>#${t.number}${carrier} <span class="role ${roleClass}">${roleLabel}</span></span>
        <span>${t.alive ? `${Math.ceil(t.hp)}hp · ${goal}` : "down"}</span>
      </li>`;
    })
    .join("");

  rosterEl.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", () => {
      const id = li.getAttribute("data-id");
      if (id) {
        switchToTank(world, id);
        refreshRoster();
      }
    });
  });
}

function appendLog(
  el: Element,
  line: { text: string; kind: string },
): void {
  const div = document.createElement("div");
  div.className = `line ${line.kind}`;
  div.textContent = line.text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function flushLogs(): void {
  while (chatCursor < world.chat.length) {
    appendLog(chatEl, world.chat[chatCursor++]);
  }
  while (eventCursor < world.events.length) {
    appendLog(eventsEl, world.events[eventCursor++]);
  }
}

function frame(ts: number): void {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  stepWorld(world, dt, { keys, mouseX, mouseY, shooting });
  renderWorld(ctx, world, mouseX, mouseY);

  timerEl.textContent = formatTime(world.matchLeft);
  const me = controlledTank(world);
  matchStateEl.textContent =
    world.outcome === "playing"
      ? me
        ? `Control #${me.number} · ${world.shareMode}`
        : "No tanks"
      : world.outcome.toUpperCase();

  if (Math.floor(world.time * 4) % 2 === 0) refreshRoster();
  flushLogs();

  requestAnimationFrame(frame);
}

refreshRoster();
flushLogs();
canvas.focus();
requestAnimationFrame(frame);
