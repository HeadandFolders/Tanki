import {
  CONFIG,
  isMpOnline,
  isMpRules,
  modesFromMenu,
  type ArenaId,
  type GameMode,
  type MenuMode,
  type ShareMode,
} from "./config";
import { getRespawnRate } from "./config/balance";
import { arenaLayoutHash, clearWallLayout, saveWallLayout } from "./arena";
import { generatedRoutes } from "./mapgen";
import { layoutHash } from "./arena-routes";
import { apiKeySource, resolveApiKey } from "./api-key";
import {
  createCamera,
  followCamera,
  minimapRect,
  minimapToWorld,
  screenToWorld,
  snapCamera,
  zoomCamera,
} from "./camera";
import {
  beginCountdown,
  controlledTank,
  createWorld,
  formatTime,
  markWreckAt,
  placePlayerMark,
  pushEvent,
  respawnQueue,
  sendOrder,
  startMatch,
  stepWorld,
  switchToNumber,
  switchToTank,
  type InputState,
} from "./game";
import {
  defaultModelFor,
  detectLlmProvider,
  probeLlmConnection,
  resolveLlmBackend,
  type LlmProbeResult,
  type LlmProviderChoice,
} from "./orders";
import {
  invertArrowKeys,
  renderMinimap,
  renderWorld,
  viewerHomeAtBottom,
} from "./render";
import { createVoiceRadio } from "./voice";
import { mountCommandOverlay } from "./command-overlay";
import { mountCommandHistory } from "./command-history";
import { beginUtterance, hasPartialCommandIntent, resetRadio } from "./radio";
import { needleSidecarEnabled, setNeedleSidecarEnabled } from "./needle-sidecar";
import { NetClient } from "./net/client";
import type { NetInput, NetTeam } from "./net/protocol";
import { applySnap, worldToSnap } from "./net/snapshot";
import type { ChatLine, LlmBackend, Wall, WorldState } from "./types";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const ctx = canvas.getContext("2d")!;
const timerEl = document.querySelector("#timer")!;
const matchStateEl = document.querySelector("#match-state")!;
const baseHpEl = document.querySelector<HTMLElement>("#base-hp")!;
const baseHpBlueEl = document.querySelector<HTMLElement>("#base-hp-blue")!;
const baseHpRedEl = document.querySelector<HTMLElement>("#base-hp-red")!;
const respawnHudEl = document.querySelector<HTMLElement>("#respawn-hud")!;
const zoneHudEl = document.querySelector<HTMLElement>("#zone-hud")!;
const zoneStateEl = document.querySelector<HTMLElement>("#zone-hud-state")!;
const zoneRateEl = document.querySelector<HTMLElement>("#zone-hud-rate")!;
const minimapEl = document.querySelector<HTMLCanvasElement>("#minimap")!;
const minimapCtx = minimapEl.getContext("2d")!;
const chatEl = document.querySelector("#chat")!;
const radioOverlayEl = document.querySelector<HTMLDivElement>("#radio-overlay")!;
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
const editMapBtn = document.querySelector<HTMLButtonElement>("#edit-map")!;
const mapEditBar = document.querySelector<HTMLElement>("#map-edit-bar")!;
const mapEditDoneBtn = document.querySelector<HTMLButtonElement>("#map-edit-done")!;
const mapEditResetBtn = document.querySelector<HTMLButtonElement>("#map-edit-reset")!;
const startOfflineBtn = document.querySelector<HTMLButtonElement>("#start-offline")!;
const recheckLlmBtn = document.querySelector<HTMLButtonElement>("#recheck-llm")!;
const gateApiKeyInput = document.querySelector<HTMLInputElement>("#gate-api-key")!;
const gateProviderSelect = document.querySelector<HTMLSelectElement>("#gate-llm-provider")!;
const gateModelInput = document.querySelector<HTMLInputElement>("#gate-llm-model")!;
const menuBtn = document.querySelector<HTMLButtonElement>("#menu-btn")!;
const gateModeBtns = [
  ...document.querySelectorAll<HTMLButtonElement>("#gate-modes .gate-mode"),
];
const mpOpponentPanel = document.querySelector<HTMLElement>("#mp-opponent-panel")!;
const mpOpponentSelect = document.querySelector<HTMLSelectElement>("#mp-opponent")!;
const mpArenaPanel = document.querySelector<HTMLElement>("#mp-arena-panel")!;
const mpArenaSelect = document.querySelector<HTMLSelectElement>("#mp-arena")!;
const mpNetPanel = document.querySelector<HTMLElement>("#mp-net-panel")!;
const mpRoomInput = document.querySelector<HTMLInputElement>("#mp-room")!;
const mpUrlInput = document.querySelector<HTMLInputElement>("#mp-url")!;
const mpHostBtn = document.querySelector<HTMLButtonElement>("#mp-host-btn")!;
const mpJoinBtn = document.querySelector<HTMLButtonElement>("#mp-join-btn")!;
const mpStartBtn = document.querySelector<HTMLButtonElement>("#mp-start-btn")!;
const mpNetStatus = document.querySelector<HTMLElement>("#mp-net-status")!;
const mpLanUrls = document.querySelector<HTMLElement>("#mp-lan-urls")!;

