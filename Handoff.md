# Tanki handoff

Written 2026-11-10 for the next agent. **Updated 2026-11-12 after the large map became the default (see "Large map is the default (2026-11-12)").** This file is the brief. The code is the source of truth if they disagree.

**Stop boundary: the generated 144×90 map is now the default wherever a map is not chosen (`CONFIG.arenaDefault`, one config key), dense 80×50 stays selectable by name in the Arena pick, `--map`/`--arena` and every per-arena test, and the batch runner prints and filenames its map. Both Base War bases are declared for large and point-symmetric; no bot behavior, doctrine or balance number changed.** Verification: `eval:replay` 44/44, `eval:orders` 41/41, `eval:radio` 29/29, `eval-commands` 20/20, `eval:stuck` 18/18, `eval-commander --quick` 17/0, `eval-motion`, `eval-wall-clearance`, `tsc` clean. `eval-basewar --quick` is red at its "passive defence on both MP arenas" guard (dense/23 defence lost 5 against ≤2) — reproduced identically with the default forced back to dense, so it predates this change.

Earlier boundary, still true except where the paragraph above supersedes it: five tank types plus a sixth repeat slot are fielded under MP rules, with directional armour, engineer repairs, a nuke round, type-aware bot behavior, type names in the radio and HUD, and a per-type table in the batch runner. Two balance signals are recorded and left alone: the nuke carrier and the Heavy dominate the kill ledger, and Base War now tilts blue 27/40 in `eval-basewar`'s side-balance guard (18/22 before). See "Tank types (2026-11-12)" below for the numbers and what is brittle.

Earlier boundary, still true: measurement tooling is added (headless batch runner, per-match metrics JSON, `rusher` and `turtle` scripted commander profiles, over-length draw cap); no balance claim is made from those runs. See "Batch measurement tooling (2026-11-12)".

Earlier boundary, still true: Slice B and Slice C are implemented and green headless; human playtest of Slice B is still the open item.

The person building this is playtesting command-following, not asking for a new game. Do not start a 3D port, a rewrite, or a training loop. Finish the prototype until spoken orders are obeyed in a way a human will call fun.

## Vision

The shipping game is a 2.5D / 3D PC online multiplayer tank game. Players command a small company by voice. Teammates are bots that take those orders the way a human squad would: they understand the intent, pick a sensible route, shoot while moving, and say when the order is done, impossible, or needs a new call.

What exists in this folder is not that game. It is a 2D top-down browser prototype (Vite, TypeScript, HTML canvas, no engine). It exists to answer two questions before anyone spends time on a 3D client:

- **Fun.** Is it more fun to give radio orders than to drive every tank yourself?
- **Feasibility.** Can bots follow natural commands well enough that a match is playable, not a tech demo of a parser?

If both answers stay yes, the thing that ports is the order contract (utterance → goal → route → motor), not the canvas renderer. A 3D client should consume the same goals. It should not relearn "what did the player just say."

Working title in the repo: Fog of War — Tank Hunt. Package name `fog-of-war-tank-hunt`. GitHub remote used in earlier sessions: `HeadandFolders/Tanki`. Multiplayer scripts were developed on branch `cursor/mp-offline-mode-1e16`. Confirm the checked-out branch before assuming main has `dev:mp`.

## Where we are

The prototype is playable. A match can be started, a human can drive one tank, and the other tanks can be given text or voice orders. Two PCs can play a host-authoritative LAN match. Slice B adds explicit order lifecycle, resumable retreats, visible reason captions and intake dedupe. Route quality and whether the resulting radio feels good still need human playtesting; passing scripted checks is not a human fun/obedience score.

Shipped and in the tree:

- **Modes.** Team Deathmatch with fog, TDM with no fog (menu default), Capture the Code, Heavy/Light (3 heavy + 3 gunner, no scouts), Multiplayer · Offline, Multiplayer · Online, and Base War against a seeded scripted commander. MP Offline also has a configurable scripted opponent; Off leaves spawn holds.
- **MP rules (`isMpRules`: offline, online, Base War).** No fog, the five-type company loadout (`LOADOUTS.company`: Scout, Heavy, Artillery, Engineer, Nuke carrier, Scout), the large generated maze by default (`CONFIG.arenaDefault`; dense 80×50 still selectable), teammates hold until ordered. They shoot a clear line while holding or driving, with explicit HP/panic interrupts. Eliminations blink twice and vanish (no wreck, no Capture-the-Code), and now come back: `RESPAWN.delaySec` (25s) later the same hull — same type, same number — returns whole at its own spawn under `RESPAWN.protectionSec` (2s) of hull-damage immunity, its clock scaled by `getRespawnRate(team)`, which is 1.0 for both sides until the middle zone exists. TDM / CTF / Heavy-Light keep the one-life wreck rules. Base War additionally has destructible team bases and `attackBase`; only a destroyed base wins — wiping out the enemy hulls stops them shooting back but does not end the match (see "Base War: the base is the win, and it leans on a wall"). Each base sits flush against a map border, off the corner, so it has one walled side and three open faces, and its tile is map data. Host is blue (south). Guest is red (north) and the view is rotated so each human's home is at the bottom.
- **Radio.** Browser speech recognition (Chrome/Edge) → text, or the text box, or phrase buttons. Same pipeline.
- **Command pipeline (`src/command-pipeline.ts`).** Partial intent gets immediate standby; side chatter stays silent. Phrase reader first. Optional local Cactus Needle sidecar only if enabled (default off), then the cloud LLM when configured. The live wrapper rejects unsettled keyword guesses and failed parses instead of inventing attacks; failure says again and clears dedupe. The LLM runs once per admitted sentence, never per frame.
- **Goals / stack.** `src/goals.ts`: moveTo, holdPosition, attackNearest, attackBase, escort, retreat, reportIn, debug, patrol, spreadOut, scout, idle. `src/interrupt-stack.ts` owns base orders, one active interrupt, lifecycle events and captions. The base keeps player provenance and command id while the effective goal temporarily becomes system retreat. `noRetreat` is an explicit Goal/OrderResult ROE flag, not an automatic movement exemption or a new voice phrase. Unsupported MP goals receive a negative acknowledgement and expire into hold.
- **Routes.** A\* on a 36px lattice in `src/ai.ts` (`planRoute`). Cost is travel times a danger field: line of sight, gun threat falling as 1/d², a toll for open ground. Body is inflated by tank radius + 2px. Diagonal corner-cuts through two blocked cells are banned. A route is reused for about `routeCommitSec` (0.4s) unless the order changes, the next step is blocked, or an enemy moves onto the remaining path.
- **Driving.** `src/motion.ts` `driveOrder` follows that polyline the same frame the goal is set. The hull faces the path. A shot aims without yawing the hull off the path. Arrival of moveTo becomes holdPosition at the point.
- **Formations.** `src/battle-plan.ts` turns "take the left, I'll take the right" into one lane split. The speaker's lane is reserved and given to nobody. `src/formation.ts` places surround / flank / line slots.
- **Map mark.** Hold F and click. "3 move to the mark" is an exact moveTo.
- **Online.** `npm run dev:mp` runs Vite on 0.0.0.0:4847 and a WebSocket relay on 4855 (`scripts/mp-server.ts`). Host simulates. Guest sends input, orders, and marks. Snapshots at 18 Hz. Same Wi-Fi or Tailscale. A cloud-VM address is not a LAN address. Mic on a remote device needs a secure context; plain `http://100.x` leaves the mic control disabled in Edge.
- **Scoring / radio.** A thin Team radio strip is visible outside Dev. Sidebar Janna explicitly scores the parse only: blank → incorrect → correct. Lifecycle reason codes appear next to the mark; tooltips contain the captions. Later events update the same row and preserve its human score. Stored in localStorage key `tanki-command-postmortem-v1` (cap 1000) and shown at `/postmortem.html`. The dev server appends command revisions, including lifecycle updates, to `logs/command-postmortem.log`; interpret repeated ids as revisions, not extra utterances. A checkbox click itself updates localStorage only. No Slice C counters were added.
- **Map export.** `map.json` is a one-shot occupancy dump of the reference arena (80×50 tiles, 16px, 0 = floor, 1 = wall). Runtime does not load it. MP and Base War use `CONFIG.arenaDefault` (`buildArena("large")` unless a map is picked); TDM / CTF / Heavy-Light use `buildArena("reference")`. `ensureTwoRoutes` tries to keep every stance reachable two ways. A saved wall edit lives in localStorage `tanki-wall-layout-v1`, keyed per arena.

## How one order runs

Example: the player says "4 attack 2".

1. Speech or the text box produces a string. Spoken number words are normalized (four → 4). The radio gate suppresses same-team/text/addressee repeats for 1500ms and remembers recognizer segment ids. Admitted partial intent gets synchronous standby before awaiting either parser; chatter is silent.
2. The phrase reader splits on the verb. Numbers before attack are friendlies. The number after is the enemy, even without the word "enemy". Other tanks are not retasked.
3. `assignOrder` replaces only the addressed base orders, retaining valid interrupts. Blue tank 4 receives player `attackNearest` with red 2's id and command provenance. The shared acknowledgement is honest about any retreat. No model is required for this sentence.
4. Every frame, both friendly brains advance the same level-triggered stack. Healthy attack holds station and fires inside range or drives toward its one locked prey. Fog routes use LOS or stored team contacts, not hidden live coordinates. Low HP/panic temporarily activates retreat with push/pop captions; resume revalidates the prey.
5. Prey death ends the attack into hold with `prey_dead_hold`; lost belief expires it with `prey_lost` and a last-seen direction from the saved contact. A multi-target order also pins its initial prey; no silent switch to another survivor. Base destruction completes `attackBase`. Death or match end closes outstanding orders.
6. Walls and exposure remain the pathfinder's job. The language model never emits a path. All goal writes, including initializers, replay and network restore, go through the stack helper; readonly goal types and `scripts/check-goal-writes.ts` enforce the boundary.

