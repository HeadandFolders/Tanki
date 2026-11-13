/**
 * Command execution: an open-lane move arrives without reversing, and a move
 * past an enemy in shoot range fires without leaving the lane.
 * Run: npx tsx scripts/eval-motion.ts
 */
import assert from "node:assert/strict";
import { CONFIG } from "../src/config.ts";
import { FIRE_SLOWDOWN } from "../src/config/balance.ts";
import { createWorld, stepWorld, type InputState } from "../src/game.ts";
import { restoreGoal } from "../src/interrupt-stack.ts";
import { driveOrder } from "../src/motion.ts";
import type { Tank, WorldState } from "../src/types.ts";

const DT = 1 / 60;
const INPUT: InputState = {
  keys: new Set<string>(),
  mouseX: 0,
  mouseY: 0,
  shooting: false,
};

function setup(opts: {
  goal: "moveTo" | "holdPosition";
  exact?: boolean;
  enemyOffset: number | null;
}): { world: WorldState; bot: Tank; enemy: Tank | null } {
  const world = createWorld("clear", "mp-offline", "normal", 1, "off");
  world.outcome = "playing";
  world.walls = [];
  world.time = 0;
  const bot = world.tanks.find(
    (t) => t.team === "blue" && t.id !== world.controlledId,
  )!;
  const enemy = world.tanks.find((t) => t.team === "red") ?? null;
  for (const t of world.tanks) {
    if (t.id !== bot.id && t.id !== enemy?.id) t.alive = false;
  }
  bot.x = 180;
  bot.y = 400;
  bot.angle = Math.PI;
  bot.hp = 100000;
  bot.maxHp = 100000;
  bot.cooldown = 0;
  bot.lastShotAt = -999;
  bot.lastKnownPos = { x: bot.x, y: bot.y };
  restoreGoal(bot, {
    kind: opts.goal,
    source: "player",
    params: { x: 980, y: 400, exact: opts.exact === true },
  });
  if (enemy) {
    enemy.alive = true;
    enemy.hp = 100000;
    enemy.maxHp = 100000;
    // A living red keeps the match running. Off the lane, they are not the shot.
    enemy.x = opts.enemyOffset == null ? 1240 : 580;
    enemy.y = opts.enemyOffset == null ? 40 : 400 + opts.enemyOffset;
    restoreGoal(enemy, {
      kind: "holdPosition",
      source: "system",
      params: { x: enemy.x, y: enemy.y },
    });
    enemy.lastKnownPos = { x: enemy.x, y: enemy.y };
  }
  if (opts.enemyOffset != null) {
    // Isolate the motor/shot contract from danger-aware route choice (eval-routes).
    stepWorld(world, 0, INPUT);
    assert.ok(bot.routeCommit);
    bot.routeCommit.points = [{ x: bot.x, y: bot.y }, { x: 980, y: 400 }];
    bot.routeCommit.until = 60;
    bot.routeCommit.cost = 1e9;
  }
  return { world, bot, enemy: opts.enemyOffset != null ? enemy : null };
}

