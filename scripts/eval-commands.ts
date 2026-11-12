/**
 * Radio command pipeline check: phrase reader, Needle sidecar, LLM fallback.
 *
 *   npx tsx scripts/eval-commands.ts          stand-in engine, no network, ~1s
 *   npx tsx scripts/eval-commands.ts --real   also runs the real Needle model
 *                                             (35 MB download once, ~40s load,
 *                                             several seconds per sentence)
 *
 * The stand-in engine answers the way a correct Needle should, instantly.
 * It tests the plumbing, gates, resolver, and formations — not the model.
 * --real measures the model itself.
 */
import assert from "node:assert/strict";
import { circleHitsWall } from "../src/arena.ts";
import { commandLog, type CommandRecord } from "../src/command-pipeline.ts";
import { CONFIG } from "../src/config.ts";
import { gunRange } from "../src/formation.ts";
import { createWorld, pushChat, pushEvent, sendOrder } from "../src/game.ts";
import { restoreGoal } from "../src/interrupt-stack.ts";
import {
  judge,
  setNeedleEngine,
  setNeedleSidecarEnabled,
  type NeedleCall,
  type NeedleEngine,
  type NeedleRawResult,
} from "../src/needle-sidecar.ts";
import { interpretOrder, lateralOffset, normalizeSpokenNumbers } from "../src/orders.ts";
import type { InterpretContext, Tank, Wall, WorldState } from "../src/types.ts";

const REAL = process.argv.includes("--real");
console.debug = () => {};

const TEST_PHRASES = [
  "everyone cover me",
  "4 and 6 attack 2",
  "1 and 3 attack 5",
  "2 cover me",
  "4 move to the left",
  "3 move to the marked spot",
  "6 take the left of 5, i'll take the right",
  "3 and 4 surround 6",
];

const SPOKEN_VARIANTS = [
  "everybody cover me",
  "four and six attack two",
  "one and three attack five",
  "two, cover me",
  "four move to the left",
  "tank three move to the marked spot",
  "six take the left of five, I'll take the right",
  "three and four surround six",
];

const JUNK = [
  "what's for dinner",
  "banana helicopter seven",
  "",
  "   ",
  "asdf;lkj qwer",
  "7 and 9 attack 12",
  "🙂🙂🙂",
  "the the the the ".repeat(60),
];

// Addressed but unresolved fragments must ask for clarification, not invent an attack.
const PARTIAL_INTENT = ["7 and 9 attack 12", "3", "2 banana helicopter", "3 go over there"];

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function borders(): Wall[] {
  return [
    { x: 0, y: 0, w: 1280, h: 32, kind: "border" },
    { x: 0, y: 32, w: 32, h: 768, kind: "border" },
    { x: 1248, y: 32, w: 32, h: 768, kind: "border" },
    { x: 32, y: 768, w: 1216, h: 32, kind: "border" },
  ];
}

/** Commander #1 at the bottom facing north, bots behind, enemies up top. */
function stagedWorld(mode: "tdm" | "mp-offline" = "tdm", openField = true): WorldState {
  const world = createWorld("clear", mode, "normal", 7);
  world.outcome = "playing";
  if (openField) world.walls = borders();
  world.controlledId = "blue-1";
  const place: Record<string, [number, number]> = {
    "blue-1": [640, 600],
    "blue-2": [440, 660],
    "blue-3": [540, 660],
    "blue-4": [740, 660],
    "blue-5": [840, 660],
    "blue-6": [940, 660],
    "red-1": [300, 260],
    "red-2": [400, 260],
    "red-3": [500, 200],
    "red-4": [780, 200],
    "red-5": [640, 300],
    "red-6": [900, 300],
  };
  for (const t of world.tanks) {
    const p = place[t.id];
    if (!p) continue;
    t.x = p[0];
    t.y = p[1];
    t.angle = t.team === "blue" ? -Math.PI / 2 : Math.PI / 2;
  }
  world.playerMarks.blue = { x: 400, y: 500 };
  return world;
}

function tank(world: WorldState, id: string): Tank {
  return world.tanks.find((t) => t.id === id)!;
}

function lastRecord(): CommandRecord {
  const log = commandLog();
  return log[log.length - 1]!;
}

