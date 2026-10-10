# Fog of War — Tank Hunt

A playable browser prototype of a top-down tank hunt. You drive one tank and give natural-language orders to five AI teammates who scout, fight, and debug wrecks while most of the map is still unknown. The question under test is whether commanding a company through fog of war is fun.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:4731`.

```bash
npm run build
npm run preview
```

`npm run build` is `tsc && vite build`. Preview serves on port `4732`.

The stack is Vite + TypeScript + HTML Canvas. Gameplay tunables live in `src/config.ts` (`CONFIG`).

Optional LLM: paste an OpenAI-compatible API key into **LLM API key (optional)**. Leave it empty to use the built-in keyword mock. You can also add `src/api-key.local.ts` (gitignored) exporting `LOCAL_API_KEY`. Voice uses the browser Web Speech API when a microphone is available; typed orders stay first-class when it is not.

## Controls

| Input | Action |
| --- | --- |
| Arrow keys | Move the controlled tank |
| Mouse | Aim (hull turns toward the cursor) |
| Space (hold) or left-click hold | Shoot (gunners only) |
| Click empty canvas | Start shooting until mouseup |
| Click a friendly tank | Take control of that tank |
| Click a wreck | Mark it for debug |
| Keys 1–6 | Switch to blue tank #N |
| Orders box + Enter / Send | Natural-language orders for the company |
| Radio | Toggle speech recognition; finals are sent as orders |
| Share | Switch `auto` / `report` / `none` during the match |
| Restart | New match, keeping the current share mode |

Arrow keys and Space are ignored while focus is in a text field or the share menu.

## Rules

The match lasts 5 minutes. Time running out with no confirmed code is a draw. Nobody respawns.

Blue (you, south) and red (AI, north) each field 6 tanks: 2 scouts and 4 gunners, roles shuffled. Exactly one tank on each team is the code carrier. You always see a star on your living carrier. The enemy carrier stays anonymous until a debug succeeds.

**Win** by debugging the red code-carrier wreck. **Lose** if red debugs your carrier wreck, or if every blue tank dies. Friendly fire is off.

Scouts are fast inspectors with a long view and no gun. Gunners are tougher, shoot, and debug slowly. Stats are in `CONFIG.roles`.

Fog starts with only the southern home strip mapped. Walls block line of sight.

| Share mode | Map | Contacts |
| --- | --- | --- |
| `auto` | Every living friendly reveals live | Live from the whole company |
| `report` (default) | Only your tank reveals live; others dump cells after standing still ~3s | Your view is live; teammates drop fading markers when they report in |
| `none` | Only your tank reveals | Map shows your contacts; teammates may call rare chat contacts |

Enemy and wreck markers fade after about 10 seconds and refresh if seen again.

## Orders

`interpretOrder` runs only when you press Send or when a voice transcript is final. It never runs per bot per tick.

Offline mock (no API key) maps phrases onto goals:

`moveTo`, `holdPosition`, `attackNearest`, `escort`, `retreat`, `reportIn`, `debug`, `idle`.

Targets: `all` / `everyone` / `team`, `#1`–`#6`, `scouts`, `gunners`, otherwise the tank you control. Landmarks include north, south, east, west, center, choke, north choke, bunker, eagle, base, home, and `wreck A`.

With an API key, one Chat Completions call covers the whole company (`gpt-4o-mini`, JSON, ~12s timeout). Invalid output falls back to the keyword mock and says so in chat. Latency is written to the event log.

## Playtest checklist

After about 10 minutes, jot answers to:

1. Could you retell what happened as a short story (who scouted, who died, where the code was)?
2. Did orders feel like command, or like fiddling with waypoints?
3. Were wreck marks and the debug loop readable without an explanation?
4. Which share mode did you actually want, and did switching it change how you played?
5. Were scouts worth the empty gun, or did you only want more shooters?
6. When it felt unfair, was the frustration interesting (fog, a missed report) or just confusing?

## Architecture

- `src/main.ts` — DOM, input, frame loop, voice and order wiring
- `src/game.ts` — match step, shooting, damage, wrecks, win / lose / draw
- `src/config.ts` — `CONFIG`, `ShareMode`, `Role`, `homeTerritoryBounds`
- `src/ai.ts` — friendly goals and the enemy brain (steering and wall slide, no navmesh)
- `src/orders.ts` — `interpretOrder` (keyword mock and optional LLM)
- `src/fog.ts` — fog grid, line of sight, share modes
- `src/voice.ts` — Web Speech API radio

Friendly goals: `moveTo`, `holdPosition`, `attackNearest`, `escort`, `retreat`, `reportIn`, `debug`, `idle`.
