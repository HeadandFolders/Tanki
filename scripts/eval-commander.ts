// Use --quick to skip the forty paired matches.
import assert from "node:assert/strict";
import { updateTankAi } from "../src/ai.ts";
import {
  commanderView, setCommander, updateCommander,
  type AiCommanderState, type CommanderDifficulty, type PendingCommanderOrder,
} from "../src/ai-commander.ts";
import { buildArena, dist } from "../src/arena.ts";
import { spawnBounds } from "../src/spawn.ts";
import { beliefFor, updateTeamBelief } from "../src/belief.ts";
import { handlerFor } from "../src/command-history.ts";
import {
  describeOrders, onCommandRecord, scriptedCommandRecord, type CommandRecord,
} from "../src/command-pipeline.ts";
import { intentsToOrders } from "../src/command-resolver.ts";
import { describeIntent, parseIntent, type CommandIntent } from "../src/command-schema.ts";
import { CONFIG, type ShareMode } from "../src/config.ts";
import { createWorld, startMatch, stepWorld, type InputState } from "../src/game.ts";
import { restoreGoal } from "../src/interrupt-stack.ts";
import { createRandom, nextRandom } from "../src/random.ts";
import type { Tank, TeamContact, TeamId, WorldState } from "../src/types.ts";

const DT = 1 / 30;
const SECONDS = 300;
const EPS = 1e-8;
// command_to_goal_ms is displayed rounded to tenths of a millisecond.
const DISPLAY_MS_EPS = 0.050001;
const TEAMS = ["blue", "red"] as const;
const DIFFICULTIES = ["easy", "normal", "hard"] as const;
const INPUT: InputState = { keys: [], mouseX: 640, mouseY: 400, shooting: false };
const args = process.argv.slice(2);
assert.ok(args.every((arg) => arg === "--quick"), "usage: eval:commander [--quick]");
const quick = args.includes("--quick");
let passed = 0;
let failed = 0;