"Everyone cover me", "2 move south and shoot at will", and "3 take the right and I'll take the left" now have deterministic-reader coverage; do not describe all of them as model-only. Unsettled sentences can still wait on the LLM (timeout 12s) or Needle. Standby covers the wait, not parser quality. Needle remains optional and off by default.

A cloud-backed session requires a successful pre-match probe. Play offline deliberately uses the phrase reader and rejects unresolved guesses with "say again". During this verification the configured probe returned HTTP 401; no real model success is claimed. Do not read, print or commit local credentials just to diagnose that status.

## Problems already seen in play

These are from human playtests, newest serious batch on 2026-11-03. Some have code changes after the report. Treat them as open until a new playtest marks them green in Janna eval. Headless scripts passing is not that.

| What the player saw | What it actually was |
| --- | --- |
| "5 attack 6" did nothing | The sentence never became a goal. Parser / address bug, not pathfinding. |
| Three bots ordered to attack froze halfway, short of gun range, often with a wall between them and the target | The old follower stopped on the last lattice point. MP attack now drives the polyline with `driveOrder` toward the prey (`src/ai.ts`, player attackNearest branch). Re-test. |
| Bots took a long dangerous route when a shorter covered one existed, including "4 move stealthily to the mark" | Hazard used to be "near an enemy dot," not "this cell is in a gun's line of sight." The danger field was rewritten. User still called routes the worst path after a later parser pass. Re-test on the dense MP map, not only `eval-routes`. |
| "Everyone cover me" took more than 3 seconds | "Everyone" missed the phrase reader and waited on the LLM. |
| Radio flipped off mid-match | Chrome/Edge end the recognition session between phrases. `src/voice.ts` restarts on `onend`, and treats aborted / no-speech as still listening. The player still saw it drop. Fragile, not solved. |
| Ordered tanks vibrated in an open field, or crept, or re-aimed at a nearby enemy and left the path | Two-point routes aimed back at the start. Enemy aim overwrote travel heading. `driveOrder` and "do not yaw off the path while driving" exist for MP move/hold. Spread, escort, and retreat still use `steerTo`. |
| Hulls clipped or shivered on corridor walls | Grid cells were "free" if the center missed the wall, ignoring the 11px body. Inflation and the diagonal ban are in `planRoute`. The follower can still chord a corner (`routeLookahead` 52). `fitBodyStep` / `pullToClear` try to keep the body off the wall. Re-test in Multiplayer · Offline, which is the dense maze. |
| Unordered MP bots drove off on their own | Default goals used to be "push the front." MP now forces non-player patrol/scout/idle/attack into hold at the current spot. |
| "2 and 3 attack 5" retasked a bot that was not named, or treated the enemy number as a friendly | Fixed in the phrase reader by splitting on the verb, plus `lockNamedAttack` for pure attack sentences only. Compound sentences must still reach the LLM. |
| Cover-me escorts stood behind the barrel and did not shoot | Escort slot is now an arc in front of the VIP, toward threats. They shoot via `shotTarget` while moving. Slots are not reserved tiles, so several escorts still stack. |
| Guest on another network could not join; mic control was grey | Relay is LAN/Tailscale, not matchmaking. HTTP is not a secure context, so `getUserMedia` stays blocked. Do not "fix" this by serving only the page over HTTPS unless the relay speaks wss too. |

Janna's checkbox now means only "did the parse match what I meant?" Reason codes and captions for what the hull did next sit beside it and in the Team radio strip; rules-of-engagement compliance is asserted by `npm run eval:replay` and `npm run eval:radio`, not by eye. That split is implemented, but it has not been played by a human yet, so do not report a fun or obedience score from these scripts alone. A green parse can still sit on a hull that routed badly or froze; the freeze case is Slice C's `stuck` detector, still unimplemented.

## Decisions already made

Language and motion stay separate. An utterance becomes a Goal. A hand-written brain plus A\* carries the goal out. There is no reinforcement learning in this repo and there never was. Nothing was trained and removed. (A throwaway PettingZoo / MAPPO sandbox was sketched outside this repo while weighing the RL route. It was shelved, and none of it is in the tree. Do not resurrect it.)

RL was skipped because the experiment is "does the order feel obeyed and can a human say why it failed," not "discover superhuman micro." A policy that kites well and ignores "5 attack 6" fails the experiment. A bad route is a grid cost you can draw. A bad policy is a training run. The browser build has no GPU sim farm.

What that choice gives up, on purpose: learned peeking, adaptive kiting against a human, and coordination that emerges instead of being placed in slots. If bots later need to feel like good players, train a motor controller under an already-set Goal (steer, fire, peek, given the goal and local cover). Do not train utterance → joystick. Speech errors, parse errors, and driving errors would become one number, and Janna eval could not tell which failed.

A later review pushed back on a too-clean version of this design. The pushback was largely right. Accept it:

- Slice B names legal deviations in both friendly brains: `panic_melee`, `hp_retreat`, `los_shot_on_path`, `prey_dead_hold`, `prey_lost`, `escort_slot_blocked`. HP retreat applies to ordered movement as well as attacks unless `noRetreat` is explicit. Nearby clear shots do not silently convert a player move into an attack.
- Slice B closes the lifecycle hole: attacks pin a prey and hold/bark on death or belief loss. Move/spread/explicit-retreat/report/debug completions speak, as do unsupported orders and lost escorts. Interrupted attacks retain their base provenance and revalidate before resuming. A wall alone does not imply loss in the no-fog modes; fog contact TTL governs belief loss.
- `routeCommitSec` (0.4s) means "do not re-run A\* every frame." The hull still moves every tick along the polyline, and replans if the next step is blocked, the order changes, or an enemy moves onto the remaining path. What is missing is a fast layer that can leave the polyline for a moment to dodge a shell or a teammate, then snap back. That layer is steering. The cost of RL here is training and eval, not inference speed. Do not repeat "a neural net is too slow to run." *(Updated: build the dodge as a plain rule first, not a network. See Latest decisions.)*
- A danger scalar is not a firing position. "Which cell sees tank 6 and the fewest other guns, and stays in cover until the last tiles" is a search over the occupancy and line-of-sight we already have. Build that query and draw it before anyone imitates peeks.
- `mpOfflineFriendlyBrain` and `friendlyBrain` are already long chains of `if (goal)`. A behavior tree or utility AI only helps after lifecycle states exist (pursue, engage, lost, done, aborted). *(Updated: for v1, implement the semantics on the current brains with a shared `interruptStack` helper. Express the same statuses as behavior-tree nodes only when a second goal type, such as escort plus peek, forces composition.)*
- Stop-and-shoot in the fight band makes a bot a turret against a human. Fine for bot-vs-bot readability. For humans, add hold-time jitter and a strafe that stays on the named target. That is still not a reason to replace the goal layer.
- Five bots and one corner: escort fans an arc, but cells are not reserved, and the slot is the VIP's current position, not where the player is about to be. If `fitBodyStep` is ~0 for several frames, the ally blocking the corridor should become a temporary wall and the route should replan.
- Pronouns ("hold there", "him", "or back to position") and speech-recognition junk are a dialog state problem (last addressee, last place, last enemy) plus a clarify/cancel path. A policy under a parser that guesses will learn the guesses.

`routeCommitSec` in `src/config.ts` is 0.4. Older notes say 0.5. Trust the file.

## Latest decisions (second design review, 2026-11-10)

These supersede the "What to do next" order that was in the earlier version of this file. The principle: **make deviation audible, resumable, and machine-checkable.** Nothing here puts a learned policy under the radio.

### The milestone: "Radio teammate v1"

One session of MP Offline / TDM No Fog. v1 shows an **obedient, honest radio teammate**. It does not show "human instincts"; peek-and-shoot is deferred, so do not present it as that bar.

In scope:

1. Fixed-step replay harness with seeded RNG (even if only 3 scenarios).
2. Goal stack with the conflict rules and hysteresis below.
3. Captioned radio: standby within 300ms, company ack, high-priority barks only, "say again", stuck bark. **No TTS.**
4. Idempotent repeated orders.
5. Janna checkbox = parse only; rules of engagement checked in replay.
6. Cheap metrics on the command record.

Out of scope for v1: learned dodge, the tactical firing-port query, imitation learning, a behavior-tree rewrite of the whole brain, spoken barks, reserved escort slots / predicted escort point, and perception-delay polish beyond "no 0ms projectile dodge." **Do not add dodge in this milestone unless the perception delay ships with it.** A naked dodge rule is a fairness regression.

### Order stack and conflict rules

`Goal` is no longer one slot. `src/interrupt-stack.ts` gives each hull an `InterruptStack`: a base order plus at most one interrupt, both on the same channel as "copy". The TDM low-HP retreat that used to do `tank.goal = { kind: "retreat", source: "system" }` now pushes `{kind, reason, until}` and leaves the player order's provenance intact — the base keeps `source: "player"` and `issuer`, and `tank.goal` is a read-only view of the effective goal written only by the helper (`scripts/check-goal-writes.ts` enforces the single write path inside `npm run eval:replay`). Every order ends in exactly one of: success, interrupted, expired, replaced, each logged as an `OrderEvent` with its reason code.