function runMove(opts: {
  goal: "moveTo" | "holdPosition";
  exact?: boolean;
  enemyOffset: number | null;
}) {
  const { world, bot, enemy } = setup(opts);
  const speed = CONFIG.roles[bot.role].speed;
  const radius = opts.exact ? 8 : CONFIG.ai.holdRadius;
  let reverse = 0;
  let maxAbsY = 0;
  let fired = false;
  let firstStep = 0;
  let sawShootOnPath = false;
  let replaced = false;
  // A hull that shoots on the way drives braced, so the lane is budgeted at the
  // slowest speed the run can pay rather than at top speed.
  const frames = Math.ceil((800 / (speed * FIRE_SLOWDOWN.factor) + 2) / DT);
  for (let i = 0; i < frames; i++) {
    const prevX = bot.x;
    const prevY = bot.y;
    const beforeKind = bot.goal.kind;
    stepWorld(world, DT, INPUT);
    if (i === 0) firstStep = bot.x - prevX;
    if (bot.x - prevX < -0.35) reverse++;
    maxAbsY = Math.max(maxAbsY, Math.abs(bot.y - 400));
    if (bot.lastShotAt >= 0) fired = true;
    if (
      enemy &&
      bot.goal.kind === "moveTo" &&
      Math.hypot(bot.x - enemy.x, bot.y - enemy.y) <= CONFIG.mpOffline.shootRange
    ) {
      const clear =
        world.projectiles.some((p) => p.ownerId === bot.id) || bot.lastShotAt >= 0;
      if (clear) sawShootOnPath = true;
    }
    if (
      beforeKind === "moveTo" &&
      bot.goal.kind !== "moveTo" &&
      bot.goal.kind !== "holdPosition"
    ) {
      replaced = true;
    }
    if (
      (bot.goal.kind === "attackNearest" || bot.goal.kind === "patrol") &&
      bot.goal.source === "player"
    ) {
      replaced = true;
    }
    const distGoal = Math.hypot(bot.x - 980, bot.y - 400);
    if (distGoal <= radius && (opts.goal === "holdPosition" || bot.goal.kind === "holdPosition")) {
      const hx = bot.x;
      const hy = bot.y;
      for (let k = 0; k < 45; k++) stepWorld(world, DT, INPUT);
      return {
        dist: Math.hypot(bot.x - 980, bot.y - 400),
        drift: Math.hypot(bot.x - hx, bot.y - hy),
        goal: bot.goal.kind,
        source: bot.goal.source,
        exact: bot.goal.params?.exact === true,
        holdX: bot.goal.params?.x,
        holdY: bot.goal.params?.y,
        reverse,
        maxAbsY,
        fired,
        sawShootOnPath,
        replaced,
        firstStep,
        speed,
        frames: i + 1,
      };
    }
  }
  return {
    dist: Math.hypot(bot.x - 980, bot.y - 400),
    drift: Infinity,
    goal: bot.goal.kind,
    source: bot.goal.source,
    exact: bot.goal.params?.exact === true,
    holdX: bot.goal.params?.x,
    holdY: bot.goal.params?.y,
    reverse,
    maxAbsY,
    fired,
    sawShootOnPath,
    replaced,
    firstStep,
    speed,
    frames,
  };
}

const open = runMove({ goal: "moveTo", enemyOffset: null });
assert.ok(
  open.firstStep > open.speed * DT * 0.85,
  `first frame should drive the path, step ${open.firstStep.toFixed(2)}`,
);
assert.equal(open.reverse, 0, "open lane reversed");
assert.ok(open.dist <= CONFIG.ai.holdRadius, `open lane dist ${open.dist}`);
assert.equal(open.goal, "holdPosition");
assert.equal(open.source, "player");
assert.equal(open.holdX, 980);
assert.equal(open.holdY, 400);
assert.ok(open.drift < 1.5, `drifted after arrival ${open.drift}`);
assert.ok(open.maxAbsY < 12, `left the lane by ${open.maxAbsY}`);

const held = runMove({ goal: "holdPosition", enemyOffset: null });
assert.ok(held.firstStep > held.speed * DT * 0.85, "hold did not start the same frame");
assert.equal(held.reverse, 0, "hold order reversed");
assert.ok(held.dist <= CONFIG.ai.holdRadius, `hold dist ${held.dist}`);
assert.equal(held.goal, "holdPosition");
assert.equal(held.source, "player");
assert.ok(held.drift < 1.5, `hold drifted ${held.drift}`);

const exact = runMove({ goal: "moveTo", exact: true, enemyOffset: null });
assert.equal(exact.reverse, 0, "exact mark reversed");
assert.ok(exact.dist <= 8, `exact dist ${exact.dist}`);
assert.equal(exact.goal, "holdPosition");
assert.equal(exact.exact, true);
assert.equal(exact.source, "player");
assert.ok(exact.drift < 1.5, `exact drifted ${exact.drift}`);

const past = runMove({ goal: "moveTo", enemyOffset: 100 });
assert.equal(past.reverse, 0, "move past an enemy reversed");
assert.equal(past.replaced, false, "player move was replaced because an enemy was nearby");
assert.equal(past.fired, true, "did not fire while passing an enemy in shoot range");
assert.equal(past.sawShootOnPath, true, "shot was not on the move");
assert.ok(past.maxAbsY < 48, `detoured off the lane by ${past.maxAbsY}`);
assert.ok(past.dist <= CONFIG.ai.holdRadius, `enemy move dist ${past.dist}`);
assert.equal(past.goal, "holdPosition");
assert.equal(past.source, "player");

