# Fog of War — Tank Hunt

Playable 2D top-down fog-of-war tank hunt. Vite + TypeScript + HTML canvas (no game engine). Battle City–inspired pixel art; voice radio orders.

**Default mode: Team Deathmatch.** Optional: Capture the Code (CTF).

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
export const LOCAL_API_KEY = "sk-...";
```

Or set `VITE_OPENAI_API_KEY` in a root `.env` (see `.env.example`), or type it in the side-panel field.

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
| Mode select | Team Deathmatch (default) / Capture the Code |
| Share select | `auto` / `report` / `none` |

## Modes

- **Team Deathmatch (default)** — wipe the enemy company. Timeout = draw.
- **Capture the Code** — debug the enemy code-carrier wreck to win (old CTF rules).

## Rules (short)

- 5-minute matches, no respawns.
- 2 scouts (slower, long vision) + 4 gunners (faster, short vision); all shoot.
- Southern ~20% home strip starts revealed; fog elsewhere.
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