function check(name: string, test: () => void): void {
  try {
    test();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}

function near(actual: number, expected: number, tolerance = EPS, label = "value"): void {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} (tolerance ${tolerance})`);
}

function between(value: number, low: number, high: number, label: string): void {
  assert.ok(Number.isFinite(value) && value >= low - EPS && value <= high + EPS,
    `${label}: ${value} outside [${low}, ${high}]`);
}

function friends(world: WorldState, team: TeamId): Tank[] {
  return world.tanks.filter((tank) => tank.team === team);
}

function commander(world: WorldState, team: TeamId): AiCommanderState {
  const state = world.commanders?.[team];
  assert.ok(state, `missing ${team} commander`);
  return state;
}

function fixture(team: TeamId = "red", difficulty: CommanderDifficulty = "normal", seed = 713): WorldState {
  const world = createWorld("clear", "mp-offline", "normal", 0x5eed, "off");
  // Only cheap unit fixtures remove walls. Balance/integration never do.
  world.walls = [];
  setCommander(world, team, difficulty, seed);
  startMatch(world);
  world.playerMarks = { blue: { x: 177, y: 611 }, red: { x: 1003, y: 173 } };
  return world;
}

function resolution(world: WorldState, state: AiCommanderState, pending: PendingCommanderOrder) {
  const view = commanderView(world, state);
  if (pending.marker) view.playerMarks = { ...view.playerMarks, [state.team]: pending.marker };
  assert.ok(pending.record.intent);
  return intentsToOrders(view, state.team, [pending.record.intent], "ai_commander");
}

function assertRecord(record: CommandRecord, state: AiCommanderState): void {
  assert.equal(record.source, "ai_commander");
  assert.equal(record.issuer, "ai_commander");
  assert.equal(record.which_path_executed, "ai_commander");
  assert.equal(handlerFor(record.which_path_executed), null, "AI orders must not enter Janna");
  assert.equal(record.seed, state.seed);
  assert.equal(record.team, state.team);
  assert.ok(record.reason && record.raw_text);
  assert.ok(record.intent);
  assert.deepEqual(parseIntent(record.intent.tool, { ...record.intent }), record.intent);
  assert.equal(record.raw_text, describeIntent(record.intent));
  assert.ok(Number.isInteger(record.id) && record.id < 0, "AI record IDs must be deterministic, not global IDs");
  assert.ok(record.issuedAt != null && record.appliedAt != null);
  near(record.at, record.issuedAt * 1000, EPS, "simulation timestamp");
  between(record.latency_ms, 300, 800, "rolled acknowledgement");
  const elapsedMs = (record.appliedAt - record.issuedAt) * 1000;
  between(elapsedMs, record.latency_ms - EPS, record.latency_ms + DT * 1000 + EPS,
    "applied acknowledgement includes at most one fixed tick");
  assert.ok(record.command_to_goal_ms != null);
  near(record.command_to_goal_ms, elapsedMs, DISPLAY_MS_EPS, "command-to-goal time");
  assert.equal(record.sidecar, false);
  assert.equal(record.needle_result, null);
  assert.equal(record.llm_result.attempted, false);
  assert.ok(record.tanks);
  assert.equal(new Set(record.tanks).size, record.tanks.length);
}

/** Check the actual resolver result against every goal write, including nonrecipients. */
function auditedUpdate(world: WorldState, state: AiCommanderState): void {
  const own = friends(world, state.team);
  const goals = new Map(own.map((tank) => [tank.id, structuredClone(tank.goal)]));
  const marks = structuredClone(world.playerMarks);
  const markObject = world.playerMarks;
  const blueMark = world.playerMarks.blue;
  const redMark = world.playerMarks.red;
  const pending = state.pending;
  const count = state.orders.length;
  const due = pending && world.time + 1e-9 >= pending.executeAt;
  updateCommander(world, state);
  assert.deepEqual(world.playerMarks, marks, "commander mutated player marks");
  assert.equal(world.playerMarks, markObject);
  assert.equal(world.playerMarks.blue, blueMark);
  assert.equal(world.playerMarks.red, redMark);
  if (!due) {
    assert.equal(state.orders.length, count, "orders logged before acknowledgement");
    for (const tank of own) assert.deepEqual(tank.goal, goals.get(tank.id), "goal written before acknowledgement");
    return;
  }
  assert.equal(state.orders.length, count + 1);
  const record = state.orders[count]!;
  assert.equal(record, pending.record, "log should contain the applied pending record");
  assertRecord(record, state);
  near(record.latency_ms, (pending.executeAt - record.issuedAt!) * 1000, EPS, "exact rolled latency");
  const resolved = resolution(world, state, pending);
  const applied = resolved.orders.filter((order) => own.some((tank) => tank.id === order.tankId && tank.alive));
  assert.deepEqual(record.tanks, applied.map((order) => order.tankId));
  assert.deepEqual(record.goals, describeOrders(applied, world.tanks));
  assert.equal(record.notice, resolved.notice);
  for (const tank of own) {
    const order = applied.find((item) => item.tankId === tank.id);
    if (!order) {
      assert.deepEqual(tank.goal, goals.get(tank.id), `nonrecipient ${tank.id} changed`);
      continue;
    }
    assert.deepEqual(tank.orderStack?.base, {
      kind: order.goal, params: order.params ?? {}, source: "player",
      commandId: record.id, noRetreat: order.noRetreat,
      commandSource: "ai_commander", issuer: "ai_commander",
    }, `normal resolver/application mismatch for ${tank.id}`);
    if (tank.orderStack?.interrupt) {
      assert.equal(tank.goal.kind, "retreat");
      assert.ok(record.orderEvents?.some((event) => event.tankId === tank.id &&
        event.reason === tank.orderStack!.interrupt!.reason && event.caption));
    } else assert.deepEqual(tank.goal, tank.orderStack?.base);
    assert.deepEqual(state.assignments[tank.id], { at: world.time, kind: order.goal });
  }
}

function finishMoves(world: WorldState, state: AiCommanderState): void {
  // Explicit completion fixture: teleport only after acknowledgement, not in real matches.
  for (const tank of friends(world, state.team)) {
    if (tank.goal.kind !== "moveTo") continue;
    assert.ok(tank.goal.params?.x != null && tank.goal.params.y != null);
    tank.x = tank.goal.params.x;
    tank.y = tank.goal.params.y;
  }
}

function assertSchedule(state: AiCommanderState): void {
  between(state.ticks.length, 75, 150, "five-minute decision count");
  const rng = createRandom(state.seed);
  let expected = 0;
  let previous = 0;
  for (const tick of state.ticks) {
    expected += 2 + 2 * nextRandom(rng);
    near(tick.at, expected, EPS, "uniform seeded schedule, independent of decisions");
    between(tick.at - previous, 2, 4, "scheduled interval including skips");
    assert.ok(tick.at <= SECONDS + EPS);
    previous = tick.at;
  }
  expected += 2 + 2 * nextRandom(rng);
  near(state.nextOrderAt, expected);
  assert.ok(state.nextOrderAt > SECONDS, "schedule stopped before the five-minute boundary");
}

function firstIssue(world: WorldState, state: AiCommanderState): PendingCommanderOrder {
  for (let tick = 1; tick <= 150; tick++) {
    world.time = tick * DT;
    auditedUpdate(world, state);
    if (state.pending) return state.pending;
  }
  assert.fail("no first order within five seconds");
}

function acknowledge(world: WorldState, state: AiCommanderState, pending: PendingCommanderOrder): void {
  for (let tick = Math.floor(world.time / DT + EPS) + 1; tick <= Math.ceil(pending.executeAt / DT) + 1; tick++) {
    world.time = tick * DT;
    auditedUpdate(world, state);
    if (state.orders.includes(pending.record)) return;
  }
  assert.fail("pending order never applied");
}

function lockedFixture(team: TeamId): WorldState {
  const world = fixture(team);
  const state = commander(world, team);
  state.deployed = friends(world, team).map((tank) => tank.number);
  for (const tank of friends(world, team)) {
    restoreGoal(tank, { kind: "moveTo", params: { x: tank.x, y: 400, exact: true },
      source: "player", issuer: "ai_commander", commandSource: "ai_commander" });
    state.assignments[tank.id] = { at: 0, kind: "moveTo" };
  }
  return world;
}

function invariants(): void {
  console.log("Commander invariants (fixed 1/30 second steps)");
  check("default six mirrored gunners, normal commander, off leaves spawn holds", () => {
    const world = createWorld("clear", "mp-offline", "normal", 17);
    assert.equal(commander(world, "red").difficulty, "normal");
    assert.equal(world.commanders?.blue, undefined);
    assert.equal(world.redDifficulty, "normal");
    const stats = (team: TeamId) => friends(world, team).map((tank) => ({
      number: tank.number, role: tank.role, hp: tank.hp, maxHp: tank.maxHp,
      cooldown: tank.cooldown, stats: CONFIG.roles[tank.role],
    }));
    assert.equal(friends(world, "blue").length, 6);
    assert.equal(friends(world, "red").length, 6);
    assert.deepEqual(stats("blue"), stats("red"));
    assert.ok(world.tanks.every((tank) => tank.role === "shooter" && tank.hp === CONFIG.roles.shooter.maxHp));
    for (const difficulty of DIFFICULTIES) {
      const variant = createWorld("clear", "mp-offline", "normal", 17, difficulty);
      assert.equal(commander(variant, "red").difficulty, difficulty);
      assert.deepEqual(variant.tanks, world.tanks, "difficulty must not grant hull stat/spawn perks");
      assert.equal(variant.redDifficulty, "normal");
    }
    const off = createWorld("clear", "mp-offline", "normal", 17, "off");
    assert.equal(off.commanders?.red, undefined);
    const before = off.tanks.map((tank) => ({ id: tank.id, x: tank.x, y: tank.y, goal: structuredClone(tank.goal) }));
    startMatch(off);
    for (let tick = 0; tick < 5 / DT; tick++) stepWorld(off, DT, INPUT);
    assert.deepEqual(off.tanks.map((tank) => ({ id: tank.id, x: tank.x, y: tank.y, goal: tank.goal })), before);
    assert.ok(off.tanks.every((tank) => tank.goal.kind === "holdPosition"));
    setCommander(world, "blue", "normal", 91);
    setCommander(world, "blue", "off");
    setCommander(world, "red", "off");
    assert.equal(world.commanders?.blue, undefined);
    assert.equal(world.commanders?.red, undefined);
  });

  check("300 seconds: exact uniform cadence, equal at all qualities; actual issued intervals and group coverage", () => {
    const sizes = new Map<number, number>();
    let everyone = 0;
    for (const team of TEAMS) {
      let schedule: number[] | undefined;
      for (const difficulty of DIFFICULTIES) {
        const world = fixture(team, difficulty, 0x1234abcd);
        const state = commander(world, team);
        // No sensor samples: decisions may move, but cannot acquire live enemies.
        for (let tick = 1; tick <= SECONDS / DT; tick++) {
          world.time = tick * DT;
          auditedUpdate(world, state);
          finishMoves(world, state);
        }
        assertSchedule(state);
        assert.ok(state.ticks.every((tick) => !tick.skipped), "completion fixture must not be busy");
        const times = state.ticks.map((tick) => tick.at);
        if (schedule) assert.deepEqual(times, schedule, "quality changed cadence");
        schedule = times;
        assert.ok(state.orders.length >= 74, "issued-order cadence fixture did not actually issue orders");
        for (let i = 0; i < state.orders.length; i++) {
          const order = state.orders[i]!;
          near(order.issuedAt!, state.ticks[i]!.at);
          if (i) between(order.issuedAt! - state.orders[i - 1]!.issuedAt!, 2, 4, "issued interval");
          const n = order.tanks!.length;
          sizes.set(n, (sizes.get(n) ?? 0) + 1);
          assert.ok(n >= 1 && (n <= 3 || n === 6), `unexpected group size ${n}`);
          if (n > 3) {
            everyone++;
            assert.deepEqual([...order.tanks!].sort(), friends(world, team).map((tank) => tank.id).sort());
          }
        }
      }
    }
    for (const size of [1, 2, 3, 6]) assert.ok(sizes.has(size), `never observed group size ${size}`);
    assert.ok(everyone > 0 && everyone < (sizes.get(2) ?? 0), "everyone must occur, not dominate");
    console.log(`    issued group sizes: ${JSON.stringify(Object.fromEntries(sizes))}`);
  });

  check("busy skips retain the five-minute clock, no recipient retasked within a live five-second lock", () => {
    for (const team of TEAMS) {
      const world = lockedFixture(team);
      const state = commander(world, team);
      let busy = 0;
      for (let tick = 1; tick <= SECONDS / DT; tick++) {
        world.time = tick * DT;
        // Keep acknowledged destinations uncompleted, including a same-position hold-angle move.
        for (const tank of friends(world, team)) {
          const goal = tank.goal;
          if (goal.kind === "moveTo" && goal.params?.x != null && goal.params.y != null) {
            tank.x = goal.params.x < CONFIG.canvasWidth / 2 ? CONFIG.canvasWidth - 50 : 50;
            tank.y = goal.params.y < CONFIG.canvasHeight / 2 ? CONFIG.canvasHeight - 50 : 50;
          }
        }
        const previous = structuredClone(state.assignments);
        const pendingBefore = state.pending;
        const orderCount = state.orders.length;
        const tickCount = state.ticks.length;
        auditedUpdate(world, state);
        if (state.pending && state.pending !== pendingBefore) {
          for (const n of state.pending.record.intent!.tank_ids) {
            const tank = friends(world, team).find((item) => item.number === n)!;
            const last = previous[tank.id];
            if (last) assert.ok(world.time - last.at >= 5 - EPS, `${tank.id} selected inside active lock`);
          }
        }
        for (const record of state.orders.slice(orderCount)) {
          for (const id of record.tanks!) {
            const last = previous[id];
            if (last) assert.ok(record.appliedAt! - last.at >= 5 - EPS, `${id} retasked too soon`);
          }
        }
        if (state.ticks.length > tickCount && state.ticks.at(-1)!.skipped === "busy") busy++;
      }
      assert.equal(state.ticks[0]!.skipped, "busy", "all six are locked at the first scheduled decision");
      assert.ok(busy > 0 && state.orders.length > 0, "must exercise both busy and issuing branches");
      assertSchedule(state);
    }
  });

  check("an ended goal permits early retask; no_tanks skips do not stop scheduling", () => {
    for (const completion of ["arrival", "hold", "idle", "changed_kind", "lost_target"] as const) {
      const world = lockedFixture("red");
      const state = commander(world, "red");
      const tank = friends(world, "red")[0]!;
      if (completion === "arrival") { tank.x = tank.goal.params!.x!; tank.y = tank.goal.params!.y!; }
      if (completion === "hold") restoreGoal(tank, { ...tank.goal, kind: "holdPosition" });
      if (completion === "idle") restoreGoal(tank, { ...tank.goal, kind: "idle" });
      if (completion === "changed_kind") restoreGoal(tank, { ...tank.goal, kind: "escort" });
      if (completion === "lost_target") {
        restoreGoal(tank, { kind: "attackNearest", params: { targetTankId: "blue-6" },
          source: "player", issuer: "ai_commander" });
        state.assignments[tank.id]!.kind = "attackNearest";
      }
      const pending = firstIssue(world, state);
      assert.ok(pending.record.issuedAt! < 5);
      assert.deepEqual(pending.record.intent!.tank_ids, [tank.number], completion);
    }
    const world = fixture("blue");
    const state = commander(world, "blue");
    for (const tank of friends(world, "blue")) tank.alive = false;
    for (let tick = 1; tick <= SECONDS / DT; tick++) {
      world.time = tick * DT;
      updateCommander(world, state);
    }
    assertSchedule(state);
    assert.ok(state.ticks.every((tick) => tick.skipped === "no_tanks"));
    assert.equal(state.orders.length, 0);
    assert.equal(state.pending, null);
  });

  check("acknowledgements: exact rolled delay, no early goal/log, one-tick quantization, applied publication", () => {
    for (const team of TEAMS) {
      const world = fixture(team);
      const state = commander(world, team);
      let publications = 0;
      const unsubscribe = onCommandRecord((record) => {
        if (record.team !== team || record.source !== "ai_commander") return;
        publications++;
        assert.equal(record.appliedAt, world.time);
        assert.ok(record.tanks?.length);
        assert.ok(record.goals.length);
        for (const id of record.tanks) {
          assert.equal(world.tanks.find((tank) => tank.id === id)!.goal.issuer, "ai_commander",
            "record published before goals were applied");
        }
      });
      try {
        const pending = firstIssue(world, state);
        assert.equal(pending.record.appliedAt, undefined);
        assert.equal(pending.record.command_to_goal_ms, null);
        assert.equal(publications, 0);
        between(pending.executeAt - pending.record.issuedAt!, 0.3, 0.8, "pending acknowledgement delay");
        acknowledge(world, state, pending);
        assert.equal(publications, 1);
        const count = state.orders.length;
        auditedUpdate(world, state);
        assert.equal(state.orders.length, count, "same-tick update applied an order twice");
      } finally { unsubscribe(); }
    }
  });

  check("dead at issue and killed during acknowledgement: only actual living recipients are recorded", () => {
    for (const team of TEAMS) {
      for (const death of ["before_issue", "one_in_ack", "all_in_ack"] as const) {
        const world = fixture(team);
        const state = commander(world, team);
        const dead = friends(world, team)[0]!;
        const oldGoal = structuredClone(dead.goal);
        if (death === "before_issue") { dead.alive = false; dead.hp = 0; }
        const pending = firstIssue(world, state);
        if (death === "before_issue") assert.ok(!pending.record.intent!.tank_ids.includes(dead.number));
        const selected = friends(world, team).filter((tank) => pending.record.intent!.tank_ids.includes(tank.number));
        const killed = death === "before_issue" ? [dead] : death === "all_in_ack" ? selected : selected.slice(0, 1);
        const killedGoals = killed.map((tank) => structuredClone(tank.goal));
        for (const tank of killed) { tank.alive = false; tank.hp = 0; }
        acknowledge(world, state, pending);
        for (let i = 0; i < killed.length; i++) {
          const tank = killed[i]!;
          assert.ok(!pending.record.tanks!.includes(tank.id));
          assert.equal(state.assignments[tank.id], undefined);
          assert.deepEqual(tank.goal, killedGoals[i]);
        }
        if (death === "before_issue") assert.deepEqual(dead.goal, oldGoal);
        if (death === "all_in_ack") {
          assert.deepEqual(pending.record.tanks, []);
          assert.deepEqual(pending.record.goals, []);
          assert.ok(pending.record.notice);
        } else assert.ok(pending.record.tanks!.length > 0);
      }
    }
  });

  check("a flank contact lost during acknowledgement never falls back to a friendly hull", () => {
    const world = fixture();
    const state = commander(world, "red");
    const pending = firstIssue(world, state);
    pending.record = scriptedCommandRecord("red", {
      tool: "flank", tank_ids: [2, 3], reference_id: 1, side: "left",
    }, "flank_alternate", pending.record.issuedAt!, state.seed, state.sequence);
    const before = world.tanks.map((tank) => structuredClone(tank.goal));
    world.time = Math.ceil(pending.executeAt / DT) * DT;
    updateCommander(world, state);
    assert.deepEqual(pending.record.tanks, []);
    assert.match(pending.record.notice ?? "", /contact/i);
    assert.deepEqual(world.tanks.map((tank) => tank.goal), before);
  });

  for (const share of ["auto", "report", "none"] as const) {
    for (const team of TEAMS) check(`${share}/${team}: per-contact delay, reacquisition, fog snapshot isolation in commander/resolver/brain`, () => {
      fogInvariant(share, team);
    });
  }

  check("all commander intent tools use ordinary resolver goals and leave both player marks untouched", () => {
    for (const team of TEAMS) {
      const world = fixture(team);
      const state = commander(world, team);
      const own = friends(world, team);
      const enemy = world.tanks.find((tank) => tank.team !== team)!;
      enemy.x = own[0]!.x + 25;
      enemy.y = own[0]!.y;
      for (let tick = 1; tick <= 30; tick++) {
        world.time = tick * DT;
        updateTeamBelief(world);
        auditedUpdate(world, state);
      }
      const intents: CommandIntent[] = [
        { tool: "move_to", tank_ids: [1, 2], ref: { type: "marker" } },
        { tool: "attack", tank_ids: [1, 2, 3], target_id: enemy.number },
        { tool: "flank", tank_ids: [2, 3], reference_id: enemy.number, side: "left" },
        { tool: "cover", tank_ids: [2, 3], protect: "player" },
      ];
      for (const intent of intents) {
        // Test the application route independently of randomized choice quality.
        const pending = firstIssueAfter(world, state);
        pending.record = scriptedCommandRecord(team, intent, "resolver_fixture",
          pending.record.issuedAt!, state.seed, state.sequence);
        pending.marker = { x: 620, y: 400 };
        while (state.pending === pending) {
          world.time += DT;
          updateTeamBelief(world);
          auditedUpdate(world, state);
        }
        assert.equal(pending.record.tanks!.length, intent.tank_ids.length);
        assert.ok(pending.record.goals.length > 0);
        // Finish this fixture's orders before requesting the next tool.
        for (const tank of own) restoreGoal(tank, { kind: "holdPosition", source: "system" });
      }
    }
  });

  check("same-seed full simulation/records, distinct-seed behavior, serialized pending checkpoint continuation", () => {
    deterministicIntegration();
  });

  check("one-survivor adjudication stops inside a step, before a second lethal projectile can wipe red", () => {
    const world = fixture();
    setCommander(world, "red", "off");
    const reds = friends(world, "red");
    for (const tank of reds.slice(2)) { tank.alive = false; tank.hp = 0; }
    world.projectiles = reds.slice(0, 2).map((tank, index) => ({
      id: `threshold-${index}`, team: "blue", ownerId: "blue-1", x: tank.x, y: tank.y,
      vx: 0, vy: 0, damage: tank.hp, life: 1, fromShooter: true,
    }));
    const step = adjudicatedStepper(world);
    assert.equal(step(), "blue");
    assert.equal(reds[0]!.alive, false);
    assert.equal(reds[1]!.alive, true);
    assert.equal(reds[1]!.hp, reds[1]!.maxHp, "survivor must not be hit after adjudication");
  });

  check("red push reaches gun range of the blue base on both MP arenas", () => {
    const limits: Record<string, number> = { dense: 30, large: 60 };
    for (const arena of ["dense", "large"] as const) {
      let slowest = 0;
      for (const seed of [23, 411]) {
        const world = createWorld("clear", "mp-offline", "normal", seed, "hard", arena, CONFIG.largeArena.seed);
        startMatch(world);
        const box = spawnBounds(arena, "blue");
        const base = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
        let arrived = -1;
        for (let tick = 0; tick < 90 / DT && arrived < 0; tick++) {
          stepWorld(world, DT, INPUT);
          if (world.tanks.some((tank) => tank.team === "red" && tank.alive &&
            dist(tank.x, tank.y, base.x, base.y) <= CONFIG.mpOffline.shootRange)) {
            arrived = world.time;
          }
        }
        assert.ok(arrived >= 0, `${arena} seed ${seed}: no red tank ever entered gun range of the blue base`);
        slowest = Math.max(slowest, arrived);
      }
      assert.ok(slowest <= limits[arena]!,
        `${arena}: red first reached the blue base at ${slowest.toFixed(1)}s (limit ${limits[arena]}s)`);
      console.log(`    ${arena}: red in range of the blue base by ${slowest.toFixed(1)}s (limit ${limits[arena]}s)`);
    }
  });
}

function firstIssueAfter(world: WorldState, state: AiCommanderState): PendingCommanderOrder {
  for (let tick = 0; tick < 180; tick++) {
    world.time += DT;
    updateTeamBelief(world);
    auditedUpdate(world, state);
    if (state.pending) return state.pending;
  }
  assert.fail("no issue in continuation fixture");
}

function fogInvariant(share: ShareMode, team: TeamId): void {
  const world = fixture(team, "hard", 901);
  world.shareMode = share;
  const state = commander(world, team);
  const rawTanks = world.tanks;
  const own = friends(world, team);
  const foes = rawTanks.filter((tank) => tank.team !== team);
  const leader = own[0]!;
  if (team === "blue") world.controlledId = leader.id;
  else world.remoteControlledId = leader.id;
  for (const [i, tank] of own.entries()) {
    tank.x = 300 + i * 25;
    tank.y = 300;
    restoreGoal(tank, { kind: "holdPosition", params: { x: tank.x, y: tank.y }, source: "system" });
  }
  state.deployed = own.map((tank) => tank.number);
  // A decision on first contact must still wait for perception.
  state.nextOrderAt = DT;
  const admitted = new Set<string>();
  const delays = new Map<string, number>();
  let reacquired = false;
  let snapshotChecks = 0;
  let rejectedBeforeReady = 0;
  let hiddenAttackRejections = 0;
  const blocked = new Set<PropertyKey>(["x", "y", "hp", "maxHp", "angle", "role", "number"]);

  for (let tick = 0; tick <= 150; tick++) {
    world.time = tick * DT;
    world.tanks = rawTanks;
    for (const [i, foe] of foes.entries()) {
      foe.x = 1050 + i * 20;
      foe.y = 100;
      foe.hp = foe.maxHp = CONFIG.roles.shooter.maxHp;
    }
    // First target vanishes, then returns. Second target arrives 0.2s later.
    if (tick < 33 || tick >= 45) { foes[0]!.x = 330; foes[0]!.y = 300; }
    if (tick >= 6) { foes[1]!.x = 340; foes[1]!.y = 310; foes[1]!.hp = 22; }
    updateTeamBelief(world); // ONLY boundary allowed to inspect live enemy data.
    const samples = structuredClone(beliefFor(world, team).contacts);
    for (const contact of samples.filter((contact) => contact.seenAt === world.time)) {
      assert.ok(contact.observed, "belief must snapshot combat metadata for both teams");
      assert.ok(own.some((tank) => tank.id === contact.seenBy));
    }
    // Poison live objects after capture to detect any downstream snapshot bypass.
    for (const foe of foes) { foe.x = -90000; foe.y = 90000; foe.hp = -777; }
    world.tanks = rawTanks.map((tank) => tank.team === team ? tank : new Proxy(tank, {
      get(target, property, receiver) {
        if (blocked.has(property)) throw new Error(`${share}/${team}: live enemy ${target.id}.${String(property)} read after observation`);
        return Reflect.get(target, property, receiver);
      },
    }));
    auditedUpdate(world, state);
    const view = commanderView(world, state);
    const visible = view.tanks.filter((tank) => tank.team !== team);
    assert.ok(!visible.some((tank) => tank.id === foes[2]!.id), "never-seen enemy admitted");
    for (const contact of samples) {
      const perceived = state.contacts[contact.enemyId];
      const exposed = visible.find((tank) => tank.id === contact.enemyId);
      if (contact.seenAt !== world.time) {
        assert.equal(exposed, undefined, "stale/lost contact remained visible");
        continue;
      }
      assert.ok(perceived);
      between(perceived.readyAt - perceived.since, 0.3, 0.8, "per-contact reaction delay");
      const key = `${contact.enemyId}@${perceived.since}`;
      const priorDelay = delays.get(key);
      if (priorDelay != null) near(perceived.readyAt, priorDelay, EPS, "continuous visibility reset readiness");
      delays.set(key, perceived.readyAt);
      if (world.time < perceived.readyAt) {
        rejectedBeforeReady++;
        assert.equal(exposed, undefined, "reacted before readyAt");
        const attack = intentsToOrders(view, team, [{ tool: "attack", tank_ids: [leader.number], target_id: contact.observed!.number }]);
        assert.equal(attack.orders.length, 0, "resolver saw unadmitted enemy");
        if (state.pending) {
          const intent = state.pending.record.intent!;
          if (intent.tool === "attack") assert.notEqual(intent.target_id, contact.observed!.number);
          if (intent.tool === "flank") assert.notEqual(intent.reference_id, contact.observed!.number);
        }
      } else {
        assert.ok(exposed, "ready visible snapshot not admitted");
        if (!admitted.has(key)) {
          between(world.time - perceived.since, 0.3, 0.8 + DT, "first admitted frame");
          admitted.add(key);
        }
        assertSnapshot(exposed, contact);
        assert.notEqual(exposed, foes.find((foe) => foe.id === exposed.id));
        snapshotChecks++;
        const attack = intentsToOrders(view, team, [{ tool: "attack", tank_ids: [leader.number], target_id: contact.observed!.number }]);
        assert.equal(attack.orders[0]?.params?.targetTankId, contact.enemyId);
        const flank = intentsToOrders(view, team, [{ tool: "flank", tank_ids: [2, 3], reference_id: contact.observed!.number, side: "right" }]);
        assert.equal(flank.orders.length, 2);
        for (const order of flank.orders) {
          between(order.params!.x!, 0, CONFIG.canvasWidth, "snapshot-derived flank x");
          between(order.params!.y!, 0, CONFIG.canvasHeight, "snapshot-derived flank y");
        }
      }
    }
    const neverSeen = intentsToOrders(view, team, [{ tool: "attack", tank_ids: [2], target_id: 3 }]);
    assert.equal(neverSeen.orders.length, 0);
    hiddenAttackRejections++;
    // Clone the probe so motor movement cannot alter the next sensor sample.
    const probe = structuredClone(leader);
    const result = updateTankAi(view, probe, DT, false);
    if (!visible.length) assert.equal(result.wantShoot, false, "brain reacted to hidden/unready enemies");
    if (tick === 45) {
      const renewed = state.contacts[foes[0]!.id]!;
      near(renewed.since, world.time);
      assert.ok(renewed.readyAt > world.time);
      reacquired = true;
    }
  }
  assert.ok(reacquired && snapshotChecks > 0 && rejectedBeforeReady > 0 && hiddenAttackRejections > 0);
  assert.equal(admitted.size, 3, "both independent contacts and reacquired contact must pass admission");
  assert.ok(state.orders.length > 0, "fog fixture never exercised pending application");
  // Legacy contacts without metadata must not authorize live-object fallback.
  world.time += DT;
  beliefFor(world, team).contacts = [{ enemyId: foes[2]!.id, x: 330, y: 300,
    seenAt: world.time, seenBy: leader.id }];
  auditedUpdate(world, state);
  assert.ok(!commanderView(world, state).tanks.some((tank) => tank.id === foes[2]!.id));
}

function assertSnapshot(tank: Tank, contact: TeamContact): void {
  assert.deepEqual({ x: tank.x, y: tank.y, number: tank.number, team: tank.team, role: tank.role,
    hp: tank.hp, maxHp: tank.maxHp, angle: tank.angle },
  { x: contact.x, y: contact.y, ...contact.observed });
}

function duel(worldSeed: number, blueSeed: number, redSeed: number): WorldState {
  const world = createWorld("clear", "mp-offline", "normal", worldSeed, "normal");
  setCommander(world, "blue", "normal", blueSeed);
  setCommander(world, "red", "normal", redSeed);
  startMatch(world);
  return world;
}

function fullRecords(world: WorldState): CommandRecord[][] {
  return TEAMS.map((team) => commander(world, team).orders);
}

function deterministicIntegration(): void {
  const a = duel(0x11223344, 1001, 2002);
  const b = duel(0x11223344, 1001, 2002);
  const different = duel(0x11223344, 3003, 4004);
  assert.deepEqual(a, b);
  const startingLeaders = TEAMS.map((team) => structuredClone(friends(a, team)[0]!));
  let checkpoint: WorldState | undefined;
  let checkpointRecordCount = 0;
  for (let tick = 0; tick < 20 / DT; tick++) {
    stepWorld(a, DT, INPUT);
    stepWorld(b, DT, INPUT);
    stepWorld(different, DT, INPUT);
    if (checkpoint) stepWorld(checkpoint, DT, INPUT);
    else if (TEAMS.some((team) => commander(a, team).pending)) {
      checkpoint = structuredClone(a);
      // JSON-roundtrip commander state without losing the world's Uint8Array.
      for (const team of TEAMS) {
        checkpoint.commanders![team] = JSON.parse(JSON.stringify(commander(a, team))) as AiCommanderState;
      }
      checkpointRecordCount = fullRecords(a).flat().length;
    }
  }
  assert.ok(checkpoint, "never checkpointed an in-flight acknowledgement");
  // Compare complete records: do not strip IDs, timestamps, intent, notice or latency.
  assert.deepEqual(fullRecords(a), fullRecords(b));
  assert.deepEqual(a, b, "same seed simulation diverged");
  assert.deepEqual(fullRecords(a), fullRecords(checkpoint), "checkpoint order continuation diverged");
  assert.deepEqual(a, checkpoint, "checkpoint simulation continuation diverged");
  assert.ok(fullRecords(a).flat().length > checkpointRecordCount + 2);
  const decisions = (world: WorldState) => fullRecords(world).map((records) => records.map((record) => ({
    issuedAt: record.issuedAt, appliedAt: record.appliedAt, intent: record.intent, reason: record.reason,
  })));
  assert.notDeepEqual(decisions(a), decisions(different), "different seeds changed only record metadata");
  const all = fullRecords(a).flat();
  assert.equal(new Set(all.map((record) => record.id)).size, all.length, "blue/red record IDs collide");
  for (const team of TEAMS) {
    for (const record of commander(a, team).orders) assertRecord(record, commander(a, team));
    const start = startingLeaders.find((tank) => tank.team === team)!;
    const end = a.tanks.find((tank) => tank.id === start.id)!;
    assert.ok(commander(a, team).orders.some((record) => record.tanks?.includes(start.id)), `${team} #1 was never ordered`);
    assert.ok(Math.hypot(end.x - start.x, end.y - start.y) > 1, `${team} player-equivalent hull was not bot-driven`);
  }
}