/** Legacy parser/application reference for valid goals, not radio display or lifecycle metadata. */
async function legacySendOrder(
  world: WorldState,
  orderText: string,
  ctx: InterpretContext = {},
  team: "blue" | "red" = "blue",
): Promise<void> {
  if (world.outcome !== "playing") return;
  pushEvent(world, `Order (${team}): ${orderText}`, "sys");
  const bundle = await interpretOrder(orderText, world.tanks, world, ctx, team);
  if (bundle.notice) {
    pushEvent(world, bundle.notice, "warn");
    pushChat(world, bundle.notice, "warn");
  }
  if (bundle.llmError) {
    pushEvent(world, `LLM unavailable (${bundle.llmError}) — keyword parse.`, "warn");
  }
  pushEvent(
    world,
    `Radio parse: ${bundle.source.toUpperCase()} (${bundle.ms}ms) → ${bundle.results.length} tank(s)`,
    "sys",
  );
  const living = bundle.results.filter((r) => {
    const t = world.tanks.find((x) => x.id === r.tankId);
    return t && t.alive;
  });
  if (living.length) {
    const sample = living[0]!;
    const sameGoal = living.every((r) => r.goal === sample.goal);
    const ack = sameGoal
      ? `Company: ${living.length} tank(s) — ${sample.chatLine.replace(/^#\d+:\s*/, "")}`
      : `Company: ${living.length} tank(s) ack.`;
    pushChat(world, ack, "ally");
  }
  for (const r of living) {
    const t = world.tanks.find((x) => x.id === r.tankId)!;
    restoreGoal(t, { kind: r.goal, params: r.params ?? {}, source: "player" });
    t.lastOrderChat = r.chatLine;
    const px = r.params?.x;
    const py = r.params?.y;
    pushEvent(
      world,
      `Interpret #${t.number}: ${r.goal}${
        px != null && py != null ? ` @(${Math.round(px)},${Math.round(py)})` : ""
      }`,
      "sys",
    );
  }
}

function goalSnapshot(world: WorldState) {
  // Slice B owns standby/copy/reason captions and provenance. Compare only
  // parser semantics, including unchanged goals on every nonrecipient.
  return world.tanks.map(({ id, goal }) => ({
    id, kind: goal.kind, params: goal.params, source: goal.source,
  }));
}

/** Canned OpenAI-compatible reply so the API path runs without a key or network. */
function stubFetch(): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                orders: [
                  {
                    tankId: "blue-2",
                    goal: "escort",
                    params: { targetTankId: "blue-1" },
                    chatLine: "#2: covering you.",
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
}

const call = (name: string, args: Record<string, unknown>): NeedleCall => ({
  name,
  arguments: args,
});

function raw(calls: NeedleCall[], confidence: number | null): NeedleRawResult {
  return {
    type: calls.length ? "call" : "respond",
    success: true,
    error: null,
    confidence,
    function_calls: calls,
    suppressed_calls: [],
  };
}

/** What a correct Needle would answer for each sentence, keyed by normalized text. */
const ORACLE: Record<string, NeedleRawResult> = {
  "everyone cover me": raw([call("cover", { tank_ids: [1, 2, 3, 4, 5, 6], protect: "player" })], 0.94),
  "everybody cover me": raw([call("cover", { tank_ids: [1, 2, 3, 4, 5, 6], protect: "player" })], 0.93),
  "2 cover me": raw([call("cover", { tank_ids: [2], protect: "player" })], 0.95),
  "2, cover me": raw([call("cover", { tank_ids: [2], protect: "player" })], 0.95),
  "3 move to the marked spot": raw(
    [call("move_to", { tank_ids: [3], ref: { type: "marker" } })],
    0.91,
  ),
  "tank 3 move to the marked spot": raw(
    [call("move_to", { tank_ids: [3], ref: { type: "marker" } })],
    0.9,
  ),
  // The second call is the player's own clause; the sidecar must drop it.
  "6 take the left of 5, i'll take the right": raw(
    [
      call("flank", { tank_ids: [6], reference_id: 5, side: "left" }),
      call("flank", { tank_ids: [1], reference_id: 5, side: "right" }),
    ],
    0.88,
  ),
  "6 take the left of 5, I'll take the right": raw(
    [call("flank", { tank_ids: [6], reference_id: 5, side: "left" })],
    0.88,
  ),
  "3 and 4 surround 6": raw([call("surround", { tank_ids: [3, 4], target_id: 6 })], 0.92),
  "3 maybe go over there": raw(
    [call("move_to", { tank_ids: [3], ref: { type: "relative", anchor: "player", direction: "forward" } })],
    0.41,
  ),
  "2 please cover me now": raw([call("cover", { tank_ids: [2, 5], protect: "player" })], 0.9),
  "2 please take out 3": raw([call("attack", { tank_ids: [2, 5], target_id: 3 })], 0.9),
};

function oracleEngine(delayMs = 0): NeedleEngine & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async complete(text) {
      calls.push(text);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return ORACLE[text] ?? raw([], 0.97);
    },
  };
}