| Case | Rule | Status |
| --- | --- | --- |
| New player order during a retreat | Replace the base order; keep the interrupt if still valid (HP still low). | Implemented |
| Two interrupts at once | Priority: panic_melee > low_HP > dodge. Dodge is momentary, never a stacked goal. Only one non-dodge interrupt at a time. | Implemented, except `stuck` |
| Resume after an interrupt | Re-validate. Prey dead or out of belief → expire and bark. Otherwise resume. | Implemented |
| Flapping | Hysteresis. Retreat enters at ≤32% HP and exits at ≥45% (or after clear for `panicCommitSec`). No re-push inside the commit window. Panic already had `panicClearRadius` / `panicCommitSec`; retreat got the same treatment. | Implemented |
| Prey dies | Hold and say so. Never silently retarget the nearest enemy. | Implemented |
| Prey lost behind a wall | Bark "lost 6, last seen …", then hold. Do not keep driving at a stale position forever. | Implemented |
| Stuck (`fitBodyStep` ≈ 0 for ~0.4–0.6s) | Reason code `stuck`, bark, force a replan with nearby allies as soft blockers. A freeze must never be a silent `moveX = 0`. | Implemented |

Reason codes now named and logged next to the command record (`OrderReason` in `src/interrupt-stack.ts`): `panic_melee`, `hp_retreat`, `los_shot_on_path`, `prey_dead_hold` (the old `prey_dead_retarget` — retargeting was removed, so the code became the hold it describes), `prey_lost`, `escort_slot_blocked`, `stuck`, plus lifecycle codes `order_received`, `order_replaced`, `order_complete`, `order_unsupported` and end-of-life codes `escort_lost`, `tank_destroyed`, `match_ended`.

### Radio and barks

Barks are the player-facing rules of engagement: reason codes are for us, barks are what the human hears. Slice B shipped this — an order is no longer one ack followed by silence, and the low-HP retreat speaks.

- Every push and pop of the stack fires the same channel as "copy" (`emit()` in `src/interrupt-stack.ts`). Examples as they appear: `#5 copy, attacking 6`; `#5 falling back, low HP`; `#5 target down, holding`; `#5 lost 6, last seen north; holding`.
- **Captioned radio, not spoken.** Text only — no earcon and no TTS was added. Radio is continuous speech recognition, so bot speech into an open mic would generate junk; if TTS ever lands it must mute recognition for the bark's duration. Barks land in two places: the thin "Team radio" strip in the sidebar (`index.html` `.radio-strip`, `#chat`, ~5.5em max height, `aria-live="polite"`) and `#radio-overlay` over the bottom of the map (last three captions, ~8s, `pointer-events:none`, `aria-hidden` because the sidebar log is the accessible copy). The overlay exists because below 900px CSS width the layout stacks and the sidebar is off-screen while you play — without it, barks had nowhere visible to land exactly where the player is looking.
- **No flooding.** One company line when the parse is shared — `Company: 3 copy, attacking 6` (game.ts coalesces accepts into one `Company:` chat entry). Per-hull audible barks are limited to high priority: HP/panic interrupts, target loss, deviations, and order endings (`tank_destroyed`, `match_ended`, `escort_lost`); completions only speak for `source: "player"` bases, so commander-authored traffic stays quiet. `stuck` will join this list in Slice C. Routine copies rate-limit to one per tank per 2s (`stack.lastCopyAt`) and `assignOrder` stays silent when the shared parse already spoke.
- **Standby.** `Company: standby` is captioned synchronously from the intake path — `beginUtterance()` fires before the parser awaits, so it lands well inside 300ms even when Needle or the LLM takes seconds (`src/radio.ts`, `src/main.ts`).
- **Idempotent repeats.** The same normalized utterance to the same addressees within 1500ms does not push a second time, and recognizer segment ids are deduped alongside the text; both windows are per world and per team and are cleared by a failure or an order expiry.
- **Say again.** A failed or junk parse captions `Company: say again` and clears the dedupe so the retry lands; `orderAcknowledgement` answers "negative, low HP" / "negative, close threat" / "negative, order unsupported in this mode" instead of a false copy. No silent best-effort attack on the commander.
- **Barks read belief, not god-view.** In clear/MP, line of sight through an open corridor is fair knowledge. Through fog, "last seen north" comes from `teamBelief` / last contact, never live enemy coordinates — enforced by assigning orders on the commander/proxy `view` and by the fog-gated `routeFoes` danger field; `eval-replay` and `eval-radio` assert it.

### Replay harness and rules-of-engagement checks

Shipped in Slice A and extended across Slice B:

- The live loop still uses variable `dt = min(0.05, frameDelta)` from `requestAnimationFrame`. `src/replay.ts` steps 1/30 or 1/60 for tests.
- `src/random.ts` records the world/reaction RNG state in snapshots; the commander keeps separate cadence, decision, perception and acknowledgement streams.
- Snapshots carry the full `InterruptStack` per hull (`snapshot.stacks` is authoritative), goals, cooldowns, HP, projectiles, wrecks, wall signature and RNG state.
- `scripts/eval-replay.ts` runs 41 fixed-step checks: goldens at both rates, hysteresis, prey loss, MP/TDM live execution, panic priority, explicit `noRetreat`, fog-safe captions, JSON checkpoint/fork determinism and forbidden `Math.random`/network guards.
- Janna's checkbox is only "did the parse match what I meant?"

### Perception fairness and dodge

- Enemy tanks today are `liveVisibleEnemies` = alive + `canSeeTank` (wall line of sight). In TDM No Fog / MP, share is `clear`, with no reaction delay.
- Projectiles are **not in the AI at all** today. `updateProjectiles` is physics only. A 0ms dodge on `world.projectiles` would be aimbot-adjacent next to a 200–250ms human.
- Fog modes still give gunners team-belief contacts the player may not see (`report` feeds all blues into belief).
- When dodge ships it needs: line of sight to the round (or its tracer), a rolled delay of about 180–280ms, then the steer. The same delay applies to "enemy appeared."
- Dodge starts as a **rule**, not an MLP: if a perceived projectile will hit this hull and the cell perpendicular to velocity is free and not a friendly, step there; otherwise stay on the committed path. Randomize left/right, skip about 15% of the time, skip if holding (unless panic), and reject the step if the danger field there is worse than the current cell. Learn something only if this fails on cluttered corners.
- Headless dodge tests: round on collision course with a wall-free side → survived; blocked side → no warp through brick.

### Metrics, scoring, and other settled points

- Slice C metrics collected on `CommandRecord`: `t_ack_ms` (intake → first acknowledgement caption, wall-clock ms; null when the 2s rate limit stayed silent), `repeat_count` (repeats of the same normalized utterance+addressees swallowed by the 1500ms dedupe gate), `interrupts` (goal interrupts attached to that command), `died_stuck` (1 when an addressee was destroyed with its stuck flag on). Persisted to localStorage `tanki-command-postmortem-v1` and shown as a compact suffix on each Janna panel row plus the Shift+dump JSON table.
- Walls are not destructible in play, so the tactical query may cache line of sight until a map-editor commit or a mode restart. If destructible brick is ever added, invalidate on wall-set change, not per shot. Do not design for a mechanic that does not exist.
- Imitation learning stays last, and only with the Goal that was active recorded alongside each demonstration. The player's own hull has no Goal, so demos need labeling. A small self-play set is the same unseen-case brittleness that made RL the wrong first tool.
- Language: the semantics (stack, priorities, resume, hysteresis, barks) are the product. The behavior tree is how you keep them from rotting. Do not block "audible, resumable, checkable" on a full AI rewrite.

### Proposed, not yet agreed

Items 1–6, 7, 8 and 10 were accepted and implemented in Slices B and C. Item 9 remains proposed.

1. **Hot mic.** Implemented in `src/radio.ts`: partial command intent gets intake; side chatter stays silent.
2. **Honest "copy."** Implemented. Retreat gives "negative, low HP" / "negative, close threat"; MP unsupported orders get a negative acknowledgement rather than a false copy. `noRetreat` is an explicit ROE flag carried on Goal and OrderResult. It is intentionally not exposed as a voice phrase in Slice B, and it is not automatically attached to movement.
3. **Level-triggered interrupts.** Implemented for HP, panic and stuck. Only one non-dodge interrupt is active, with panic taking priority over HP.
4. **Dedupe details.** Implemented on normalized utterance + addressees for 1500ms and on recognizer segment ids, scoped per world and team; failure clears both.
5. **Completions always speak.** Implemented. Shared company copies coalesce into one line and rate-limit per hull to about 2s; replacements, deviations, completions, deaths and unsupported orders always caption.
6. **Replay determinism.** Implemented in the fixed-step harness; goldens assert events and invariants rather than exact trajectories.
7. **Metric definitions.** Implemented in Slice C: `t_ack_ms`, `repeat_count`, `interrupts`, `died_stuck` collected on `CommandRecord` and persisted to the postmortem log.
8. **Acceptance test for v1.** Implemented by `scripts/eval-radio.ts`: 20 scripted utterances, zero silent deviations, zero uncommanded retargets.
9. **Second Janna checkbox.** Not implemented; still proposed.
10. **Single write path.** Implemented by readonly Tank goal typing plus `scripts/check-goal-writes.ts`, which runs inside `npm run eval:replay`.

