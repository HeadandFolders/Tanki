import {
  CONFIG,
  modesFromMenu,
  type GameMode,
  type MenuMode,
  type ShareMode,
} from "./config";
import { apiKeySource, resolveApiKey } from "./api-key";
import {
  beginCountdown,
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
import {
  defaultModelFor,
  detectLlmProvider,
  probeLlmConnection,
  resolveLlmBackend,
  type LlmProbeResult,
  type LlmProviderChoice,
} from "./orders";
import { renderWorld } from "./render";
import { createVoiceRadio } from "./voice";
import type { LlmBackend, WorldState } from "./types";

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
const countdownOverlay = document.querySelector<HTMLElement>("#countdown-overlay")!;
const countdownNumEl = document.querySelector<HTMLElement>("#countdown-num")!;
const countdownCaptionEl = document.querySelector<HTMLElement>(".countdown-caption")!;
const llmStatusEl = document.querySelector<HTMLElement>("#llm-status")!;
const startRoundBtn = document.querySelector<HTMLButtonElement>("#start-round")!;
const startOfflineBtn = document.querySelector<HTMLButtonElement>("#start-offline")!;
const recheckLlmBtn = document.querySelector<HTMLButtonElement>("#recheck-llm")!;
const gateApiKeyInput = document.querySelector<HTMLInputElement>("#gate-api-key")!;
const gateProviderSelect = document.querySelector<HTMLSelectElement>("#gate-llm-provider")!;
const gateModelInput = document.querySelector<HTMLInputElement>("#gate-llm-model")!;
const menuBtn = document.querySelector<HTMLButtonElement>("#menu-btn")!;
const gateModeBtns = [
  ...document.querySelectorAll<HTMLButtonElement>("#gate-modes .gate-mode"),
];

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

/** Hard-refresh always lands on TDM No Fog unless the user already changed the select. */
modeSelect.value = CONFIG.menuModeDefault;
const boot = applyMenuPreset();
let world: WorldState = createWorld(boot.share, boot.mode);
let countdownTimer: number | null = null;
let countdownLeft = 0;

// Prefill placeholders from file/env (password fields stay empty unless user types)
const bootKey = resolveApiKey("");
const bootSrc = apiKeySource("");
if (bootKey) {
  const hint = `key available from ${bootSrc} — paste to override, or Test connection`;
  apiKeyInput.placeholder = hint;
  gateApiKeyInput.placeholder = hint;
}

type GateProbeState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "need_key" }
  | { kind: "ok"; provider: string; model: string; backend: LlmBackend; ms: number }
  | { kind: "fail"; provider?: string; model?: string; error: string; ms: number }
  | { kind: "offline_chosen" };

let gateProbe: GateProbeState = { kind: "idle" };
let probeSeq = 0;
/** Last successful LLM settings — used for in-match radio orders. */
let liveLlm: { backend: LlmBackend; model: string } | null = null;

/** Prefer gate field, then sidebar, then file/env. */
function gateResolvedKey(): string | undefined {
  return resolveApiKey(gateApiKeyInput.value || apiKeyInput.value);
}

function gateProviderChoice(): LlmProviderChoice {
  return gateProviderSelect.value as LlmProviderChoice;
}

function syncKeyFields(from: "gate" | "sidebar"): void {
  if (from === "gate") {
    apiKeyInput.value = gateApiKeyInput.value;
  } else {
    gateApiKeyInput.value = apiKeyInput.value;
  }
}

function providerLabel(p: string): string {
  if (p === "gemini") return "Gemini";
  if (p === "anthropic") return "Anthropic";
  if (p === "openrouter") return "OpenRouter";
  return "OpenAI";
}

function syncModelPlaceholder(): void {
  const choice = gateProviderChoice();
  if (choice !== "auto") {
    gateModelInput.placeholder = defaultModelFor(choice);
    return;
  }
  const key = gateResolvedKey();
  gateModelInput.placeholder = key
    ? defaultModelFor(detectLlmProvider(key))
    : "auto from key (OpenRouter / OpenAI / Gemini / Anthropic)";
}