/** Local human team for online play (host=blue, guest=red). */
let localTeam: NetTeam = "blue";
let netGuestConnected = false;
let latestPeerInput: InputState | null = null;
let snapAcc = 0;
let guestControlledNumber = 1;

function setMpStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  mpNetStatus.textContent = text;
  mpNetStatus.classList.remove("ok", "err");
  if (kind) mpNetStatus.classList.add(kind);
}

/** Prefer home Wi‑Fi IPs; flag Cursor/cloud 172.x as unreachable from home. */
function rankLanIp(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (ip.startsWith("172.")) return 3;
  return 2;
}

function showHostLanUrls(ips: string[], room: string): void {
  const sorted = [...ips].sort(
    (a, b) => rankLanIp(a) - rankLanIp(b) || a.localeCompare(b),
  );
  const preferred = sorted.filter((ip) => !ip.startsWith("172."));
  const cloudish = sorted.filter((ip) => ip.startsWith("172."));
  const show = preferred.length ? preferred : sorted;
  const lines = show.map(
    (ip) =>
      `<div><strong>http://${ip}:4847</strong> · room <code>${room}</code> · relay <code>ws://${ip}:4855</code></div>`,
  );
  let warn = "";
  if (!preferred.length && cloudish.length) {
    warn = `<p class="mp-lan-warn">These look like cloud/docker addresses (172.x). Phones on home Wi‑Fi cannot reach a Cursor VM. Run <code>npm run dev:mp</code> on your home PC and share a <code>192.168.x.x</code> URL instead.</p>`;
  } else if (cloudish.length) {
    warn = `<p class="mp-lan-warn">Ignoring 172.x (${cloudish.join(", ")}) — often unreachable from home Wi‑Fi.</p>`;
  }
  mpLanUrls.innerHTML = `<div>Guest opens (same Wi‑Fi):</div>${lines.join("")}${warn}`;
  mpLanUrls.hidden = false;
}

function clearHostLanUrls(): void {
  mpLanUrls.hidden = true;
  mpLanUrls.innerHTML = "";
}

function syncMpPanel(): void {
  const online = modeSelect.value === "mp-online";
  mpNetPanel.hidden = !online;
  if (online) {
    startOfflineBtn.textContent = "Play bots offline instead";
  } else {
    startOfflineBtn.textContent = "Play offline";
  }
}

