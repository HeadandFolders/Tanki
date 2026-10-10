# Fog of War — Tank Hunt

Playable 2D top-down fog-of-war tank hunt. Vite + TypeScript + HTML canvas (no game engine). Battle City–inspired pixel art; voice radio orders.

**Default mode: Team Deathmatch No Fog.** Also in the Mode menu: Team Deathmatch (fog), Capture the Code (CTF), **Multiplayer · Offline** (local/bot), and **Multiplayer · Online** (two-device LAN).

## Branch (required for multiplayer)

`dev:mp` and Online Host/Join live on **`cursor/mp-offline-mode-1e16`** (PR #5), not `main`. If you see `Missing script: "dev:mp"`, check out that branch first:

```bash
git fetch origin
git checkout cursor/mp-offline-mode-1e16
npm install
npm run
# confirm "dev:mp" is listed, then:
npm run dev:mp
```

## Run locally

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4847](http://127.0.0.1:4847).

For **two-device multiplayer** (Vite + WebSocket relay) — must be on `cursor/mp-offline-mode-1e16`:

```bash
npm run dev:mp
```

- Vite UI: [http://127.0.0.1:4847](http://127.0.0.1:4847) (LAN `0.0.0.0:4847`)
- Relay: `ws://0.0.0.0:4855` (health: [http://127.0.0.1:4855/health](http://127.0.0.1:4855/health))

```bash
npm run build
```

### Connect two devices (LAN)

1. **Host laptop:** `npm run dev:mp`. Open the game, select **Multiplayer · Online**, set a room code (default `TANK`), click **Host match**. The panel shows LAN URLs like `http://192.168.x.x:4847`.
2. **Guest device:** open that host URL in a browser (same Wi‑Fi). Select **Multiplayer · Online**, same room code, click **Join match**.
3. **Host:** when status says guest connected, click **Start when guest joins**.
4. Host plays **blue** (south); guest plays **red** (north). Same Offline rules: no fog, all gunners, blink deaths, denser map, wipe to win.

Optional: set Relay to `ws://<host-lan-ip>:4855` if the guest page is not loaded from the host.

## LLM API key (Radio → STT → LLM → bots)

Paste your key in:

**[`src/api-key.local.ts`](src/api-key.local.ts)**

```ts
export const LOCAL_API_KEY = "AIza..."; // Gemini — or sk-... for OpenAI
```

Gemini (`AIza…`), OpenAI (`sk-…`), and Anthropic (`sk-ant-…`) work; provider is auto-detected from the key prefix.  
Or set `VITE_OPENAI_API_KEY` in `.env` / the side-panel field (same auto-detect).

Browser calls go through Vite `/llm/*` proxies (see `vite.config.ts`) so they are not blocked by CORS.

Pipeline: **Radio LIVE → browser STT → `interpretOrder` (LLM if key set, else keyword mock) → bot goals**. LLM runs **only on each order**, never every tick.

## Controls

| Input | Action |
| --- | --- |
| Arrow keys | Move |
| Mouse | Aim |
| Space / Click | Shoot |
| `1`–`6` / click friendly | Switch tank |
| Radio LIVE | Voice orders (Chrome/Edge + mic) |
| Phrase buttons / text box | Same order path without mic |
| Mode select | TDM No Fog / TDM Fog / CTF / Multiplayer · Offline / Multiplayer · Online |
| Share select | `clear` (no fog) / `report` / `auto` / `none` |
| Start | After each Restart/mode change: review LLM status, then Start the clock |

## Modes

- **Team Deathmatch No Fog (default)** — wipe the enemy company; full map and enemies visible (no fog).
- **Team Deathmatch** — same rules with fog share (`report` by default).
- **Capture the Code** — debug the enemy code-carrier wreck to win (old CTF rules).
- **Multiplayer · Offline** — local/bot TDM test: no fog, denser map, all standard gunners, win by wiping the enemy team. Teammates **hold until ordered** (voice/text/phrases); shoot while holding if a target is hittable; panic-escape when surrounded/under close attack. Eliminations blink twice then vanish (no wreck/debug / Capture-the-Code).
- **Multiplayer · Online** — two-device LAN via WebSocket relay (`npm run dev:mp`). Host=blue, Join=red; host-authoritative snapshots. Same combat rules as Offline. Use **Play bots offline instead** for a local bot match without a peer.

## Rules (short)

- 5-minute matches, no respawns.
- Most modes: 2 scouts (slower, long vision) + 4 gunners (faster, short vision); all shoot. Multiplayer modes: six gunners.
- No Fog (`clear`): whole map visible; fogged modes keep the southern ~20% home strip pre-revealed.
- Tunables in `src/config.ts` (`CONFIG.mpOffline`, `CONFIG.net`).

## Committed roadmap

Ship **strong cooperative TDM under fog** with **speech → controls** (hierarchical: STT → LLM planner → goal-conditioned executor). See project docs for the full phase plan.

**This PR slice (P0/P1):** frozen goal schema + order eval suite; team belief from share modes; order priority; fog-aware scout/gunner defaults; red difficulty tiers (`CONFIG.ai.redDifficultyDefault`).

```bash
npm run eval:orders   # goal schema + offline order gold cases
```

## Playtest checklist

1. Stories after a match?
2. Ordering (voice/phrases) vs driving tanks yourself?
3. TDM feel vs switching to CTF?
4. Share mode preference?
5. Where did bots feel dumb or stuck?