## What to do next

Do these in order. Stop when a playtest in Multiplayer · Offline shows the current item is actually better. Do not skip to a 3D engine because the list feels architectural.

1. **Playtest Slice B before accepting it.** Headless checks are green, but no human has scored this build. Dense MP map, at minimum: "5 attack 6"; "2 and 3 attack 5 and 6"; "4 move stealthily to the mark" with an enemy watching the short gap; three bots attacking one enemy; "everyone cover me"; a move past an enemy in shoot range. Now also check the new lifecycle aloud: get a hull to low HP mid-attack and confirm "falling back, low HP" then resume or an honest expiry; kill the named prey and confirm "target down, holding" with no switch to another enemy; repeat one sentence inside 1.5s and confirm one order; say junk and confirm "say again". Janna now scores only the parse — judge obedience from the radio. Read the captions over the bottom of the map (`#radio-overlay`), and with a narrow window (under ~900px CSS, where the panel stacks below the map) confirm the page actually scrolls to Team radio and that nothing is stretched. If a bot freezes, log the goal, route points and whether `drive.arrived` flipped early; **a freeze is exactly what Slice C's stuck detector will name, so record it rather than fixing it here.**
2. **Slice A: replay foundation.** Done (fixed-step runner, snapshot schema, seeded RNG, goldens at 30 and 60 Hz).
3. **Slice B: stack, barks, idempotency on the live game.** Done, pending the human playtest above.
4. **Slice C: stuck detector and metrics on command records.** Done. The stuck detector is wired into the live brains (`src/ai.ts` `noteStuck`), the four metrics are collected on `CommandRecord`, and `eval-stuck` has 18 passing motor-level checks.
5. **Make "everyone" and cover hit the phrase reader** so that sentence does not wait on a 3–12s model call. Keep the LLM for sentences the reader cannot settle. Add dialog state for "there / him / back" only after the numbered commands are reliable. If a sentence is ambiguous, ask or hold. Do not guess an attack. (The standby ack in slice B covers the waiting problem in the meantime.)
6. **Fast reactive layer on the committed path, with perception delay.** Dodge as the perpendicular-cell rule, plus ally separation and not ramming the player. Not a second planner. Only ship together with the reaction delay.
7. **Reserved slots and a predicted escort point.** One cell per bot. Escort target is the player plus a short lead (player + velocity × ~0.4s), in front of them, toward the threat. If a bot is wedged, replan with the blocker as a wall.
8. **Tactical position query, drawn on the map,** before any peek behavior: a cell that sees the named target, sees as few other enemies as possible, and whose approach stays in cover. Search, using the same rays as the danger field.
9. **Behavior tree over Goal + rules of engagement,** only when escort plus peek force composition. Then, last, imitation of the human's own peeking and kiting with the goal already set. Record the goal id with the demonstration.

Leave the 3D / 2.5D PC client, matchmaking, accounts, and persistence until (1) through (4) are green in play. The online prototype is a feasibility relay (one room, host simulates, guest displays). It is not the netcode of the shipping game. When the real client exists, keep host-authoritative simulation and send goals, not raw "the LLM said to turn left."

## Slice B verification and remaining checks

Checked on 2026-11-11 with `npx tsc --noEmit -p tsconfig.json` clean:

