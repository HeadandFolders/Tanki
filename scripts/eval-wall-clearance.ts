/**
 * Path cells stay a hull-radius away from walls, and diagonals do not cut
 * the corner between two blocked neighbors.
 * Run: npx tsx scripts/eval-wall-clearance.ts
 */
import assert from "node:assert/strict";
import { buildArena, circleHitsWall } from "../src/arena.ts";
import { planOrderedRoute } from "../src/ai.ts";
import { CONFIG } from "../src/config.ts";
import { createWorld, stepWorld } from "../src/game.ts";
import { restoreGoal } from "../src/interrupt-stack.ts";
import type { Wall } from "../src/types.ts";

const brick = (x: number, y: number, w: number, h: number): Wall => ({
  x,
  y,
  w,
  h,
  kind: "brick",
});

function samples(route: { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / 4));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function clipCount(walls: Wall[], route: { x: number; y: number }[]): number {
  return samples(route).filter((p) =>
    circleHitsWall(p.x, p.y, CONFIG.tankRadius, walls),
  ).length;
}

// Orthogonal neighbors of the diagonal are inside walls. The centerline of the
// diagonal misses both walls, but a tank body would clip the corners.
// Grid cells around (408,408) and (444,444). The two orthogonal cells sit in
// walls; the diagonal centerline misses them, but a hull would clip the corners.
const cornerWalls: Wall[] = [
  brick(433, 380, 40, 39),
  brick(380, 433, 39, 40),
];
const corner = planOrderedRoute(408, 408, 444, 444, cornerWalls, []);
assert.ok(corner.length >= 2, "corner route exists");
assert.equal(clipCount(cornerWalls, corner), 0, "diagonal cuts the blocked corner");
assert.ok(
  Math.hypot(corner[corner.length - 1]!.x - 444, corner[corner.length - 1]!.y - 444) < 20,
  "corner route did not reach the far cell",
);
const straight = samples([
  { x: 408, y: 408 },
  { x: 444, y: 444 },
]);
assert.ok(
  clipCount(cornerWalls, straight) > 0,
  "fixture must be a real clip, not an empty gap",
);

// A gap wide enough for a hull is still used.
const slot: Wall[] = [
  brick(400, 80, 32, 280),
  brick(400, 440, 32, 280),
];
const through = planOrderedRoute(180, 400, 760, 400, slot, []);
assert.equal(clipCount(slot, through), 0, "slot route clips");
assert.ok(
  samples(through).some((p) => p.x > 400 && p.x < 432 && p.y > 360 && p.y < 440),
  "route no longer passes the open slot",
);

const dense = buildArena("dense");
const free: { x: number; y: number }[] = [];
for (let y = 100; y <= 700; y += 120) {
  for (let x = 100; x <= 1100; x += 160) {
    if (!circleHitsWall(x, y, CONFIG.tankRadius + 2, dense)) free.push({ x, y });
  }
}
assert.ok(free.length >= 4, "dense arena has open stances");
let checked = 0;
for (let i = 0; i < free.length; i += 3) {
  const a = free[i]!;
  const b = free[(i + 5) % free.length]!;
  const route = planOrderedRoute(a.x, a.y, b.x, b.y, dense, []);
  assert.ok(route.length >= 2, "dense route missing");
  const clips = clipCount(dense, route);
  assert.equal(
    clips,
    0,
    `dense route clips ${clips} samples from (${a.x},${a.y}) to (${b.x},${b.y})`,
  );
  checked++;
}
assert.ok(checked >= 3, "checked dense routes");

// Multiplayer Offline drives the same cleared routes. A long steer chord
// must not spend the body margin against the dense-arena walls.
const world = createWorld("clear", "mp-offline", "normal", 3, "off");
assert.equal(world.gameMode, "mp-offline");
world.outcome = "playing";
const bot = world.tanks.find((t) => t.team === "blue" && t.id !== world.controlledId)!;
const anchor = world.tanks.find((t) => t.team === "red")!;
for (const t of world.tanks) {
  if (t.id !== bot.id && t.id !== anchor.id) t.alive = false;
}
anchor.x = 80;
anchor.y = 720;
restoreGoal(anchor, {
  kind: "holdPosition",
  source: "system",
  params: { x: anchor.x, y: anchor.y },
});
bot.hp = 1e6;
const goal = { x: 1100, y: 160 };
restoreGoal(bot, { kind: "moveTo", source: "player", params: goal });
const input = { keys: new Set<string>(), mouseX: 0, mouseY: 0, shooting: false };
let minClear = Infinity;
let bodyClips = 0;
function hullGap(x: number, y: number): number {
  let best = Infinity;
  for (const w of world.walls) {
    const nx = Math.max(w.x, Math.min(x, w.x + w.w));
    const ny = Math.max(w.y, Math.min(y, w.y + w.h));
    best = Math.min(best, Math.hypot(x - nx, y - ny) - CONFIG.tankRadius);
  }
  return best;
}
for (let i = 0; i < 60 * 25; i++) {
  stepWorld(world, 1 / 60, input);
  const clear = hullGap(bot.x, bot.y);
  minClear = Math.min(minClear, clear);
  if (clear < 0) bodyClips++;
  if (
    Math.hypot(bot.x - goal.x, bot.y - goal.y) < CONFIG.ai.holdRadius &&
    bot.goal.kind === "holdPosition"
  ) {
    break;
  }
}
assert.equal(bodyClips, 0, "mp-offline hull overlapped a wall");
assert.ok(minClear >= 1.5, `mp-offline hull grazed a wall (${minClear.toFixed(2)}px)`);
assert.equal(bot.goal.kind, "holdPosition", "mp-offline move did not arrive");

console.log("ok  inflated cells and no corner cutting");