console.log("Flag off: valid parser goals match the legacy reader");
{
  setNeedleSidecarEnabled(false);
  setNeedleEngine(oracleEngine());
  // The last three canonical/spoken sentences require semantic resolution;
  // their old no-key guesses are not a correctness reference.
  const settled = [...TEST_PHRASES.slice(0, 5), ...SPOKEN_VARIANTS.slice(0, 5),
    "3 move to the mark", "tank three move to the mark"];
  const modelPhrases = ["push through the courtyard", TEST_PHRASES[5]!, TEST_PHRASES[7]!,
    SPOKEN_VARIANTS[5]!, SPOKEN_VARIANTS[7]!];
  for (const mode of ["tdm", "mp-offline"] as const) {
    for (const withKey of [false, true]) {
      const phrases = withKey ? [...settled, ...modelPhrases] : settled;
      await check(`${mode}${withKey ? " + mocked API" : ""}: ${phrases.length} valid goal sets match`, async () => {
        if (withKey) stubFetch();
        const ctx: InterpretContext = withKey ? { apiKey: "sk-test", provider: "openai" } : {};
        for (const text of phrases) {
          const a = stagedWorld(mode, false);
          const b = stagedWorld(mode, false);
          // Spoken forms must preserve the canonical recipient set. The legacy
          // mp-offline reader misread "two, cover me" as covering tank #2.
          const variant = SPOKEN_VARIANTS.indexOf(text);
          const reference = variant < 0 ? text : TEST_PHRASES[variant]!;
          Math.random = seededRandom(11);
          await legacySendOrder(a, reference, ctx);
          Math.random = seededRandom(11);
          await sendOrder(b, text, ctx);
          assert.deepEqual(goalSnapshot(b), goalSnapshot(a), `differs for ${JSON.stringify(text)}`);
          const rec = lastRecord();
          assert.equal(rec.raw_text, text);
          assert.equal(rec.sidecar, false);
          assert.equal(rec.needle_result, null, "needle never consulted with the flag off");
          if (settled.includes(text)) assert.equal(rec.fast_path_result.settled, true, text);
          else {
            assert.equal(rec.which_path_executed, "llm_api", text);
            assert.equal(rec.llm_result.attempted, true);
            assert.equal(rec.llm_result.ok, true);
          }
          for (const t of b.tanks) {
            if (t.goal.source === "player") {
              assert.equal(t.goal.commandSource, rec.which_path_executed);
            }
          }
          assert.ok(b.tanks.some((t) => t.goal.source === "player"), `no goals for ${text}`);
          assert.ok(["phrase_reader", "llm_api"].includes(rec.which_path_executed), rec.which_path_executed);
        }
      });
    }
  }
}

await check("flag off, API key: settled phrases stay phrase_reader, the rest go to llm_api", async () => {
  setNeedleSidecarEnabled(false);
  stubFetch();
  const w = stagedWorld();
  await sendOrder(w, "4 and 6 attack 2", { apiKey: "sk-test", provider: "openai" });
  assert.equal(lastRecord().which_path_executed, "phrase_reader");
  assert.equal(lastRecord().llm_result.attempted, false);
  await sendOrder(w, "2 cover me", { apiKey: "sk-test", provider: "openai" });
  assert.equal(lastRecord().which_path_executed, "phrase_reader");
  assert.equal(lastRecord().llm_result.attempted, false);
  await sendOrder(w, "push through the courtyard", { apiKey: "sk-test", provider: "openai" });
  const rec = lastRecord();
  assert.equal(rec.which_path_executed, "llm_api");
  assert.equal(rec.llm_result.attempted, true);
  assert.equal(rec.llm_result.ok, true);
});

console.log("Flag on: the eight test commands");
const needleRecords: CommandRecord[] = [];
async function run(world: WorldState, text: string): Promise<CommandRecord> {
  await sendOrder(world, text, {});
  const rec = lastRecord();
  if (rec.which_path_executed === "needle") needleRecords.push(rec);
  return rec;
}