const net = new NetClient({
  onStatus: (s) => {
    if (s.kind === "connecting") {
      clearHostLanUrls();
      setMpStatus("Connecting to relay…");
      mpStartBtn.disabled = true;
    } else if (s.kind === "connected" || s.kind === "lobby") {
      localTeam = s.team;
      netGuestConnected = s.kind === "lobby" ? s.guestConnected : false;
      const info = net.info;
      if (s.role === "host" && info.lanIps.length) {
        showHostLanUrls(info.lanIps, s.room);
      } else {
        clearHostLanUrls();
      }
      const homeIps = info.lanIps.filter((ip) => !ip.startsWith("172."));
      const tip =
        s.role === "host" && !homeIps.length && info.lanIps.some((ip) => ip.startsWith("172."))
          ? "\n⚠ 172.x only — run host on your home PC, not a Cursor cloud VM."
          : "";
      const line =
        s.kind === "lobby" && s.role === "host"
          ? `Hosting room ${s.room} as BLUE.` +
            (s.guestConnected
              ? "\nGuest connected — click Start when guest joins."
              : "\nWaiting for guest on the same Wi‑Fi…") +
            tip
          : s.kind === "lobby" && s.role === "guest"
            ? `Joined room ${s.room} as RED. Waiting for host to Start.`
            : `Connected as ${s.role.toUpperCase()} (${s.team}) room ${s.room}`;
      setMpStatus(line, "ok");
      mpStartBtn.disabled = !(s.role === "host" && netGuestConnected);
    } else if (s.kind === "error") {
      clearHostLanUrls();
      setMpStatus(s.message, "err");
      mpStartBtn.disabled = true;
    }
  },
  onStart: (seed, arena, arenaSeed, hostHash) => {
    const resolved = modesFromMenu("mp-online");
    mpArenaSelect.value = arena;
    world = createWorld(resolved.share, resolved.mode, "normal", seed, "normal", arena, arenaSeed);
    const hash = layoutHash(world.walls);
    if (localTeam === "red") net.sendLayout(hash);
    if (hash !== hostHash) {
      layoutMismatch(hash, hostHash);
      return;
    }
    resetLogs();
    gateProbe = { kind: "offline_chosen" };
    pushEvent(
      world,
      localTeam === "blue"
        ? "Online match — you are BLUE (host)."
        : "Online match — you are RED (guest).",
      "warn",
    );
    startPreMatchCountdown();
  },
  onState: (snap) => {
    if (localTeam !== "red") return;
    const oldChat = world.chat;
    const oldEvents = world.events;
    applySnap(world, snap, "red");
    // Snapshot tails are reconstructed objects. Retain identity for their shared
    // suffix/prefix so the radio does not replay the same captions every frame.
    world.chat = retainLogIdentity(oldChat, world.chat);
    world.events = retainLogIdentity(oldEvents, world.events);
    if (world.chat.some((line) => !oldChat.includes(line) && line.team === localTeam &&
      /say again|negative|lost|unable|order closed/i.test(line.text))) resetRadio(world, localTeam);
    // Keep guest's selected tank from snapshot remote id
    if (world.remoteControlledId) {
      const t = world.tanks.find((x) => x.id === world.remoteControlledId);
      if (t) guestControlledNumber = t.number;
    }
  },
  onPeerInput: (input) => {
    latestPeerInput = {
      keys: new Set(input.keys),
      mouseX: input.mouseX,
      mouseY: input.mouseY,
      shooting: input.shooting,
    };
    if (input.controlledNumber >= 1 && input.controlledNumber <= 6) {
      switchToNumber(world, input.controlledNumber, "red");
    }
  },
  onPeerOrder: (text, segmentId) => {
    void sendOrder(world, text, hostLlmContext(), "red", undefined, { segmentId });
    flushLogs();
  },
  onPeerMark: (x, y) => {
    placePlayerMark(world, "red", x, y);
    flushLogs();
  },
  onPeerLayout: (hash) => {
    const mine = layoutHash(world.walls);
    if (hash !== mine) layoutMismatch(mine, hash);
  },
  onLog: (line) => {
    if (world) pushEvent(world, line, "sys");
  },
});

/** Both peers must rasterize the same walls; local wall edits are the usual cause. */
function layoutMismatch(mine: string, theirs: string): void {
  showRoundGate();
  setMpStatus(
    `Arena layout mismatch (mine ${mine}, peer ${theirs}). ` +
      "Clear wall edits (map editor → Reset) on both sides and Start again.",
    "err",
  );
  pushEvent(world, "Online start aborted: arena layouts differ between host and guest.", "warn");
  flushLogs();
}

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

function currentOpponent(): "easy" | "normal" | "hard" | "off" {
  const value = mpOpponentSelect.value;
  return value === "easy" || value === "hard" || value === "off" ? value : "normal";
}

/** Arena pick applies to the multiplayer modes only; others keep their fixed layouts. */
function currentArena(): ArenaId | undefined {
  const menu = modeSelect.value;
  if (menu !== "mp-offline" && menu !== "mp-online" && menu !== "base-war") return undefined;
  const value = mpArenaSelect.value;
  return value === "generated" || value === "large" ? value : "dense";
}

/**
 * `?map-seed=` picks which generated map the page builds; without it the map
 * stays on the authored default seed so every other arena is untouched.
 */
const MAP_SEED = (() => {
  const raw = new URLSearchParams(location.search).get("map-seed");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : CONFIG.largeArena.seed;
})();

/** `?routes=1` shows the three routes at boot; "r" toggles them from there. */
let showRoutes = new URLSearchParams(location.search).get("routes") === "1";

/** Hard-refresh always lands on TDM No Fog unless the user already changed the select. */
modeSelect.value = CONFIG.menuModeDefault;
if (new URLSearchParams(location.search).get("arena") === "generated") {
  modeSelect.value = "mp-offline";
  mpArenaSelect.value = "generated";
}
const boot = applyMenuPreset();
let world: WorldState = createWorld(boot.share, boot.mode, "normal", undefined, currentOpponent(), currentArena(), MAP_SEED);
let countdownTimer: number | null = null;
let countdownLeft = 0;

