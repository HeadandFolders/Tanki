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

  check("Tanks #1 and #5 attack enemy tank #6 → only those two", () => {
    const r = interpretOffline(
      "Tanks #1 and #5 attack enemy tank #6",
      tanks,
      world,
    );
    assert.equal(r.length, 2);
    const nums = r
      .map((o) => livingBlues(world).find((t) => t.id === o.tankId)?.number)
      .sort();
    assert.deepEqual(nums, [1, 5]);
    const red6 = world.tanks.find(
      (t) => t.team === "red" && t.number === 6 && t.alive,
    );
    assert.ok(red6);
    for (const o of r) {
      assert.equal(o.goal, "attackNearest");
      assert.equal(o.params?.targetTankId, red6!.id);
    }
  });

  check("3 and 4 attack 2 → only those two, enemy is #2", () => {
    const r = interpretOffline("3 and 4 attack 2", tanks, world);
    assert.equal(r.length, 2);
    const nums = r
      .map((o) => livingBlues(world).find((t) => t.id === o.tankId)?.number)
      .sort();
    assert.deepEqual(nums, [3, 4]);
    const red2 = world.tanks.find(
      (t) => t.team === "red" && t.number === 2 && t.alive,
    );
    assert.ok(red2);
    for (const o of r) {
      assert.equal(o.goal, "attackNearest");
      assert.equal(o.params?.targetTankId, red2!.id);
    }
    assert.ok(!r.some((o) => o.tankId.endsWith("-2") && o.tankId.startsWith("blue")));
  });

  check("2 and 3 attack 5 and 6 → only those allies, both enemies", () => {
    for (const phrase of [
      "2 and 3 attack 5 and 6",
      "Tanks #2 and #3 attack enemy tanks #5 and #6",
      "two and three attack five and six",
    ]) {
      for (const mode of ["tdm", "mp-offline"] as const) {
        const w = mode === "tdm" ? world : createWorld("clear", mode);
        const r = interpretOffline(phrase, w.tanks, w);
        assert.equal(r.length, 2, `${mode} ${phrase}`);
        const blues = w.tanks.filter((t) => t.team === "blue" && t.alive);
        const nums = r
          .map((o) => blues.find((t) => t.id === o.tankId)?.number)
          .sort();
        assert.deepEqual(nums, [2, 3]);
        const red5 = w.tanks.find(
          (t) => t.team === "red" && t.number === 5 && t.alive,
        );
        const red6 = w.tanks.find(
          (t) => t.team === "red" && t.number === 6 && t.alive,
        );
        assert.ok(red5 && red6);
        for (const o of r) {
          assert.equal(o.goal, "attackNearest");
          assert.deepEqual(o.params?.targetTankIds, [red5!.id, red6!.id]);
        }
      }
    }
  });

  check("1 attack 6 → blue #1 targets red #6", () => {
    const r = interpretOffline("1 attack 6", tanks, world);
    assert.equal(r.length, 1);
    const body = livingBlues(world).find((t) => t.id === r[0].tankId);
    assert.equal(body?.number, 1);
    const red6 = world.tanks.find(
      (t) => t.team === "red" && t.number === 6 && t.alive,
    );
    assert.equal(r[0].params?.targetTankId, red6?.id);
  });

  check("spoken two and three attack five", () => {
    const r = interpretOffline("two and three attack five", tanks, world);
    const nums = r
      .map((o) => livingBlues(world).find((t) => t.id === o.tankId)?.number)
      .sort();
    assert.deepEqual(nums, [2, 3]);
    const red5 = world.tanks.find(
      (t) => t.team === "red" && t.number === 5 && t.alive,
    );
    for (const o of r) assert.equal(o.params?.targetTankId, red5?.id);
  });

  check("spoken four attack two", () => {
    const r = interpretOffline("four attack two", tanks, world);
    assert.equal(r.length, 1);
    const body = livingBlues(world).find((t) => t.id === r[0].tankId);
    assert.equal(body?.number, 4);
    const red2 = world.tanks.find(
      (t) => t.team === "red" && t.number === 2 && t.alive,
    );
    assert.equal(r[0].params?.targetTankId, red2?.id);
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

  check("3 move to the mark → only #3, exact point", () => {
    world.playerMarks.blue = { x: 240, y: 610 };
    const r = interpretOffline("3 move to the mark", tanks, world);
    assert.equal(r.length, 1);
    const body = livingBlues(world).find((t) => t.id === r[0].tankId);
    assert.equal(body?.number, 3);
    assert.equal(r[0].goal, "moveTo");
    assert.equal(r[0].params?.x, 240);
    assert.equal(r[0].params?.y, 610);
    assert.equal(r[0].params?.exact, true);
  });

  check("Tanks #1 and #5 move to the mark → only those two", () => {
    for (const mode of ["tdm", "mp-offline"] as const) {
      const w = mode === "tdm" ? world : createWorld("clear", mode);
      w.playerMarks.blue = { x: 400, y: 500 };
      const r = interpretOffline("Tanks #1 and #5 move to the mark", w.tanks, w);
      assert.equal(r.length, 2, mode);
      const blues = w.tanks.filter((t) => t.team === "blue" && t.alive);
      const nums = r
        .map((o) => blues.find((t) => t.id === o.tankId)?.number)
        .sort();
      assert.deepEqual(nums, [1, 5]);
      for (const o of r) {
        assert.equal(o.params?.x, 400);
        assert.equal(o.params?.y, 500);
        assert.equal(o.params?.exact, true);
      }
    }
  });

  check("move to the mark with no X orders nobody", () => {
    world.playerMarks.blue = null;
    const r = interpretOffline("4 move to the mark", tanks, world);
    assert.equal(r.length, 0);
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

  check("mp: every bot holds its spawn", () => {
    for (const mode of ["mp-offline", "mp-online"] as const) {
      const w = createWorld("clear", mode);
      for (const t of w.tanks) {
        assert.equal(t.goal.kind, "holdPosition");
        assert.equal(t.goal.source, "system");
        assert.ok(Math.abs((t.goal.params?.x ?? -1) - t.x) < 0.01);
        assert.ok(Math.abs((t.goal.params?.y ?? -1) - t.y) < 0.01);
      }
    }
  });

  check("mp: vague order holds the current spot", () => {
    const w = createWorld("clear", "mp-online");
    const r = interpretOffline("do something", w.tanks, w);
    assert.ok(r.length > 0);
    assert.ok(r.every((o) => o.goal === "holdPosition"));
    for (const o of r) {
      const t = w.tanks.find((x) => x.id === o.tankId)!;
      assert.equal(o.params?.x, t.x);
      assert.equal(o.params?.y, t.y);
    }
  });

  check("mp: move south and shoot at will only moves", () => {
    const w = createWorld("clear", "mp-online");
    const r = interpretOffline("2 move south and shoot at will", w.tanks, w);
    assert.equal(r.length, 1);
    assert.equal(r[0].goal, "moveTo");
    const tank = w.tanks.find((t) => t.id === r[0].tankId);
    assert.equal(tank?.number, 2);
    assert.ok((r[0].params?.y ?? 0) > 500);
  });

  check("mp: take the right does not also order the speaker left", () => {
    const w = createWorld("clear", "mp-online");
    const r = interpretOffline(
      "3 take the right and I'll take the left",
      w.tanks,
      w,
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].goal, "moveTo");
    const tank = w.tanks.find((t) => t.id === r[0].tankId);
    assert.equal(tank?.number, 3);
    assert.ok((r[0].params?.x ?? 0) > 900);
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