- `eval:replay` 41/41, `eval:radio` 29/29 (20/20 scripted utterances, zero silent deviations, zero uncommanded retargets, plus coalesced/rate-limited copies and world-local command records after a serialized checkpoint).
- `eval:orders` 41/41, `eval-commands` 20/20, `eval-routes`, `eval-motion`, `eval-wall-clearance`, `eval-battle-plan`, `eval-arena` pass.
- `eval-commander` full run (not `--quick`): **17 passed, 0 failed**, including the 40 paired commander-vs-commander balance matches — `blue=13 red=5 draw=22` (blue 32.5%, red 12.5%, both under the 65% ceiling), 40/40 matches engaged, effective damage B/R 17094/16434, shots 1831/1816, applied commands 2424/2456. The stack did not skew either commander.
- `eval-basewar` full run (12 checks incl. its balance matches) passed; `--quick` (11) re-run after the last edits.
- Browser text-order intake verified at http://127.0.0.1:4847 in Multiplayer · Offline: standby appears before parse settles, healthy attack gets a company copy, HP interrupt and prey-death captions reach the visible radio, later lifecycle events update the same Janna row without duplicating it and keep its human score. Duplicate text created one history row; junk and no-intent chatter were correct.
- **Layout defect found and fixed after the first playtest screenshot.** The Qoder in-app browser and this desktop session cannot hand the page a visible surface (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`, `visibilityState=hidden`), so canvas pixels were measured instead of eyeballed: a manual `renderWorld` of a live dense MP-offline world fills the whole 1280×800 view (zoom 1, camera clamped to center), so the map itself was never letterboxed by the renderer. The real fault is CSS at narrow windows: below the 900px breakpoint `.layout` stacks into one column, and `html, body` kept `height:100%` with `overflow:auto`, so both stayed 100vh scroll boxes — the document never grew (`documentElement.scrollHeight` 617 while content was 1300) and the window could not scroll. The whole panel — Team radio, roster, Janna — was pushed below the fold and was unreachable, which is precisely where barks are supposed to land. Fixed by `height:auto; overflow:visible` in that media block plus `aspect-ratio:1280/800` on `.canvas-wrap` so the canvas box can no longer stretch away from the world's shape, and by the new `#radio-overlay` over the map. Re-measured in a same-origin 828×617 iframe (the window width from the screenshot): `scrollHeight` 1298, `scrollTo` reaches 696, the radio strip comes into view, canvas box 804×500 (aspect 1.61), and a submitted "2 attack 6" captioned `Company: standby` then `Company: #2 copy, attacking 6` in the overlay.
- Still unverified by a human eye: whether this now *looks* right at the player's window size. The numbers above are structural, not visual, and `take_screenshot` still fails in this session.
- Only browser console error remained the preconfigured LLM probe's expired-key 401. Offline mode was used deliberately.
- Unverified by automation: canvas visuals and hull feel, microphone recognition restart and real utterances, two-device online latency and guest captions, and all behavior after human playtest. These require the player's chair, not more scripted checks.
- Route-choice behavior itself was intentionally not retuned in Slice B. `eval-motion`'s shoot-past case pins its committed polyline so the remaining assertions test driving and firing rather than A\* choice; danger-aware routing is still judged by `eval-routes` and human playtest.
- Known product boundary: no-fog MP treats all living enemies as known, so a hidden target behind an open corridor remains held until it dies or the order changes. Fog contact TTL and belief decide loss in fog. This boundary is tested but not retuned.
- Radio dedupe survives online play: guests acknowledge locally and the host applies authoritatively, while snapshots preserve team, text, timestamp and object identity; a host failure caption clears the matching local guest dedupe. Two-device behavior was not manually tested.
- The 20 scripted utterances are one coverage set, not a claim that only 20 sentences work; many variants have deterministic phrase-reader coverage and all of them share the same execution path.

## Slice C verification and remaining checks

Checked on 2026-11-11 with `npx tsc --noEmit -p tsconfig.json` clean:

- `eval:stuck` 18/18: motor-level stuck detector checks at 30 and 60 Hz, including ally-blocked corridor flagging at 0.5s, sealed-corridor no-route reporting, no false positives for hold/arrived/open/fight-band, same-seed determinism with JSON checkpoint fork, and reroute isolation from dead/enemy/self IDs.
- `eval:replay` 41/41, `eval:radio` 29/29, `eval:orders` 41/41, `eval-commander --quick` 17/0, `eval-basewar --quick` 13 checks, `check-goal-writes` passed.
- Stuck detector wired into live brains (`src/ai.ts` `noteStuck` called from `applyMove`): a hull that wants to move and is not flags stuck after 0.5s, retries once per `stuckAfterSec` window with nearby allies as soft blockers, and expires the order with reason "stuck" after 2s if nothing frees it.
- Four metrics collected on `CommandRecord`: `t_ack_ms` (intake → first acknowledgement caption), `repeat_count` (dedupe-suppressed repeats), `interrupts` (goal interrupts attached to that command), `died_stuck` (1 when an addressee died with its stuck flag on).
- Metrics persisted to localStorage `tanki-command-postmortem-v1` and shown as a compact suffix on each Janna panel row (`src/command-history.ts` `rowFor`) plus the Shift+dump JSON table (`src/command-overlay.ts` `dumpCommandLog`).
- Radio gate (`src/radio.ts`) now tracks `UtteranceMeter` objects by identity: a repeat that lands while the parser awaits bumps `meter.count`, and the attach callback refreshes the record after it has been published.
- `markDiedStuck` exported from `src/command-pipeline.ts` and called from `applyDamage` in `src/game.ts` before `finishOrder` when `tank.stuckState?.stuck`.
- `npm run eval:stuck` added to package.json.

Still unverified by a human eye: whether the stuck detector actually fires in a live playtest and whether the metrics display correctly in the Janna panel. The motor-level tests prove the detector logic; the live wiring is in place; the display code is wired. A playtest in Multiplayer · Offline with a hull sealed in a pocket would confirm the end-to-end flow.

## Batch measurement tooling (2026-11-12)

Added so the game can be measured before features land. No gameplay number, doctrine, route rule or balance value changed. `npx tsc --noEmit -p tsconfig.json` clean, `eval:replay` 41/41, `eval:commander --quick` 17/0 (balance matches skipped by the flag).

What exists now:

- `npm run sim -- --matches N --seed S [--blue P --red P] [--mode --arena --share --difficulty --max-length --hz --middle-band --base-sample --out --rows]`. Plays full scripted-vs-scripted matches with no rendering at a fixed step as fast as the CPU allows, prints tables, writes `{params, summary, matches}` to `logs/sim-<blue>-vs-<red>-<mode>-<matches>mx<seed>.json`.
- `src/sim/match.ts` (`runMatch`, `MatchRecord`, `matchSeeds`), `src/sim/summary.ts` (`summarize`, `batchParams`), `scripts/sim-matches.ts` (CLI + tables). The `sim` block in `src/config.ts` (`hz`, `defaultMatches`, `maxLengthSec`, `middleBandFraction`, `baseSampleSec`) is tooling config only.
- Definitions chosen, because the game had none: middle area = central 40% of map height (tanked as `middle-tank-seconds` and as share-of-match-with-someone-there); base HP sampled every 5s plus a closing sample at the exact end state; a match still playing at `--max-length` (default 300s) is stopped and counted as an over-length draw, separate from a draw decided in play.
- Commander profiles on `createCommander`/`setCommander` (`tactical` = the shipped doctrine and still the default, `rusher`, `turtle`), threaded through `startMatch` so a profile survives match start.

Reads `src/sim/match.ts` directly — the sim code never renders, and the runner only reads world state between steps.

Numbers from seed 1, base-war / dense / share=clear / difficulty=normal / 30 Hz / 300s cap, 50 matches each. Throughput was contended (the three batches and two harnesses overlapped), so the wall-clock figures are not a clean benchmark.

| Matchup | blue wins | red wins | draws (over length) | length mean / median / max s | kills B/R | middle tank-s B/R | final base HP B/R | orders/match B/R |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tactical vs tactical | 25 (50.0%) | 25 (50.0%) | 0 (0) | 42.9 / 35.6 / 110.6 | 146 / 129 | 70.4 / 56.8 | 46.0% / 47.1% | 9.2 / 8.8 |
| rusher vs turtle | 50 (100.0%) | 0 | 0 (0) | 21.7 / 21.8 / 22.6 | 50 / 0 | 89.2 / 0.0 | 100.0% / 0.0% | 3.1 / 1.0 |
| rusher vs tactical | 37 (74.0%, 77.1% decided) | 11 (22.0%) | 2 (2) | 50.4 / 34.2 / 300.0 | 186 / 133 | 94.6 / 44.1 | 69.9% / 18.2% | 236 total (4.7) / 471 total (9.4) |

- `ORDERS BY INTENT` is the doctrine proof: rusher issued `attack_base` and nothing else (153 and 236 orders); turtle issued `defend_base` and nothing else (52), zero attack intents; tactical mixes `attack_base` / `defend_base` / `move_to` (250/202/6 blue, 249/190/3 red in the mirror match).
- The cap works: the two rusher-vs-tactical draws are both over-length at exactly 300.0s and are reported separately from in-play draws.
- Mirror match is 25/25 with red taking slightly more kills (129 vs 146 blue deaths asymmetry) — i.e. side asymmetry, not commander quality, is what the mirror exposes. Not tuned.
- Rusher beat tactical 74%, above the 65% ceiling the paired `eval:commander` balance run uses. Recorded, deliberately not fixed; `attack_base`-only pressure may just be strong in Base War.

Brittle / open:

- Base HP buckets print `samples 0` and `—` for every bucket past the longest match (all rusher-vs-turtle buckets are empty because that batch ended by 22.6s). The bucket is the mean over matches still running at that time; finished matches only show in `final` and `destroyed`.
- Hull types exist now (see "Tank types"), so the batch runner prints a pooled per-type row; the 2026-11-12 tables above were recorded before that, when every MP hull was a `shooter`.
- Profiles lean on bases. In a base-less mode (`--mode mp-offline|tdm`) turtle has nothing to garrison and issues no orders at all — its passivity then comes from the hold-at-spawn default — and rusher falls back to `move_to` the enemy spawn centre. Base War is the batch default for that reason.
- `--max-length` at or above the mode's own clock (base-war 600s, TDM 300s) makes the engine timeout decide first; the runner prints a note when that happens.
- AGENTS.md names `src/config/balance.ts` as the single gameplay config file; it now exists and holds the tank-type table, armour, repair, nuke and loadout numbers. `src/config.ts` re-exports it as `CONFIG.roles`, so a hull still reads `CONFIG.roles[tank.role]`. The `sim` block stayed in `src/config.ts` because it is tooling config, not gameplay.

## Tank types (2026-11-12)

Five hull types plus one repeat slot replace the six identical gunners under MP rules. No command phrase, no map, no win condition and no balance value was changed as a reaction to the numbers below — they are recorded, not tuned.

**The table.** `src/config/balance.ts` is the single source: `TANK_TYPES[role]` carries `maxHealth, speed, turnRate, fireRate, damage, range, visionRange, armor{front,side,rear}, doctrine, standoff, chaseRange, projectileSpeed, canShoot, debugRate`, plus `repairRate`/`repairRange` for the Engineer and a `nuke` block for the carrier, and `label`/`shortCode` for display. Scout 60 hp / 165 px·s / 9 dmg / 175 px gun / 240 px sight; Heavy 260 / 78 / 42 / 170 / 150 with `.5 / 1.1 / 1.45` armour; Artillery 70 / 72 / 70 / 380 / 200 at 0.16 shots·s⁻¹; Engineer 130 / 118 / 12 / 165 / 165 repairing 5 hp·s⁻¹ in an 85 px bubble; Nuke carrier 170 / 82 / 16 / 185 / 160. `src/config.ts` re-exports it as `CONFIG.roles`, so a hull still reads `CONFIG.roles[tank.role]` and `Role` is `TankTypeId`; the field on `Tank` stays `role` because radio, roster, net snapshot and the LLM payload all name it.

**The loadout.** `LOADOUTS.company = [scout, heavy, artillery, engineer, nuke, scout]` indexed by hull number, chosen by `loadoutFor(mode)`. TDM and CTF keep `LOADOUTS.tdm`, Heavy/Light keeps `heavyLight`, so `shooter` ("Gunner", the old line gun) survives for those modes and for the sixth slot. Six numbered hulls, six radio numbers.

**Directional damage.** `armorBand(target, bearing)` classifies a hit from the round's bearing against the hull's nose, `armoredDamage` applies the multiplier, `rawDamageFor` inverts it for test fixtures. A round with no velocity is a side hit. `applyDamage(world, tank, damage, sourceId, band)` records `tank.killedBy = sourceId`, which is what makes the per-type kill ledger possible.

**The nuke.** Only the carrier can throw one. The human's existing fire key launches it when it is off cooldown and a base is inside `nuke.range` (420 px); bots launch on the same reach while ordered `attackBase`. `damageVsBase` 400 bypasses `CONFIG.baseDamageMultiplier`, `damageVsTank` 45 still pays armour, cooldown 45 s with a 20 s spawn warmup so a match cannot open with one.

**Behavior that respects the type.** `combatManeuver` holds each hull's own band (`standoff × range`) and only `push` doctrine closes to the old kite line, so Artillery snipes from 380 and Heavy does not run anyone down. `shotTarget`, `tryShoot` and `notePathShot` gate on the hull's own `range`; `baseReachOf(role)` decides base reach; formation rings size themselves by the shortest gun in the group (`gunRange`). `chaseRange` bounds the AI's *initiative* — peeling for a team-belief contact in `maybeEngageFromBelief`, and breaking a soft order to fight a passer-by in `friendlyBrain`. A player order is still followed by any hull, however slow: the replay harness forbids vetoing orders, so "Heavy does not chase" is implemented as stand-off bands, per-hull gun reach and initiative leash, not as refusal. Invariant worth keeping: `standoff × range ≤ visionRange`, or a hull loses sight of the thing it is holding distance against and oscillates (documented on the field, not clamped in code).

**Type in the text.** Every radio-visible hull line names the type: deviation and order copies (`#3 Artillery copy, covering`), company acknowledgements (`Company: #2 Heavy ack, moving to the mark`), destruction notices (`Enemy #4 Nuke carrier destroyed.`), the recon hull-voice lines (`#1 Scout: report in — 6 cells logged.`, `contact near`) and the control-switch pair (`Control → #4 Engineer`, `#2 Heavy: continuing last order.`). The standby copy reads "Five hull types a side". CTF/TDM wreck-debug lines are left unstamped — those modes do not field the company. The HUD line reads `… · #1 Scout · clear` and each hull carries a two-letter type mark tinted per type.

Verification, all after the last edit: `npx tsc --noEmit -p tsconfig.json` clean; `eval:replay` 41/41 (with `check-goal-writes`), `eval:orders` 41/41, `eval:radio` 29/29 with 0 silent deviations and 0 retargets, `eval-commands` 20/20 — all four re-run after the final caption stamps, counts unchanged — plus, before them, `eval:stuck` 18/18, `eval-commander` full run (with the 40 paired balance matches) 18/18, `eval-motion`, `eval-battle-plan` 4/4, `eval-routes`, `eval-wall-clearance`, `check-routes` and `eval-arena` pass, `eval-basewar --quick` 13/13. The only red in the tree is `eval-basewar`'s 40-battle side guard, below.

Batch, 50 matches, seed 1, Base War, dense, tactical vs tactical — with the same batch on the pre-type HEAD tree next to it:

| | blue / red / draws | length mean | kills B/R |
| --- | --- | --- | --- |
| six gunners (HEAD) | 25 / 25 / 0 | 42.9 s | 146 / 129 |
| five-type company | 30 / 16 / 4 (all over the 300 s cap) | 187.1 s | 223 / 189 |

Per-type ledger (both teams pooled; 412 kills, all attributed):

| type | hulls | share of fielded | kills | share of kills | deaths | K/D | deaths per hull |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scout | 200 | 33.3% | 59 | 14.3% | 161 | 0.37 | 0.81 |
| Heavy | 100 | 16.7% | 133 | 32.3% | 69 | 1.93 | 0.69 |
| Artillery | 100 | 16.7% | 106 | 25.7% | 64 | 1.66 | 0.64 |
| Engineer | 100 | 16.7% | 22 | 5.3% | 92 | 0.24 | 0.92 |
| Nuke carrier | 100 | 16.7% | 92 | 22.3% | 26 | 3.54 | 0.26 |

Flagged, deliberately not rebalanced:

- **Nuke carrier dominates.** Best hull on every column: 22.3% of kills from 16.7% of the field, K/D 3.54, and it is killed 0.26 times per hull — the others die 0.64–0.92. In Base War its launches are also most of the damage a base takes: 1200 of 1295 on dense/seed 23 over 120 s (three launches, exactly on cooldown).
- **Heavy is the strongest line gun** (32.3% of kills, K/D 1.93) even though it has the shortest initiative leash. Slow and short-ranged, and it still out-trades.
- **Scout is weak**: 0.30 kills per hull (two of six slots, so 200 hulls) and the most deaths. It is also the hull the human drives by default.
- **Engineer is invisible rather than proven useless** — the batch runner measures no repair value at all, so its 5.3% share of kills is the only thing it can see.
- **Base War shape changed**: matches 4.4× longer, kills up from 275 to 412, four over-length draws where there were none, and blue 60% where the mirror was 25/25.
- `eval-commander`'s 40 paired MP-offline matches still pass their ceiling but read very differently: blue=3 red=5 **draw=32**, resolved 8/40, against the recorded pre-type blue=13 red=5 draw=22. A mixed company kills too slowly to empty a side inside the clock.
- **`eval-basewar`'s side guard is red**: 27/40 blue against a 26 ceiling (HEAD same seeds 18/22). Left failing as a recorded signal, not tuned away.

Brittle / open:

- The human drives blue #1, which is now a 60 hp Scout with a 175 px gun; an MP human used to drive a 110 hp Gunner with 220 px. `game.ts` still resolves the player hull as "first blue whose role is `shooter`, else first blue", which in the company resolves to #1. Changing who the player drives is a `LOADOUTS.company` edit.
- Three eval fixtures pin the legacy Gunner because they assert pre-type tuning: `eval-replay`'s low-HP retreat cycle (a Heavy cannot re-close and fire inside the 0.25 s window the test gives), `eval-basewar`'s continuous-firing pace and its gun-range-vs-vision-line check. `eval-motion`'s windows are derived from the hull's own speed, `eval-commands`' surround band is measured against the group's shortest and longest gun, and `eval-commander`'s large-arena push guard went 60 s → 75 s (measured 71.8 s; the company's slowest hulls drive at 72–82 px/s where every MP hull did 130).
- Directional armour is only as sharp as the aim. Bots face what they shoot, so live hits are mostly front or side; nobody deliberately maneuvers for a rear arc yet, so the 1.45 Heavy rear multiplier is barely reached in play.
- No metric exists for repairs, for the Engineer's value, or for intercepting a nuke round in flight.
- The batch JSON in `logs/` is overwritten by whichever `npm run sim` ran last; the two 50-match tables above are from `logs/sim-company-50b.log` and `logs/sim-head-50.log`.

