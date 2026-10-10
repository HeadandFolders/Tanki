import {
  CONFIG,
  modesFromMenu,
  type GameMode,
  type MenuMode,
  type ShareMode,
} from "./config";
import { apiKeySource, resolveApiKey } from "./api-key";
import {
  controlledTank,
  createWorld,
  formatTime,
  markWreckAt,
  pushEvent,
  sendOrder,
  startMatch,
  stepWorld,
  switchToNumber,
  switchToTank,
} from "./game";
import { probeLlmConnection, type LlmProbeResult } from "./orders";
import { renderWorld } from "./render";
import { createVoiceRadio } from "./voice";
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
const modeSelect = document.querySelector<HTMLSelectElement>("#game-mode")!;
const restartBtn = document.querySelector<HTMLButtonElement>("#restart")!;
const voiceBtn = document.querySelector<HTMLButtonElement>("#voice-btn")!;
const voiceStatusEl = document.querySelector("#voice-status")!;
const roundGate = document.querySelector<HTMLElement>("#round-gate")!;
const llmStatusEl = document.querySelector<HTMLElement>("#llm-status")!;
const startRoundBtn = document.querySelector<HTMLButtonElement>("#start-round")!;
const recheckLlmBtn = document.querySelector<HTMLButtonElement>("#recheck-llm")!;

/** Apply Mode-menu preset to the Share select, then return resolved modes. */
function applyMenuPreset(): { share: ShareMode; mode: GameMode } {
  const menu = modeSelect.value as MenuMode;
  const resolved = modesFromMenu(menu);
  shareSelect.value = resolved.share;
  return resolved;
}

function currentModes(): { share: ShareMode; mode: GameMode } {
  return {
    share: shareSelect.value as ShareMode,
    mode: modesFromMenu(modeSelect.value as MenuMode).mode,
  };
}

const boot = applyMenuPreset();
let world: WorldState = createWorld(boot.share, boot.mode);

// Prefill UI from file/env (password field stays empty for security; status shows source)
const bootKey = resolveApiKey("");
if (bootKey) {
  apiKeyInput.placeholder = `key loaded from ${apiKeySource("")}`;
}

type GateProbeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "offline" }
  | { kind: "ok"; provider: string; ms: number }
  | { kind: "fail"; provider?: string; error: string; ms: number };

let gateProbe: GateProbeState = { kind: "idle" };
let probeSeq = 0;

function providerLabel(p: string): string {
  if (p === "gemini") return "Gemini";
  if (p === "anthropic") return "Anthropic";
  return "OpenAI";
}

function renderGateStatus(): void {
  llmStatusEl.classList.remove("llm-ok", "llm-off", "llm-checking");
  startRoundBtn.disabled = gateProbe.kind === "checking";

  if (gateProbe.kind === "checking") {
    llmStatusEl.classList.add("llm-checking");
    llmStatusEl.innerHTML =
      `<strong>LLM: checking…</strong>` +
      `<span>Live probe via /llm/* proxy. Start unlocks when this finishes.</span>`;
    startRoundBtn.textContent = "Wait…";
    return;
  }

  if (gateProbe.kind === "offline") {
    llmStatusEl.classList.add("llm-off");
    llmStatusEl.innerHTML =
      `<strong>LLM: offline (keyword mock)</strong>` +
      `<span>No API key. Orders use the local parser. Paste a key then Recheck, or Start with mock orders.</span>`;
    startRoundBtn.textContent = "Start (offline)";
    startRoundBtn.disabled = false;
    return;
  }

  if (gateProbe.kind === "ok") {
    llmStatusEl.classList.add("llm-ok");
    llmStatusEl.innerHTML =
      `<strong>LLM: verified (${gateProbe.provider} · ${gateProbe.ms}ms)</strong>` +
      `<span>Key works. Radio/typed orders will call the cloud model, then set bot goals.</span>`;
    startRoundBtn.textContent = "Start";
    startRoundBtn.disabled = false;
    return;
  }

  if (gateProbe.kind === "fail") {
    llmStatusEl.classList.add("llm-off");
    const who = gateProbe.provider ? ` · ${gateProbe.provider}` : "";
    llmStatusEl.innerHTML =
      `<strong>LLM: failed${who} (${gateProbe.ms}ms)</strong>` +
      `<span>${gateProbe.error}. Start anyway to use keyword parse, or fix the key and Recheck.</span>`;
    startRoundBtn.textContent = "Start (offline)";
    startRoundBtn.disabled = false;
    return;
  }

  llmStatusEl.innerHTML = `<strong>LLM: …</strong><span>Preparing probe.</span>`;
  startRoundBtn.disabled = true;
  startRoundBtn.textContent = "Start";
}

