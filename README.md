# Fog of War — Tank Hunt

Playable 2D top-down fog-of-war tank hunt. Vite + TypeScript + HTML canvas (no game engine). Battle City–inspired pixel art; voice radio orders.

**Default mode: Team Deathmatch No Fog.** Also in the Mode menu: Team Deathmatch (fog), Capture the Code (CTF), and **Multiplayer · Offline** (local/bot TDM, no fog, all gunners).

## Run locally

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4847](http://127.0.0.1:4847).

```bash
npm run build
```

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
| Mode select | TDM No Fog (default) / TDM Fog / Capture the Code / Multiplayer · Offline |
| Share select | `clear` (no fog) / `report` / `auto` / `none` |
| Start | After each Restart/mode change: review LLM status, then Start the clock |

## Modes

- **Team Deathmatch No Fog (default)** — wipe the enemy company; full map and enemies visible (no fog).
- **Team Deathmatch** — same rules with fog share (`report` by default).
- **Capture the Code** — debug the enemy code-carrier wreck to win (old CTF rules).
- **Multiplayer · Offline** — local/bot TDM test: no fog, denser map, all standard gunners, win by wiping the enemy team. Teammates **hold until ordered** (voice/text/phrases); shoot while holding if a target is hittable; panic-escape when surrounded/under close attack. Eliminations blink twice then vanish (no wreck/debug / Capture-the-Code).

## Rules (short)

- 5-minute matches, no respawns.
- Most modes: 2 scouts (slower, long vision) + 4 gunners (faster, short vision); all shoot. Multiplayer · Offline: six gunners.
- No Fog (`clear`): whole map visible; fogged modes keep the southern ~20% home strip pre-revealed.
- Tunables in `src/config.ts` (see `CONFIG.mpOffline` for the offline mode).

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