for (const [label, phrases] of [
  ["canonical", TEST_PHRASES],
  ["spoken", SPOKEN_VARIANTS],
] as const) {
  await check(`${label}: all eight parse to the right goals`, async () => {
    setNeedleSidecarEnabled(true);
    setNeedleEngine(oracleEngine());
    const expectNeedle = (rec: CommandRecord) => {
      assert.equal(rec.which_path_executed, "needle", `${rec.raw_text}: ${JSON.stringify(rec.needle_result)}`);
      assert.equal(rec.needle_result?.status, "accepted");
      assert.equal(rec.llm_result.attempted, false, "Needle has final authority");
    };

    // everyone cover me → every bot escorts the player; the player gets nothing.
    // Cover is a keyword the phrase reader already settles, so Needle is not
    // consulted (that used to wait on the LLM for several seconds).
    let w = stagedWorld();
    let rec = await run(w, phrases[0]);
    assert.equal(rec.which_path_executed, "phrase_reader", rec.raw_text);
    assert.equal(rec.llm_result.attempted, false);
    for (const id of ["blue-2", "blue-3", "blue-4", "blue-5", "blue-6"]) {
      assert.equal(tank(w, id).goal.kind, "escort", id);
      assert.equal(tank(w, id).goal.params?.targetTankId, "blue-1");
      assert.equal(tank(w, id).goal.commandSource, "phrase_reader");
    }
    assert.notEqual(tank(w, "blue-1").goal.source, "player");

    // 4 and 6 attack 2 → one order set, both tanks, enemy #2 (phrase reader).
    w = stagedWorld();
    rec = await run(w, phrases[1]);
    assert.equal(rec.which_path_executed, "phrase_reader");
    assert.equal(rec.needle_result?.status, "skipped_fast_path");
    for (const id of ["blue-4", "blue-6"]) {
      assert.equal(tank(w, id).goal.kind, "attackNearest");
      assert.equal(tank(w, id).goal.params?.targetTankId, "red-2");
      assert.equal(tank(w, id).goal.commandSource, "phrase_reader");
    }
    assert.equal(rec.goals.length, 1, "one grouped goal line for both tanks");

    // 1 and 3 attack 5 → #1 and #3 on red #5, nobody orders friendly #5.
    w = stagedWorld();
    rec = await run(w, phrases[2]);
    assert.equal(rec.which_path_executed, "phrase_reader");
    assert.equal(tank(w, "blue-3").goal.params?.targetTankId, "red-5");
    assert.notEqual(tank(w, "blue-5").goal.source, "player");

    // 2 cover me → only #2 escorts the player.
    w = stagedWorld();
    rec = await run(w, phrases[3]);
    assert.equal(rec.which_path_executed, "phrase_reader", rec.raw_text);
    assert.equal(tank(w, "blue-2").goal.kind, "escort");
    assert.equal(tank(w, "blue-2").goal.params?.targetTankId, "blue-1");
    assert.equal(w.tanks.filter((t) => t.goal.source === "player").length, 1);

    // 4 move to the left → phrase reader's flank, on the player's left.
    w = stagedWorld();
    rec = await run(w, phrases[4]);
    assert.equal(rec.which_path_executed, "phrase_reader");
    const g4 = tank(w, "blue-4").goal;
    assert.equal(g4.kind, "moveTo");
    assert.equal(g4.params?.side, "left");
    assert.ok((g4.params?.x ?? 999) < tank(w, "blue-1").x, "left of a north-facing player is west");

    // 3 move to the marked spot → #3 to the mark, exactly.
    w = stagedWorld();
    rec = await run(w, phrases[5]);
    expectNeedle(rec);
    const g3 = tank(w, "blue-3").goal;
    assert.equal(g3.kind, "moveTo");
    assert.deepEqual([g3.params?.x, g3.params?.y, g3.params?.exact], [400, 500, true]);

    // 6 take the left of 5, I'll take the right → only #6, left of enemy #5.
    w = stagedWorld();
    rec = await run(w, phrases[6]);
    expectNeedle(rec);
    assert.ok(rec.fast_path_result.vetoed, "phrase reader's reading was not trusted");
    const ordered = w.tanks.filter((t) => t.goal.source === "player").map((t) => t.id);
    assert.deepEqual(ordered, ["blue-6"]);
    const g6 = tank(w, "blue-6").goal;
    const red5 = tank(w, "red-5");
    const cmd = tank(w, "blue-1");
    const heading = Math.atan2(red5.y - cmd.y, red5.x - cmd.x);
    const p6 = { x: g6.params!.x!, y: g6.params!.y! };
    assert.ok(lateralOffset(heading, red5, p6) < -40, "on the left of #5 as the player sees it");
    const d6 = Math.hypot(p6.x - red5.x, p6.y - red5.y);
    const range = gunRange(tank(w, "blue-6"), w);
    assert.ok(d6 > range * 0.6 && d6 <= range, `at gun range (${Math.round(d6)} of ${range})`);

    // 3 and 4 surround 6 → opposite sides of enemy #6, at gun range.
    w = stagedWorld();
    rec = await run(w, phrases[7]);
    expectNeedle(rec);
    const red6 = tank(w, "red-6");
    const pts = ["blue-3", "blue-4"].map((id) => {
      const g = tank(w, id).goal;
      assert.equal(g.kind, "moveTo");
      return { x: g.params!.x!, y: g.params!.y! };
    });
    const a0 = Math.atan2(pts[0]!.y - red6.y, pts[0]!.x - red6.x);
    const a1 = Math.atan2(pts[1]!.y - red6.y, pts[1]!.x - red6.x);
    let spread = Math.abs(a0 - a1);
    if (spread > Math.PI) spread = 2 * Math.PI - spread;
    assert.ok(spread > Math.PI * 0.85, `opposite sides (${Math.round((spread * 180) / Math.PI)}°)`);
    for (const p of pts) {
      const d = Math.hypot(p.x - red6.x, p.y - red6.y);
      assert.ok(d > range * 0.6 && d <= range, `at gun range (${Math.round(d)})`);
    }
  });
}

