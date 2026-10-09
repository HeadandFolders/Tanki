# Fog of War — Tank Hunt

Playable 2D top-down fog-of-war tank hunt. Vite + TypeScript + HTML canvas (no game engine).

You command a six-tank company through dark terrain, hunting the enemy **code carrier**. Win by debugging their carrier’s wreck. Lose if they debug yours, or if your company is wiped. Time out is a draw.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (default [http://127.0.0.1:4731](http://127.0.0.1:4731)).

```bash
npm run build   # typecheck + production build
```

## Controls

| Input | Action |
| --- | --- |
| Arrow keys | Move controlled tank |
| Mouse | Aim |
| Click | Shoot (or switch if clicking a friendly, or mark a wreck) |
| Keys `1`–`6` | Switch to tank #N |
| Orders box + Enter | Natural-language team orders |
| Share select | `auto` / `report` / `none` vision sharing |
| API key field | Optional LLM order parser (offline keyword mock if empty) |

## Rules (short)

- **5-minute** matches, **no respawns**.
- Teams: 6 tanks each — **2 scouts** (slow, fragile, large vision, fast debug) + **4 shooters** (fast, sturdy, small vision, real damage).
- One random **code carrier** per team. You always see your own carrier icon; never the enemy’s.
- Shooters may only engage enemies visible to **any** teammate.
- Map starts with a **southern home strip (~20% height)** pre-revealed for your team; the rest is fog until scouted. Enemy spawns in a northern band (hidden until found). Share modes:
  - **auto** — all friendly vision live on the map
  - **report** (default) — only controlled tank lives; others dump discoveries after standing still ~3s (“report in”)
  - **none** — only controlled reveals; others chat-only
- Enemy contacts/wrecks leave **faded markers** (~10s).
- Click wrecks to **mark** them; order `debug` / stand near marked wrecks to inspect. Chat: `#2: wreck E is clean` / `#2: found the code on wreck E!`

Tunables (speeds, radii, timers, match length, etc.) live in `src/config.ts`.

## Playtest checklist (after ~10 minutes)

Answer these after a match or two:

1. **Stories** — Can you retell what happened (who died where, which wrecks you marked, how you found the code)?
2. **Command style** — Did you keep typing NL orders, or mostly switch tanks (1–6) and drive yourself?
3. **Wreck marks** — How often did you click-mark wrecks vs forgetting until chat reminded you?
4. **Share mode** — Which mode did you scout with first (`report` / `auto` / `none`), and did you switch mid-match?
5. **Scouts vs shooters** — Did scout vision feel worth protecting, or did you burn them as disposable eyes?
6. **Frustration** — Any moment the fog / shoot-permission / report-in rules felt unfair vs interesting?

## Architecture notes

- `interpretOrder(orderText, tanks, worldState)` in `src/orders.ts` — LLM JSON-only when an API key is set; keyword mock otherwise. Invoked **only on order send**, never per tick.
- Friendly AI goals: `moveTo`, `holdPosition`, `attackNearest`, `escort`, `retreat`, `reportIn`, `debug`.
- Enemy bots: attack visible player tanks; otherwise debug player wrecks.
