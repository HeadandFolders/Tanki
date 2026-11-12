import assert from "node:assert/strict";
import { circleHitsWall } from "../src/arena";
import { planRoute } from "../src/ai";
import { CONFIG } from "../src/config";
import { createWorld, startMatch } from "../src/game";
import { driveOrder, fitBodyStep } from "../src/motion";
import { captureReplaySnapshot, ReplayRunner, type ReplayHz } from "../src/replay";
import { detectStuck, replanStuckRoute, type StuckSample, type StuckState } from "../src/stuck";
import type { Goal, Wall } from "../src/types";

type Point = { x: number; y: number };
type Mode = "corridor" | "sealed" | "open" | "hold" | "arrived" | "fight";
const START = { x: 300, y: 400 };
const TARGET = { x: 500, y: 400 };
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

function fixture(hz: ReplayHz, mode: Mode, seed = 7331): ReplayRunner {
  const world = createWorld("clear", "mp-offline", "normal", seed, "off");
  world.walls = [];
  if (mode === "corridor" || mode === "sealed") {
    const x = mode === "sealed" ? 0 : 280;
    const w = mode === "sealed" ? CONFIG.canvasWidth : 80;
    world.walls = [
      { x, y: 352, w, h: 16, kind: "steel" },
      { x, y: 432, w, h: 16, kind: "steel" },
    ];
  }
  world.controlledId = mode === "fight" ? "blue-1" : "blue-2";
  const goals: { tankId: string; goal: Goal }[] = [];
  for (const tank of world.tanks) {
    tank.alive = ["blue-2", "blue-3", "red-2"].includes(tank.id);
    if ((mode === "open" || mode === "fight") && tank.id === "blue-3") tank.alive = false;
    if (!tank.alive) continue;
    tank.x = tank.id === "blue-2" ? 300 : tank.id === "blue-3" ? 322 : mode === "fight" ? 380 : 1150;
    tank.y = tank.team === "red" && mode !== "fight" ? 100 : 400;
    tank.angle = 0;
    tank.lastKnownPos = { x: tank.x, y: tank.y };
    tank.hp = tank.maxHp = 100000;
    if (tank.id !== "blue-2") tank.cooldown = 10000;
    const goal: Goal = tank.id !== "blue-2" || mode === "hold"
      ? { kind: "holdPosition", source: "player", params: { x: tank.x, y: tank.y } }
      : mode === "fight"
        ? { kind: "attackNearest", source: "player", params: { targetTankId: "red-2" } }
        : { kind: "moveTo", source: "player", params: { ...(mode === "arrived" ? START : TARGET), exact: true } };
    goals.push({ tankId: tank.id, goal });
  }
  startMatch(world);
  return new ReplayRunner({ snapshot: captureReplaySnapshot(world, hz),
    commands: [{ tick: 0, utterance: "stuck motor fixture", goals }], inputs: [] });
}

function tankOf(runner: ReplayRunner) {
  return runner.world.tanks.find((tank) => tank.id === "blue-2")!;
}

// Exercise the opt-in motor on the replay clock without wiring the live brains.
function motorTick(runner: ReplayRunner, previous?: StuckState, points = [START, TARGET], mode: Mode = "corridor"): StuckState {
  const tank = tankOf(runner);
  const dt = 1 / runner.hz;
  const allies = runner.world.tanks.filter((ally) => ally.alive && ally.team === tank.team && ally.id !== tank.id);
  const goal = mode === "arrived" ? START : TARGET;
  const drive = mode === "hold" ? { moveX: 0, moveY: 0, angle: tank.angle, arrived: false, blockerAllyIds: [] } : driveOrder({
    tank, orderKey: "move-fixture", points, x: tank.x, y: tank.y, angle: tank.angle,
    speed: CONFIG.roles[tank.role].speed, dt, arriveRadius: 8, goalX: goal.x, goalY: goal.y,
    walls: runner.world.walls, allies,
  });
  tank.x += drive.moveX;
  tank.y += drive.moveY;
  tank.angle = drive.angle;
  assert.ok(!circleHitsWall(tank.x, tank.y, CONFIG.tankRadius, runner.world.walls));
  for (const ally of allies) assert.ok(Math.hypot(tank.x - ally.x, tank.y - ally.y) >= CONFIG.tankRadius * 2 - 1e-6);
  return detectStuck(previous, { time: runner.world.time, dt, movementKey: "move-fixture",
    held: mode === "hold", arrived: drive.arrived, shootingInFightBand: false,
    fittedStep: { x: drive.moveX, y: drive.moveY, blockerAllyIds: drive.blockerAllyIds } });
}

function assertClear(points: Point[], walls: Wall[], ally: Point): void {
  assert.deepEqual(points[0], START);
  assert.deepEqual(points[points.length - 1], TARGET);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let j = 0; j <= steps; j++) {
      const x = a.x + (b.x - a.x) * j / steps, y = a.y + (b.y - a.y) * j / steps;
      assert.ok(!circleHitsWall(x, y, CONFIG.tankRadius, walls), "reroute intersects a wall");
      assert.ok(Math.hypot(x - ally.x, y - ally.y) >= CONFIG.tankRadius * 2 - 1e-4, "reroute cuts through ally");
    }
  }
}