await check("Needle path: command → goal under 50ms", () => {
  assert.ok(needleRecords.length >= 4, `${needleRecords.length} Needle records`);
  const worst = Math.max(...needleRecords.map((r) => r.command_to_goal_ms ?? Infinity));
  console.log(`        worst command→goal on the Needle path: ${worst}ms`);
  assert.ok(worst < 50, `${worst}ms`);
});

console.log("Junk, gates, and safe fall-through");
for (const enabled of [false, true]) {
  await check(`flag ${enabled ? "on" : "off"}: side chatter is silent, partial intent says again, neither retasks`, async () => {
    setNeedleSidecarEnabled(enabled);
    const engine = oracleEngine();
    setNeedleEngine(engine);
    for (const text of new Set([...JUNK, ...PARTIAL_INTENT])) {
      const w = stagedWorld();
      const before = structuredClone(w.tanks);
      const beforeChat = structuredClone(w.chat);
      const beforeRecords = [...commandLog()];
      const beforeCalls = engine.calls.length;
      await sendOrder(w, text, {});
      assert.deepEqual(w.tanks, before, `goals and stacks unchanged for ${JSON.stringify(text)}`);
      if (PARTIAL_INTENT.includes(text)) {
        const rec = lastRecord();
        assert.notEqual(rec, beforeRecords.at(-1));
        assert.equal(rec.raw_text, text);
        assert.equal(rec.which_path_executed, "none");
        assert.deepEqual(rec.goals, []);
        assert.equal(rec.llm_result.attempted, false);
        if (enabled) assert.equal(rec.needle_result?.status, "no_command");
        else assert.equal(rec.needle_result, null);
        assert.deepEqual(w.chat.slice(beforeChat.length).map((c) => c.text),
          ["Company: standby", "Company: say again"]);
      } else {
        assert.deepEqual(commandLog(), beforeRecords, `no record for side chatter ${JSON.stringify(text)}`);
        assert.deepEqual(w.chat, beforeChat, `no chat for side chatter ${JSON.stringify(text)}`);
        assert.equal(engine.calls.length, beforeCalls, "chatter never reaches Needle");
      }
    }
  });
}