mountCommandOverlay(canvas.parentElement!);
mountCommandHistory(
  document.querySelector<HTMLElement>("#command-history")!,
  () => world.gameMode,
);
if (new URLSearchParams(location.search).get("needle") === "1") {
  setNeedleSidecarEnabled(true);
}
if (needleSidecarEnabled()) {
  pushEvent(world, "Needle sidecar: loading local model…", "sys");
  let lastShown = -1;
  void import("./needle-browser")
    .then((m) =>
      m.loadBrowserNeedle((pct) => {
        const step = pct == null ? -1 : Math.floor(pct / 25) * 25;
        if (step <= lastShown) return;
        lastShown = step;
        pushEvent(world, `Needle sidecar: model ${step}%`, "sys");
      }),
    )
    .then(() => pushEvent(world, "Needle sidecar: ready.", "sys"))
    .catch((err: unknown) =>
      pushEvent(
        world,
        `Needle sidecar failed to load (${err instanceof Error ? err.message : String(err)}) — LLM path only.`,
        "warn",
      ),
    );
}

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
      `<span>Phrase reader only — unrecognized orders are not applied.</span>`;
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
  shareSelect.disabled = current === "base-war";
  if (current === "base-war") shareSelect.value = "clear";
  mpOpponentPanel.hidden = current !== "mp-offline" && current !== "base-war";
  const off = mpOpponentSelect.querySelector<HTMLOptionElement>('option[value="off"]')!;
  off.disabled = current === "base-war";
  off.hidden = current === "base-war";
  if (current === "base-war" && mpOpponentSelect.value === "off") mpOpponentSelect.value = "normal";
  mpArenaPanel.hidden = current !== "mp-offline" && current !== "mp-online" && current !== "base-war";
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
  syncMpPanel();
  if (menu !== "mp-online") {
    net.disconnect();
    localTeam = "blue";
    latestPeerInput = null;
    setMpStatus("Not connected.");
  }
  if (rebuild) {
    // Rebuild the paused match with the new mode (still behind the menu)
    world = createWorld(resolved.share, resolved.mode, "normal", undefined, currentOpponent(), currentArena(), MAP_SEED);
    resetLogs();
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
      : "Phrase reader orders (offline).";
  pushEvent(world, `Match started — ${modeNote}`, "warn");
  flushLogs();
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

  // Online matches start via Host "Start when guest joins" (net onStart).
  if (isMpOnline(world.gameMode) && !forceOffline) {
    setMpStatus("Use Host / Join below, then Start when guest joins.", "err");
    return;
  }

  if (forceOffline) {
    gateProbe = { kind: "offline_chosen" };
    // Playing bots locally even if Online mode card is selected
    if (modeSelect.value === "mp-online") {
      selectMenuMode("mp-offline", true);
    }
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

mpHostBtn.addEventListener("click", () => {
  selectMenuMode("mp-online", true);
  net.connect({
    role: "host",
    room: mpRoomInput.value.trim() || CONFIG.net.defaultRoom,
    url: mpUrlInput.value.trim() || undefined,
  });
  net.sendReady();
});

mpJoinBtn.addEventListener("click", () => {
  selectMenuMode("mp-online", true);
  net.connect({
    role: "guest",
    room: mpRoomInput.value.trim() || CONFIG.net.defaultRoom,
    url: mpUrlInput.value.trim() || undefined,
  });
  net.sendReady();
});

mpStartBtn.addEventListener("click", () => {
  if (!net.info.connected || net.info.role !== "host") return;
  if (!netGuestConnected) {
    setMpStatus("Wait for a guest to join first.", "err");
    return;
  }
  gateProbe = { kind: "offline_chosen" };
  const arena = currentArena() ?? CONFIG.arenaDefault;
  net.sendStart(arena, MAP_SEED, arenaLayoutHash(arena, MAP_SEED));
});

const keys = new Set<string>();
let mouseX = CONFIG.viewWidth / 2;
let mouseY = CONFIG.viewHeight / 2;
/** Cursor over the overview panel, in panel px — the only place a mark pins. */
let miniCursor: { x: number; y: number } | null = null;
let shooting = false;
let mapEditing = false;
let dragWall: Wall | null = null;
let dragOffX = 0;
let dragOffY = 0;
let lastTs = performance.now();
let seenChat = new WeakSet<ChatLine>();
let seenEvents = new WeakSet<ChatLine>();
let logWorld: WorldState | null = null;
let logTeam: NetTeam | null = null;
const cam = createCamera();
/** World the camera was last snapped to; a new world re-centers on the hull. */
let camWorld: WorldState | null = null;

function canvasCoords(ev: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * CONFIG.viewWidth;
  const y = ((ev.clientY - rect.top) / rect.height) * CONFIG.viewHeight;
  return { x, y };
}

/** Cursor → world space through the camera (zoom, pan, online-red 180° flip). */
function pointerWorld(): { x: number; y: number } {
  return screenToWorld(cam, mouseX, mouseY);
}

function localHull(): { x: number; y: number } | undefined {
  const id = localTeam === "red" ? world.remoteControlledId : world.controlledId;
  return world.tanks.find((t) => t.id === id);
}

function updateCamera(dt: number): void {
  cam.flipped = viewerHomeAtBottom(world.gameMode, localTeam);
  if (camWorld !== world) {
    camWorld = world;
    const me = localHull();
    snapCamera(cam, me?.x ?? CONFIG.canvasWidth / 2, me?.y ?? CONFIG.canvasHeight / 2);
    return;
  }
  if (mapEditing) {
    // Arrows pan the editor view (screen axes, so the flip is honored).
    const s = (cam.flipped ? -1 : 1) * (600 / cam.zoom) * dt;
    let dx = 0;
    let dy = 0;
    if (keys.has("arrowleft")) dx -= s;
    if (keys.has("arrowright")) dx += s;
    if (keys.has("arrowup")) dy -= s;
    if (keys.has("arrowdown")) dy += s;
    if (dx || dy) snapCamera(cam, cam.x + dx, cam.y + dy);
    return;
  }
  const me = localHull();
  if (me) followCamera(cam, me.x, me.y, dt);
}

function pickStructure(x: number, y: number): Wall | null {
  let best: Wall | null = null;
  let bestArea = Infinity;
  for (const w of world.walls) {
    if (w.kind === "border") continue;
    if (x < w.x || y < w.y || x > w.x + w.w || y > w.y + w.h) continue;
    const area = w.w * w.h;
    if (area < bestArea) {
      best = w;
      bestArea = area;
    }
  }
  return best;
}

function moveStructure(wall: Wall, x: number, y: number): void {
  const s = CONFIG.tileSize;
  const pad = s * 2;
  let nx = Math.round(x / s) * s;
  let ny = Math.round(y / s) * s;
  nx = Math.max(pad, Math.min(CONFIG.canvasWidth - pad - wall.w, nx));
  ny = Math.max(pad, Math.min(CONFIG.canvasHeight - pad - wall.h, ny));
  wall.x = nx;
  wall.y = ny;
}

function enterMapEdit(): void {
  mapEditing = true;
  dragWall = null;
  roundGate.hidden = true;
  mapEditBar.hidden = false;
  canvas.focus();
}

function leaveMapEdit(): void {
  const wasEditing = mapEditing;
  dragWall = null;
  if (wasEditing) saveWallLayout(world.walls, world.arenaId);
  mapEditing = false;
  mapEditBar.hidden = true;
  canvas.style.cursor = "";
  if (wasEditing && world.outcome === "ready") {
    const { share, mode } = currentModes();
    world = createWorld(share, mode, "normal", undefined, currentOpponent(), currentArena(), MAP_SEED);
  }
}

canvas.addEventListener("mousemove", (ev) => {
  const p = canvasCoords(ev);
  mouseX = p.x;
  mouseY = p.y;
  if (!mapEditing) return;
  const worldPt = pointerWorld();
  if (dragWall) {
    moveStructure(dragWall, worldPt.x - dragOffX, worldPt.y - dragOffY);
    canvas.style.cursor = "grabbing";
    return;
  }
  canvas.style.cursor = pickStructure(worldPt.x, worldPt.y) ? "grab" : "default";
});

canvas.addEventListener("mousedown", (ev) => {
  canvas.focus();
  const p = canvasCoords(ev);
  mouseX = p.x;
  mouseY = p.y;

  if (ev.button === 0 && mapEditing) {
    const worldPt = pointerWorld();
    const hit = pickStructure(worldPt.x, worldPt.y);
    if (hit) {
      dragWall = hit;
      dragOffX = worldPt.x - hit.x;
      dragOffY = worldPt.y - hit.y;
      canvas.style.cursor = "grabbing";
    }
    return;
  }

  if (ev.button === 0) {
    // A mark pins on the overview panel only; F on the map stays inert so it
    // does not quietly turn into a hull switch.
    if (keys.has("f")) return;
    const worldPt = pointerWorld();
    const friendly = world.tanks.find(
      (t) =>
        t.team === localTeam &&
        t.alive &&
        Math.hypot(t.x - worldPt.x, t.y - worldPt.y) <= CONFIG.tankRadius + 6,
    );
    if (friendly) {
      if (localTeam === "red") guestControlledNumber = friendly.number;
      switchToTank(world, friendly.id, localTeam);
      return;
    }
    if (markWreckAt(world, worldPt.x, worldPt.y)) {
      flushLogs();
      return;
    }
    shooting = true;
  }
});

/** Hold-F mark, dropped either under the cursor on the map or on the panel. */
function dropMark(target: { x: number; y: number }): void {
  if (world.outcome !== "playing" && world.outcome !== "countdown") return;
  const placed = placePlayerMark(world, localTeam, target.x, target.y);
  if (isMpOnline(world.gameMode) && localTeam === "red" && net.info.connected) {
    net.sendMark(placed.x, placed.y);
  }
  flushLogs();
}

minimapEl.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0 || !keys.has("f")) return;
  const rect = minimapEl.getBoundingClientRect();
  const r = minimapRect();
  const spot = minimapToWorld(
    cam,
    ((ev.clientX - rect.left) / rect.width) * r.w,
    ((ev.clientY - rect.top) / rect.height) * r.h,
  );
  if (spot) dropMark(spot);
});