function blockedRun(hz: ReplayHz, mode: "corridor" | "sealed" = "corridor", seed = 7331) {
  const runner = fixture(hz, mode, seed);
  const trace: StuckState[] = [];
  let state: StuckState | undefined;
  runner.run(hz, (r) => {
    state = motorTick(r, state);
    trace.push(state);
  });
  assert.equal(runner.tick, hz);
  const flagged = trace.findIndex((sample) => sample.stuck);
  assert.ok(flagged >= 0, "never flagged");
  const firstFlag = (flagged + 1) / hz;
  assert.ok(firstFlag >= 0.4 && firstFlag <= 0.6, `flagged at ${firstFlag}s`);
  assert.ok(Math.abs(firstFlag - CONFIG.ai.stuckAfterSec) <= 1 / hz);
  assert.ok(trace.slice(flagged).every((sample) => sample.stuck), "flag must remain level-triggered");
  assert.ok(Math.abs(state!.sinceTime!) < 1e-9);
  assert.deepEqual(state!.blockerAllyIds, ["blue-3"]);
  assert.equal(state!.lastStuckAt, runner.world.time);
  const before = JSON.stringify(runner.checkpoint());
  const points = replanStuckRoute(runner.world, tankOf(runner), TARGET, state!, []);
  assert.equal(JSON.stringify(runner.checkpoint()), before, "reroute mutated world, route cache, goals or stack");
  if (mode === "corridor") {
    assert.ok(points, "corridor has a route around its ends");
    assertClear(points, runner.world.walls, { x: 322, y: 400 });
  } else {
    assert.equal(points, null, "sealed corridor must report no route, not a path through the ally");
  }
  return { runner, trace, state: state!, points };
}