// Right-angle polyline: lookahead should keep speed up, without a reverse.
{
  const points = [
    { x: 100, y: 200 },
    { x: 460, y: 200 },
    { x: 460, y: 560 },
  ];
  let x = 100;
  let y = 200;
  let angle = Math.PI;
  const speed = 130;
  let slow = 0;
  let backed = 0;
  let samples = 0;
  let arrived = false;
  const tank = {};
  for (let i = 0; i < 60 * 10; i++) {
    const drive = driveOrder({
      tank,
      orderKey: "corner",
      points,
      x,
      y,
      angle,
      speed,
      dt: DT,
      arriveRadius: 36,
      goalX: 460,
      goalY: 560,
    });
    if (drive.arrived || Math.hypot(460 - x, 560 - y) <= 36) {
      arrived = true;
      break;
    }
    const step = Math.hypot(drive.moveX, drive.moveY);
    const goalD = Math.hypot(460 - x, 560 - y);
    if (goalD > 70) {
      samples++;
      if (step / DT < speed * 0.8) slow++;
    }
    const before = goalD;
    x += drive.moveX;
    y += drive.moveY;
    angle = drive.angle;
    if (Math.hypot(460 - x, 560 - y) > before + 0.5) backed++;
  }
  assert.equal(arrived, true, `corner did not arrive (${x.toFixed(0)},${y.toFixed(0)})`);
  assert.equal(slow, 0, `corner speed dropped on ${slow}/${samples} frames`);
  assert.ok(backed < 4, `corner reversed on ${backed} frames`);
}

// Grazing a wall must slide at full speed. The free-axis leftover of a
// diagonal used to flip sign and leave the hull vibrating in the open.
{
  const world = createWorld("clear", "mp-offline", "normal", 4, "off");
  world.outcome = "playing";
  world.time = 0;
  world.walls = [{ x: 220, y: 280, w: 520, h: 28, kind: "brick" }];
  const bot = world.tanks.find(
    (t) => t.team === "blue" && t.id !== world.controlledId,
  )!;
  const enemy = world.tanks.find((t) => t.team === "red")!;
  for (const t of world.tanks) {
    if (t.id !== bot.id && t.id !== enemy.id) t.alive = false;
  }
  enemy.x = 80;
  enemy.y = 80;
  enemy.hp = 100000;
  restoreGoal(enemy, { kind: "holdPosition", source: "system", params: { x: 80, y: 80 } });
  bot.x = 280;
  bot.y = 360;
  bot.angle = -Math.PI / 2;
  bot.hp = 100000;
  restoreGoal(bot, {
    kind: "moveTo",
    source: "player",
    params: { x: 760, y: 220 },
  });
  const speed = CONFIG.roles[bot.role].speed;
  // The old thresholds were 72% and 41% of what the 130 px/s hull could cover
  // in this window; the same sliding efficiency is what is being asserted,
  // whatever hull the loadout put in the slot.
  const budget = 90 * DT * speed;
  let path = 0;
  let flips = 0;
  let prevDx = 0;
  let prevDy = 0;
  const x0 = bot.x;
  const y0 = bot.y;
  for (let i = 0; i < 90; i++) {
    const px = bot.x;
    const py = bot.y;
    stepWorld(world, DT, INPUT);
    const dx = bot.x - px;
    const dy = bot.y - py;
    const step = Math.hypot(dx, dy);
    path += step;
    if (i > 8 && step > 0.4 && Math.hypot(prevDx, prevDy) > 0.4) {
      const dot = prevDx * dx + prevDy * dy;
      const mag = Math.hypot(prevDx, prevDy) * step;
      if (dot / mag < -0.2) flips++;
    }
    if (step > 0.05) {
      prevDx = dx;
      prevDy = dy;
    }
  }
  const net = Math.hypot(bot.x - x0, bot.y - y0);
  assert.ok(net > budget * 0.41, `wall graze barely moved, net ${net.toFixed(0)} of ${budget.toFixed(0)}`);
  assert.ok(path > budget * 0.72, `wall graze crawled, path ${path.toFixed(0)} of ${budget.toFixed(0)}`);
  assert.ok(flips < 4, `wall graze vibrated on ${flips} frames`);
}

console.log("ok  open-lane move, exact mark, and shoot-without-detour");