minimapEl.addEventListener("mousemove", (ev) => {
  const rect = minimapEl.getBoundingClientRect();
  const r = minimapRect();
  miniCursor = {
    x: ((ev.clientX - rect.left) / rect.width) * r.w,
    y: ((ev.clientY - rect.top) / rect.height) * r.h,
  };
});
minimapEl.addEventListener("mouseleave", () => {
  miniCursor = null;
});

window.addEventListener("mouseup", () => {
  shooting = false;
  if (!dragWall) return;
  dragWall = null;
  if (mapEditing) saveWallLayout(world.walls, world.arenaId);
});

canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    zoomCamera(cam, Math.sign(ev.deltaY));
  },
  { passive: false },
);

editMapBtn.addEventListener("click", () => enterMapEdit());
mapEditDoneBtn.addEventListener("click", () => {
  leaveMapEdit();
  showRoundGate();
});
mapEditResetBtn.addEventListener("click", () => {
  clearWallLayout(world.arenaId);
  dragWall = null;
  const { share, mode } = currentModes();
  world = createWorld(share, mode, "normal", undefined, currentOpponent(), currentArena(), MAP_SEED);
  flushLogs();
});

window.addEventListener("keydown", (ev) => {
  const tag = (ev.target as HTMLElement)?.tagName;
  const k = ev.key === " " ? " " : ev.key.toLowerCase();
  // F stays tracked while held so a click can drop a mark even if an input had focus.
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (k === "f") keys.add("f");
    return;
  }

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
  if (k === "r" && world.arenaId === "generated") {
    showRoutes = !showRoutes;
  }
  if (k === " " || k === "spacebar") {
    shooting = true;
  }
  if (ev.key >= "1" && ev.key <= "6") {
    const n = Number(ev.key);
    if (localTeam === "red") {
      guestControlledNumber = n;
      switchToNumber(world, n, "red");
    } else {
      switchToNumber(world, n, "blue");
    }
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
  if (world.gameMode === "base-war") shareSelect.value = "clear";
  world.shareMode = shareSelect.value as ShareMode;
});

