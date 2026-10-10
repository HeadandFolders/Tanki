/**
 * Order / goal-schema eval suite (roadmap P0).
 * Run: npm run eval:orders
 */
import assert from "node:assert/strict";
import { beliefViewers, updateTeamBelief } from "../src/belief.ts";
import { createWorld } from "../src/game.ts";
import { GOAL_KINDS, isGoalKind } from "../src/goals.ts";
import {
  interpretOffline,
  sanitizeOrders,
} from "../src/orders.ts";
import type { OrderResult, Tank, WorldState } from "../src/types.ts";

let failed = 0;
let passed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

function livingBlues(world: WorldState): Tank[] {
  return world.tanks.filter((t) => t.team === "blue" && t.alive);
}

function expectGoal(
  results: OrderResult[],
  goal: string,
  minTanks = 1,
): void {
  assert.ok(results.length >= minTanks, `expected ≥${minTanks} results`);
  for (const r of results) {
    assert.equal(r.goal, goal, `expected ${goal}, got ${r.goal}`);
    assert.ok(isGoalKind(r.goal), `invalid goal ${r.goal}`);
  }
}

console.log("Goal schema");
check("GOAL_KINDS includes scout + core verbs", () => {
  for (const g of [
    "moveTo",
    "holdPosition",
    "attackNearest",
    "escort",
    "scout",
    "spreadOut",
  ] as const) {
    assert.ok(GOAL_KINDS.includes(g));
  }
  assert.equal(isGoalKind("moveTo"), true);
  assert.equal(isGoalKind("flyAway"), false);
});

console.log("Offline interpret gold cases");
{
  const world = createWorld("report", "tdm", "normal");
  const tanks = world.tanks;

  check("cover me → escort commander", () => {
    const r = interpretOffline("cover me", tanks, world);
    assert.ok(r.length >= 1);
    for (const o of r) {
      assert.equal(o.goal, "escort");
      assert.equal(o.params?.targetTankId, world.controlledId);
      assert.notEqual(o.tankId, world.controlledId);
    }
  });

  check("4, cover me → bodyguard #4 only", () => {
    const r = interpretOffline("4, cover me", tanks, world);
    assert.equal(r.length, 1);
    assert.equal(r[0].goal, "escort");
    const body = livingBlues(world).find((t) => t.id === r[0].tankId);
    assert.ok(body);
    assert.equal(body!.number, 4);
    assert.equal(r[0].params?.targetTankId, world.controlledId);
  });

  check("move to bottom left → moveTo with coords", () => {
    const r = interpretOffline("all move to bottom left", tanks, world);
    expectGoal(r, "moveTo", 2);
    for (const o of r) {
      assert.ok(o.params?.x != null && o.params?.y != null);
      assert.ok(o.params!.y! > 500, "bottom-left should be southern");
    }
  });

  check("scout ahead → scout goal", () => {
    const r = interpretOffline("scouts scout ahead", tanks, world);
    expectGoal(r, "scout", 1);
  });

  check("spread out → spreadOut", () => {
    const r = interpretOffline("everyone spread out", tanks, world);
    expectGoal(r, "spreadOut", 2);
  });

  check("hold north → holdPosition", () => {
    const r = interpretOffline("gunners hold north", tanks, world);
    expectGoal(r, "holdPosition", 1);
  });

  check("attack / hunt → attackNearest", () => {
    const r = interpretOffline("all attack", tanks, world);
    expectGoal(r, "attackNearest", 2);
  });

  check("3, attack enemy tank #2 → blue #3 targets red #2", () => {
    const r = interpretOffline("3, attack enemy tank #2", tanks, world);
    assert.equal(r.length, 1);
    assert.equal(r[0].goal, "attackNearest");
    const body = livingBlues(world).find((t) => t.id === r[0].tankId);
    assert.ok(body);
    assert.equal(body!.number, 3);
    const red2 = world.tanks.find(
      (t) => t.team === "red" && t.number === 2 && t.alive,
    );
    assert.ok(red2);
    assert.equal(r[0].params?.targetTankId, red2!.id);
  });

  check("all attack enemy #5 → company focus-fires red #5", () => {
    const r = interpretOffline("all attack enemy #5", tanks, world);
    expectGoal(r, "attackNearest", 2);
    const red5 = world.tanks.find(
      (t) => t.team === "red" && t.number === 5 && t.alive,
    );
    assert.ok(red5);
    for (const o of r) {
      assert.equal(o.params?.targetTankId, red5!.id);
    }
  });

  check("retreat → retreat", () => {
    const r = interpretOffline("fall back", tanks, world);
    expectGoal(r, "retreat", 1);
  });
}