const originalRandom = Math.random;
const originalFetch = globalThis.fetch;
let randomCalls = 0;
let fetchCalls = 0;
Math.random = () => { randomCalls++; throw new Error("Unseeded randomness in stuck replay"); };
globalThis.fetch = async () => { fetchCalls++; throw new Error("Network/model call in stuck replay"); };
try {
  for (const hz of [30, 60] as const) {
    check(`ally blocks corridor, flags at 0.5s, reroutes (${hz} Hz)`, () => {
      const { runner, points, state } = blockedRun(hz);
      let current = state;
      let recovered = false;
      runner.run(hz * 6, (r) => {
        current = motorTick(r, current, points!);
        if (!current.stuck) recovered = true;
      });
      assert.ok(recovered, "rerouted motor never recovered");
      assert.ok(Math.hypot(tankOf(runner).x - TARGET.x, tankOf(runner).y - TARGET.y) <= 8.1, "reroute motor did not arrive");
      assert.ok(current.lastStuckAt !== null, "recovery erased stuck history");
    });
    check(`sealed corridor reports no route (${hz} Hz)`, () => { blockedRun(hz, "sealed"); });
    for (const mode of ["hold", "arrived", "open"] as const) {
      check(`no false positives: ${mode} (${hz} Hz)`, () => {
        const runner = fixture(hz, mode);
        let state: StuckState | undefined;
        runner.run(hz * 2, (r) => {
          state = motorTick(r, state, [START, mode === "arrived" ? START : TARGET], mode);
          assert.equal(state.stuck, false);
          assert.equal(state.sinceTime, null);
          assert.equal(state.lastStuckAt, null);
        });
      });
    }
    check(`fight-band shooting, including cooldown gaps, never flags (${hz} Hz)`, () => {
      const runner = fixture(hz, "fight");
      let state: StuckState | undefined;
      runner.run(hz * 2, (r) => {
        const tank = tankOf(r);
        assert.equal(tank.goal.kind, "attackNearest");
        assert.ok(Math.hypot(tank.x - START.x, tank.y - START.y) < 1e-6);
        state = detectStuck(state, { time: r.world.time, dt: 1 / r.hz, movementKey: "attack-red-2",
          held: false, arrived: false, shootingInFightBand: true,
          fittedStep: fitBodyStep(tank.x, tank.y, 0, 0, r.world.walls) });
        assert.equal(state.stuck, false);
      });
      assert.ok(runner.events.some((event) => event.type === "shot" && event.tankId === "blue-2"));
      assert.equal(state!.lastStuckAt, null);
    });
  }

  check("same seed, interleaved worlds and JSON checkpoint preserve detector results", () => {
    const a = blockedRun(60);
    const b = blockedRun(60);
    assert.deepEqual(a.trace, b.trace);
    assert.deepEqual(a.points, b.points);
    assert.deepEqual(a.runner.checkpoint(), b.runner.checkpoint());
    const first = fixture(60, "corridor");
    let left: StuckState | undefined;
    first.run(17, (r) => { left = motorTick(r, left); });
    const second = new ReplayRunner(jsonCopy(first.checkpoint()));
    let right: StuckState = jsonCopy(left);
    const unrelated = fixture(30, "open", 99);
    for (let i = 0; i < 60; i++) {
      first.run(1, (r) => { left = motorTick(r, left); });
      unrelated.step();
      second.run(1, (r) => { right = motorTick(r, right); });
      assert.deepEqual(left, right);
    }
    assert.deepEqual(jsonCopy(first.checkpoint()), jsonCopy(second.checkpoint()));
  });

  check("pure state: recovery, exemptions and changed movement reset timing but retain history", () => {
    const sample: StuckSample = { time: 0.5, dt: 1 / 60, movementKey: "move-a", held: false,
      arrived: false, shootingInFightBand: false, fittedStep: { x: 0, y: 0, blockerAllyIds: ["b", "a", "b"] } };
    const previous: StuckState = { movementKey: "move-a", stillFor: 0.49, stuck: false,
      sinceTime: 0, blockerAllyIds: [], lastStuckAt: null };
    Object.freeze(previous.blockerAllyIds);
    Object.freeze(previous);
    const flagged = detectStuck(previous, sample);
    assert.equal(flagged.stuck, true);
    assert.deepEqual(flagged.blockerAllyIds, ["a", "b"]);
    assert.deepEqual(detectStuck(previous, sample), flagged);
    for (const change of [{ held: true }, { arrived: true }, { shootingInFightBand: true },
      { movementKey: null }, { fittedStep: { x: 2, y: 0 } }]) {
      const reset = detectStuck(flagged, { ...sample, time: 1, ...change });
      assert.equal(reset.stuck, false);
      assert.equal(reset.sinceTime, null);
      assert.equal(reset.lastStuckAt, 0.5);
      assert.deepEqual(reset.blockerAllyIds, []);
      assert.equal(detectStuck(reset, { ...sample, time: 1 + sample.dt }).stuck, false);
    }
    const changed = detectStuck(flagged, { ...sample, movementKey: "move-b" });
    assert.equal(changed.stuck, false);
    assert.equal(changed.stillFor, sample.dt);
    assert.equal(detectStuck(undefined, sample).lastStuckAt, null, "another tank inherited history");
    assert.equal(detectStuck(previous, { ...sample, fittedStep: { x: sample.dt * 0.5, y: 0 } }).stuck, true);
    assert.equal(detectStuck(previous, { ...sample, fittedStep: { x: sample.dt * 2, y: 0 } }).stuck, false);
  });

  check("ally fitting is opt-in, swept, and permits moving away or tangentially", () => {
    const ally = { id: "blue-3", x: 322, y: 400 };
    assert.deepEqual(fitBodyStep(300, 400, 2, 0, []), { x: 2, y: 0 });
    assert.deepEqual(fitBodyStep(300, 400, 2, 0, [], []), { x: 2, y: 0 });
    assert.deepEqual(fitBodyStep(300, 400, 2, 0, [], [ally]), { x: 0, y: 0, blockerAllyIds: [ally.id] });
    assert.equal(fitBodyStep(300, 400, -2, 0, [], [ally]).x, -2);
    assert.equal(fitBodyStep(300, 400, 0, 2, [], [ally]).y, 2);
    assert.equal(fitBodyStep(250, 400, 200, 0, [], [ally]).x, 50);
    assert.equal(fitBodyStep(310, 400, -2, 0, [], [ally]).x, -2);
  });

  check("temporary blocker costs never contaminate default routes or caches", () => {
    const walls: Wall[] = [];
    const args = [300, 400, 500, 400, walls, CONFIG.tankRadius, []] as const;
    const before = planRoute(...args);
    assert.deepEqual(before, [START, TARGET]);
    const detour = planRoute(...args, [{ x: 322, y: 400 }]);
    assert.ok(detour.length > 2);
    assertClear(detour, walls, { x: 322, y: 400 });
    assert.deepEqual(planRoute(...args), before);
    assert.deepEqual(planRoute(...args, []), before);
  });

  check("rerouting ignores dead, enemy and self IDs and does not run before stuck", () => {
    const { runner, state } = blockedRun(60);
    assert.equal(replanStuckRoute(runner.world, tankOf(runner), TARGET, { ...state, stuck: false }, []), null);
    const ally = runner.world.tanks.find((tank) => tank.id === "blue-3")!;
    ally.alive = false;
    const points = replanStuckRoute(runner.world, tankOf(runner), TARGET,
      { ...state, blockerAllyIds: [ally.id, "red-2", "blue-2"] }, []);
    assert.deepEqual(points, [START, TARGET]);
  });

  check("all stuck replays avoided network/models and unseeded randomness", () => {
    assert.equal(randomCalls, 0);
    assert.equal(fetchCalls, 0);
  });
} finally {
  Math.random = originalRandom;
  globalThis.fetch = originalFetch;
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