function restartMatch(fromMenu = false): void {
  leaveMapEdit();
  const { share, mode } = fromMenu ? applyMenuPreset() : currentModes();
  world = createWorld(share, mode, "normal", undefined, currentOpponent(), currentArena(), MAP_SEED);
  resetLogs();
  flushLogs();
  showRoundGate();
}

function openGameMenu(): void {
  leaveMapEdit();
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
  syncMpPanel();
  restartMatch(true);
});
mpOpponentSelect.addEventListener("change", () => {
  if (roundGate.hidden || (modeSelect.value !== "mp-offline" && modeSelect.value !== "base-war")) return;
  // Replace the paused world so pending commander orders cannot survive a change.
  selectMenuMode(modeSelect.value as MenuMode, true);
});
mpArenaSelect.addEventListener("change", () => {
  if (roundGate.hidden || currentArena() === undefined) return;
  selectMenuMode(modeSelect.value as MenuMode, true);
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

function hostLlmContext(): {
  apiKey?: string;
  provider?: ReturnType<typeof resolveLlmBackend>;
  model?: string;
} {
  const key = gateProbe.kind === "ok" ? gateResolvedKey() : undefined;
  if (!key) return {};
  if (liveLlm) {
    return { apiKey: key, provider: liveLlm.backend, model: liveLlm.model };
  }
  return {
    apiKey: key,
    provider: resolveLlmBackend(key, gateProviderChoice()),
    model: gateModelInput.value.trim() || undefined,
  };
}

async function submitOrder(
  text: string,
  via: "typed" | "voice" | "phrase",
  segmentId?: string,
): Promise<void> {
  const cleaned = text.trim();
  // Keep hot-mic chatter out of the parser, radio, and diagnostic event log.
  if (!cleaned || !hasPartialCommandIntent(cleaned)) return;
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
  const llmCtx = hostLlmContext();
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
        : `Radio pipeline: ${via} → phrase reader → bots`,
    "sys",
  );

  const beforeEvents = new Set(world.events);
  // Guest sends orders to host for authoritative apply
  if (isMpOnline(world.gameMode) && localTeam === "red" && net.info.connected) {
    if (!beginUtterance(world, cleaned, localTeam, segmentId)) return;
    net.sendOrder(cleaned, { segmentId });
    pushEvent(world, `Order sent to host: ${cleaned}`, "sys");
    flushLogs();
    return;
  }
  const pending = sendOrder(world, cleaned, llmCtx, localTeam, undefined, { segmentId });
  flushLogs(); // beginUtterance emits standby synchronously, before the parser awaits.
  await pending;
  const fresh = world.events.filter((e) => !beforeEvents.has(e));
  const llmFail = fresh.find((e) => e.text.startsWith("LLM unavailable"));
  if (llmFail && key) {
    // Probe was stale/wrong — lock to phrase reader for the rest of the match
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
}

orderForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = orderInput.value.trim();
  if (!text) return;
  orderInput.value = "";
  await submitOrder(text, "typed");
});