## Base War: the base is the win, and it leans on a wall (2026-11-12)

Four changes, no rebalance attached to the numbers below.

**1. Only a destroyed base ends the match.** `checkBaseWarOutcome` in `src/game.ts` reads the two structures and nothing else: both gone → draw "Simultaneous destruction", one gone → win/lose "Base destroyed". Killing every enemy hull no longer finishes anything; a side with no hulls on the field is a side whose hulls are counting down at base, and the match runs on. `resolveBaseWarTimeout` is untouched and is now the only place elimination counts, as the second tie-break after base HP percentage. Non-Base-War modes keep elimination victories in `checkOutcome`. The briefing line and the gate's mode description say the same thing ("destroy the enemy base — killing their hulls only sends them back to base").

**2. Base position is map data.** `src/types.ts` gained `BaseTile` (moved out of `arena-bases.ts`), `WallSide` and `BasePlacement { tile, wall }`. Each map declares its own: `AUTHORED_BASES` in `src/arena-layouts.ts` for the hand-authored arenas (dense: tile 29,45 backing the south border) and `LARGE_BASE` in `src/arena-large.ts` for the generated one (tile 6,85, computed from `rows - BORDER_TILES - BASE_FOOTPRINT` so it stays flush if the map grows). `BASE_WAR_ARENAS` is gone; `baseWarMap(arena)` reads that declaration and derives red by the 180° mirror (`cols - BASE_FOOTPRINT - tile`), the mirrored `wall` side, the spawn ranks and the garrison posts from it. A future map generator sets the same `{ tile, wall }` field and gets all of that for free. Both bases now back onto a border, sit at least two tiles from a corner, and show one walled face and three open faces. `BASE_FOOTPRINT` lives in `src/config.ts` to keep `arena-large` ↔ `arena-bases` free of a runtime cycle.

**3. Base HP is in balance.ts.** `BASE_HP = 2000` in `src/config/balance.ts`, re-exported as `CONFIG.baseHp`; `createBaseStates` still reads `CONFIG.baseHp`, so nothing else moved. `baseDamageMultiplier` (0.25 on shells, bypassed by the nuke's `damageVsBase`) stayed where it was.

**4. The top bar shows both structures.** `#base-hp` in `index.html` (two spans, `hidden` until the world has bases), `renderBaseHp` on the per-frame path in `src/main.ts` beside the match timer, `.base-hp-blue` / `.base-hp-red` in the team colours already used on canvas. It reads e.g. `blue base 2000/2000   red base 1480/2000`, and appends `· lost`. The canvas `drawBaseHud` bars are unchanged, so the numbers appear twice on purpose: once in the strip, once over the map.

Verification, all after the last edit: `npx tsc --noEmit -p tsconfig.json` clean; `eval:replay` 41/41 with `check-goal-writes`; `eval-basewar` **14/14** full run (its 40-battle side guard, the one red item recorded under "Tank types", now reads blue 14 / red 26 against the 26 ceiling — it passes because elimination no longer decides anything, not because anything was tuned); `eval:orders` 41/41; `eval:radio` 29/29; `eval-commander` 18/18 (blue=3 red=5 draw=32, unchanged from the recorded run). `eval-basewar`'s placement check was rewritten: it asserted a wall-free ring on all four sides and now asserts exactly one border touched, three open faces and one walled face probed at 0.6 tile out, a base at least two tiles from a corner, enemy spawns still blind to the base centre, garrison posts clear of walls, and — new — that the two teams' posts are exact point mirrors. That last assertion caught a half-tile bias in my first `anchorPosts`: red's arc was landing 5 tiles out, inside a brick wall, while blue's sat 3 tiles out.

Batch, seed 1, Base War, share=clear, difficulty=normal, 30 Hz, `--max-length 600` so the engine's own 600s clock decides rather than the runner's 300s cap, 20 matches per row:

| Matchup | wins | length mean / median / min / max s | ended by a clock | final base HP B/R |
| --- | --- | --- | --- | --- |
| rusher vs turtle, dense | rusher 20/20 | 165.2 / 165.9 / 156.6 / 167.4 | 0/20 | 100.0% / 0.0% |
| turtle vs rusher, dense (sides swapped) | rusher 20/20 | 156.7 / 156.8 / 155.8 / 157.9 | 0/20 | 100.0% / 0.0% |
| rusher vs turtle, large | rusher 20/20 | 181.2 / 182.1 / 170.6 / 188.5 | 0/20 | 100.0% / 0.0% |
| tactical vs tactical, dense | blue 9 / red 11 / 0 draws | 248.3 / 211.4 / 130.6 / 600.0 | 2/20 | 30.3% / 43.1% |

**Is the turtle beatable? Yes, easily — and it is the turtle that never wins.** 40 rusher-vs-turtle matches, every one of them "Base destroyed", spread over ~2m37s on dense and ~3m01s on large, and the rusher's own base finished on 100% HP in all 40: the wall-backed apron plus `defend_base` garrison posts never let a rusher hull get a shot in, and the turtle gives up nothing because it issues only `defend_base` (1.1 orders a match against the rusher's 23.8–26.2 `attack_base`). Under the new rules a doctrine that never orders an attack cannot win, since destroying the enemy base is the only way to. Recorded, not fixed, as instructed. The mirror tactical batch is the sanity check that the mode is not one-sided: 18 of 20 matches ended "Base destroyed", both bases took steady shellfire (78.8%/87.5% by t=60s, 44.6%/49.7% by t=180s) and 10 blue / 8 red bases fell.

Brittle / open:

- **The HUD was never eyeballed.** The in-app browser still cannot be handed a visible surface (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`, `visibilityState=hidden`), and the entire HUD — including `#base-hp` — is painted from the `requestAnimationFrame` loop, so no frame ever ran and the element kept its initial `hidden`. Checked structurally instead: mode select → Base War → Play offline reaches a running world on the dense arena, the elements exist, the refs resolve, `renderBaseHp(world)` sits on the per-frame path, and `world.bases` is populated for dense and large (the placement check proves it). Whether the strip fits the top bar at a narrow window needs a human eye.
- ~~A dead side now just sits there.~~ Recorded before respawns: an eliminator advantage converted to a free kill on the structure rather than a win, and 2/20 tactical matches ran the whole 600s to be decided on base HP percentage. Respawns are in now ("Slow respawning"), which is what that gap was pointing at.
- `logs/sim-<blue>-vs-<red>-<mode>-<n>mx<seed>.json` did not include `--arena`, so the large-arena rusher-vs-turtle run overwrote the dense one. Fixed in "Large map is the default": the map is now in the filename. The dense numbers in the tables above are the printed output and this file.
- Garrison posts are derived (`anchorPosts`: 4 tiles out either side of the open face, 3 straight out) instead of a hand-listed table. They are only guaranteed free because `prepareBaseWarWalls` cuts a 3-tile apron; a map generator that shrinks that apron has to move the posts with it.
- The wall side is trusted, not measured: `wall` says which border the base backs onto and `openFace` derives the other three. A `BasePlacement` that is not actually flush with that border would leave the base floating with four open faces and the eval check would catch it for the two arenas that declare one.
- `scripts/sim-matches.ts` now validates `--mode base-war` against `baseWarMap(arena)` instead of the old table, so `--arena reference|standard` still fails with the same message.

## Large map is the default (2026-11-12)

The generated 144×90 map is what you get when nothing names a map. Dense 80×50 is still a name you can type. No bot behavior, doctrine, route rule or balance value changed, and no commit was made.

**One key holds the choice.** `CONFIG.arenaDefault` in `src/config.ts` is the only default-map setting. It replaced `CONFIG.mpOffline.denseArena` (a boolean that could only ever mean "the maze") and `CONFIG.net.arenaDefault` (which said dense for the LAN host); both are gone. `createWorld` in `src/game.ts` reads it for the MP ruleset only — TDM / CTF / Heavy-Light still take the reference screenshot layout, because there the map is a mode choice, not a pick. `src/main.ts` uses it when a LAN host starts with no arena. The Arena select in `index.html` now ships `large` selected, and `src/sim/match.ts` `matchSpec()` takes `CONFIG.arenaDefault` too, so a batch with no `--map` runs the same map the game boots into.

**Bases.** Nothing to add: `LARGE_BASE` in `src/arena-large.ts` already seats blue at tile 6,85 flush with the south border (wall "south", three open faces) and `baseWarMap` mirrors red to tile 135,2 against the north border. `eval-basewar`'s placement check runs both maps and asserts, per team: exactly one border touched, all four faces probed (three open, one walled), at least two tiles from a corner, enemy spawns blind to the base centre, garrison posts out of walls, and blue's posts the exact point mirror of red's. Equal distance to centre and equal wall exposure follow from the 180° mirror and are checked by it.

**Batch runner.** `--map` is now an accepted alias of the existing `--arena` (same value set, same validation), the header already printed the map (`mode=… arena=… share=…`) and still does, and the default JSON name now carries it — `logs/sim-<blue>-vs-<red>-<mode>-<map>-<matches>mx<seed>.json` — which closes the recorded brittleness where a large run overwrote the dense one.

**Verification** — `npx tsc --noEmit -p tsconfig.json` clean; `eval:replay` 44/44 (with `check-goal-writes`), `eval:orders` 41/41, `eval:radio` 29/29 with 0 silent deviations and 0 retargets, `eval-commands` 20/20, `eval:stuck` 18/18, `eval-commander --quick` 17/0 (both MP arenas: dense 26.6s, large 71.8s to first base contact), `eval-motion`, `eval-wall-clearance`, `eval-basewar` placement check.

Four harnesses no longer inherit the map, because each one measures something calibrated to the dense maze and would silently change meaning: `duel()` in `eval-commander.ts` (the paired balance run asserts its walls equal `buildArena("dense")`), `fixture()` and `battle()` in `eval-basewar.ts` (the 30s attackBase window and the 26% side guard), and the mp-offline long-steer case in `eval-wall-clearance.ts`. They now pass `"dense"` explicitly.

`eval-basewar --quick`'s "passive defence on both MP arenas" failed here at `dense/23: defence lost 5` (guard ≤2), scripts/eval-basewar.ts:405, and was left as a recorded signal. Respawns explain it: that check counted losses as drops in the living-hull count, so a hull that died, returned and died again was charged twice. It now counts hulls destroyed at least once — the cost a wreck mode used to charge — and reports respawns beside it, so the guard says what it always meant. Same seeds: dense/23 attackers 5 / defence 2 / 11 respawns, dense/411 4 / 2 / 13, large/23 3 / 0 / 2, large/411 4 / 2 / 4. Note the defence sits exactly on its ≤2 limit in three of the four cases; the margin is thin and the guard will need re-reading if the respawn delay moves.

Batch, seed 1, Base War, share=clear, difficulty=normal, 30 Hz, 300s cap (not reached), rusher (blue) vs turtle (red), 40 matches each:

| Map | rusher wins | length mean / median / min / max s | winner's own base HP | final base HP blue/red |
| --- | --- | --- | --- | --- |
| large (the new default) | 40/40 (100%) | 170.9 / 170.9 / 169.7 / 172.3 | 100.0% in all 40 | 100.0% / 0.0% |
| dense | 40/40 (100%) | 165.4 / 168.8 / 156.3 / 178.8 | 100.0% in all 40 | 100.0% / 0.0% |

Same shape on both maps that the previous step recorded: the turtle only issues `defend_base` (1.2 orders/match large, 2.2 dense) against the rusher's 34.7/34.1 `attack_base`, and the wall-backed apron means the winner never loses HP — so under rules where only a destroyed base wins, the passive doctrine cannot win at all. Recorded, not tuned, as instructed. Orders and kill counts differ from the older 20-match rows because respawns are live in this tree (7.0 blue respawns/match on large).

## Slow respawning (2026-11-12)

Dead hulls come back. No middle zone, no rate that moves yet — the point of this step is the clock, the return, and the one function the next step will bend.

**Two numbers, one hook.** `RESPAWN = { delaySec: 25, protectionSec: 2 }` and `getRespawnRate(team)` live in `src/config/balance.ts` with every other gameplay number. `getRespawnRate` returns 1.0 for both sides and is called from exactly one place — `updateRespawns` multiplies `dt` by it — so zone control arrives by changing that function and nothing else. The rate is the only scale; the delay stays `RESPAWN.delaySec`.

**Where it applies.** `isMpRules` only: Base War, Multiplayer · Offline, Multiplayer · Online. TDM / CTF / Heavy-Light still leave a wreck for good, so their wipe-and-wreck victories and their fixtures are untouched. The timer is armed in `applyDamage` — the single hull-damage choke point — and nowhere else, which is what keeps every harness that sets `alive = false` by hand honest: a hull killed without going through damage has no countdown and stays dead.

**The return.** `respawnTank` in `src/game.ts` revives the same `Tank` object — same id, role and number — at `tank.spawnPos` with full HP, its team's spawn heading, `cooldown` 0, the nuke round warming up again from `nuke.warmupSec`, all order bookkeeping (route, drive track, stuck flag, report/debug progress, `killedBy`) cleared, and the order it was following dropped: it holds position at base until someone names a new one. `spawnPos` is written once by `spawnTeam` (`src/types.ts` gained three optional fields — `spawnPos`, `respawnLeft`, `spawnProtectionUntil` — optional so the hand-built Tank literals in `render.ts` and `ai-commander.ts` still compile).

**Protection is a plain timer.** For `RESPAWN.protectionSec` after the hull appears, `applyDamage` returns before armour is read, so shells and the nuke blast do it no damage. Nothing cancels it early — not firing, not moving, not entering a base's gun line. Structures are unaffected: bases take damage through `applyBaseDamage`, which never sees the flag.

**Victory rules survive, honestly.** `checkOutcome` still ends an MP match on a wipe, but a wipe now means the whole enemy company dead in the same instant; killing them one at a time no longer finishes anything. Base War was already base-only, and its comment that "respawns are the next step" is now true.

**HUD.** `#respawn-hud` in the top bar (beside `#base-hp`) lists each of the local team's waiting hulls as `#3 NV 17s`, counting down, and hides when nobody is in the ground. It reads the exported selector `respawnQueue(world, team)` from `src/game.ts`; the per-frame path in `src/main.ts` never touches sim internals, and `sim/` stays DOM-free.

**Netcode.** `respawnLeft` is carried in `NetTankSnap` (`src/net/protocol.ts`, encoded/decoded in `src/net/snapshot.ts`) so a guest can draw its own countdown; the host is authoritative and `spawnProtectionUntil` is not sent. The replay snapshot needs nothing: `captureReplaySnapshot` structured-clones the world, so all three fields ride along.

**Batch metrics.** `src/sim/match.ts` counts respawns (dead → alive transitions, symmetric with the existing kill detection) and, every tick, the seconds each team has fewer than `spec.underStrengthAlive` living hulls. The threshold is 5 — one short of the six-hull company — and lives in `CONFIG.sim` in `src/config.ts` because it is a measurement definition, not a gameplay number. `summarize` exposes `deathsByTeam`, `respawns` and `underStrength` (seconds mean and share-of-match mean), `scripts/sim-matches.ts` prints them as a RESPAWN table with a `--under-strength N` knob, and the header states the rules the batch is running under.

Verification — `npx tsc --noEmit -p tsconfig.json` clean. `eval:replay` **44/44** with `check-goal-writes` (three new checks: the countdown returns the hull whole to its own base with its type and number and survives a checkpoint/restore fork; protection blocks a lethal shell and expires, and the second death re-arms; the clock ticks at `dt × getRespawnRate(team)` for both teams). The new checks were falsified on purpose: with `getRespawnRate` stubbed to 2.0 while `updateRespawns` ignored it, two of the three failed and named the tick count; both edits reverted. `eval:radio` 29/29, `eval:orders` 41/41, `eval-commander --quick` 17/0, `eval-basewar --quick` 13 checks (its "passive defence" guard needed the death-counting fix described above), plus a headless player-path check that died the controlled hull: control switched to `blue-4`, the queue read `blue-1#1 25.0s`, the scout returned at tick 750 (25.00s) at its recorded spawn coordinates with 60/60 HP, `#1 scout`, 2.00s of protection left, and `switchToTank` took it back.


## How to run

```
npm install
npm run dev
```

Open http://127.0.0.1:4847. For two devices, on the multiplayer branch:

```
npm run dev:mp
```

Host: Multiplayer · Online → room TANK → Host match → share `http://192.168.x.x:4847` (not a 172.x VM address). Guest joins the same room. Host starts when the guest is connected. Windows firewall must allow TCP 4847 and 4855.

Phrase buttons and the text box use the same order path as the mic. Use them when speech recognition is the thing you are trying not to debug.

Checks that exist (scripts are outside tsc; run with tsx):

- `npm run eval:orders` — goal schema and offline gold sentences. This is `npm test`.
- `npm run eval:replay` — `scripts/check-goal-writes.ts` plus 44 fixed-step lifecycle/determinism checks, including the three respawn ones.
- `npm run eval:radio` — 29 checks: 20 scripted utterances with zero silent deviations or retargets, dedupe, failure reset, silent chatter, synchronous standby under a delayed fake parser, coalesced and rate-limited copies, order replacements that always speak, and world-local command records.
- `npm run eval:commander` — scripted-commander invariants; without `--quick` it also runs the 40 paired balance matches.
- `npm run sim -- --matches 50 --seed 1` — headless batch measurement of full scripted-vs-scripted Base War matches. No rendering, fixed step, no pacing. Prints win rate by side, match length, kills and deaths by hull type, a pooled per-type ledger (hulls, kills, deaths, K/D, deaths per hull) with a note for any kill that has no hull type, the RESPAWN row (deaths, respawns and time below `--under-strength` living hulls per team, with a share of match), middle-area time, base HP over time, orders applied and orders by intent; writes `{params, summary, matches}` to `logs/sim-<blue>-vs-<red>-<mode>-<map>-<matches>mx<seed>.json`. `--blue`/`--red` take `tactical|default|rusher|turtle` (`default` is the alias of `tactical`); `--map` (alias `--arena`) picks the map, default `CONFIG.arenaDefault` = `large`, and the header prints it; `--max-length` is the over-length draw cap; `--under-strength N` sets the living-hull threshold (default `CONFIG.sim.underStrengthAlive` = 5, one short of the six-hull company); `--help` lists the rest. It measures, it does not tune — every knob only changes what is being measured.
- `npx tsx scripts/eval-commands.ts`
- `npx tsx scripts/eval-routes.ts` — covered corridor beats the gap an enemy is watching.
- `npx tsx scripts/eval-motion.ts` — open-lane move does not reverse; a move past an enemy fires without leaving the path. Its shoot-past case pins the committed polyline so it measures the motor, not `eval-routes`' danger-aware route choice.
- `npx tsx scripts/eval-basewar.ts` — Base War rules; `--quick` skips the balance matches.
- `npx tsx scripts/eval-wall-clearance.ts`
- `npx tsx scripts/eval-battle-plan.ts`
- `npx tsx scripts/eval-arena.ts`
- `npx tsc --noEmit -p tsconfig.json`

`tsconfig` includes `src` only, `noUnusedLocals` on. Do not reference `process` from `src`. PowerShell has no `&&`. On this machine the sandbox often cannot see the workspace; shell commands need full permissions. npm may warn `Unknown env config devdir`; ignore it.

A normal/TDM match that kills every red tank sets outcome to win and `stepWorld` stops. Base War ends only when a base is destroyed — simultaneous victories rule a draw, a 600s timeout resolves by base HP percent then surviving tanks — and emptying the enemy side changes nothing but who can still shoot. Headless Base War tests must expect a match to keep running after an elimination; other headless matches must leave one red alive. Respawns change what "every red tank" means: under MP rules a dead hull is only in the ground for `RESPAWN.delaySec`, so the wipe victory now needs the whole enemy company down in the same instant, and a hull killed one at a time never finishes anything. Tests that want a wipe still set `alive = false` directly — only `applyDamage` arms the countdown, so a hand-killed hull stays dead.

## Code map

| Path | Role |
| --- | --- |
| `src/main.ts` | UI, input, mode menu, LLM probe, voice, online client wiring |
| `src/game.ts` | World, shooting, damage, win check, `sendOrder` |
| `src/config.ts` | Arenas, modes, AI and match rules. Tank numbers are not here |
| `src/config/balance.ts` | The tank-type table: stats, armour bands, repair, nuke, per-mode loadouts. AGENTS.md's one gameplay-number file |
| `src/goals.ts` | The goal enum. Parsers and brains must stay inside it |
| `src/orders.ts` | Phrase reader, keyword reader, LLM prompt, sanitize |
| `src/command-schema.ts` | Shared intent tools: attack, cover, move_to, flank, surround |
| `src/command-pipeline.ts` | Phrase reader → Needle → LLM, plus the comparison log |
| `src/command-resolver.ts` | Intent → tank ids and goals. Parsers do not emit coordinates |
| `src/needle-sidecar.ts`, `src/needle-browser.ts` | Experimental local parser. Default off |
| `src/battle-plan.ts` | One utterance, one lane split |
| `src/formation.ts` | Surround / flank / line slots |
| `src/ai.ts` | Brains, danger field, `planRoute`, `committedRoute` |
| `src/interrupt-stack.ts` | Goal stack, lifecycle events, captions, ordered-prey binding |
| `src/radio.ts` | Partial-intent intake, normalization, addressee dedupe, captions |
| `src/random.ts`, `src/replay.ts` | Seeded RNG and fixed-step snapshot replay |
| `src/ai-commander.ts` | Scripted opponent commander and its belief view. `profile` selects `tactical` (the shipped doctrine), `rusher` (all bots at the enemy base) or `turtle` (garrison the own base, never attacks) |
| `src/sim/match.ts`, `src/sim/summary.ts` | Headless batch measurement: one full match → `MatchRecord`, batch → `Summary`. Reads world state only, never renders |
| `src/motion.ts` | Polyline follower |
| `src/arena.ts`, `src/arena-layouts.ts`, `src/arena-routes.ts` | Walls, collision, two-route repair. The route repair is not the bot planner. `arena-layouts.ts` also carries `AUTHORED_BASES`, the Base War `{ tile, wall }` each hand-authored map declares |
| `src/arena-bases.ts` | Base War off one declared placement: `baseWarMap(arena)` mirrors red, derives spawns, garrison posts, the apron clear and the base walls |
| `src/spawn.ts` | Teams, roles, hold-at-spawn for MP |
| `src/belief.ts`, `src/fog.ts` | Shared contacts and vision. MP is no-fog, so belief matters for TDM |
| `src/render.ts` | Canvas. Online red view is rotated 180° |
| `src/voice.ts` | Browser speech recognition |
| `src/command-history.ts`, `src/postmortem.ts`, `postmortem.html` | Janna parse scoring and lifecycle reason tooltips |
| `src/net/*`, `scripts/mp-server.ts` | LAN relay |
| `map.json`, `scripts/export-map.ts` | Export only |

`public/neon-map.jpg` is reference art from a request to restyle the floor. Collision is still the brick maze from `arena-layouts.ts`. Do not delete interior walls to match a picture unless the player asks again; invisible collision and missing collision were both rejected in play.

## Working agreements

- Do not commit unless asked. Do not commit `src/api-key.local.ts` or `.env`.
- Do not put the language model in the frame loop.
- Do not replace `planRoute` with a learned policy to fix a bad route. Draw the polyline and the danger field first.
- Do not give Needle final authority while it is slower and less confident than the phrase reader.
- MP bots hold until a player order names them. A new order rewrites only the tanks it names.
- Player moveTo and hold are not replaced by patrol or attack because an enemy is nearby. Shooting while staying on the path is allowed, but it is captioned as a deviation.
- Retreat exemptions are explicit `noRetreat`; ordered movement does not receive one implicitly.
- Anchors are free tiles the body can occupy, not wall centers.
- Typecheck stays clean.
- Barks are captioned text. No TTS or spoken bot audio into an open mic in v1.
- Eval and replay use a fixed timestep and a recorded RNG seed. The player's frame rate is never the source of truth for tests.
- No dodge without a perception model and reaction delay. A 0ms projectile dodge is a fairness regression.
- An order must never be silently dropped, retargeted, or overwritten. Every interrupt gets a reason code on the command record and a bark.