type Winner = TeamId | "draw";

// Stop on the fifth loss before another projectile in this tick can wipe the remaining hull.
function adjudicatedStepper(world: WorldState): () => Winner | null {
  const remaining = { blue: friends(world, "blue").filter((tank) => tank.alive).length,
    red: friends(world, "red").filter((tank) => tank.alive).length };
  assert.ok(remaining.blue > 1 && remaining.red > 1);
  const stop = { loser: null as TeamId | null };
  let result: Winner | null = null;
  for (const tank of world.tanks) {
    let alive = tank.alive;
    Object.defineProperty(tank, "alive", {
      enumerable: true, configurable: true,
      get: () => alive,
      set: (value: boolean) => {
        if (value === alive) return;
        alive = value;
        remaining[tank.team] += value ? 1 : -1;
        if (!value && remaining[tank.team] === 1) {
          stop.loser = tank.team;
          throw stop;
        }
      },
    });
  }
  return () => {
    if (result) return result;
    try { stepWorld(world, DT, INPUT); }
    catch (error) {
      if (error !== stop) throw error;
      result = stop.loser === "blue" ? "red" : "blue";
      world.outcome = result === "blue" ? "win" : "lose";
    }
    assert.ok(remaining.red >= 1 && remaining.blue >= 1, "adjudication allowed a wipe");
    if (!result && world.outcome !== "playing") {
      assert.equal(world.outcome, "draw", "engine ended before one-survivor adjudication");
      result = "draw";
    }
    return result;
  };
}