const radio = createVoiceRadio({
  onOrder: (text, segmentId) => {
    void submitOrder(text, "voice", segmentId);
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
          : "Listening… STT → phrase reader (cloud key optional)");
      return;
    }
    if (status === "error") {
      voiceBtn.textContent = "Radio: retry";
      voiceStatusEl.textContent = detail ?? "Mic error — use phrases";
      return;
    }
    voiceBtn.textContent = "Radio: off";
    voiceStatusEl.textContent = "Radio LIVE → STT → LLM/phrases → bots";
  },
});

voiceBtn.addEventListener("click", () => {
  void radio.toggle();
});

document.querySelectorAll<HTMLButtonElement>("#phrases [data-order]").forEach(
  (btn) => {
    btn.addEventListener("click", () => {
      const order = btn.getAttribute("data-order");
      if (order) void submitOrder(order, "phrase");
    });
  },
);

/** The panel canvas follows the arena aspect, so a new arena resizes it. */
function syncMinimapSurface(): void {
  const r = minimapRect();
  if (minimapEl.width !== r.w) minimapEl.width = r.w;
  if (minimapEl.height !== r.h) minimapEl.height = r.h;
}

/** Both structures' HP in the top bar, the numbers the match is decided on. */
function renderBaseHp(world: WorldState): void {
  const bases = world.bases;
  baseHpEl.hidden = !bases;
  if (!bases) return;
  baseHpBlueEl.textContent = `blue base ${Math.ceil(bases.blue.hp)}/${bases.blue.maxHp}${bases.blue.alive ? "" : " · lost"}`;
  baseHpRedEl.textContent = `red base ${Math.ceil(bases.red.hp)}/${bases.red.maxHp}${bases.red.alive ? "" : " · lost"}`;
}

/** Company hulls in the ground and the seconds left before each one is back. */
function renderRespawnHud(world: WorldState): void {
  const queue = respawnQueue(world, localTeam);
  respawnHudEl.hidden = queue.length === 0;
  if (!queue.length) return;
  const span = (cls: string, text: string): HTMLElement => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  };
  respawnHudEl.replaceChildren(
    span("respawn-label", "respawn"),
    ...queue.map(({ tank, secondsLeft }) =>
      span("respawn-item",
        `#${tank.number} ${CONFIG.roles[tank.role].shortCode} ${Math.ceil(secondsLeft)}s`)),
  );
}

/**
 * Who owns the middle zone's respawn bonus, and what each side's clock is
 * running at. The zone only bites where dead hulls come back, so outside the
 * multiplayer ruleset there is nothing to advertise.
 */
function renderMiddleZone(world: WorldState): void {
  const live = isMpRules(world.gameMode);
  zoneHudEl.hidden = !live;
  if (!live) return;
  const zone = world.middleZone;
  const holder = zone.holder;
  zoneStateEl.textContent = `middle ${holder ? `${holder} holds` : zone.contested ? "contested" : "open"}`;
  zoneStateEl.className = `zone-hud-state ${holder ? `zone-${holder}` : zone.contested ? "zone-contested" : "zone-open"}`;
  zoneRateEl.textContent = `respawn blue ×${getRespawnRate("blue", zone)} red ×${getRespawnRate("red", zone)}`;
}

function appendLog(
  el: Element,
  line: { text: string; kind: string },
): void {
  const div = document.createElement("div");
  div.className = `line ${line.kind}`;
  div.textContent = line.text;
  el.appendChild(div);
  while (el.children.length > 80) el.firstElementChild?.remove();
  el.scrollTop = el.scrollHeight;
}

/** Control switches name a hull. The other player must not see which one. */
function revealsEnemyCommander(text: string): boolean {
  if (localTeam === "blue") return text.startsWith("Remote control →");
  return (
    text.startsWith("Control →") || text.includes("continuing last order")
  );
}

