import assert from "node:assert/strict";
import { circleHitsWall } from "../src/arena";
import { commandLog } from "../src/command-pipeline";
import { CONFIG, homeTerritoryBounds, type GameMode } from "../src/config";
import { canSeeTank } from "../src/fog";
import { createWorld, sendOrder, startMatch, stepWorld } from "../src/game";
import { restoreGoal, stackFor, type OrderEvent } from "../src/interrupt-stack";
import { needleSidecarEnabled, setNeedleSidecarEnabled } from "../src/needle-sidecar";
import { beginUtterance, createRadioGate, failRadio, normalizeRadioText } from "../src/radio";
import type { Goal, Tank, WorldState } from "../src/types";

// Deliberately separate from eval-replay's absolute fetch prohibition. The only
// permitted fetch here is a locally resolved deferred response in the latency test.
const DT = 1 / 60;
const input = { keys: [], mouseX: 0, mouseY: 0, shooting: false };
let clock = 0;
let passed = 0;
let failed = 0;
let utterances = 0;
let appliedUtterances = 0;
let completedScripts = 0;
let silentDeviations = 0;
let retargets = 0;
let forbiddenFetches = 0;
let forbiddenRandoms = 0;
const originalFetch = globalThis.fetch;
const originalRandom = Math.random;
const originalDebug = console.debug;
const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
const originalSidecar = needleSidecarEnabled();
const forbidFetch: typeof fetch = async () => {
  forbiddenFetches++;
  throw new Error("Unexpected network/model call in offline radio acceptance");
};