console.log("sanitizeOrders");
{
  const world = createWorld("clear", "tdm");
  const tanks = world.tanks;
  const controlled = world.controlledId;

  check("drops dead/invalid tankIds and bad goals", () => {
    const dirty: OrderResult[] = [
      {
        tankId: "red-1",
        goal: "attackNearest",
        chatLine: "nope",
      },
      {
        tankId: controlled,
        goal: "flyAway" as OrderResult["goal"],
        chatLine: "bad",
      },
      {
        tankId: controlled,
        goal: "moveTo",
        params: {},
        chatLine: "#?: moving",
      },
    ];
    const clean = sanitizeOrders(
      dirty,
      tanks,
      "move to bottom left",
      world,
    );
    assert.equal(clean.length, 1);
    assert.equal(clean[0].goal, "moveTo");
    assert.ok(clean[0].params?.x != null);
  });

  check("escort self → retarget commander", () => {
    const body = livingBlues(world).find((t) => t.id !== controlled)!;
    const clean = sanitizeOrders(
      [
        {
          tankId: body.id,
          goal: "escort",
          params: { targetTankId: body.id },
          chatLine: `#${body.number}: escort`,
        },
      ],
      tanks,
      "cover me",
      world,
    );
    assert.equal(clean.length, 1);
    assert.equal(clean[0].params?.targetTankId, controlled);
  });

  check("sanitize fills red target for enemy attack order", () => {
    const body = livingBlues(world).find((t) => t.number === 4)!;
    const red2 = world.tanks.find(
      (t) => t.team === "red" && t.number === 2 && t.alive,
    )!;
    const clean = sanitizeOrders(
      [
        {
          tankId: body.id,
          goal: "attackNearest",
          params: {},
          chatLine: `#4: ack`,
        },
      ],
      tanks,
      "4, attack enemy tank #2",
      world,
    );
    assert.equal(clean.length, 1);
    assert.equal(clean[0].params?.targetTankId, red2.id);
  });
}

console.log("Fog spawn defaults");
{
  const fogWorld = createWorld("report", "tdm");
  const clearWorld = createWorld("clear", "tdm");

  check("fog: scouts start on scout, gunners hold", () => {
    const scouts = fogWorld.tanks.filter(
      (t) => t.team === "blue" && t.role === "scout",
    );
    const guns = fogWorld.tanks.filter(
      (t) => t.team === "blue" && t.role === "shooter",
    );
    assert.ok(scouts.every((t) => t.goal.kind === "scout"));
    assert.ok(guns.every((t) => t.goal.kind === "holdPosition"));
  });

  check("clear: blues patrol (push mid)", () => {
    const blues = clearWorld.tanks.filter((t) => t.team === "blue");
    assert.ok(blues.every((t) => t.goal.kind === "patrol"));
  });

  check("world has teamBelief + redDifficulty", () => {
    assert.ok(Array.isArray(fogWorld.teamBelief.contacts));
    assert.equal(fogWorld.redDifficulty, "normal");
  });
}

console.log("Team belief");
{
  const world = createWorld("report", "tdm");
  world.outcome = "playing";
  // Park a blue scout on top of a red so LOS is trivial
  const scout = world.tanks.find((t) => t.team === "blue" && t.role === "scout")!;
  const red = world.tanks.find((t) => t.team === "red")!;
  scout.x = red.x;
  scout.y = red.y + 20;

  check("report mode: all blues are belief viewers", () => {
    const viewers = beliefViewers(world);
    assert.equal(
      viewers.length,
      world.tanks.filter((t) => t.team === "blue" && t.alive).length,
    );
  });

  check("updateTeamBelief records contact when scout sees red", () => {
    updateTeamBelief(world);
    assert.ok(
      world.teamBelief.contacts.some((c) => c.enemyId === red.id),
      "expected contact for visible red",
    );
  });

  check("none mode: only controlled feeds belief", () => {
    world.shareMode = "none";
    const viewers = beliefViewers(world);
    assert.equal(viewers.length, 1);
    assert.equal(viewers[0].id, world.controlledId);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