async function runLlmProbe(): Promise<void> {
  const seq = ++probeSeq;
  const key = resolveApiKey(apiKeyInput.value);
  if (!key) {
    gateProbe = { kind: "offline" };
    renderGateStatus();
    return;
  }

  gateProbe = { kind: "checking" };
  renderGateStatus();
  recheckLlmBtn.disabled = true;

  const result: LlmProbeResult = await probeLlmConnection(key);
  if (seq !== probeSeq) return; // stale

  if (result.ok) {
    gateProbe = {
      kind: "ok",
      provider: providerLabel(result.provider),
      ms: result.ms,
    };
  } else {
    gateProbe = {
      kind: "fail",
      provider: result.provider ? providerLabel(result.provider) : undefined,
      error: result.error,
      ms: result.ms,
    };
  }
  recheckLlmBtn.disabled = false;
  renderGateStatus();
}

function showRoundGate(): void {
  roundGate.hidden = false;
  void runLlmProbe();
}

function hideRoundGate(): void {
  roundGate.hidden = true;
  canvas.focus();
}

function beginRound(): void {
  if (world.outcome !== "ready") return;
  if (gateProbe.kind === "checking") return;
  startMatch(world);
  const modeNote =
    gateProbe.kind === "ok"
      ? `LLM live (${gateProbe.provider}).`
      : "Keyword mock orders (no working LLM key).";
  pushEvent(world, `Match started — ${modeNote}`, "warn");
  hideRoundGate();
  flushLogs();
  refreshRoster();
}

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

  const k = ev.key === " " ? " " : ev.key.toLowerCase();
  if (
    k === "arrowup" ||
    k === "arrowdown" ||
    k === "arrowleft" ||
    k === "arrowright" ||
    k === " "
  ) {
    ev.preventDefault();
  }
  keys.add(k);
  if (k === " " || k === "spacebar") {
    shooting = true;
  }
  if (ev.key >= "1" && ev.key <= "6") {
    switchToNumber(world, Number(ev.key));
    refreshRoster();
  }
});

window.addEventListener("keyup", (ev) => {
  const k = ev.key === " " ? " " : ev.key.toLowerCase();
  keys.delete(k);
  if (k === " " || k === "spacebar") {
    shooting = false;
  }
});

shareSelect.addEventListener("change", () => {
  world.shareMode = shareSelect.value as ShareMode;
});

function restartMatch(fromMenu = false): void {
  const { share, mode } = fromMenu ? applyMenuPreset() : currentModes();
  world = createWorld(share, mode);
  chatCursor = 0;
  eventCursor = 0;
  chatEl.innerHTML = "";
  eventsEl.innerHTML = "";
  refreshRoster();
  flushLogs();
  showRoundGate();
}

restartBtn.addEventListener("click", () => restartMatch(false));
modeSelect.addEventListener("change", () => restartMatch(true));
startRoundBtn.addEventListener("click", beginRound);
recheckLlmBtn.addEventListener("click", () => {
  void runLlmProbe();
});
apiKeyInput.addEventListener("change", () => {
  if (world.outcome === "ready") void runLlmProbe();
});
roundGate.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && gateProbe.kind !== "checking") {
    ev.preventDefault();
    beginRound();
  }
});