await check("below threshold, unsettled deterministic parse → say again, no legacy guess", async () => {
  setNeedleSidecarEnabled(true);
  setNeedleEngine(oracleEngine());
  // Lead with the addressee so this partial intent crosses radio admission.
  const text = "3 maybe go over there";
  const w = stagedWorld();
  const before = structuredClone(w.tanks);
  await sendOrder(w, text);
  const rec = lastRecord();
  assert.equal(rec.raw_text, text);
  assert.equal(rec.fast_path_result.settled, false);
  assert.equal(rec.needle_result?.status, "low_confidence");
  assert.equal(rec.needle_result?.confidence, 0.41);
  assert.equal(rec.which_path_executed, "none");
  assert.deepEqual(rec.goals, []);
  assert.deepEqual(w.tanks, before, "no silent best-effort attack or other goal change");
  assert.equal(w.chat.at(-1)?.text, "Company: say again");
});

await check("a tank the speaker never named rejects the whole reading", async () => {
  setNeedleSidecarEnabled(true);
  setNeedleEngine(oracleEngine());
  const w = stagedWorld();
  await sendOrder(w, "2 please take out 3");
  const rec = lastRecord();
  assert.equal(rec.needle_result?.status, "ungrounded");
  assert.match(rec.needle_result?.reason ?? "", /#5 was not spoken/);
  assert.notEqual(tank(w, "blue-5").goal.commandSource, "needle");
});

await check("two calls with the same target become one call with both ids", () => {
  const w = stagedWorld();
  const v = judge(
    raw(
      [
        call("attack", { tank_ids: [4], target_id: 2 }),
        call("attack", { tank_ids: [6], target_id: 2 }),
      ],
      0.9,
    ),
    "4 and 6 attack 2",
    w,
    "blue",
    1,
  );
  assert.equal(v.status, "accepted");
  assert.deepEqual(v.intents, [{ tool: "attack", tank_ids: [4, 6], target_id: 2 }]);
});

await check("an attacker that is also the target is rejected (1 and 3 attack 5 → [1,3,5])", () => {
  const w = stagedWorld();
  const v = judge(
    raw([call("attack", { tank_ids: [1, 3, 5], target_id: 5 })], 0.9),
    "1 and 3 attack 5",
    w,
    "blue",
    1,
  );
  assert.equal(v.status, "ungrounded");
});

await check("off-schema and null-confidence answers never execute", () => {
  const w = stagedWorld();
  assert.equal(
    judge(raw([call("attack", { tank_ids: [9], target_id: 2 })], 0.99), "9 attack 2", w, "blue", 1)
      .status,
    "invalid",
  );
  assert.equal(
    judge(raw([call("cover", { tank_ids: [2], protect: "player" })], null), "2 cover me", w, "blue", 1)
      .status,
    "low_confidence",
  );
});

await check("marker missing → understood, nothing executed, notice shown", async () => {
  setNeedleSidecarEnabled(true);
  setNeedleEngine(oracleEngine());
  const w = stagedWorld();
  w.playerMarks.blue = null;
  await sendOrder(w, "3 move to the marked spot");
  const rec = lastRecord();
  assert.equal(rec.which_path_executed, "none");
  assert.match(rec.notice ?? "", /No map mark/);
  assert.notEqual(tank(w, "blue-3").goal.source, "player");
});

await check("slow Needle → timeout and say again; late answer is logged but never executed", async () => {
  setNeedleSidecarEnabled(true);
  const slow = oracleEngine(CONFIG.needle.timeoutMs + 80);
  setNeedleEngine(slow);
  const w = stagedWorld();
  const before = structuredClone(w.tanks);
  await sendOrder(w, "3 and 4 surround 6");
  const rec = lastRecord();
  assert.equal(rec.needle_result?.status, "timeout");
  assert.equal(rec.which_path_executed, "none");
  assert.deepEqual(w.tanks, before, "timeout never executes an unsettled guess");
  assert.equal(w.chat.at(-1)?.text, "Company: say again");

  await sendOrder(w, "2 please take out 5");
  assert.equal(lastRecord().raw_text, "2 please take out 5");
  assert.equal(lastRecord().needle_result?.status, "busy", "one sentence at a time");
  assert.equal(lastRecord().which_path_executed, "none");
  assert.deepEqual(w.tanks, before, "busy fallback never guesses an attack");

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(rec.needle_result?.late, true);
  assert.equal(rec.needle_result?.status, "accepted");
  assert.equal(rec.which_path_executed, "none");
  assert.deepEqual(w.tanks, before, "late answers never execute on any tank");
});

await check("engine not loaded → not_ready and say again without an unsettled guess", async () => {
  setNeedleSidecarEnabled(true);
  setNeedleEngine(null);
  const w = stagedWorld();
  const before = structuredClone(w.tanks);
  await sendOrder(w, "3 and 4 surround 6");
  assert.equal(lastRecord().needle_result?.status, "not_ready");
  assert.equal(lastRecord().which_path_executed, "none");
  assert.deepEqual(w.tanks, before);
  assert.equal(w.chat.at(-1)?.text, "Company: say again");
});

await check("formation slots on the real map are never inside a wall", async () => {
  setNeedleSidecarEnabled(true);
  setNeedleEngine(oracleEngine());
  for (const text of ["3 and 4 surround 6", "6 take the left of 5, i'll take the right"]) {
    const w = stagedWorld("tdm", false);
    await sendOrder(w, text);
    for (const t of w.tanks.filter((x) => x.goal.source === "player")) {
      const { x, y } = t.goal.params ?? {};
      assert.ok(x != null && y != null);
      assert.equal(circleHitsWall(x!, y!, CONFIG.tankRadius, w.walls), false, `${t.id} @${x},${y}`);
    }
  }
});

await check("every record carries what the comparison needs", () => {
  const keys = [
    "raw_text",
    "fast_path_result",
    "needle_result",
    "llm_result",
    "which_path_executed",
    "latency_ms",
    "command_to_goal_ms",
    "goals",
  ];
  for (const rec of commandLog()) {
    for (const k of keys) assert.ok(k in rec, `${k} missing`);
  }
});

if (REAL) {
  console.log("\nReal Needle (cactus-needle, local WASM)");
  const { Needle, downloadModel, tool } = await import("cactus-needle");
  const { NEEDLE_SYSTEM, needleToolOptions } = await import("../src/needle-sidecar.ts");
  const opts = needleToolOptions();
  const t0 = performance.now();
  const needle = new Needle({
    tools: {
      attack: tool(opts.attack),
      cover: tool(opts.cover),
      move_to: tool(opts.move_to),
      flank: tool(opts.flank),
      surround: tool(opts.surround),
    },
    stateless: true,
    system: NEEDLE_SYSTEM,
    maxOutputTokens: 128,
    modelPath: await downloadModel(),
  });
  try {
    await needle.complete("1 attack 2");
    console.log(`  model ready in ${Math.round(performance.now() - t0)}ms`);
    const engine: NeedleEngine = {
      complete: async (text) => (await needle.complete(text)) as NeedleRawResult,
    };
    const rows: Record<string, unknown>[] = [];
    let accepted = 0;
    for (const text of [...TEST_PHRASES, ...SPOKEN_VARIANTS, ...JUNK.filter((j) => j.trim())]) {
      const w = stagedWorld();
      const s = performance.now();
      const normalized = normalizeSpokenNumbers(text.trim());
      const v = judge(await engine.complete(normalized), normalized, w, "blue", 0);
      const ms = Math.round(performance.now() - s);
      if (v.status === "accepted") accepted++;
      rows.push({
        text: text.length > 44 ? `${text.slice(0, 41)}...` : text,
        status: v.status,
        confidence: v.confidence,
        ms,
        reading: (v.intents.length ? v.intents : v.calls.length ? v.calls : v.suppressed)
          .map((c) => JSON.stringify(c))
          .join(" ")
          .slice(0, 90),
      });
    }
    console.table(rows);
    await check("real Needle never crashes and never executes junk", () => {
      assert.ok(rows.every((r) => !(JUNK.includes(String(r.text)) && r.status === "accepted")));
    });
    console.log(`  real Needle readings accepted at ≥${CONFIG.needle.threshold}: ${accepted}/${rows.length}`);

    setNeedleSidecarEnabled(true);
    setNeedleEngine(engine);
    const w = stagedWorld();
    await sendOrder(w, "2 cover me");
    const rec = lastRecord();
    console.log(
      `  in the game loop (timeout ${CONFIG.needle.timeoutMs}ms): needle ${rec.needle_result?.status}, executed by ${rec.which_path_executed}, command→goal ${rec.command_to_goal_ms}ms`,
    );
    await new Promise((r) => setTimeout(r, 15000));
    console.log(
      `  late answer: ${rec.needle_result?.status} conf ${rec.needle_result?.confidence} after ${rec.needle_result?.ms}ms`,
    );
  } finally {
    await needle.close();
    setNeedleEngine(null);
  }
}

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