function renderGateStatus(): void {
  llmStatusEl.classList.remove("llm-ok", "llm-off", "llm-checking");
  const busy = gateProbe.kind === "checking";
  recheckLlmBtn.disabled = busy;
  startOfflineBtn.disabled = busy;
  // Primary Start only after a successful dummy call
  startRoundBtn.disabled = gateProbe.kind !== "ok";

  if (gateProbe.kind === "checking") {
    llmStatusEl.classList.add("llm-checking");
    llmStatusEl.innerHTML =
      `<strong>Testing connection…</strong>` +
      `<span>Sending a tiny dummy request through the /llm/* proxy. Please wait.</span>`;
    startRoundBtn.textContent = "Start";
    return;
  }

  if (gateProbe.kind === "need_key") {
    llmStatusEl.classList.add("llm-off");
    llmStatusEl.innerHTML =
      `<strong>Enter an API key</strong>` +
      `<span>Pick Provider (or Auto), optional Model, paste any supported key, then Test. Or Play offline.</span>`;
    startRoundBtn.textContent = "Start";
    return;
  }

  if (gateProbe.kind === "ok") {
    llmStatusEl.classList.add("llm-ok");
    llmStatusEl.innerHTML =
      `<strong>LLM confirmed (${gateProbe.provider} · ${gateProbe.model} · ${gateProbe.ms}ms)</strong>` +
      `<span>Dummy call succeeded. Start — radio orders use this provider/model/key.</span>`;
    startRoundBtn.textContent = "Start match";
    startRoundBtn.focus();
    return;
  }

  if (gateProbe.kind === "fail") {
    llmStatusEl.classList.add("llm-off");
    const who = gateProbe.provider
      ? ` · ${gateProbe.provider}${gateProbe.model ? ` / ${gateProbe.model}` : ""}`
      : "";
    llmStatusEl.innerHTML =
      `<strong>LLM failed${who} (${gateProbe.ms}ms)</strong>` +
      `<span>${gateProbe.error}. Try Provider=OpenRouter for sk-or-… keys, or change Model. Or Play offline.</span>`;
    startRoundBtn.textContent = "Start";
    return;
  }

  if (gateProbe.kind === "offline_chosen") {
    llmStatusEl.classList.add("llm-off");
    llmStatusEl.innerHTML =
      `<strong>Offline mode</strong>` +
      `<span>Keyword parser only — no cloud LLM this match.</span>`;
    startRoundBtn.textContent = "Start";
    return;
  }

  llmStatusEl.innerHTML = `<strong>LLM: …</strong><span>Waiting for a key test.</span>`;
  startRoundBtn.disabled = true;
  startRoundBtn.textContent = "Start";
}

async function runLlmProbe(): Promise<void> {
  const seq = ++probeSeq;
  syncKeyFields("gate");
  const key = gateResolvedKey();
  if (!key) {
    liveLlm = null;
    gateProbe = { kind: "need_key" };
    renderGateStatus();
    gateApiKeyInput.focus();
    return;
  }

  gateProbe = { kind: "checking" };
  renderGateStatus();

  const result: LlmProbeResult = await probeLlmConnection(key, {
    provider: gateProviderChoice(),
    model: gateModelInput.value,
  });
  if (seq !== probeSeq) return; // stale

  if (result.ok) {
    liveLlm = { backend: result.provider, model: result.model };
    gateProbe = {
      kind: "ok",
      provider: providerLabel(result.provider),
      model: result.model,
      backend: result.provider,
      ms: result.ms,
    };
  } else {
    liveLlm = null;
    gateProbe = {
      kind: "fail",
      provider: result.provider ? providerLabel(result.provider) : undefined,
      model: result.model,
      error: result.error,
      ms: result.ms,
    };
  }
  renderGateStatus();
}

