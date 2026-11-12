/**
 * Headless route checks: danger-aware detours, direct runs when safe,
 * and smoothed polylines.
 * Run: npx tsx scripts/eval-routes.ts
 */
import assert from "node:assert/strict";
import { buildArena, segmentHitsWall } from "../src/arena.ts";
import { planOrderedRoute } from "../src/ai.ts";
import type { Wall } from "../src/types.ts";

type Pt = { x: number; y: number };
type Foe = { id: string; x: number; y: number; gunRange: number };

let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

const brick = (x: number, y: number, w: number, h: number): Wall => ({
  x,
  y,
  w,
  h,
  kind: "brick",
});

function sampleRoute(route: Pt[], every = 8): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / every));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function show(route: Pt[]): string {
  return route.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(" ");
}

function seenBy(foe: Foe, walls: Wall[], p: Pt): boolean {
  return !segmentHitsWall(p.x, p.y, foe.x, foe.y, walls);
}

check("open gap beats the short gap an enemy covers", () => {
  // A west baffle hides a long corridor. The short gap in the main wall is the
  // shortcut, and the enemy stands where that gap is a clear shot.
  const walls: Wall[] = [
    brick(480, 60, 40, 280),
    brick(480, 400, 40, 150),
    brick(480, 630, 40, 200),
    brick(220, 240, 40, 340),
    brick(520, 400, 520, 48),
  ];
  const enemy: Foe = { id: "red-1", x: 560, y: 370, gunRange: 500 };
  const tank = { x: 140, y: 140 };
  const goal = { x: 760, y: 590 };
  assert.equal(seenBy(enemy, walls, tank), false, "start is out of the shot");
  assert.equal(seenBy(enemy, walls, goal), false, "goal is out of the shot");
  assert.equal(seenBy(enemy, walls, { x: 500, y: 370 }), true, "short gap is in the shot");

  const route = planOrderedRoute(tank.x, tank.y, goal.x, goal.y, walls, [enemy]);
  const samples = sampleRoute(route);
  const seen = samples.filter((p) => seenBy(enemy, walls, p));
  assert.equal(seen.length, 0, `enters the clear shot; route ${show(route)}`);
  assert.ok(
    samples.some((p) => p.x > 450 && p.x < 540 && p.y > 550 && p.y < 630),
    `uses the open gap; route ${show(route)}`,
  );
});

check("detours behind cover instead of crossing watched open ground", () => {
  // Open field. A low wall shelters a lane ~4 cells south of the straight line.
  const walls: Wall[] = [brick(340, 450, 600, 36)];
  const enemy: Foe = { id: "red-1", x: 640, y: 230, gunRange: 420 };
  const tank = { x: 200, y: 400 };
  const goal = { x: 1080, y: 400 };
  const route = planOrderedRoute(tank.x, tank.y, goal.x, goal.y, walls, [enemy]);
  const middle = sampleRoute(route).filter((p) => p.x > 440 && p.x < 840);
  assert.ok(middle.length > 0, `route passes the middle; route ${show(route)}`);
  const watched = middle.filter((p) => seenBy(enemy, walls, p));
  assert.equal(
    watched.length,
    0,
    `crosses the watched middle at ${watched.length} samples; route ${show(route)}`,
  );
});

check("attack approaches the target through cover, not down its sightline", () => {
  // The target's own gun covers the open row. A wall shelters a lane to the south.
  const walls: Wall[] = [brick(300, 440, 560, 30)];
  const target: Foe = { id: "red-4", x: 900, y: 400, gunRange: 420 };
  const tank = { x: 200, y: 400 };
  const route = planOrderedRoute(tank.x, tank.y, target.x, target.y, walls, [target]);
  const inShot = (pts: Pt[]) =>
    pts.filter(
      (p) =>
        Math.hypot(p.x - target.x, p.y - target.y) < target.gunRange &&
        seenBy(target, walls, p),
    ).length;
  const direct = sampleRoute([tank, { x: target.x - 30, y: target.y }]);
  const routed = sampleRoute(route);
  assert.ok(
    inShot(routed) < inShot(direct) * 0.5,
    `in its shot ${inShot(routed)} vs direct ${inShot(direct)}; route ${show(route)}`,
  );
  assert.ok(
    routed.some((p) => p.x > 450 && p.x < 750 && p.y > 470),
    `uses the covered lane; route ${show(route)}`,
  );
});

check("drives straight when no enemy is near", () => {
  const walls: Wall[] = [brick(340, 450, 600, 36)];
  const none = planOrderedRoute(200, 300, 1080, 300, walls, []);
  assert.equal(none.length, 2, `no enemies: ${show(none)}`);
  const far: Foe = { id: "red-1", x: 1180, y: 740, gunRange: 400 };
  const distant = planOrderedRoute(200, 300, 700, 300, walls, [far]);
  assert.equal(distant.length, 2, `enemy out of reach: ${show(distant)}`);
});

check("smoothed path is a few straight runs, not cell steps", () => {
  const walls: Wall[] = [brick(500, 260, 220, 260)];
  const route = planOrderedRoute(200, 200, 1000, 620, walls, []);
  assert.ok(route.length <= 4, `too many waypoints: ${show(route)}`);
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) > 40, `short zigzag run: ${show(route)}`);
  }
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    assert.equal(segmentHitsWall(a.x, a.y, b.x, b.y, walls), false, `run hits a wall: ${show(route)}`);
  }
});

check("six planners on the dense arena stay fast", () => {
  const walls = buildArena("dense");
  const foes: Foe[] = [
    { id: "red-1", x: 300, y: 160, gunRange: 400 },
    { id: "red-2", x: 640, y: 200, gunRange: 400 },
    { id: "red-3", x: 980, y: 170, gunRange: 400 },
  ];
  const pairs = [
    [160, 640, 1000, 300],
    [200, 600, 900, 260],
    [180, 500, 1100, 240],
    [240, 700, 980, 320],
    [140, 560, 1040, 280],
    [220, 680, 920, 300],
  ];
  const t0 = performance.now();
  for (const [sx, sy, gx, gy] of pairs) {
    planOrderedRoute(sx!, sy!, gx!, gy!, walls, foes);
  }
  const ms = performance.now() - t0;
  console.log(`      six searches incl. one field build: ${ms.toFixed(1)}ms`);
  assert.ok(ms < 250, `too slow: ${ms.toFixed(1)}ms`);
});

if (failed) {
  console.error(`${failed} route check(s) failed`);
  process.exit(1);
}
