# AGENTS.md

Project context and the current build state live in `Handoff.md`. This file holds the standing rules.

## Gameplay configuration

- All gameplay numbers (tank stats, respawn times, zone radius, vision ranges, map size) live in ONE config file: `src/config/balance.ts`. Never hardcode them elsewhere.

## Architecture

- Simulation (`sim/`) must stay free of DOM, canvas and rendering code. Renderers only read sim state.

## Testing

- The seeded fixed-step replay harness must keep passing after every change. Run it before finishing.

## Scope

- Do only the task in the prompt. Do not start the next feature, refactor unrelated code, or "improve" things I didn't ask about.

## Finishing a task

- When finishing a task, report what changed, files touched, tests run and results, and anything brittle or unclear.
- When finishing a task, update `Handoff.md` with what was done, current state, and what is next.