interface MatchResult {
  winner: Winner;
  seconds: number;
  alive: Record<TeamId, number>;
  damage: Record<TeamId, number>;
  shots: Record<TeamId, number>;
  orders: Record<TeamId, number>;
  engagedSeconds: number;
}

function balanceMatch(world: WorldState): MatchResult {
  const step = adjudicatedStepper(world);
  const shots = { blue: 0, red: 0 };
  const lastShots = new Map(world.tanks.map((tank) => [tank.id, tank.lastShotAt]));
  let engagedSeconds = 0;
  let winner: Winner | null = null;
  for (let tick = 0; tick < SECONDS / DT && !winner; tick++) {
    winner = step();
    let engaged = false;
    for (const tank of world.tanks) {
      if (tank.lastShotAt !== lastShots.get(tank.id)) {
        shots[tank.team]++;
        lastShots.set(tank.id, tank.lastShotAt);
        engaged = true;
      }
    }
    if (engaged || TEAMS.some((team) => Object.values(commander(world, team).contacts)
      .some((contact) => contact.visible && contact.readyAt <= world.time))) engagedSeconds += DT;
  }
  const alive = { blue: friends(world, "blue").filter((tank) => tank.alive).length,
    red: friends(world, "red").filter((tank) => tank.alive).length };
  assert.ok(alive.red >= 1 && alive.blue >= 1);
  const lostHp = (team: TeamId) => friends(world, team).reduce((sum, tank) => sum + tank.maxHp - tank.hp, 0);
  return {
    winner: winner ?? "draw", seconds: world.time, alive,
    // Effective enemy HP removed, capped by real hull HP (no overkill inflation).
    damage: { blue: lostHp("red"), red: lostHp("blue") }, shots,
    orders: { blue: commander(world, "blue").orders.filter((record) => record.tanks?.length).length,
      red: commander(world, "red").orders.filter((record) => record.tanks?.length).length },
    engagedSeconds,
  };
}

