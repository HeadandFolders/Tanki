/**
 * Headless battle-plan check. No microphone.
 * Run: npx tsx scripts/eval-battle-plan.ts
 *
 * Commander faces east, enemies sit to the north.
 * "3 take the left and I'll take the right" puts tank 3 on the commander's
 * left and does not order the commander. "4 hold" leaves tank 3's goal.
 */
import assert from "node:assert/strict";
import { circleHitsWall } from "../src/arena.ts";
import {
  applyBattlePlan,
  battleIntentsFromUtterance,
} from "../src/battle-plan.ts";
import { CONFIG } from "../src/config.ts";
import { createWorld } from "../src/game.ts";
import type { Tank, Wall, WorldState } from "../src/types.ts";

const TILE = CONFIG.tileSize;

function borders(): Wall[] {
  return [
    { x: 0, y: 0, w: 1280, h: 32, kind: "border" },
    { x: 0, y: 32, w: 32, h: 768, kind: "border" },
    { x: 1248, y: 32, w: 32, h: 768, kind: "border" },
    { x: 32, y: 768, w: 1216, h: 32, kind: "border" },
  ];
}

/** Slab whose center is the naive left-lane point. A wall center is not an anchor. */
function blockingSlab(): Wall {
  return { x: 680, y: 260, w: 320, h: 200, kind: "brick" };
}

function stage(
  walls: Wall[],
  enemyX: number,
): { world: WorldState; commander: Tank } {
  const world = createWorld("clear", "tdm", "normal", 1);
  world.walls = walls;
  const commander = world.tanks.find((t) => t.team === "blue" && t.number === 1)!;
  world.controlledId = commander.id;
  commander.x = 640;
  commander.y = 500;
  commander.angle = 0;
  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    if (tank.team === "red") {
      tank.x = enemyX;
      tank.y = 160;
      continue;
    }
    if (tank.id === commander.id) continue;
    tank.x = 180 + tank.number * 70;
    tank.y = 700;
    tank.angle = 0;
  }
  return { world, commander };
}

function isTileCenter(n: number): boolean {
  const k = (n - TILE / 2) / TILE;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

function onWallCenter(x: number, y: number, walls: Wall[]): boolean {
  return walls.some((w) => {
    const cx = w.x + w.w / 2;
    const cy = w.y + w.h / 2;
    return Math.abs(x - cx) < 1 && Math.abs(y - cy) < 1;
  });
}

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

console.log("Battle plan");

check("3 take the left, I'll take the right — tank 3 on the left, commander untouched", () => {
  const slab = blockingSlab();
  const { world, commander } = stage([...borders(), slab], 640);
  const tank3 = world.tanks.find((t) => t.team === "blue" && t.number === 3)!;
  const before = new Map(world.tanks.map((t) => [t.id, t.goal]));
  const phrase = "3 take the left and I'll take the right";
  const intents = battleIntentsFromUtterance(phrase);
  assert.ok(intents.some((i) => i.tankNumbers.includes(3) && i.namedSide === "left"));
  assert.ok(intents.some((i) => i.speakerSide === "right"));

  const plan = applyBattlePlan(world, phrase, intents);
  assert.equal(plan.reservedSide, "right");
  assert.ok(plan.reservedAnchor, "speaker lane has a free tile");
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0]!.side, "left");
  assert.equal(plan.assignments[0]!.risk, "normal");
  assert.ok(!plan.addressedIds.includes(commander.id));
  assert.ok(plan.assignments.every((a) => a.tankId !== commander.id));
  assert.notEqual(plan.assignments[0]!.tankId, commander.id);

  assert.equal(tank3.goal.kind, "moveTo");
  assert.equal(tank3.goal.source, "player");
  assert.equal(tank3.goal.params?.side, "left");
  assert.equal(tank3.goal.params?.risk, "normal");
  const gx = tank3.goal.params?.x ?? NaN;
  const gy = tank3.goal.params?.y ?? NaN;
  assert.ok(gy < commander.y - 48, `left of an east-facing hull is north, y=${gy}`);
  assert.ok(isTileCenter(gx) && isTileCenter(gy), "anchor is a tile center");
  assert.equal(onWallCenter(gx, gy, world.walls), false);
  assert.equal(circleHitsWall(gx, gy, CONFIG.tankRadius, world.walls), false);
  assert.ok(plan.reservedAnchor!.y > commander.y + 48, "reserved lane stays on the right");
  assert.equal(onWallCenter(plan.reservedAnchor!.x, plan.reservedAnchor!.y, world.walls), false);
  assert.notEqual(tank3.id, commander.id);

  for (const tank of world.tanks) {
    if (tank.id === tank3.id) {
      assert.notEqual(tank.goal, before.get(tank.id));
    } else {
      assert.equal(tank.goal, before.get(tank.id), `untouched #${tank.number} ${tank.team}`);
    }
  }

  const goal3 = tank3.goal;
  const goalCmd = commander.goal;
  const holdPhrase = "4 hold";
  const holdIntents = battleIntentsFromUtterance(holdPhrase);
  applyBattlePlan(world, holdPhrase, holdIntents);
  const tank4 = world.tanks.find((t) => t.team === "blue" && t.number === 4)!;
  assert.equal(tank3.goal, goal3, "tank 3 keeps the flank goal");
  assert.equal(tank3.goal.params?.side, "left");
  assert.equal(tank3.goal.params?.risk, "normal");
  assert.equal(commander.goal, goalCmd, "commander still has no order");
  assert.equal(tank4.goal.kind, "holdPosition");
  assert.equal(tank4.goal.source, "player");
  assert.notEqual(tank4.id, commander.id);
});