function retainLogIdentity(old: ChatLine[], next: ChatLine[]): ChatLine[] {
  const equal = (a: ChatLine, b: ChatLine) =>
    a.text === b.text && a.kind === b.kind && a.team === b.team && a.t === b.t;
  for (let overlap = Math.min(old.length, next.length); overlap > 0; overlap--) {
    const offset = old.length - overlap;
    if (next.slice(0, overlap).every((line, i) => equal(old[offset + i]!, line))) {
      return [...old.slice(offset), ...next.slice(overlap)];
    }
  }
  return next;
}

function resetLogs(): void {
  seenChat = new WeakSet();
  seenEvents = new WeakSet();
  logWorld = world;
  logTeam = localTeam;
  chatEl.replaceChildren();
  eventsEl.replaceChildren();
}

/** Barks must be readable over the map, not only in a sidebar that a short window pushes off-screen. */
const RADIO_OVERLAY_SEC = 8;
function renderRadioOverlay(privateLine: (line: ChatLine) => boolean): void {
  const recent: ChatLine[] = [];
  for (let i = world.chat.length - 1; i >= 0 && recent.length < 3; i--) {
    const line = world.chat[i]!;
    if (privateLine(line) || world.time - line.t > RADIO_OVERLAY_SEC) continue;
    recent.unshift(line);
  }
  radioOverlayEl.replaceChildren();
  radioOverlayEl.hidden = recent.length === 0;
  for (const line of recent) {
    const div = document.createElement("div");
    div.className = `line ${line.kind}`;
    div.textContent = line.text;
    radioOverlayEl.appendChild(div);
  }
}

function flushLogs(): void {
  if (logWorld !== world || logTeam !== localTeam) resetLogs();
  const privateLine = (line: ChatLine) =>
    Boolean(line.team && line.team !== localTeam) || revealsEnemyCommander(line.text);
  const flush = (lines: ChatLine[], seen: WeakSet<ChatLine>, el: Element) => {
    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      if (privateLine(line)) continue;
      appendLog(el, line);
    }
  };
  // Object identity survives the capped arrays shifting; a numeric cursor does not.
  flush(world.chat, seenChat, chatEl);
  flush(world.events, seenEvents, eventsEl);
  renderRadioOverlay(privateLine);
}

function frame(ts: number): void {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  const online = isMpOnline(world.gameMode) && net.info.connected;
  const isGuest = online && localTeam === "red";
  const isHost = online && localTeam === "blue";
  updateCamera(dt);
  const aim = pointerWorld();

  if (isGuest && world.outcome === "playing") {
    // Guest does not simulate — send world-space input (view is rotated 180°).
    const payload: NetInput = {
      keys: invertArrowKeys(keys),
      mouseX: aim.x,
      mouseY: aim.y,
      shooting,
      controlledNumber: guestControlledNumber,
    };
    net.sendInput(payload);
  } else {
    stepWorld(
      world,
      dt,
      { keys, mouseX: aim.x, mouseY: aim.y, shooting },
      isHost ? latestPeerInput : null,
    );
    if (isHost && world.outcome === "playing") {
      snapAcc += dt;
      const period = 1 / CONFIG.net.snapshotHz;
      if (snapAcc >= period) {
        snapAcc = 0;
        net.sendState(worldToSnap(world));
      }
    }
  }

  const marking =
    keys.has("f") &&
    (world.outcome === "playing" || world.outcome === "countdown");
  renderWorld(
    ctx,
    world,
    cam,
    aim.x,
    aim.y,
    localTeam,
    mapEditing,
    showRoutes && world.arenaId === "generated"
      ? generatedRoutes(world.arenaSeed)
      : null,
  );
  syncMinimapSurface();
  renderMinimap(minimapCtx, world, cam, localTeam, marking ? miniCursor : null);

  timerEl.textContent = formatTime(world.matchLeft);
  renderBaseHp(world);
  renderRespawnHud(world);
  renderMiddleZone(world);
  const me =
    localTeam === "red"
      ? world.tanks.find((t) => t.id === world.remoteControlledId)
      : controlledTank(world);
  const modeLabel =
    world.gameMode === "ctf"
      ? "CTF"
      : world.gameMode === "heavy-light"
        ? "Heavy/Light"
        : world.gameMode === "mp-online"
        ? `MP Online (${localTeam})`
        : world.gameMode === "base-war"
          ? "Base War"
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
      ? `${modeLabel} · #${me.number} ${CONFIG.roles[me.role].label} · ${world.shareMode}`
      : "No tanks";
  } else {
    matchStateEl.textContent = world.outcome.toUpperCase();
  }

  flushLogs();

  requestAnimationFrame(frame);
}

syncMpPanel();
flushLogs();
showRoundGate();
requestAnimationFrame(frame);