function syncGateModeButtons(): void {
  const current = modeSelect.value;
  for (const btn of gateModeBtns) {
    const on = btn.dataset.mode === current;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function selectMenuMode(menu: MenuMode, rebuild: boolean): void {
  modeSelect.value = menu;
  const resolved = modesFromMenu(menu);
  shareSelect.value = resolved.share;
  syncGateModeButtons();
  if (rebuild) {
    // Rebuild the paused match with the new mode (still behind the menu)
    world = createWorld(resolved.share, resolved.mode);
    chatCursor = 0;
    eventCursor = 0;
    chatEl.innerHTML = "";
    eventsEl.innerHTML = "";
    refreshRoster();
    flushLogs();
  }
}

function cancelCountdown(): void {
  if (countdownTimer != null) {
    window.clearTimeout(countdownTimer);
    countdownTimer = null;
  }
  countdownLeft = 0;
  countdownOverlay.hidden = true;
}

function showRoundGate(): void {
  cancelCountdown();
  if (world.outcome === "countdown") {
    world.outcome = "ready";
  }
  countdownOverlay.hidden = true;
  roundGate.hidden = false;
  syncGateModeButtons();
  syncModelPlaceholder();
  liveLlm = null;
  gateProbe = { kind: "idle" };
  renderGateStatus();
  // If file/env already has a key, auto-run the dummy call; else wait for input
  if (gateResolvedKey()) {
    void runLlmProbe();
  } else {
    gateProbe = { kind: "need_key" };
    renderGateStatus();
    gateApiKeyInput.focus();
  }
}

function hideRoundGate(): void {
  roundGate.hidden = true;
  canvas.focus();
}

function finishCountdown(): void {
  countdownTimer = null;
  countdownOverlay.hidden = true;
  startMatch(world);
  const modeNote =
    gateProbe.kind === "ok"
      ? `LLM live (${gateProbe.provider}).`
      : "Keyword mock orders (offline).";
  pushEvent(world, `Match started — ${modeNote}`, "warn");
  flushLogs();
  refreshRoster();
  canvas.focus();
}

function tickCountdown(): void {
  if (world.outcome !== "countdown") {
    cancelCountdown();
    return;
  }
  if (countdownLeft <= 0) {
    countdownNumEl.textContent = "GO";
    countdownCaptionEl.textContent = "Match live";
    countdownTimer = window.setTimeout(finishCountdown, 450);
    return;
  }
  countdownNumEl.textContent = String(countdownLeft);
  countdownCaptionEl.textContent =
    countdownLeft === CONFIG.startCountdownSec ? "Get ready" : "Stand by";
  countdownLeft -= 1;
  countdownTimer = window.setTimeout(tickCountdown, 1000);
}

function startPreMatchCountdown(): void {
  cancelCountdown();
  beginCountdown(world);
  hideRoundGate();
  countdownOverlay.hidden = false;
  countdownLeft = CONFIG.startCountdownSec;
  countdownNumEl.textContent = String(countdownLeft);
  countdownCaptionEl.textContent = "Get ready";
  flushLogs();
  // First tick advances after one second so "3" is visible immediately
  countdownLeft -= 1;
  countdownTimer = window.setTimeout(tickCountdown, 1000);
}

function beginRound(forceOffline = false): void {
  if (world.outcome !== "ready") return;
  if (gateProbe.kind === "checking") return;

  if (forceOffline) {
    gateProbe = { kind: "offline_chosen" };
  }

  // Require verified key unless explicitly playing offline
  if (gateProbe.kind !== "ok" && gateProbe.kind !== "offline_chosen") {
    renderGateStatus();
    if (gateProbe.kind === "need_key" || gateProbe.kind === "idle") {
      gateApiKeyInput.focus();
    }
    return;
  }

  syncKeyFields("gate");
  startPreMatchCountdown();
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

function openGameMenu(): void {
  cancelCountdown();
  // Pause live / countdown back to ready so mode/key can be changed
  if (world.outcome === "playing" || world.outcome === "countdown") {
    world.outcome = "ready";
  }
  if (world.outcome === "win" || world.outcome === "lose" || world.outcome === "draw") {
    restartMatch(false);
    return;
  }
  showRoundGate();
}

restartBtn.addEventListener("click", () => restartMatch(false));
menuBtn.addEventListener("click", openGameMenu);
modeSelect.addEventListener("change", () => {
  syncGateModeButtons();
  restartMatch(true);
});
for (const btn of gateModeBtns) {
  btn.addEventListener("click", () => {
    const menu = btn.dataset.mode as MenuMode;
    if (!menu) return;
    selectMenuMode(menu, true);
  });
}
startRoundBtn.addEventListener("click", () => beginRound(false));
startOfflineBtn.addEventListener("click", () => beginRound(true));
recheckLlmBtn.addEventListener("click", () => {
  void runLlmProbe();
});
gateApiKeyInput.addEventListener("input", () => {
  syncKeyFields("gate");
  syncModelPlaceholder();
  liveLlm = null;
  if (gateProbe.kind === "ok" || gateProbe.kind === "fail") {
    gateProbe = { kind: "need_key" };
    renderGateStatus();
  }
});
gateApiKeyInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void runLlmProbe();
  }
});
gateProviderSelect.addEventListener("change", () => {
  syncModelPlaceholder();
  // Prefill empty model field with the provider default
  if (!gateModelInput.value.trim() && gateProviderChoice() !== "auto") {
    gateModelInput.placeholder = defaultModelFor(gateProviderChoice() as LlmBackend);
  }
  liveLlm = null;
  if (gateProbe.kind === "ok" || gateProbe.kind === "fail") {
    gateProbe = { kind: "idle" };
    renderGateStatus();
  }
});
gateModelInput.addEventListener("input", () => {
  liveLlm = null;
  if (gateProbe.kind === "ok" || gateProbe.kind === "fail") {
    gateProbe = { kind: "idle" };
    renderGateStatus();
  }
});
gateModelInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void runLlmProbe();
  }
});
apiKeyInput.addEventListener("input", () => {
  if (world.outcome === "ready") syncKeyFields("sidebar");
});
roundGate.addEventListener("keydown", (ev) => {
  if (
    ev.key === "Enter" &&
    gateProbe.kind === "ok" &&
    (ev.target as HTMLElement)?.id !== "gate-api-key"
  ) {
    ev.preventDefault();
    beginRound(false);
  }
});