async function dispatchOrder(
  text: string,
  via: "typed" | "voice" | "phrase",
): Promise<void> {
  const cleaned = text.trim();
  if (!cleaned) return;
  if (world.outcome === "ready") {
    pushEvent(world, "Match paused — press Start on the overlay first.", "warn");
    flushLogs();
    return;
  }
  if (world.outcome !== "playing") return;

  // Use cloud LLM only when the pre-Start probe verified the key
  const key =
    gateProbe.kind === "ok" ? resolveApiKey(apiKeyInput.value) : undefined;
  const src = apiKeySource(apiKeyInput.value);

  if (via === "voice") {
    orderInput.value = cleaned;
    pushEvent(world, `STT: “${cleaned}”`, "sys");
  } else if (via === "phrase") {
    pushEvent(world, `Phrase: “${cleaned}”`, "sys");
  }

  pushEvent(
    world,
    key
      ? `Radio pipeline: ${via} → LLM (${src}) → bots`
      : `Radio pipeline: ${via} → keyword mock → bots`,
    "sys",
  );

  await sendOrder(world, cleaned, key);
  if (via === "voice") orderInput.value = "";
  flushLogs();
  refreshRoster();
}

orderForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = orderInput.value.trim();
  if (!text) return;
  orderInput.value = "";
  await dispatchOrder(text, "typed");
});

const radio = createVoiceRadio({
  onFinalOrder: (text) => {
    // STT final → LLM/mock → bot goals
    void dispatchOrder(text, "voice");
  },
  onStatus: (status, detail) => {
    voiceBtn.classList.toggle("live", status === "listening");
    voiceBtn.classList.toggle("err", status === "error");
    voiceBtn.disabled = status === "unsupported";
    if (status === "unsupported") {
      voiceBtn.textContent = "Radio: n/a";
      voiceStatusEl.textContent =
        detail ?? "Voice needs Chrome/Edge — use phrases / type";
      return;
    }
    if (status === "listening") {
      voiceBtn.textContent = "Radio: LIVE";
      const key = resolveApiKey(apiKeyInput.value);
      voiceStatusEl.textContent =
        detail ??
        (key
          ? "Listening… STT → LLM → bots"
          : "Listening… STT → mock (set key in src/api-key.local.ts)");
      return;
    }
    if (status === "error") {
      voiceBtn.textContent = "Radio: retry";
      voiceStatusEl.textContent = detail ?? "Mic error — use phrases";
      return;
    }
    voiceBtn.textContent = "Radio: off";
    voiceStatusEl.textContent = "Radio LIVE → STT → LLM/mock → bots";
  },
});

voiceBtn.addEventListener("click", () => {
  void radio.toggle();
});

document.querySelectorAll<HTMLButtonElement>("#phrases [data-order]").forEach(
  (btn) => {
    btn.addEventListener("click", () => {
      const order = btn.getAttribute("data-order");
      if (order) void dispatchOrder(order, "phrase");
    });
  },
);

function refreshRoster(): void {
  const blues = world.tanks
    .filter((t) => t.team === "blue")
    .sort((a, b) => a.number - b.number);
  rosterEl.innerHTML = blues
    .map((t) => {
      const carrier =
        world.gameMode === "ctf" && t.isCodeCarrier ? " ★" : "";
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
  const modeLabel =
    world.gameMode === "ctf"
      ? "CTF"
      : world.shareMode === "clear"
        ? "TDM No Fog"
        : "TDM";
  if (world.outcome === "ready") {
    matchStateEl.textContent = `${modeLabel} · PAUSED — START`;
  } else if (world.outcome === "playing") {
    matchStateEl.textContent = me
      ? `${modeLabel} · #${me.number} · ${world.shareMode}`
      : "No tanks";
  } else {
    matchStateEl.textContent = world.outcome.toUpperCase();
  }

  if (Math.floor(world.time * 4) % 2 === 0) refreshRoster();
  flushLogs();

  requestAnimationFrame(frame);
}

refreshRoster();
flushLogs();
showRoundGate();
requestAnimationFrame(frame);