check("several named tanks share the complementary lane without stacking", () => {
  const { world, commander } = stage(borders(), 640);
  const tank2 = world.tanks.find((t) => t.team === "blue" && t.number === 2)!;
  const tank3 = world.tanks.find((t) => t.team === "blue" && t.number === 3)!;
  tank2.x = 400;
  tank2.y = 700;
  tank3.x = 900;
  tank3.y = 700;
  const cmdGoal = commander.goal;
  const phrase = "2 and 3 take the left and I'll take the right";
  const plan = applyBattlePlan(world, phrase, battleIntentsFromUtterance(phrase));
  assert.equal(plan.assignments.length, 2);
  assert.ok(plan.assignments.every((a) => a.side === "left"));
  assert.equal(commander.goal, cmdGoal);
  const g2x = tank2.goal.params?.x ?? 0;
  const g2y = tank2.goal.params?.y ?? 0;
  const g3x = tank3.goal.params?.x ?? 0;
  const g3y = tank3.goal.params?.y ?? 0;
  assert.ok(g2y < commander.y - 48 && g3y < commander.y - 48);
  assert.ok(g2x < g3x, "the tank already further ahead keeps the forward slot");
  const gap = Math.hypot(g3x - g2x, g3y - g2y);
  assert.ok(gap >= CONFIG.tankRadius * 2 + 8, `spread gap ${gap}`);
  assert.equal(circleHitsWall(g2x, g2y, CONFIG.tankRadius, world.walls), false);
  assert.equal(circleHitsWall(g3x, g3y, CONFIG.tankRadius, world.walls), false);
});

check("speaker lane is not given out even if a tank was told that side", () => {
  const { world, commander } = stage(borders(), 640);
  const tank3 = world.tanks.find((t) => t.team === "blue" && t.number === 3)!;
  const phrase = "3 take the right and I'll take the right";
  const plan = applyBattlePlan(world, phrase, battleIntentsFromUtterance(phrase));
  assert.equal(plan.reservedSide, "right");
  assert.equal(tank3.goal.params?.side, "left");
  assert.ok((tank3.goal.params?.y ?? 999) < commander.y - 48);
  assert.ok(!plan.addressedIds.includes(commander.id));
});

check("enemy positions pull the lane forward", () => {
  const near = stage(borders(), 640);
  const far = stage(borders(), 1100);
  const phrase = "3 take the left and I'll take the right";
  const intents = battleIntentsFromUtterance(phrase);
  applyBattlePlan(near.world, phrase, intents);
  applyBattlePlan(far.world, phrase, intents);
  const nearX =
    near.world.tanks.find((t) => t.team === "blue" && t.number === 3)!.goal.params?.x ?? 0;
  const farX =
    far.world.tanks.find((t) => t.team === "blue" && t.number === 3)!.goal.params?.x ?? 0;
  assert.ok(farX > nearX + 20, `enemy further east should move the anchor east (${nearX} → ${farX})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