async function dispatchOrder(
  text: string,
  via: "typed" | "voice" | "phrase",
): Promise<void> {
  const cleaned = text.trim();
  if (!cleaned) return;
  if (world.outcome === "ready" || world.outcome === "countdown") {
    pushEvent(
      world,
      world.outcome === "countdown"
        ? "Countdown in progress — wait for GO."
        : "Match paused — press Start on the overlay first.",
      "warn",
    );
    flushLogs();
    return;
  }
  if (world.outcome !== "playing") return;

  // Cloud LLM only after a successful pre-Start probe — never retry a known-bad key
  const key = gateProbe.kind === "ok" ? gateResolvedKey() : undefined;
  const llmCtx =
    key && liveLlm
      ? { apiKey: key, provider: liveLlm.backend, model: liveLlm.model }
      : key
        ? {
            apiKey: key,
            provider: resolveLlmBackend(key, gateProviderChoice()),
            model: gateModelInput.value.trim() || undefined,
          }
        : {};
  const src = apiKeySource(gateApiKeyInput.value || apiKeyInput.value);

  if (via === "voice") {
    orderInput.value = cleaned;
    pushEvent(world, `STT: “${cleaned}”`, "sys");
  } else if (via === "phrase") {
    pushEvent(world, `Phrase: “${cleaned}”`, "sys");
  }

  pushEvent(
    world,
    key && liveLlm
      ? `Radio pipeline: ${via} → ${providerLabel(liveLlm.backend)}/${liveLlm.model} (${src}) → bots`
      : key
        ? `Radio pipeline: ${via} → LLM (${src}) → bots`
        : `Radio pipeline: ${via} → keyword mock → bots`,
    "sys",
  );

  const beforeEvents = world.events.length;
  await sendOrder(world, cleaned, llmCtx);
  const fresh = world.events.slice(beforeEvents);
  const llmFail = fresh.find((e) => e.text.startsWith("LLM unavailable"));
  if (llmFail && key) {
    // Probe was stale/wrong — lock to keyword mock for the rest of the match
    const detail = llmFail.text
      .replace(/^LLM unavailable \(/, "")
      .replace(/\) — keyword parse\.$/, "");
    gateProbe = {
      kind: "fail",
      error: detail,
      ms: 0,
    };
  }
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
      : world.gameMode === "mp-offline"
        ? "MP Offline"
        : world.shareMode === "clear"
          ? "TDM No Fog"
          : "TDM";
  if (world.outcome === "ready") {
    matchStateEl.textContent = `${modeLabel} · MENU`;
  } else if (world.outcome === "countdown") {
    matchStateEl.textContent = `${modeLabel} · COUNTDOWN`;
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
