# Fog of War — Tank Hunt

Playable 2D top-down fog-of-war tank hunt. Vite + TypeScript + HTML canvas (no game engine). Battle City–inspired pixel art; voice radio orders.

**Default mode: Team Deathmatch No Fog.** Also in the Mode menu: Team Deathmatch (fog) and Capture the Code (CTF).

## Run locally

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4731](http://127.0.0.1:4731).

```bash
npm run build
```

## LLM API key (Radio → STT → LLM → bots)

Paste your key in:

**[`src/api-key.local.ts`](src/api-key.local.ts)**

```ts
export const LOCAL_API_KEY = "AIza..."; // Gemini — or sk-... for OpenAI
```

Gemini (`AIza…`) and OpenAI (`sk-…`) both work; provider is auto-detected.  
Or set `VITE_OPENAI_API_KEY` in `.env` / the side-panel field (same auto-detect).

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
| Mode select | Team Deathmatch No Fog (default) / Team Deathmatch / Capture the Code |
| Share select | `clear` (no fog) / `report` / `auto` / `none` |

## Modes

- **Team Deathmatch No Fog (default)** — wipe the enemy company; full map and enemies visible (no fog).
- **Team Deathmatch** — same rules with fog share (`report` by default).
- **Capture the Code** — debug the enemy code-carrier wreck to win (old CTF rules).

## Rules (short)

- 5-minute matches, no respawns.
- 2 scouts (slower, long vision) + 4 gunners (faster, short vision); all shoot.
- No Fog (`clear`): whole map visible; fogged modes keep the southern ~20% home strip pre-revealed.
- Tunables in `src/config.ts`.

## Roadmap / stretch

1. **Now:** Radio LIVE → STT → LLM (optional) → local bot AI goals.
2. **Next:** better goal-conditioned scripted / learned motor policies.
3. **Stretch / end goal:** end-to-end RL for speech → tactics (research-scale; not required for fun playtests).

## Playtest checklist

1. Stories after a match?
2. Ordering (voice/phrases) vs driving tanks yourself?
3. TDM feel vs switching to CTF?
4. Share mode preference?
5. Where did bots feel dumb or stuck?
