import assert from "node:assert/strict";
import { circleHitsWall } from "../src/arena";
import { createBaseStates } from "../src/arena-bases";
import { CONFIG, homeTerritoryBounds } from "../src/config";
import { getRespawnRate, rawDamageFor, RESPAWN, TANK_TYPES } from "../src/config/balance";
import { createWorld, respawnQueue, startMatch } from "../src/game";
import { canSeeTank } from "../src/fog";
import { advanceHpInterrupt, assignOrder, createInterruptStack, restoreGoal, stackFor, updateInterruptStack } from "../src/interrupt-stack";
import { createRandom, nextRandom } from "../src/random";
import { captureReplaySnapshot, ReplayRunner, wallSignature, type ReplayHz, type ReplayRecording } from "../src/replay";
import type { Goal, Tank, WorldState } from "../src/types";

let passed = 0;
let failed = 0;
function check(name: string, test: () => void): void {
  try {
    test();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}`, error);
  }
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const attack: Goal = {
  kind: "attackNearest", source: "player", commandSource: "phrase_reader",
  params: { targetTankId: "red-2" },
};

function fixture(hz: ReplayHz, lowHp = false): ReplayRecording {
  const world = createWorld("clear", "mp-offline", "normal", 1234, "off");
  world.walls = world.walls.filter((wall) => wall.kind === "border");
  world.controlledId = "blue-1";
  const positions = new Map([
    ["blue-1", [120, 720]], ["blue-2", [300, 400]],
    ["red-2", [380, 400]], ["red-6", [1160, 100]],
  ]);
  for (const tank of world.tanks) {
    const position = positions.get(tank.id);
    tank.alive = !!position;
    if (!position) continue;
    [tank.x, tank.y] = position;
    tank.lastKnownPos = { x: tank.x, y: tank.y };
    tank.angle = 0;
    restoreGoal(tank, { kind: "holdPosition", source: "player", params: { x: tank.x, y: tank.y } });
    if (tank.team === "red") {
      tank.maxHp = tank.hp = 100000;
      tank.cooldown = 10000;
    }
  }
  if (lowHp) {
    const prey = world.tanks.find((t) => t.id === "blue-2")!;
    // The hp-retreat cycle this fixture feeds is a couple of reloads long, so
    // it is timed against the baseline gunner: a 260 HP heavy crawls home at
    // 78 px/s and is still out of its own gun reach when the retreat re-latches.
    // Which hull fills slot 2 is the batch runner's question, not this one.
    prey.role = "shooter";
    prey.maxHp = prey.hp = TANK_TYPES.shooter.maxHealth;
    world.projectiles.push({
      id: "injury", team: "red", ownerId: "red-2", x: 300, y: 400,
      vx: 0, vy: 0, life: 1, fromShooter: true,
      // Sized off the table: it leaves the hull in slot 2 at half the retreat
      // threshold, whatever that hull's HP and side armour happen to be.
      damage: rawDamageFor(prey.role, "side",
        prey.maxHp * (1 - CONFIG.ai.retreatHpFraction * 0.5)),
    });
  }
  startMatch(world);
  const bot = world.tanks.find((t) => t.id === "blue-2")!;
  return {
    snapshot: captureReplaySnapshot(world, hz),
    commands: [{ tick: lowHp ? 0 : 7, utterance: "2 attack 2", goals: [{ tankId: bot.id, goal: attack }] }],
    inputs: [],
  };
}

function bot(runner: ReplayRunner): Tank {
  return runner.world.tanks.find((t) => t.id === "blue-2")!;
}

/**
 * A shell placed on the victim's own hull. Damage is deliberately four times
 * the hull's HP: the armour band a stationary shell resolves to depends on
 * where the tank happens to be facing, and these checks are about the respawn
 * rules, not about which plate the round lands on.
 */
function shootHull(world: WorldState, victimId: string, ownerId: string, id: string): void {
  const victim = world.tanks.find((t) => t.id === victimId)!;
  world.projectiles.push({
    id, team: victim.team === "blue" ? "red" : "blue", ownerId,
    x: victim.x, y: victim.y, vx: 0, vy: 0,
    damage: victim.maxHp * 4, life: 1, fromShooter: true,
  });
}

/** Steps until the hull is back on the field; the loop bound is the failure case. */
function stepsUntilBack(runner: ReplayRunner, tankId: string, hz: number): number {
  let steps = 0;
  while (!runner.world.tanks.find((t) => t.id === tankId)!.alive) {
    if (steps++ > 60 * hz) throw new Error(`${tankId} never returned from the dead`);
    runner.step();
  }
  return steps;
}

function assertSpoken(world: WorldState): void {
  for (const event of world.orderEvents ?? []) {
    assert.ok(event.reason?.trim(), `${event.type} missing reason`);
    assert.ok(event.caption?.trim(), `${event.type} missing caption`);
    // Routine copies may be coalesced/debounced. Lifecycle changes may not be silent.
    if (event.type !== "applied") {
      assert.ok(world.chat.some((line) => line.t === event.t && line.text === event.caption),
        `${event.tankId} ${event.type}/${event.reason} was not spoken: ${event.caption}`);
    }
  }
}

function hidePrey(recording: ReplayRecording, x = 1000): void {
  const world = recording.snapshot.world;
  world.gameMode = "tdm";
  world.shareMode = "report";
  world.walls.push({ x: 0, y: 320, w: CONFIG.canvasWidth, h: 16, kind: "steel" });
  const prey = world.tanks.find((t) => t.id === "red-2")!;
  prey.x = x;
  prey.y = 180;
  world.teamBelief.contacts = [];
  recording.snapshot.wallSignature = wallSignature(world.walls);
  for (const friend of world.tanks.filter((t) => t.alive && t.team === "blue")) {
    assert.equal(canSeeTank(friend, prey, world.walls), false, `${friend.id} refreshed a supposedly lost prey`);
  }
}

function invariants(runner: ReplayRunner): void {
  const current = runner.events.filter((event) => event.tick === runner.tick - 1);
  for (const event of current) {
    if (["success", "interrupted", "resumed", "expired", "replaced", "deviation"].includes(event.type)) {
      assert.ok(event.reason?.trim() && event.caption?.trim(), `${event.type} lacks explanation`);
      assert.ok(runner.world.chat.some((line) => line.text === event.caption), `${event.type} did not speak`);
    }
    if (event.type === "goal_changed" && event.tankId === "blue-2") {
      assert.ok(current.some((e) => e.tankId === event.tankId && e.reason && e.caption &&
        ["success", "expired", "interrupted", "resumed"].includes(e.type)),
        `silent effective goal deviation at tick ${event.tick}`);
    }
  }
  assert.equal(runner.world.outcome, "playing", "fixture must leave both teams alive");
  assert.ok(runner.world.tanks.some((t) => t.team === "red" && t.alive));
  for (const tank of runner.world.tanks.filter((t) => t.alive)) {
    assert.ok(Number.isFinite(tank.x) && Number.isFinite(tank.y));
    assert.ok(tank.hp > 0 && tank.hp <= tank.maxHp);
    assert.ok(tank.cooldown >= 0);
    assert.ok(!circleHitsWall(tank.x, tank.y, CONFIG.tankRadius, runner.world.walls), `${tank.id} entered a wall`);
  }
}

function healthy(hz: ReplayHz): void {
  const recording = jsonCopy(fixture(hz));
  const runner = new ReplayRunner(recording);
  const others = runner.world.tanks.filter((t) => t.id !== "blue-2").map((t) => structuredClone(t.goal));
  runner.run(hz * 2, (r) => {
    invariants(r);
    assert.equal(bot(r).hp, bot(r).maxHp);
    if (r.tick > 7) assert.deepEqual(bot(r).goal, attack);
    assert.deepEqual(r.world.tanks.filter((t) => t.id !== "blue-2").map((t) => t.goal), others);
  });
  assert.equal(runner.tick, hz * 2);
  assert.ok(Math.abs(runner.world.time - 2) < 1e-10);
  assert.deepEqual(runner.events.filter((e) => e.type === "order_applied").map((e) => [e.tick, e.tankId]), [[7, "blue-2"]]);
  assert.ok(runner.events.some((e) => e.type === "shot" && e.tankId === "blue-2" && e.tick >= 7));
  assert.ok(runner.events.some((e) => e.type === "damaged" && e.tankId === "red-2" && e.tick >= 7));
  assert.equal(runner.events.filter((e) => ["interrupted", "expired", "goal_changed"].includes(e.type)).length, 0);
  assert.equal(recording.snapshot.world.time, 0, "runner mutated its recording");
}

function lowHpResumes(hz: ReplayHz): void {
  const runner = new ReplayRunner(jsonCopy(fixture(hz, true)));
  runner.run(2, invariants);
  assert.ok(bot(runner).hp / bot(runner).maxHp <= CONFIG.ai.retreatHpFraction);
  assert.equal(runner.stacks["blue-2"].interrupt?.reason, "hp_retreat");
  assert.deepEqual(runner.stacks["blue-2"].base, attack);
  const checkpoint = jsonCopy(runner.checkpoint());
  const fork = new ReplayRunner(checkpoint);
  const startEvents = runner.events.length;
  const start = { x: bot(runner).x, y: bot(runner).y };
  for (let i = 0; i < hz * 5; i++) {
    runner.run(1, invariants);
    fork.run(1, invariants);
    assert.deepEqual(runner.stacks["blue-2"].base, attack, "interrupt destroyed player provenance");
    if (runner.events.some((e) => e.type === "resumed")) break;
  }
  assert.ok(runner.events.some((e) => e.type === "resumed"), "low-HP order never resumed after clearing the threat");
  assert.ok(Math.hypot(bot(runner).x - start.x, bot(runner).y - start.y) > CONFIG.tankRadius, "retreat never moved the hull");
  assert.deepEqual(bot(runner).goal, attack);
  const resumeTick = runner.tick - 1;
  runner.run(Math.ceil(hz * 0.25), invariants);
  fork.run(Math.ceil(hz * 0.25), invariants);
  assert.deepEqual(runner.events.filter((e) => ["interrupted", "resumed", "expired"].includes(e.type)).map((e) => [e.type, e.reason]), [
    ["interrupted", "hp_retreat"], ["resumed", "hp_retreat"],
  ]);
  assert.ok(runner.events.some((e) => e.type === "shot" && e.tankId === "blue-2" && e.tick >= resumeTick), "resumed attack did not fire");
  assert.deepEqual(fork.events, runner.events.slice(startEvents));
  assert.deepEqual(jsonCopy(fork.checkpoint()), jsonCopy(runner.checkpoint()));
  assert.equal(checkpoint.snapshot.tick, 2, "continued runner mutated checkpoint");
}

const originalRandom = Math.random;
const originalFetch = globalThis.fetch;
let randomCalls = 0;
let fetchCalls = 0;
Math.random = () => { randomCalls++; throw new Error("Unseeded randomness in replay"); };
globalThis.fetch = async () => { fetchCalls++; throw new Error("Network/model call in replay"); };
try {
  check("seeded RNG continues from saved state; seeds diverge", () => {
    const a = createRandom(1234);
    const b = createRandom(1234);
    const c = createRandom(4321);
    const sequence = Array.from({ length: 100 }, () => nextRandom(a));
    assert.deepEqual(sequence, Array.from({ length: 100 }, () => nextRandom(b)));
    assert.notDeepEqual(sequence, Array.from({ length: 100 }, () => nextRandom(c)));
    const saved = jsonCopy(a);
    assert.equal(nextRandom(a), nextRandom(saved));
    assert.ok(sequence.every((value) => value >= 0 && value < 1));
  });

  for (const hz of [30, 60] as const) {
    check(`golden: attack while healthy (${hz} Hz)`, () => healthy(hz));
    check(`golden: low HP interrupt resumes (${hz} Hz, shared live stack)`, () => lowHpResumes(hz));
  }

  check("low-HP boundaries, commitment, recovery, and expiry", () => {
    const stack = createInterruptStack(attack);
    const context = { now: 0, hpFraction: 0.33, threatNearby: true, resumeValid: true, position: { x: 300, y: 400 } };
    assert.equal(advanceHpInterrupt(stack, context), null);
    assert.equal(advanceHpInterrupt(stack, { ...context, hpFraction: 0.32 })?.type, "interrupted");
    assert.equal(advanceHpInterrupt(stack, { ...context, now: 0.54, hpFraction: 0.45 }), null);
    assert.equal(advanceHpInterrupt(stack, { ...context, now: 0.55, hpFraction: 0.44 }), null);
    assert.equal(advanceHpInterrupt(stack, { ...context, now: 0.55, hpFraction: 0.45 })?.type, "resumed");
    assert.equal(advanceHpInterrupt(stack, { ...context, now: 1, hpFraction: 0.31 }), null);
    assert.equal(advanceHpInterrupt(stack, { ...context, now: 1.11, hpFraction: 0.31 })?.type, "interrupted");
    assert.equal(advanceHpInterrupt(stack, { ...context, now: 2, hpFraction: 0.45, resumeValid: false })?.type, "expired");
    assert.equal(stack.base.kind, "holdPosition");
    assert.equal(stack.interrupt, null);
  });

  check("dead or no-longer-believed prey expires after interrupt, never retargets", () => {
    for (const hidden of [false, true]) {
      const runner = new ReplayRunner(fixture(60, true));
      runner.run(2);
      const checkpoint = runner.checkpoint();
      const target = checkpoint.snapshot.world.tanks.find((t) => t.id === "red-2")!;
      if (hidden) {
        hidePrey(checkpoint);
      } else {
        target.alive = false;
        target.hp = 0;
      }
      const fork = new ReplayRunner(jsonCopy(checkpoint));
      for (let i = 0; i < 180 && !fork.events.some((e) => e.type === "expired"); i++) fork.step();
      assert.ok(fork.events.some((e) => e.type === "expired"));
      assert.equal(fork.stacks["blue-2"].base.kind, "holdPosition");
      assert.equal(bot(fork).goal.kind, "holdPosition");
      assert.equal(fork.events.some((e) => e.type === "resumed"), false);
      assert.ok(fork.events.some((e) => e.type === "expired" && e.tankId === "blue-2" &&
        e.reason === (hidden ? "prey_lost" : "prey_dead_hold")));
      assert.equal(stackFor(bot(fork)).preyId, "red-2");
      assertSpoken(fork.world);
    }
  });

  check("JSON checkpoint preserves route cursor, cooldowns, projectiles, RNG and independent worlds", () => {
    const recording = fixture(60);
    recording.snapshot.world.tanks.find((t) => t.id === "red-2")!.x = 650;
    const a = new ReplayRunner(recording);
    a.run(20);
    assert.ok(bot(a).routeCommit);
    assert.ok(bot(a).driveTrack);
    for (let i = 0; i < 240 && !a.world.projectiles.some((p) => p.ownerId === "blue-2"); i++) a.step();
    assert.ok(a.world.projectiles.some((p) => p.ownerId === "blue-2"), "checkpoint must contain an in-flight shot");
    assert.ok(bot(a).cooldown > 0);
    const splitTick = a.tick;
    const saved = jsonCopy(a.checkpoint());
    const b = new ReplayRunner(saved);
    assert.deepEqual(b.world.projectiles, a.world.projectiles);
    const unrelated = new ReplayRunner(fixture(30, true));
    for (let i = 0; i < 80; i++) {
      a.step();
      unrelated.step();
      b.step();
    }
    assert.deepEqual(jsonCopy(a.checkpoint()), jsonCopy(b.checkpoint()));
    assert.deepEqual(b.events, a.events.filter((e) => e.tick >= splitTick));
    assert.deepEqual(saved.snapshot.world.random, recording.snapshot.world.random);
    assert.ok(bot(a).cooldown > 0 || a.events.some((e) => e.type === "shot" && e.tankId === "blue-2"));
  });

  check("TDM scouting consumes only world RNG and resumes identically", () => {
    const recording = fixture(30);
    recording.commands = [];
    recording.snapshot.world.gameMode = "tdm";
    recording.snapshot.stacks = {};
    const scout = recording.snapshot.world.tanks.find((t) => t.id === "blue-2")!;
    scout.role = "scout";
    restoreGoal(scout, { kind: "scout", source: "system" });
    recording.snapshot.stacks[scout.id] = structuredClone(stackFor(scout));
    recording.snapshot.world.tanks.find((t) => t.id === "red-2")!.x = 1100;
    const a = new ReplayRunner(recording);
    a.run(1);
    assert.notEqual(a.world.random.state, recording.snapshot.world.random.state);
    const b = new ReplayRunner(jsonCopy(a.checkpoint()));
    a.run(20);
    b.run(20);
    assert.deepEqual(jsonCopy(a.checkpoint()), jsonCopy(b.checkpoint()));
  });

  for (const mode of ["mp-offline", "tdm"] as const) {
    check(`shared live stack preserves executor completion (${mode})`, () => {
      const recording = fixture(60);
      recording.snapshot.world.gameMode = mode;
      recording.commands = [{ tick: 0, utterance: "2 move here", goals: [{ tankId: "blue-2", goal: {
        kind: "moveTo", source: "player", params: { x: 300, y: 400 },
      } }] }];
      const runner = new ReplayRunner(recording);
      runner.run(10);
      assert.equal(runner.events.filter((e) => e.type === "goal_changed" && e.tankId === "blue-2").length, 1);
      assert.equal(runner.stacks["blue-2"].base.kind, "holdPosition");
      assert.strictEqual(runner.stacks["blue-2"], stackFor(bot(runner)));
      assert.equal(runner.events.filter((e) => e.type === "success" && e.tankId === "blue-2").length, 1);
      assertSpoken(runner.world);
    });
  }

  for (const mode of ["mp-offline", "tdm"] as const) {
    check(`live ordered attack remains pinned and healthy (${mode})`, () => {
      const recording = fixture(60);
      recording.snapshot.world.gameMode = mode;
      recording.commands[0].tick = 0;
      // Inside both MP and TDM gun range, but outside the melee interrupt radius.
      recording.snapshot.world.tanks.find((t) => t.id === "red-2")!.x = 385;
      const runner = new ReplayRunner(recording);
      runner.run(20, (r) => {
        invariants(r);
        assert.deepEqual(stackFor(bot(r)).base, attack);
        assert.equal(stackFor(bot(r)).preyId, "red-2");
        assert.equal(stackFor(bot(r)).interrupt, null);
        assert.equal(bot(r).hp, bot(r).maxHp);
      });
      assert.ok(runner.events.some((e) => e.type === "shot" && e.tankId === "blue-2"));
      assertSpoken(runner.world);
    });

    check(`new order during HP retreat replaces only the suspended base (${mode})`, () => {
      const recording = fixture(60, true);
      recording.snapshot.world.gameMode = mode;
      const replacement: Goal = { kind: "moveTo", source: "player", commandId: 42,
        commandSource: "phrase_reader", params: { x: 800, y: 650 } };
      recording.commands.push({ tick: 2, utterance: "2 move east", goals: [{ tankId: "blue-2", goal: replacement }] });
      const runner = new ReplayRunner(recording);
      runner.run(2);
      const stack = stackFor(bot(runner));
      const interrupt = structuredClone(stack.interrupt);
      assert.equal(interrupt?.reason, "hp_retreat");
      runner.step();
      assert.equal(stack.interrupt?.reason, "hp_retreat");
      assert.equal(stack.interrupt?.until, interrupt.until, "new order reset interrupt commitment");
      assert.equal(bot(runner).goal.kind, "retreat");
      assert.deepEqual(stack.base, replacement);
      assert.ok(runner.events.some((e) => e.type === "replaced" && e.tankId === "blue-2"));
      bot(runner).hp = bot(runner).maxHp;
      for (let i = 0; i < 120 && stack.interrupt; i++) runner.step();
      assert.equal(stack.interrupt, null);
      assert.deepEqual(bot(runner).goal, replacement);
      assert.ok(runner.events.some((e) => e.type === "resumed" && e.reason === "hp_retreat"));
      assertSpoken(runner.world);
    });

    check(`prey death holds and barks once, never selects a survivor (${mode})`, () => {
      const recording = fixture(60);
      recording.snapshot.world.gameMode = mode;
      recording.commands[0].tick = 0;
      const runner = new ReplayRunner(recording);
      runner.step();
      assert.equal(stackFor(bot(runner)).preyId, "red-2");
      const target = runner.world.tanks.find((t) => t.id === "red-2")!;
      target.hp = 0;
      target.alive = false;
      runner.run(90, (r) => {
        assert.equal(stackFor(bot(r)).preyId, "red-2");
        assert.equal(bot(r).goal.kind, "holdPosition");
        assert.equal(stackFor(bot(r)).base.kind, "holdPosition");
      });
      const endings = runner.events.filter((e) => e.tankId === "blue-2" && e.reason === "prey_dead_hold");
      assert.equal(endings.length, 1);
      assert.equal(endings[0].type, "success");
      assert.match(endings[0].caption!, /target down.*holding/i);
      assertSpoken(runner.world);
    });

    check(`panic_melee takes priority over an existing HP retreat (${mode})`, () => {
      const recording = fixture(60, true);
      recording.snapshot.world.gameMode = mode;
      const runner = new ReplayRunner(recording);
      runner.run(2);
      const tank = bot(runner);
      assert.equal(stackFor(tank).interrupt?.reason, "hp_retreat");
      const target = runner.world.tanks.find((t) => t.id === "red-2")!;
      target.x = tank.x + 50;
      target.y = tank.y;
      runner.step();
      assert.equal(stackFor(tank).interrupt?.reason, "panic_melee");
      assert.equal(stackFor(tank).hpLatched, true);
      assert.deepEqual(stackFor(tank).base, attack);
      assert.equal(tank.goal.kind, "retreat");
      assert.deepEqual(runner.events.filter((e) => e.tankId === tank.id && ["interrupted", "resumed"].includes(e.type))
        .map((e) => [e.type, e.reason]), [
        ["interrupted", "hp_retreat"], ["resumed", "hp_retreat"], ["interrupted", "panic_melee"],
      ]);
      tank.hp = tank.maxHp;
      updateInterruptStack(runner.world, tank);
      assert.equal(stackFor(tank).interrupt?.reason, "panic_melee", "healing incorrectly cleared close-threat priority");
      assertSpoken(runner.world);
    });

    check(`ordered move is not retreat-exempt; noRetreat is explicit (${mode})`, () => {
      for (const noRetreat of [false, true]) {
        const recording = fixture(60, true);
        recording.snapshot.world.gameMode = mode;
        const goal: Goal = { kind: "moveTo", source: "player", noRetreat,
          params: { x: 800, y: 650 } };
        recording.commands[0].goals[0].goal = goal;
        const runner = new ReplayRunner(recording);
        runner.run(2);
        assert.deepEqual(stackFor(bot(runner)).base, goal);
        assert.equal(stackFor(bot(runner)).interrupt?.reason ?? null, noRetreat ? null : "hp_retreat");
        assert.equal(bot(runner).goal.kind, noRetreat ? "moveTo" : "retreat");
        if (noRetreat) {
          const target = runner.world.tanks.find((t) => t.id === "red-2")!;
          target.x = bot(runner).x + 50;
          target.y = bot(runner).y;
          runner.step();
          assert.equal(stackFor(bot(runner)).interrupt, null, "explicit noRetreat failed to suppress panic");
        }
        assertSpoken(runner.world);
      }
    });
  }

  check("live HP 32/45 hysteresis honors commitment and does not flap", () => {
    const runner = new ReplayRunner(fixture(60));
    const tank = bot(runner);
    assignOrder(runner.world, tank, attack);
    const reason = () => stackFor(tank).interrupt?.reason ?? null;
    const update = (time: number, hp: number) => {
      runner.world.time = time;
      tank.hp = tank.maxHp * hp;
      updateInterruptStack(runner.world, tank);
    };
    update(0, 0.33);
    assert.equal(reason(), null);
    update(0, 0.32);
    assert.equal(reason(), "hp_retreat");
    update(0.54, 0.45);
    assert.equal(reason(), "hp_retreat", "HP recovery bypassed minimum commitment");
    for (let i = 0; i < 60; i++) {
      update(0.55 + i / 60, i % 2 ? 0.44 : 0.33);
      assert.equal(reason(), "hp_retreat");
    }
    update(1.55, 0.45);
    assert.equal(reason(), null);
    update(2.09, 0.32);
    assert.equal(reason(), null, "reentry ignored commitment cooldown");
    update(2.11, 0.32);
    assert.equal(reason(), "hp_retreat");
    assert.deepEqual(runner.world.orderEvents!.filter((e) => ["interrupted", "resumed"].includes(e.type))
      .map((e) => [e.type, e.reason]), [
      ["interrupted", "hp_retreat"], ["resumed", "hp_retreat"], ["interrupted", "hp_retreat"],
    ]);
    assertSpoken(runner.world);
  });

  check("fog expiry bark uses the team contact, not hidden live coordinates", () => {
    for (const interrupted of [false, true]) {
      const initial = fixture(60, interrupted);
      initial.commands[0].tick = 0;
      const runner = new ReplayRunner(initial);
      runner.run(2);
      const contact = structuredClone(stackFor(bot(runner)).lastContact!);
      assert.ok(contact, "fixture did not acquire a shared sighting");
      const captions: string[] = [];
      for (const hiddenX of [100, 1100]) {
        const recording = jsonCopy(runner.checkpoint());
        hidePrey(recording, hiddenX);
        // Retain an expired contact so the actual belief TTL path must remove it.
        recording.snapshot.world.teamBelief.contacts = [{ ...contact,
          seenAt: recording.snapshot.world.time - CONFIG.ai.beliefTtlSec - 1 / 60 }];
        const fork = new ReplayRunner(recording);
        let expectedDirection: string | undefined;
        fork.run(100, (r) => {
          assert.equal(stackFor(bot(r)).preyId, "red-2");
          assert.deepEqual(stackFor(bot(r)).lastContact, contact, "hidden coordinates overwrote the stored team contact");
          assert.equal(r.world.teamBelief.contacts.some((c) => c.enemyId === "red-2"), false);
          if (!expectedDirection && r.events.some((e) => e.tankId === "blue-2" && e.reason === "prey_lost")) {
            const dx = contact.x - bot(r).x, dy = contact.y - bot(r).y;
            expectedDirection = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "west" : "east") : (dy < 0 ? "north" : "south");
          }
        });
        const lost = fork.events.filter((e) => e.tankId === "blue-2" && e.type === "expired" && e.reason === "prey_lost");
        assert.equal(lost.length, 1);
        assert.ok(expectedDirection);
        assert.ok(lost[0].caption!.includes(`lost 2, last seen ${expectedDirection}; holding`));
        assert.equal(bot(fork).goal.kind, "holdPosition");
        assert.equal(stackFor(bot(fork)).interrupt, null);
        assert.equal(fork.events.some((e) => e.type === "resumed" && e.tankId === "blue-2"), false);
        captions.push(lost[0].caption!);
        assertSpoken(fork.world);
      }
      assert.equal(captions[0], captions[1], "hidden enemy movement leaked into the last-seen bark");
    }
  });

  check("attackBase uses the same HP stack and completes audibly", () => {
    const recording = fixture(60);
    recording.snapshot.world.gameMode = "base-war";
    recording.snapshot.world.bases = createBaseStates("dense");
    assert.ok(recording.snapshot.world.bases, "dense fixture must provide bases");
    const base = recording.snapshot.world.bases.red;
    base.x = 450;
    base.y = 380;
    const goal: Goal = { kind: "attackBase", source: "player", commandSource: "phrase_reader", commandId: 81 };
    recording.commands = [{ tick: 0, utterance: "2 attack base", goals: [{ tankId: "blue-2", goal }] }];
    const runner = new ReplayRunner(recording);
    runner.run(15, invariants);
    assert.ok(runner.events.some((e) => e.type === "shot" && e.tankId === "blue-2"));
    bot(runner).hp = bot(runner).maxHp * 0.3;
    runner.step();
    assert.equal(stackFor(bot(runner)).interrupt?.reason, "hp_retreat");
    assert.deepEqual(stackFor(bot(runner)).base, goal);
    const fork = new ReplayRunner(jsonCopy(runner.checkpoint()));
    bot(runner).hp = bot(runner).maxHp;
    bot(fork).hp = bot(fork).maxHp;
    runner.run(40, invariants);
    fork.run(40, invariants);
    assert.deepEqual(bot(runner).goal, goal);
    assert.ok(runner.events.some((e) => e.type === "resumed" && e.tankId === "blue-2"));
    assert.deepEqual(jsonCopy(runner.checkpoint()), jsonCopy(fork.checkpoint()));
    runner.world.bases!.red.alive = false;
    runner.world.bases!.red.hp = 0;
    runner.step();
    assert.equal(bot(runner).goal.kind, "holdPosition");
    assert.equal(runner.events.filter((e) => e.type === "success" && e.tankId === "blue-2" && e.reason === "order_complete").length, 1);
    assertSpoken(runner.world);
  });

  for (const mode of ["mp-offline", "tdm"] as const) {
    for (const kind of ["moveTo", "spreadOut", "retreat", "reportIn", "debug", "escort"] as const) {
      check(`every finite executor completion speaks: ${kind} (${mode})`, () => {
        const recording = fixture(60);
        recording.snapshot.world.gameMode = mode;
        const target = recording.snapshot.world.tanks.find((t) => t.id === "red-2")!;
        target.x = 1100;
        target.y = 100;
        const tank = recording.snapshot.world.tanks.find((t) => t.id === "blue-2")!;
        const home = homeTerritoryBounds("blue");
        if (kind === "retreat") {
          tank.x = CONFIG.canvasWidth * (0.15 + (tank.number % 5) * 0.15);
          tank.y = (home.y0 + home.y1) / 2;
          tank.lastKnownPos = { x: tank.x, y: tank.y };
        }
        if (kind === "debug" && mode === "tdm") {
          recording.snapshot.world.wrecks.push({ id: "fixture-wreck", label: "A", team: "red", tankNumber: 4,
            x: tank.x, y: tank.y, wasCodeCarrier: false, marked: true, debugged: false, debugResult: null });
        }
        const goal: Goal = { kind, source: "player", commandSource: "phrase_reader", commandId: 91,
          params: kind === "escort" ? { targetTankId: "blue-4" } : { x: tank.x, y: tank.y } };
        recording.commands = [{ tick: 0, utterance: `2 ${kind}`, goals: [{ tankId: tank.id, goal }] }];
        const runner = new ReplayRunner(recording);
        const seconds = kind === "reportIn" ? CONFIG.reportInSeconds + 0.3 :
          kind === "debug" && mode === "tdm" ? 1 / CONFIG.roles[tank.role].debugRate + 1 : 0.2;
        runner.run(Math.ceil(seconds * 60), invariants);
        const unsupported = mode === "mp-offline" && ["reportIn", "debug"].includes(kind);
        const expired = unsupported || kind === "escort";
        const endings = runner.events.filter((e) => e.tankId === tank.id && ["success", "expired"].includes(e.type));
        assert.equal(endings.length, 1, "completion was missing or repeated");
        assert.equal(endings[0].type, expired ? "expired" : "success");
        assert.equal(endings[0].reason, unsupported ? "order_unsupported" : kind === "escort" ? "escort_lost" : "order_complete");
        assert.equal(bot(runner).goal.kind, "holdPosition");
        assert.equal(stackFor(bot(runner)).base.commandId, 91, "completion lost command provenance");
        assertSpoken(runner.world);
      });
    }
  }

  check("snapshot.stacks is authoritative over per-tank serialized stacks", () => {
    const recording = fixture(60, true);
    const runner = new ReplayRunner(recording);
    runner.run(2);
    const saved = jsonCopy(runner.checkpoint());
    const tank = saved.snapshot.world.tanks.find((t) => t.id === "blue-2")!;
    restoreGoal(tank, { kind: "scout", source: "system" });
    const fork = new ReplayRunner(saved);
    assert.deepEqual(stackFor(bot(fork)), saved.snapshot.stacks["blue-2"]);
    assert.strictEqual(stackFor(bot(fork)), fork.stacks["blue-2"]);
    assert.deepEqual(stackFor(bot(fork)).base, attack);
    assert.equal(bot(fork).goal.kind, "retreat");
    runner.run(90);
    fork.run(90);
    assert.deepEqual(jsonCopy(fork.checkpoint()), jsonCopy(runner.checkpoint()));
  });

  check("different wall layouts cannot share a lossy danger-cache signature", () => {
    const a = fixture(30);
    const b = fixture(30);
    a.snapshot.world.walls.push({ x: 350, y: 350, w: 16, h: 100, kind: "steel" });
    b.snapshot.world.walls.push({ x: 363, y: 343, w: 16, h: 100, kind: "steel" });
    a.snapshot.wallSignature = wallSignature(a.snapshot.world.walls);
    b.snapshot.wallSignature = wallSignature(b.snapshot.world.walls);
    assert.notEqual(a.snapshot.wallSignature, b.snapshot.wallSignature);
    const first = new ReplayRunner(a);
    const other = new ReplayRunner(b);
    first.run(15);
    const fork = new ReplayRunner(jsonCopy(first.checkpoint()));
    for (let i = 0; i < 30; i++) {
      first.step();
      other.step();
      fork.step();
    }
    assert.deepEqual(jsonCopy(first.checkpoint()), jsonCopy(fork.checkpoint()));
  });

  check("death and wreck ID sequences survive restore and unrelated world creation", () => {
    for (const mode of ["mp-offline", "tdm"] as const) {
      const recording = fixture(60);
      recording.snapshot.stacks = {};
      recording.snapshot.world.gameMode = mode;
      recording.commands = [];
      const target = recording.snapshot.world.tanks.find((t) => t.id === "red-2")!;
      recording.snapshot.world.projectiles.push({
        id: "lethal", team: "blue", ownerId: "blue-2", x: target.x, y: target.y,
        vx: 0, vy: 0, damage: target.maxHp, life: 1, fromShooter: true,
      });
      const runner = new ReplayRunner(recording);
      runner.step();
      assert.equal(runner.world.tanks.find((t) => t.id === "red-2")!.alive, false);
      const saved = jsonCopy(runner.checkpoint());
      const survivor = saved.snapshot.world.tanks.find((t) => t.id === "red-6")!;
      saved.snapshot.world.projectiles.push({
        id: "second-lethal", team: "blue", ownerId: "blue-2", x: survivor.x, y: survivor.y,
        vx: 0, vy: 0, damage: survivor.maxHp, life: 1, fromShooter: true,
      });
      const a = new ReplayRunner(saved);
      const b = new ReplayRunner(saved);
      createWorld("clear", mode, "normal", 99);
      a.step();
      const unrelated = new ReplayRunner(recording);
      unrelated.step();
      b.step();
      assert.deepEqual(jsonCopy(a.checkpoint()), jsonCopy(b.checkpoint()));
      if (mode === "tdm") {
        assert.equal(a.world.wreckSeq, 2);
        assert.equal(a.world.nextWreckLabel, 2);
      } else {
        assert.equal(a.world.deathFxSeq, 2);
      }
    }
  });

  check("dead hull counts down, then returns whole to its own base with its type and number", () => {
    const hz = 30;
    const recording = fixture(hz);
    recording.snapshot.stacks = {};
    recording.commands = [];
    shootHull(recording.snapshot.world, "red-2", "blue-1", "kill-red-2");
    const runner = new ReplayRunner(recording);
    runner.step();
    const hull = runner.world.tanks.find((t) => t.id === "red-2")!;
    assert.equal(hull.alive, false);
    assert.equal(hull.respawnLeft, RESPAWN.delaySec, "countdown did not start at the configured delay");
    assert.deepEqual(respawnQueue(runner.world, "red").map((q) => q.tank.id), ["red-2"]);
    assert.equal(respawnQueue(runner.world, "blue").length, 0, "a hull never fielded should not queue");
    const role = hull.role;
    const number = hull.number;
    const home = { ...hull.spawnPos! };

    runner.run(150);
    const midway = jsonCopy(runner.checkpoint());
    const stepsAfter = stepsUntilBack(runner, "red-2", hz);
    assert.ok(
      Math.abs((150 + stepsAfter) / hz - RESPAWN.delaySec / getRespawnRate("red")) <= 1 / hz,
      `returned after ${150 + stepsAfter} ticks, expected ~${(RESPAWN.delaySec / getRespawnRate("red")) * hz}`,
    );
    const fork = new ReplayRunner(midway);
    assert.equal(stepsUntilBack(fork, "red-2", hz), stepsAfter, "restored countdown ran differently");
    assert.deepEqual(jsonCopy(fork.checkpoint()), jsonCopy(runner.checkpoint()));

    assert.equal(hull.alive, true);
    assert.equal(hull.respawnLeft, undefined);
    assert.equal(hull.role, role, "respawn changed the hull type");
    assert.equal(hull.number, number, "respawn changed the hull number");
    assert.equal(hull.hp, hull.maxHp);
    assert.ok(Math.abs(hull.x - home.x) <= 1 && Math.abs(hull.y - home.y) <= 1, "returned away from its own base");
    assert.equal(respawnQueue(runner.world, "red").length, 0, "returned hull still counted down");
    assert.equal(hull.goal.kind, "holdPosition");
    assert.ok(
      runner.world.events.some((e) => e.text.includes(`#${number}`) && e.text.includes("respawned at base")),
      "no respawn broadcast for the returned hull",
    );
  });

  check("spawn protection shields a returned hull for the configured seconds, then it dies again", () => {
    const recording = fixture(30);
    recording.snapshot.stacks = {};
    recording.commands = [];
    shootHull(recording.snapshot.world, "red-2", "blue-1", "kill-red-2");
    const originalDelay = RESPAWN.delaySec;
    RESPAWN.delaySec = 3;
    try {
      const runner = new ReplayRunner(recording);
      runner.run(120);
      const hull = runner.world.tanks.find((t) => t.id === "red-2")!;
      assert.equal(hull.alive, true, "hull did not return on the configured delay");
      assert.ok(hull.spawnProtectionUntil !== undefined);
      assert.ok(runner.world.time < hull.spawnProtectionUntil!, "protection had already run out");
      bot(runner).cooldown = 10000; // the checks below are about protection, not gunnery
      shootHull(runner.world, "red-2", "blue-1", "shot-under-protection");
      runner.step();
      assert.equal(hull.alive, true, "protection did not block the shell");
      assert.equal(hull.hp, hull.maxHp, "protection let damage through");
      assert.equal(hull.respawnLeft, undefined, "a blocked shell still counted as a death");
      runner.run(Math.ceil(RESPAWN.protectionSec * 30) + 1);
      assert.ok(runner.world.time >= hull.spawnProtectionUntil!, "protection outlasted its timer");
      shootHull(runner.world, "red-2", "blue-1", "shot-after-protection");
      runner.step();
      assert.equal(hull.alive, false, "expired protection still shielded the hull");
      assert.equal(hull.respawnLeft, RESPAWN.delaySec, "second death did not re-arm the countdown");
      assert.equal(respawnQueue(runner.world, "red").length, 1);
    } finally {
      RESPAWN.delaySec = originalDelay;
    }
  });

  check("respawn countdown ticks once per team at getRespawnRate", () => {
    assert.equal(getRespawnRate("blue"), 1, "the middle zone is not in yet");
    assert.equal(getRespawnRate("red"), 1);
    const hz = 30;
    const recording = fixture(hz);
    recording.snapshot.stacks = {};
    recording.commands = [];
    shootHull(recording.snapshot.world, "red-2", "blue-1", "kill-red-2");
    shootHull(recording.snapshot.world, "blue-2", "red-6", "kill-blue-2");
    const runner = new ReplayRunner(recording);
    runner.step();
    const red = runner.world.tanks.find((t) => t.id === "red-2")!;
    const blue = runner.world.tanks.find((t) => t.id === "blue-2")!;
    assert.equal(red.alive, false);
    assert.equal(blue.alive, false);
    for (let i = 0; i < 20; i++) {
      const redLeft = red.respawnLeft!;
      const blueLeft = blue.respawnLeft!;
      runner.step();
      assert.ok(Math.abs(redLeft - red.respawnLeft! - (1 / hz) * getRespawnRate("red")) < 1e-9);
      assert.ok(Math.abs(blueLeft - blue.respawnLeft! - (1 / hz) * getRespawnRate("blue")) < 1e-9);
    }
    assert.ok(red.respawnLeft! > 0 && blue.respawnLeft! > 0);
  });

  check("recorded input, same-tick command order, terminal stop, and invalid snapshot rejection", () => {
    const recording = fixture(60);
    recording.commands.push({ tick: 7, utterance: "2 hold", goals: [{ tankId: "blue-2", goal: { kind: "holdPosition", source: "player", params: { x: 300, y: 400 } } }] });
    recording.inputs.push({ tick: 0, local: { keys: ["arrowright"], mouseX: 900, mouseY: 720, shooting: true } });
    const runner = new ReplayRunner(recording);
    const startX = runner.world.tanks.find((t) => t.id === "blue-1")!.x;
    runner.run(8);
    assert.ok(runner.world.tanks.find((t) => t.id === "blue-1")!.x > startX);
    assert.ok(runner.events.some((e) => e.type === "shot" && e.tankId === "blue-1" && e.tick === 0));
    assert.equal(bot(runner).goal.kind, "holdPosition");
    assert.equal(runner.events.filter((e) => e.type === "order_applied").length, 2);
    runner.world.outcome = "win";
    const terminal = jsonCopy(runner.checkpoint());
    runner.run(60);
    assert.deepEqual(jsonCopy(runner.checkpoint()), terminal);
    const bad = jsonCopy(recording);
    bad.snapshot.wallSignature = "different map";
    assert.throws(() => new ReplayRunner(bad), /wall signature/);
    assert.throws(() => runner.run(-1), /step count/);
    const badHz = jsonCopy(recording);
    (badHz.snapshot as { hz: number }).hz = 45;
    assert.throws(() => new ReplayRunner(badHz), /30 or 60/);
  });
  check("all replay scenarios avoided network/models and Math.random, including caught errors", () => {
    assert.equal(randomCalls, 0);
    assert.equal(fetchCalls, 0);
  });
} finally {
  Math.random = originalRandom;
  globalThis.fetch = originalFetch;
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