function balance(): void {
  console.log("Balance: 20 fixed world seeds x 2 commander-seed assignments; dense arena; 300s cap; 30 Hz");
  console.log("Adjudication: first team reduced to one survivor loses, immediately within that physics tick.");
  const rows: MatchResult[] = [];
  const dense = buildArena("dense");
  assert.ok(CONFIG.mpOffline.denseArena && dense.length > 0);
  assert.equal(CONFIG.matchDurationSec, SECONDS, "balance requires the unmodified five-minute match cap");
  for (let seed = 0; seed < 20; seed++) {
    // Swap only commander seeds, preserving the map and physical spawn positions.
    const worldSeed = (0x5eed0000 + seed) >>> 0;
    const seedA = (0x13579bdf ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
    const seedB = (0x2468ace0 ^ Math.imul(seed + 1, 0x85ebca6b)) >>> 0;
    assert.notEqual(seedA, seedB);
    const first = duel(worldSeed, seedA, seedB);
    const swapped = duel(worldSeed, seedB, seedA);
    assert.deepEqual(first.walls, dense, "not the actual dense arena");
    assert.deepEqual(swapped.walls, first.walls, "map was rotated/modified for the return leg");
    assert.deepEqual(swapped.tanks, first.tanks, "physical spawns/stats changed between legs");
    assert.deepEqual(swapped.random, first.random);
    for (const [leg, world] of [first, swapped].entries()) {
      const row = balanceMatch(world);
      rows.push(row);
      console.log(`    seed=${seed + 1} world=${worldSeed} leg=${leg + 1}` +
        ` commanders=${commander(world, "blue").seed}/${commander(world, "red").seed}` +
        ` ${row.winner} t=${row.seconds.toFixed(1)} alive=${row.alive.blue}/${row.alive.red}` +
        ` damage(B/R)=${row.damage.blue}/${row.damage.red} shots=${row.shots.blue}/${row.shots.red}` +
        ` applied=${row.orders.blue}/${row.orders.red} engaged=${row.engagedSeconds.toFixed(1)}s`);
    }
  }
  const count = (winner: Winner) => rows.filter((row) => row.winner === winner).length;
  const blue = count("blue");
  const red = count("red");
  const draws = count("draw");
  const resolved = blue + red;
  const sum = (value: (row: MatchResult) => number) => rows.reduce((total, row) => total + value(row), 0);
  console.log(`  blue=${blue} red=${red} draw=${draws} resolved=${resolved}/40` +
    ` | blue win=${(blue / 40 * 100).toFixed(1)}% red win=${(red / 40 * 100).toFixed(1)}% (denominator 40, draws included)`);
  console.log(`  effective damage B/R=${sum((row) => row.damage.blue)}/${sum((row) => row.damage.red)}` +
    ` shots=${sum((row) => row.shots.blue)}/${sum((row) => row.shots.red)}` +
    ` applied commands=${sum((row) => row.orders.blue)}/${sum((row) => row.orders.red)}` +
    ` engaged matches=${rows.filter((row) => row.damage.blue + row.damage.red > 0).length}/40` +
    ` contact-or-firing time=${sum((row) => row.engagedSeconds).toFixed(1)}s`);
  assert.equal(rows.length, 40);
  assert.ok(resolved > 0, "all stalemates: balance is inconclusive, not a passing result");
  assert.ok(rows.every((row) => row.damage.blue + row.damage.red > 0 && row.engagedSeconds > 0),
    "a match had no actual damage/engagement");
  for (const team of TEAMS) {
    assert.ok(sum((row) => row.damage[team]) > 0 && sum((row) => row.shots[team]) > 0);
    assert.ok(rows.every((row) => row.orders[team] > 0), `${team} commander inactive in a match`);
  }
  assert.ok(blue / 40 <= 0.65, `blue exceeds 65%: ${blue}/40`);
  assert.ok(red / 40 <= 0.65, `red exceeds 65%: ${red}/40`);
}

// Suppress per-order debug noise only within this evaluation process.
const originalDebug = console.debug;
console.debug = () => {};
try {
  invariants();
  if (quick) console.log("Balance skipped (--quick); no balance claim made.");
  else check("40 paired commander-vs-commander matches: engagement and neither side above 65%", balance);
} finally { console.debug = originalDebug; }
console.log(`\n${passed} passed, ${failed} failed${quick ? " (invariants only)" : ""}`);
if (failed) process.exitCode = 1;