async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  try {
    await test();
    passed++;
    if (name.startsWith("script")) completedScripts++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}`, error);
  }
}
function actor(world: WorldState): Tank {
  return world.tanks.find((tank) => tank.id === "blue-2")!;
}
function prey(world: WorldState): Tank {
  return world.tanks.find((tank) => tank.id === "red-2")!;
}
function fixture(mode: GameMode = "mp-offline"): WorldState {
  const world = createWorld("clear", mode, "normal", 1234, "off", "dense");
  world.walls = world.walls.filter((wall) => wall.kind === "border");
  world.controlledId = "blue-1";
  world.remoteControlledId = "red-2";
  const positions: Record<string, [number, number]> = {
    "blue-1": [120, 720], "blue-2": [300, 400], "blue-3": [180, 650],
    "red-2": [385, 400], "red-6": [1160, 100],
  };
  for (const tank of world.tanks) {
    tank.alive = tank.id in positions;
    if (!tank.alive) continue;
    [tank.x, tank.y] = positions[tank.id];
    tank.role = "shooter";
    tank.lastKnownPos = { x: tank.x, y: tank.y };
    tank.angle = 0;
    restoreGoal(tank, { kind: "holdPosition", source: "system", noRetreat: true,
      params: { x: tank.x, y: tank.y } });
    if (tank.team === "red") {
      tank.hp = tank.maxHp = 100000;
      tank.cooldown = 10000;
    }
  }
  startMatch(world);
  world.chat = [];
  world.events = [];
  world.orderEvents = [];
  return world;
}
function auditEvents(world: WorldState, from: number): void {
  for (const event of world.orderEvents!.slice(from)) {
    const explained = !!event.reason?.trim() && !!event.caption?.trim();
    if (!explained) silentDeviations++;
    assert.ok(explained, `${event.tankId} ${event.type} lacks a reason/caption`);
    if (event.type !== "applied") {
      const spoken = world.chat.some((line) => line.t === event.t && line.text === event.caption &&
        line.team === world.tanks.find((t) => t.id === event.tankId)!.team);
      if (!spoken) silentDeviations++;
      assert.ok(spoken, `silent ${event.type}/${event.reason}: ${event.caption}`);
    }
  }
}
function step(world: WorldState, count = 1): void {
  for (let i = 0; i < count; i++) {
    assert.equal(world.outcome, "playing", "script tried stepping a terminal world");
    const tank = actor(world);
    const previous = {
      goal: JSON.stringify(tank.goal), base: JSON.stringify(stackFor(tank).base),
      prey: stackFor(tank).preyId, command: stackFor(tank).base.commandId,
      shot: tank.lastShotAt,
    };
    const from = world.orderEvents!.length;
    // The target is controlled with empty input so AI motion cannot change the
    // test's visibility/threat fixture. The addressed ally uses the live brain.
    stepWorld(world, DT, input, input);
    const events = world.orderEvents!.slice(from).filter((event) => event.tankId === tank.id);
    const stack = stackFor(tank);
    if (previous.prey && previous.command === stack.base.commandId && stack.preyId !== previous.prey) {
      retargets++;
      assert.fail(`uncommanded retarget ${previous.prey} -> ${stack.preyId}`);
    }
    if (previous.goal !== JSON.stringify(tank.goal) || previous.base !== JSON.stringify(stack.base)) {
      const explained = events.some((e) => ["success", "expired", "interrupted", "resumed"].includes(e.type));
      if (!explained) silentDeviations++;
      assert.ok(explained, `silent effective/base goal change: ${previous.goal} -> ${JSON.stringify(tank.goal)}`);
    }
    if (tank.lastShotAt !== previous.shot && !["attackNearest", "attackBase"].includes(tank.goal.kind)) {
      const explained = stack.deviations.includes("los_shot_on_path") ||
        events.some((event) => event.reason === "los_shot_on_path");
      if (!explained) silentDeviations++;
      assert.ok(explained, "off-order shot lacked a deviation reason");
    }
    auditEvents(world, from);
    for (const living of world.tanks.filter((t) => t.alive)) {
      assert.ok(Number.isFinite(living.x) && Number.isFinite(living.y));
      assert.ok(living.hp > 0 && living.hp <= living.maxHp);
      assert.ok(living.cooldown >= 0);
      assert.ok(!circleHitsWall(living.x, living.y, CONFIG.tankRadius, world.walls), `${living.id} entered a wall`);
    }
    clock += DT * 1000;
  }
}
async function say(world: WorldState, text: string, expected: Goal["kind"]): Promise<void> {
  const from = world.orderEvents!.length;
  utterances++;
  clock += 2000;
  const chatStart = world.chat.length;
  const pending = sendOrder(world, text, {}, "blue", undefined, { segmentId: `acceptance:${utterances}` });
  assert.equal(world.chat[chatStart]?.text, "Company: standby", "offline intake did not acknowledge synchronously");
  await pending;
  auditEvents(world, from);
  const applied = world.orderEvents!.slice(from).filter((e) => e.type === "applied");
  assert.deepEqual(applied.map((e) => e.tankId), ["blue-2"],
    `${text}: wrong addressees or no applied order (${commandLog().at(-1)?.notice ?? "no parser notice"})`);
  assert.equal(stackFor(actor(world)).base.kind, expected, `${text}: unexpected parser result`);
  assert.equal(stackFor(actor(world)).base.commandSource, "phrase_reader");
  assert.equal(commandLog().at(-1)?.which_path_executed, "phrase_reader");
  assert.equal(commandLog().at(-1)?.llm_result.attempted, false);
  appliedUtterances++;
}
function event(world: WorldState, type: OrderEvent["type"], reason: OrderEvent["reason"]): OrderEvent {
  const matching = world.orderEvents!.filter((e) => e.tankId === "blue-2" && e.type === type && e.reason === reason);
  assert.ok(matching.length, `missing ${type}/${reason}`);
  return matching.at(-1)!;
}
function farThreat(world: WorldState): void {
  prey(world).x = 1100;
  prey(world).y = 100;
}
function atGoal(world: WorldState): void {
  const tank = actor(world);
  const point = stackFor(tank).base.params!;
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  tank.x = point.x!;
  tank.y = point.y!;
  tank.lastKnownPos = { x: tank.x, y: tank.y };
}
function assertHolding(world: WorldState): void {
  assert.equal(actor(world).goal.kind, "holdPosition");
  assert.equal(stackFor(actor(world)).base.kind, "holdPosition");
  assert.equal(stackFor(actor(world)).interrupt, null);
}
function injury(world: WorldState): void {
  const tank = actor(world);
  world.projectiles.push({ id: `injury-${world.time}`, team: "red", ownerId: "red-2", x: tank.x, y: tank.y,
    vx: 0, vy: 0, damage: tank.maxHp * 0.8, life: 1, fromShooter: true });
}
function isolate(world: WorldState): void {
  world.shareMode = "report";
  world.walls.push({ x: 0, y: 320, w: CONFIG.canvasWidth, h: 16, kind: "steel" });
  prey(world).x = 1000;
  prey(world).y = 180;
  for (const friend of world.tanks.filter((t) => t.team === "blue" && t.alive)) {
    assert.equal(canSeeTank(friend, prey(world), world.walls), false, `${friend.id} still sees hidden prey`);
  }
}

Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
Math.random = () => { forbiddenRandoms++; throw new Error("Unseeded randomness in radio acceptance"); };
globalThis.fetch = forbidFetch;
console.debug = () => {};
setNeedleSidecarEnabled(false);
try {
  await check("script 01: healthy attack executes without interrupt", async () => {
    const world = fixture();
    await say(world, "2 attack 2", "attackNearest");
    step(world, 60);
    assert.equal(stackFor(actor(world)).preyId, "red-2");
    assert.equal(stackFor(actor(world)).interrupt, null);
    assert.equal(actor(world).hp, actor(world).maxHp);
    assert.ok(actor(world).lastShotAt > 0);
    assert.ok(prey(world).hp < prey(world).maxHp);
  });
  await check("script 02: HP damage interrupts and resumes the same attack", async () => {
    const world = fixture();
    await say(world, "2 engage 2", "attackNearest");
    const base = structuredClone(stackFor(actor(world)).base);
    injury(world);
    step(world, 2);
    event(world, "interrupted", "hp_retreat");
    assert.deepEqual(stackFor(actor(world)).base, base);
    actor(world).hp = actor(world).maxHp;
    farThreat(world);
    step(world, 75);
    event(world, "resumed", "hp_retreat");
    assert.deepEqual(actor(world).goal, base);
  });
  await check("script 03: killed prey completes into hold, never retargets", async () => {
    const world = fixture();
    await say(world, "2 attack enemy 2", "attackNearest");
    step(world);
    prey(world).alive = false;
    prey(world).hp = 0;
    step(world, 60);
    assertHolding(world);
    assert.equal(stackFor(actor(world)).preyId, "red-2");
    event(world, "success", "prey_dead_hold");
  });
  await check("scripts 04-05: new move replaces suspended attack without clearing retreat", async () => {
    const world = fixture();
    await say(world, "2 attack 2", "attackNearest");
    injury(world);
    step(world, 2);
    const until = stackFor(actor(world)).interrupt!.until;
    await say(world, "2 move east", "moveTo");
    assert.equal(actor(world).goal.kind, "retreat");
    assert.equal(stackFor(actor(world)).interrupt?.until, until);
    event(world, "replaced", "order_replaced");
    const replacement = structuredClone(stackFor(actor(world)).base);
    actor(world).hp = actor(world).maxHp;
    farThreat(world);
    step(world, 75);
    event(world, "resumed", "hp_retreat");
    assert.deepEqual(stackFor(actor(world)).base, replacement);
  });
  await check("script 06: close panic supersedes HP retreat", async () => {
    const world = fixture();
    await say(world, "2 attack 2", "attackNearest");
    injury(world);
    step(world, 2);
    assert.equal(stackFor(actor(world)).interrupt?.reason, "hp_retreat");
    prey(world).x = actor(world).x + 50;
    prey(world).y = actor(world).y;
    step(world);
    event(world, "interrupted", "panic_melee");
    assert.equal(stackFor(actor(world)).interrupt?.reason, "panic_melee");
    assert.equal(stackFor(actor(world)).base.kind, "attackNearest");
  });
  await check("script 07: multi-prey order pins its first prey even when another becomes nearer", async () => {
    const world = fixture();
    await say(world, "2 attack 2 and 6", "attackNearest");
    step(world);
    const other = world.tanks.find((t) => t.id === "red-6")!;
    prey(world).x = 600;
    other.x = 390;
    other.y = 400;
    step(world, 10);
    assert.equal(stackFor(actor(world)).preyId, "red-2");
    prey(world).alive = false;
    prey(world).hp = 0;
    step(world, 20);
    assertHolding(world);
    assert.equal(stackFor(actor(world)).preyId, "red-2");
    event(world, "success", "prey_dead_hold");
  });
  await check("script 08: an ordered move still receives the HP interrupt", async () => {
    const world = fixture();
    await say(world, "2 move north", "moveTo");
    injury(world);
    step(world, 2);
    event(world, "interrupted", "hp_retreat");
    assert.equal(actor(world).goal.kind, "retreat");
    assert.equal(stackFor(actor(world)).base.kind, "moveTo");
  });
  await check("script 09: hold's defensive fire is an explained deviation", async () => {
    const world = fixture();
    await say(world, "2 hold", "holdPosition");
    step(world, 15);
    assertHolding(world);
    assert.ok(actor(world).lastShotAt > 0);
    event(world, "deviation", "los_shot_on_path");
  });
  await check("script 10: move completion speaks", async () => {
    const world = fixture();
    farThreat(world);
    world.playerMarks!.blue = { x: 500, y: 600 };
    await say(world, "2 move to mark", "moveTo");
    atGoal(world);
    step(world, 2);
    assertHolding(world);
    event(world, "success", "order_complete");
  });
  await check("script 11: spread completion speaks", async () => {
    const world = fixture();
    farThreat(world);
    await say(world, "2 spread out", "spreadOut");
    atGoal(world);
    step(world, 2);
    assertHolding(world);
    event(world, "success", "order_complete");
  });
  await check("script 12: explicit retreat arrival speaks", async () => {
    const world = fixture();
    farThreat(world);
    const home = homeTerritoryBounds("blue");
    actor(world).x = CONFIG.canvasWidth * (0.15 + (actor(world).number % 5) * 0.15);
    actor(world).y = (home.y0 + home.y1) / 2;
    await say(world, "2 retreat", "retreat");
    step(world, 2);
    assertHolding(world);
    event(world, "success", "order_complete");
  });
  await check("script 13: lost escort expires audibly", async () => {
    const world = fixture();
    farThreat(world);
    await say(world, "2 cover 3", "escort");
    const buddy = world.tanks.find((t) => t.id === "blue-3")!;
    buddy.hp = 0;
    buddy.alive = false;
    step(world, 2);
    assertHolding(world);
    event(world, "expired", "escort_lost");
  });
  await check("script 14: unsupported MP debug expires audibly", async () => {
    const world = fixture();
    await say(world, "2 debug", "debug");
    assert.ok(world.chat.some((line) => line.text.includes("negative, order unsupported")));
    assert.equal(world.chat.some((line) => line.text.includes("copy")), false);
    step(world, 2);
    assertHolding(world);
    event(world, "expired", "order_unsupported");
  });
  await check("script 15: unsupported MP scout expires audibly", async () => {
    const world = fixture();
    await say(world, "2 scout", "scout");
    step(world, 2);
    assertHolding(world);
    event(world, "expired", "order_unsupported");
  });
  await check("script 16: TDM report completion speaks", async () => {
    const world = fixture("tdm");
    farThreat(world);
    await say(world, "2 report in", "reportIn");
    step(world, Math.ceil((CONFIG.reportInSeconds + 0.2) / DT));
    assertHolding(world);
    event(world, "success", "order_complete");
  });
  await check("script 17: TDM wreck inspection completion speaks", async () => {
    const world = fixture("tdm");
    farThreat(world);
    world.wrecks.push({ id: "test-wreck", label: "A", team: "red", tankNumber: 4,
      x: actor(world).x, y: actor(world).y, wasCodeCarrier: false, marked: true, debugged: false, debugResult: null });
    await say(world, "2 debug wreck A", "debug");
    step(world, Math.ceil((1 / CONFIG.roles[actor(world).role].debugRate + 1) / DT));
    assert.equal(world.wrecks[0].debugged, true);
    assertHolding(world);
    event(world, "success", "order_complete");
  });
  await check("script 18: attackBase shares HP interrupt/resume and speaks on completion", async () => {
    const world = fixture("base-war");
    const base = world.bases!.red;
    base.x = 450; base.y = 380;
    await say(world, "2 attack base", "attackBase");
    const order = structuredClone(stackFor(actor(world)).base);
    step(world, 15);
    assert.ok(actor(world).lastShotAt > 0, "healthy base attack did not fire");
    injury(world);
    step(world, 2);
    event(world, "interrupted", "hp_retreat");
    assert.deepEqual(stackFor(actor(world)).base, order);
    actor(world).hp = actor(world).maxHp;
    farThreat(world);
    step(world, 75);
    event(world, "resumed", "hp_retreat");
    assert.deepEqual(stackFor(actor(world)).base, order);
    base.alive = false;
    base.hp = 0;
    step(world);
    assertHolding(world);
    event(world, "success", "order_complete");
  });
  await check("script 19: tank death closes its outstanding order audibly", async () => {
    const world = fixture();
    await say(world, "2 hold position", "holdPosition");
    world.projectiles.push({ id: "lethal", team: "red", ownerId: "red-2", x: actor(world).x, y: actor(world).y,
      vx: 0, vy: 0, damage: actor(world).maxHp, life: 1, fromShooter: true });
    step(world);
    assert.equal(actor(world).alive, false);
    event(world, "expired", "tank_destroyed");
  });
  await check("script 20: interrupted attack expires on fog belief TTL, never retargets", async () => {
    const world = fixture("tdm");
    await say(world, "2 attack 2", "attackNearest");
    injury(world);
    step(world, 2);
    event(world, "interrupted", "hp_retreat");
    assert.ok(stackFor(actor(world)).lastContact);
    isolate(world);
    world.teamBelief.contacts.forEach((contact) => { contact.seenAt = world.time - CONFIG.ai.beliefTtlSec - DT; });
    step(world, 100);
    assertHolding(world);
    assert.equal(stackFor(actor(world)).preyId, "red-2");
    event(world, "expired", "prey_lost");
    assert.equal(world.orderEvents!.some((e) => e.tankId === "blue-2" && e.type === "resumed"), false);
  });
  await check("20 scripted utterances: zero silent deviations and zero retargets", () => {
    assert.equal(utterances, 20);
    assert.equal(appliedUtterances, 20, "not all scripted utterances reached the executor");
    assert.equal(completedScripts, 19, "not all script invariants completed (04-05 share one scenario)");
    assert.equal(silentDeviations, 0);
    assert.equal(retargets, 0);
  });

  await check("lifecycle records remain world-local after a serialized human-order checkpoint", async () => {
    const world = fixture();
    await sendOrder(world, "2 attack 2");
    const record = world.humanCommands!.at(-1)!;
    const before = structuredClone(record);
    const fork: WorldState = JSON.parse(JSON.stringify(world));
    prey(fork).alive = false;
    prey(fork).hp = 0;
    step(fork);
    assert.ok(fork.humanCommands!.at(-1)!.orderEvents!.some((e) => e.reason === "prey_dead_hold"));
    assert.deepEqual(record, before, "fork lifecycle mutated the original published command");
    assert.equal(stackFor(actor(world)).base.kind, "attackNearest");
    prey(world).alive = false;
    prey(world).hp = 0;
    step(world);
    assert.ok(record.orderEvents!.some((e) => e.reason === "prey_dead_hold"));
  });
  await check("shared copies coalesce and rate-limit while replacements always speak", async () => {
    const world = fixture();
    farThreat(world);
    await sendOrder(world, "2 and 3 hold");
    const copies = () => world.chat.filter((line) => line.text.includes("copy"));
    assert.equal(copies().length, 1);
    assert.match(copies()[0].text, /Company: #2 copy, holding; #3 copy, holding/);
    world.time = 0.5;
    await sendOrder(world, "2 and 3 hold position");
    assert.equal(copies().length, 1, "routine copy bypassed the two-second limit");
    assert.equal(world.orderEvents!.filter((e) => e.type === "replaced").length, 2);
    auditEvents(world, 0);
    world.time = 2.1;
    await sendOrder(world, "2 and 3 wait");
    assert.equal(copies().length, 2);
  });
  await check("injectable radio gate handles the exact 1.5s boundary, segments, teams and failure reset", () => {
    const world = fixture();
    let now = 0;
    const gate = createRadioGate(() => now);
    assert.equal(normalizeRadioText("Two, HOLD!"), normalizeRadioText("2 hold"));
    assert.equal(gate.beginUtterance(world, "Two, HOLD!", "blue", "voice:1"), true);
    now = 1499;
    assert.equal(gate.beginUtterance(world, "2 hold", "blue", "voice:2"), false);
    now = 1500;
    assert.equal(gate.beginUtterance(world, "2 hold", "blue", "voice:3"), true);
    now = 5000;
    assert.equal(gate.beginUtterance(world, "2 hold", "blue", "voice:2"), false, "text-duplicate segment was not remembered");
    assert.equal(gate.beginUtterance(world, "2 hold", "red", "voice:1"), true);
    gate.failRadio(world, "blue");
    assert.equal(world.chat.at(-1)?.text, "Company: say again");
    assert.equal(gate.beginUtterance(world, "2 hold", "blue", "voice:1"), true);
    assert.equal(gate.beginUtterance(world, "2 hold", "red", "voice:1"), false, "blue failure cleared red dedupe");
  });
  await check("actual sendOrder normalizes STT duplicates and executes one order per segment", async () => {
    const world = fixture();
    clock = 10000;
    const startRecords = commandLog().length;
    await sendOrder(world, "Two, ATTACK TWO!", {}, "blue", undefined, { segmentId: "stt:1" });
    assert.equal(world.orderEvents!.filter((e) => e.type === "applied").length, 1);
    const base = structuredClone(stackFor(actor(world)).base);
    const chats = structuredClone(world.chat);
    clock += 1499;
    await sendOrder(world, "2 attack 2", {}, "blue", undefined, { segmentId: "stt:2" });
    assert.deepEqual(stackFor(actor(world)).base, base);
    assert.deepEqual(world.chat, chats);
    assert.equal(commandLog().length, startRecords + 1);
    clock++;
    await sendOrder(world, "2 attack 2", {}, "blue", undefined, { segmentId: "stt:3" });
    assert.notEqual(stackFor(actor(world)).base.commandId, base.commandId);
    clock += 5000;
    await sendOrder(world, "2 move east", {}, "blue", undefined, { segmentId: "stt:1" });
    await sendOrder(world, "2 attack 2", {}, "blue", undefined, { segmentId: "stt:2" });
    assert.equal(world.orderEvents!.filter((e) => e.type === "applied").length, 2);
    assert.equal(commandLog().length, startRecords + 2);
  });
  await check("same normalized text is independent for changed addressees, worlds and teams", async () => {
    const world = fixture();
    clock += 2000;
    await sendOrder(world, "all attack 2");
    const before = world.orderEvents!.filter((e) => e.type === "applied").length;
    assert.equal(before, 3);
    world.tanks.find((t) => t.id === "blue-3")!.alive = false;
    await sendOrder(world, "all attack 2");
    assert.equal(world.orderEvents!.filter((e) => e.type === "applied").length - before, 2);
    const another = fixture();
    await sendOrder(world, "2 attack 2", {}, "blue", undefined, { segmentId: "shared:1" });
    await sendOrder(another, "2 attack 2", {}, "blue", undefined, { segmentId: "shared:1" });
    await sendOrder(another, "2 attack 2", {}, "red", undefined, { segmentId: "shared:1" });
    assert.deepEqual(another.orderEvents!.filter((e) => e.type === "applied").map((e) => e.tankId), ["blue-2", "red-2"]);
    assert.ok(another.chat.some((line) => line.team === "red" && line.text === "Company: standby"));
  });
  await check("failed actual sendOrder says again, leaves goals intact and resets text/segment dedupe", async () => {
    const world = fixture();
    await sendOrder(world, "2 attack 2", {}, "blue", undefined, { segmentId: "retry:1" });
    const goals = world.tanks.map((t) => structuredClone(t.goal));
    const before = world.orderEvents!.length;
    for (let i = 0; i < 2; i++) {
      const from = world.chat.length;
      await sendOrder(world, "2 quantum banana", {}, "blue", undefined, { segmentId: "retry:bad" });
      assert.deepEqual(world.chat.slice(from).map((line) => line.text), ["Company: standby", "Company: say again"]);
      assert.deepEqual(world.tanks.map((t) => t.goal), goals);
      assert.equal(world.orderEvents!.length, before);
    }
    await sendOrder(world, "2 attack 2", {}, "blue", undefined, { segmentId: "retry:1" });
    assert.equal(world.orderEvents!.filter((e) => e.type === "applied").length, 2);
    assert.equal(beginUtterance(world, "2 attack 2", "blue", "retry:1"), false);
    failRadio(world, "blue");
    assert.equal(beginUtterance(world, "2 attack 2", "blue", "retry:1"), true);
  });
  await check("hot-mic chatter is entirely silent and never reaches any parser", async () => {
    const world = fixture();
    const before = structuredClone({ chat: world.chat, events: world.events, orders: world.orderEvents,
      goals: world.tanks.map((t) => t.goal) });
    const records = commandLog().length;
    for (const text of ["", "um yeah", "the team is doing fine", "I think we should attack later",
      "that was a nice shot", "can you hear me", "my microphone is on", "we lost two yesterday"]) {
      await sendOrder(world, text, { apiKey: "fake-never-send", provider: "openai" });
    }
    assert.deepEqual({ chat: world.chat, events: world.events, orders: world.orderEvents,
      goals: world.tanks.map((t) => t.goal) }, before);
    assert.equal(commandLog().length, records);
  });
  await check("standby is synchronous and <300ms while a fake delayed LLM fetch remains pending", async () => {
    const world = fixture();
    farThreat(world);
    const originalGoal = structuredClone(actor(world).goal);
    let resolve!: (response: Response) => void;
    const deferred = new Promise<Response>((done) => { resolve = done; });
    let calls = 0;
    let settled = false;
    let pending: Promise<void> | undefined;
    const beganAt = clock;
    globalThis.fetch = async () => {
      calls++;
      assert.equal(world.chat[0]?.text, "Company: standby", "fetch started before standby");
      assert.ok(clock - beganAt < 300);
      return deferred;
    };
    try {
      pending = sendOrder(world, "2 perform a pincer maneuver", { apiKey: "offline-test-key", provider: "openai" },
        "blue", undefined, { segmentId: "delayed:1" }).then(() => { settled = true; });
      assert.equal(world.chat[0]?.text, "Company: standby");
      assert.ok(clock - beganAt < 300);
      assert.equal(calls, 1);
      assert.equal(settled, false);
      clock += 2500;
      step(world, 10);
      assert.deepEqual(actor(world).goal, originalGoal, "pending parser assigned a speculative goal");
      await sendOrder(world, "2 perform a pincer maneuver", { apiKey: "offline-test-key", provider: "openai" },
        "blue", undefined, { segmentId: "delayed:1" });
      assert.equal(calls, 1, "duplicate pending segment launched another parser");
      assert.equal(settled, false);
      resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ orders: [
        { tankId: "blue-2", goal: "holdPosition", params: { x: 300, y: 400 }, chatLine: "Holding" },
      ] }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await pending;
      assert.equal(settled, true);
      assert.equal(world.orderEvents!.filter((e) => e.type === "applied").length, 1);
      assert.equal(stackFor(actor(world)).base.commandSource, "llm_api");
      assert.equal(world.chat.filter((line) => line.text === "Company: standby").length, 1);
      assert.ok(commandLog().at(-1)!.command_to_goal_ms! >= 2500);
    } finally {
      // Resolve on assertion failure too, so no real-time timeout or hanging promise escapes.
      resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
      await pending;
      globalThis.fetch = forbidFetch;
    }
  });
  await check("offline acceptance made no forbidden fetch or Math.random calls", () => {
    assert.equal(forbiddenFetches, 0);
    assert.equal(forbiddenRandoms, 0);
  });
} finally {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
  console.debug = originalDebug;
  setNeedleSidecarEnabled(originalSidecar);
  if (originalNow) Object.defineProperty(performance, "now", originalNow);
  else Reflect.deleteProperty(performance, "now");
}
console.log(`\n${passed} passed, ${failed} failed; ${appliedUtterances}/${utterances} scripted utterances applied, ${completedScripts}/19 scenarios completed; ${silentDeviations} silent deviations, ${retargets} retargets`);
if (failed) process.exitCode = 1;
