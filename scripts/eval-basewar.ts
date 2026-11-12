import assert from "node:assert/strict";
import { buildArena, circleHitsWall, dist, segmentHitsWall } from "../src/arena.ts";
import { baseShotClear, defensiveAnchors } from "../src/arena-bases.ts";
import { tankRouteCuts } from "../src/arena-routes.ts";
import { commanderView, setCommander, updateCommander } from "../src/ai-commander.ts";
import { beliefFor, updateTeamBelief } from "../src/belief.ts";
import { commandLog } from "../src/command-pipeline.ts";
import { CONFIG, type ShareMode } from "../src/config.ts";
import { baseReachOf, TANK_TYPES } from "../src/config/balance.ts";
import { applyBaseDamage, createWorld, sendOrder, stepWorld } from "../src/game.ts";
import { restoreGoal } from "../src/interrupt-stack.ts";
import type { BaseState, TeamId, Wall, WorldState } from "../src/types.ts";

const DT = 1 / 30;
const INPUT = { keys: [], mouseX: 0, mouseY: 0, shooting: false };
const TEAMS = ["blue", "red"] as const;
const SIDES = ["north", "south", "east", "west"] as const;
type Side = (typeof SIDES)[number];
console.debug = () => {};
let passed = 0;
async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  await test();
  passed++;
  console.log(`ok  ${name}`);
}
function fixture(seed = 1): WorldState {
  // These rule checks run the dense map by name; its base-to-base distance is
  // what the timing windows below are cut for.
  const world = createWorld("clear", "base-war", "normal", seed, "off", "dense");
  world.outcome = "playing";
  for (const t of world.tanks) t.cooldown = 1e9;
  return world;
}
function shell(world: WorldState, base: BaseState, team: TeamId, damage = 22): void {
  world.projectiles.push({ id: `test-${world.projectiles.length}`, team,
    ownerId: `${team}-1`, x: base.x + base.w / 2, y: base.y + base.h / 2,
    vx: 0, vy: 0, damage, life: 1, fromShooter: true });
}
function between(n: number, min: number, max: number): void {
  assert.ok(n >= min - 1e-8 && n <= max + 1e-8, `${n} outside ${min}..${max}`);
}
/** Which map borders the base rect sits hard against. */
function bordersTouched(b: BaseState, borders: Wall[]): Side[] {
  const spans = (r: Wall) => r.x <= b.x && r.x + r.w >= b.x + b.w;
  const across = (r: Wall) => r.y <= b.y && r.y + r.h >= b.y + b.h;
  return SIDES.filter((side) => borders.some((r) =>
    side === "north" ? r.y + r.h === b.y && spans(r)
      : side === "south" ? r.y === b.y + b.h && spans(r)
        : side === "west" ? r.x + r.w === b.x && across(r)
          : r.x === b.x + b.w && across(r)));
}
/** Whether a tank can reach the face of a base from that side. */
function faceOpen(b: BaseState, side: Side, walls: Wall[]): boolean {
  const d = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[side];
  const gap = CONFIG.tileSize * 0.6;
  const points = [0.25, 0.5, 0.75].map((f) => ({
    x: d[0] === 0 ? b.x + b.w * f : b.x + (d[0] < 0 ? -gap : b.w + gap),
    y: d[1] === 0 ? b.y + b.h * f : b.y + (d[1] < 0 ? -gap : b.h + gap),
  }));
  return points.every((p) => !circleHitsWall(p.x, p.y, CONFIG.tankRadius, walls));
}

await check("dense and large bases: symmetric 3x3 footprints, one wall side and three open faces, two routes, hidden from enemy spawn", () => {
  for (const arena of ["dense", "large"] as const) {
    const original = JSON.stringify(buildArena(arena));
    const w = createWorld("clear", "base-war", "normal", 1, "off", arena);
    const bases = w.bases!;
    assert.equal(bases.blue.x + bases.red.x + bases.blue.w, CONFIG.canvasWidth);
    assert.equal(bases.blue.y + bases.red.y + bases.blue.h, CONFIG.canvasHeight);
    const borders = w.walls.filter((wall) => wall.kind === "border");
    const posts = (team: TeamId) =>
      defensiveAnchors(arena, team)
        .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
        .sort();
    assert.deepEqual(
      defensiveAnchors(arena, "blue")
        .map((p) => `${(CONFIG.canvasWidth - p.x).toFixed(1)},${(CONFIG.canvasHeight - p.y).toFixed(1)}`)
        .sort(),
      posts("red"),
      `${arena}: garrison posts are not point-symmetric`,
    );
    for (const team of TEAMS) {
      const b = bases[team];
      assert.equal(b.w, 48); assert.equal(b.h, 48);
      const walls = w.walls.filter((wall) => wall.baseTeam !== team);
      const back = bordersTouched(b, borders);
      assert.equal(back.length, 1, `${arena}/${team} backs onto ${back.length} borders`);
      for (const side of SIDES) {
        assert.equal(faceOpen(b, side, walls), side !== back[0],
          `${arena}/${team} face ${side} should be ${side === back[0] ? "walled" : "open"}`);
      }
      const alongWall = back[0] === "north" || back[0] === "south"
        ? Math.min(b.x, CONFIG.canvasWidth - b.x - b.w)
        : Math.min(b.y, CONFIG.canvasHeight - b.y - b.h);
      assert.ok(alongWall >= 2 * CONFIG.tileSize, `${arena}/${team} sits ${alongWall}px from a corner`);
      for (const t of w.tanks.filter((t) => t.team !== team)) {
        assert.ok(segmentHitsWall(t.x, t.y, b.x + 24, b.y + 24, walls), `${arena}/${team} spawn LOS`);
      }
      const anchors = defensiveAnchors(arena, team);
      assert.ok(anchors.length >= 2);
      for (const p of anchors) {
        assert.ok(!circleHitsWall(p.x, p.y, CONFIG.tankRadius + 2, walls), `${arena}/${team} post in a wall`);
      }
      for (const tank of w.tanks.filter((t) => t.team === team)) {
        assert.ok(team === "blue" ? tank.y < b.y : tank.y > b.y + b.h, "base must be behind spawn");
        assert.ok(!circleHitsWall(tank.x, tank.y, CONFIG.tankRadius + 2, w.walls));
        const other = w.tanks.find((t) => t.team !== team && t.number === tank.number)!;
        assert.equal(tank.x + other.x, CONFIG.canvasWidth);
        assert.equal(tank.y + other.y, CONFIG.canvasHeight);
      }
    }
    const cuts = tankRouteCuts(w.walls);
    assert.equal(cuts.components, 1);
    assert.equal(cuts.articulationPoints, 0);
    assert.equal(JSON.stringify(buildArena(arena)), original, "shared layout changed");
  }
});

await check("friendly shells absorb; enemy shells damage; alerts rate-limit at five seconds", () => {
  const w = fixture(); const b = w.bases!.blue;
  shell(w, b, "blue"); stepWorld(w, DT, INPUT);
  assert.equal(b.hp, CONFIG.baseHp); assert.equal(w.projectiles.length, 0);
  assert.equal(b.lastAlertAt, -999);
  shell(w, b, "red"); stepWorld(w, DT, INPUT);
  assert.equal(b.hp, CONFIG.baseHp - 22 * CONFIG.baseDamageMultiplier);
  const first = b.lastAlertAt;
  w.time = first + 4.9; applyBaseDamage(w, b, 22, "red"); assert.equal(b.lastAlertAt, first);
  w.time = first + 5; applyBaseDamage(w, b, 22, "red"); assert.equal(b.lastAlertAt, w.time);
});

await check("only a destroyed base ends it: elimination keeps play going, simultaneous and cross conditions resolve to base", () => {
  for (const team of TEAMS) {
    const w = fixture(); shell(w, w.bases![team], team === "blue" ? "red" : "blue", 8000);
    stepWorld(w, DT, INPUT);
    assert.equal(w.outcome, team === "red" ? "win" : "lose");
    assert.equal(w.outcomeReason, "Base destroyed");
    assert.equal(w.bases![team].destroyedAt, w.time);
    const record = commandLog().at(-1)!;
    assert.equal(record.reason, "match_outcome"); assert.ok(record.raw_text.includes("Base destroyed"));
    // A side with no hulls left cannot shoot back, but the match is not over.
    const emptied = fixture();
    for (const t of emptied.tanks.filter((t) => t.team === team)) t.alive = false;
    for (let tick = 0; tick < 30; tick++) stepWorld(emptied, DT, INPUT);
    assert.equal(emptied.outcome, "playing", `${team} wiped out ended the match`);
    assert.ok(emptied.matchLeft < 600);
  }
  const both = fixture(); shell(both, both.bases!.red, "blue", 8000); shell(both, both.bases!.blue, "red", 8000);
  stepWorld(both, DT, INPUT); assert.equal(both.outcome, "draw");
  const cross = fixture();
  for (const t of cross.tanks.filter((t) => t.team === "red")) t.alive = false;
  shell(cross, cross.bases!.blue, "red", 8000); stepWorld(cross, DT, INPUT);
  assert.equal(cross.outcome, "lose"); assert.equal(cross.outcomeReason, "Base destroyed");
});

await check("600-second timeout: HP percentage first, survivors second, exact tie draw", () => {
  assert.equal(fixture().matchLeft, 600);
  for (const outcome of ["win", "lose", "draw"] as const) {
    const hp = fixture(); hp.matchLeft = DT;
    hp.bases!.blue.maxHp = 4000; hp.bases!.blue.hp = outcome === "win" ? 4000 : 2000;
    hp.bases!.red.hp = outcome === "lose" ? 2000 : 1000;
    stepWorld(hp, DT, INPUT); assert.equal(hp.outcome, outcome);
    if (outcome !== "draw") assert.equal(hp.outcomeReason, "Time up: base HP");
    const count = fixture(); count.matchLeft = DT;
    if (outcome !== "draw") count.tanks.find((t) => t.team === (outcome === "win" ? "red" : "blue"))!.alive = false;
    stepWorld(count, DT, INPUT); assert.equal(count.outcome, outcome);
    assert.equal(count.outcomeReason, outcome === "draw" ? "Time up: draw" : "Time up: surviving tanks");
  }
});

await check("attackBase follows the real dense maze, stops in LOS, fires, and never retargets", async () => {
  for (const seed of [1, 7, 29]) for (const team of TEAMS) {
    const w = fixture(seed);
    const bot = w.tanks.find((t) => t.team === team && t.number === 2)!;
    const base = w.bases![team === "blue" ? "red" : "blue"];
    bot.cooldown = 0;
    const start = { x: bot.x, y: bot.y };
    await sendOrder(w, "2 attack their base", {}, team);
    for (let tick = 0; tick < 30 / DT && base.hp === base.maxHp; tick++) stepWorld(w, DT, INPUT);
    assert.ok(base.hp < base.maxHp, `${seed}/${team}: no base damage`);
    assert.ok(dist(start.x, start.y, bot.x, bot.y) > 50);
    assert.ok(baseShotClear(bot, base, w.walls, baseReachOf(bot.role)));
    const stop = { x: bot.x, y: bot.y };
    for (let tick = 0; tick < 30; tick++) stepWorld(w, DT, INPUT);
    assert.ok(dist(stop.x, stop.y, bot.x, bot.y) < 0.1);
    assert.equal(bot.goal.kind, "attackBase");
    base.alive = false; base.hp = 0; stepWorld(w, DT, INPUT);
    assert.equal(bot.goal.kind, "holdPosition");
  }
});

await check("continuous live firing: one gunner about a minute, three about twenty seconds", async () => {
  for (const n of [1, 3]) {
    const w = fixture(); w.walls = [];
    const b = w.bases!.red;
    const bots = w.tanks.filter((t) => t.team === "blue" && t.number >= 2 && t.number < 2 + n);
    for (const [i, tank] of w.tanks.filter((t) => !bots.includes(t)).entries()) {
      tank.x = 80 + i * 30; tank.y = 80;
      restoreGoal(tank, { kind: "holdPosition", source: "system", params: { x: tank.x, y: tank.y } });
    }
    for (const [i, t] of bots.entries()) {
      // The pace this measures belongs to the old line gun. Company slot 2 is
      // a Heavy, whose 42-point shell every 1.8s would need minutes on base HP
      // tuned for a 22/0.16s gun; which hull fills the slot is the batch's question.
      t.role = "shooter";
      t.maxHp = t.hp = TANK_TYPES.shooter.maxHealth;
      const angle = Math.PI / 2 + (i - (n - 1) / 2) * 0.35;
      t.x = b.x + 24 + Math.cos(angle) * 160; t.y = b.y + 24 + Math.sin(angle) * 160;
      t.lastKnownPos = { x: t.x, y: t.y }; t.cooldown = 0;
    }
    await sendOrder(w, `${bots.map((t) => t.number).join(" and ")} attack the base`);
    while (w.outcome === "playing" && w.time < 70) stepWorld(w, DT, INPUT);
    assert.equal(w.outcome, "win"); between(w.time, n === 1 ? 56 : 18, n === 1 ? 63 : 22);
    console.log(`    ${n} gunner(s): ${w.time.toFixed(2)}s`);
  }
});

await check("five-minute seeded cadence, acknowledgement delay, locks, dead recipients, normal sixth hull", () => {
  const cadence: number[][] = [];
  for (const difficulty of ["easy", "normal", "hard"] as const) {
    const w = fixture(91); setCommander(w, "red", difficulty);
    const c = w.commanders!.red!;
    let issued = 0;
    for (let tick = 1; tick <= 300 / DT; tick++) {
      w.time = tick * DT;
      if (tick === 1800) w.tanks.find((t) => t.id === "red-2")!.alive = false;
      const previous = new Map(w.tanks.map((t) => [t.id, structuredClone(t.goal)]));
      const assignments = structuredClone(c.assignments);
      updateTeamBelief(w); updateCommander(w, c);
      for (const record of c.orders.slice(issued)) {
        between(record.latency_ms / 1000, 0.3, 0.8);
        between(record.appliedAt! - record.issuedAt!, 0.3, 0.8 + DT);
        assert.equal(record.issuer, "ai_commander"); assert.equal(record.which_path_executed, "ai_commander");
        for (const id of record.tanks!) {
          assert.notEqual(id, "red-6"); assert.ok(w.tanks.find((t) => t.id === id)!.alive);
          const old = previous.get(id)!; const assignment = assignments[id];
          if (assignment && old.kind === assignment.kind && (old.kind === "attackBase" || old.kind === "holdPosition")) {
            assert.ok(w.time - assignment.at >= 5 - 1e-8, `early retask ${id}`);
          }
        }
        const count = record.intent!.tank_ids.length;
        assert.ok(count <= 3 || count === w.tanks.filter((t) => t.team === "red" && t.alive && t.number !== 6).length);
      }
      issued = c.orders.length;
    }
    for (let i = 1; i < c.ticks.length; i++) between(c.ticks[i]!.at - c.ticks[i - 1]!.at, 2, 4);
    assert.ok(c.orders.length > 30); cadence.push(c.ticks.map((t) => t.at));
    console.log(`    ${difficulty}: ${c.orders.length} applied / ${c.ticks.length} scheduled (${c.ticks.filter((t) => t.skipped).length} busy ticks)`);
    assert.equal(w.tanks.find((t) => t.id === "red-6")!.goal.issuer, undefined);
  }
  assert.deepEqual(cadence[0], cadence[1]); assert.deepEqual(cadence[1], cadence[2]);
});

await check("fog decisions/resolver read delayed belief snapshots, never live enemy coordinates", () => {
  for (const share of ["auto", "report", "none"] as ShareMode[]) for (const team of TEAMS) {
    const w = fixture(901); w.shareMode = share; setCommander(w, team, "hard");
    const c = w.commanders![team]!;
    const own = w.tanks.filter((t) => t.team === team);
    const enemy = w.tanks.filter((t) => t.team !== team);
    const raw = w.tanks;
    for (let tick = 1; tick <= 180; tick++) {
      w.time = tick * DT;
      w.tanks = raw;
      const contact = { enemyId: enemy[0]!.id, x: 600, y: 400, seenAt: w.time, seenBy: own[0]!.id,
        observed: { number: 1, team: enemy[0]!.team, role: enemy[0]!.role, hp: 22, maxHp: 110, angle: 0 } };
      beliefFor(w, team).contacts = [contact];
      w.tanks = raw.map((t) => t.team === team ? t : new Proxy(t, { get(target, prop, receiver) {
        if (["x", "y", "hp", "angle", "number", "role"].includes(String(prop))) throw new Error(`live enemy ${String(prop)}`);
        return Reflect.get(target, prop, receiver);
      } }));
      updateCommander(w, c);
      const view = commanderView(w, c);
      const seen = view.tanks.find((t) => t.team !== team);
      const perceived = c.contacts[enemy[0]!.id]!;
      between(perceived.readyAt - perceived.since, 0.3, 0.8);
      if (w.time < perceived.readyAt) assert.equal(seen, undefined);
      else { assert.equal(seen?.x, 600); assert.equal(seen?.hp, 22); }
      assert.equal(view.bases, w.bases);
    }
    assert.ok(c.orders.length);
  }
});

await check("Base War strategies use the resolver, respect the human/spare hull, and log actual recipients", () => {
  const reasons = ["base_all_defend", "base_all_in", "base_recall", "base_intercept", "focus_fire_weakest", "base_flank_alternate"];
  for (const team of TEAMS) for (const reason of reasons) {
    let found = false;
    for (let seed = 1; seed <= 30 && !found; seed++) {
      const w = fixture(seed); setCommander(w, team, "normal");
      const state = w.commanders![team]!;
      w.time = state.nextOrderAt = 10;
      state.deployed = w.tanks.filter((t) => t.team === team).map((t) => t.number);
      const home = w.bases![team]; const away = w.bases![team === "blue" ? "red" : "blue"];
      if (reason === "base_all_defend") home.hp = home.maxHp * 0.25;
      if (reason === "base_all_in") away.hp = away.maxHp * 0.3;
      if (reason === "base_recall" || reason === "base_intercept") home.lastDamagedAt = w.time;
      if (reason === "base_intercept" || reason === "focus_fire_weakest") {
        const enemy = w.tanks.find((t) => t.team !== team)!;
        const contact = { enemyId: enemy.id, seenBy: `${team}-2`, seenAt: w.time,
          x: home.x + 70, y: home.y, observed: { number: enemy.number, team: enemy.team,
            role: enemy.role, hp: 22, maxHp: enemy.maxHp, angle: 0 } };
        beliefFor(w, team).contacts = [contact];
        state.contacts[enemy.id] = { contact, since: 9, readyAt: 9.5, visible: true };
      }
      const before = w.tanks.map((t) => structuredClone(t.goal));
      updateCommander(w, state);
      const pending = state.pending!;
      assert.deepEqual(w.tanks.map((t) => t.goal), before, "goals changed before acknowledgement");
      if (pending.record.reason !== reason) continue;
      found = true;
      w.time = Math.ceil(pending.executeAt / DT) * DT;
      for (const contact of beliefFor(w, team).contacts) contact.seenAt = w.time;
      updateCommander(w, state);
      assert.equal(pending.record.tanks!.length, pending.record.intent!.tank_ids.length);
      assert.ok(pending.record.goals.length);
      for (const id of pending.record.tanks!) {
        assert.notEqual(id, team === "blue" ? w.controlledId : "red-6");
        assert.equal(w.tanks.find((t) => t.id === id)!.goal.issuer, "ai_commander");
      }
      if (reason === "base_flank_alternate") assert.equal(pending.record.tanks!.length, 2);
      if (reason === "base_all_defend") assert.equal(pending.record.intent!.tool, "defend_base");
      if (reason === "base_all_in") assert.equal(pending.record.intent!.tool, "attack_base");
      assert.deepEqual(w.playerMarks, { blue: null, red: null });
    }
    assert.ok(found, `${team}: missing strategy ${reason}`);
  }
});

await check("Base War acknowledgement drops dead recipients and an eliminated spare gives no false advantage", () => {
  for (const team of TEAMS) for (const all of [false, true]) {
    const w = fixture(); setCommander(w, team, "normal");
    const state = w.commanders![team]!;
    w.time = state.nextOrderAt;
    updateCommander(w, state);
    const pending = state.pending!;
    const recipients = w.tanks.filter((t) => t.team === team && pending.record.intent!.tank_ids.includes(t.number));
    for (const t of all ? recipients : recipients.slice(0, 1)) { t.alive = false; t.hp = 0; }
    w.time = pending.executeAt + DT;
    updateCommander(w, state);
    assert.deepEqual(pending.record.tanks, recipients.filter((t) => t.alive).map((t) => t.id));
    if (all) assert.deepEqual(pending.record.goals, []);
  }
  for (let seed = 1; seed <= 20; seed++) {
    const w = fixture(seed); setCommander(w, "red", "normal");
    const state = w.commanders!.red!;
    state.deployed = [1, 2, 3, 4, 5];
    w.tanks.find((t) => t.id === "red-6")!.alive = false;
    w.tanks.find((t) => t.id === "blue-6")!.alive = false;
    w.time = state.nextOrderAt;
    updateCommander(w, state);
    assert.notEqual(state.pending!.record.reason, "base_all_in");
  }
});

await check("allies answer a shot the brain already aimed: full gun range, not vision range", () => {
  const w = fixture();
  w.walls = [];
  const ally = w.tanks.find((t) => t.team === "blue" && t.id !== w.controlledId)!;
  const foe = w.tanks.find((t) => t.team === "red")!;
  // The old MP roster had one gun on every hull; this one measures that gun's
  // reach against its own sight line, so pin the classic 220/95 pair.
  ally.role = "shooter";
  ally.maxHp = ally.hp = TANK_TYPES.shooter.maxHealth;
  ally.x = 600; ally.y = 400; ally.cooldown = 0;
  restoreGoal(ally, { kind: "holdPosition", source: "system", params: { x: 600, y: 400 } });
  foe.x = 800; foe.y = 400; foe.cooldown = 1e9;
  restoreGoal(foe, { kind: "holdPosition", source: "system", params: { x: 800, y: 400 } });
  for (const t of w.tanks) {
    if (t === ally || t === foe) continue;
    t.x = 100;
    t.y = t.team === "red" ? 700 : 100;
    t.cooldown = 1e9;
  }
  assert.ok(200 > CONFIG.roles[ally.role].visionRange + 40, "test moved inside vision range");
  for (let tick = 0; tick < 30 && foe.hp === foe.maxHp; tick++) stepWorld(w, DT, INPUT);
  assert.ok(foe.hp < foe.maxHp, "held ally fired no shot at 200px with a clear line");
});

await check("passive defence on both MP arenas trades with an AI attack", () => {
  const nukeBaseDamage = TANK_TYPES.nuke.nuke!.damageVsBase;
  for (const arena of ["dense", "large"] as const) {
    for (const seed of [23, 411]) {
      const w = createWorld("clear", "base-war", "normal", seed, "normal", arena);
      w.outcome = "playing";
      // Base War respawns now, so one hull can die several times in two minutes.
      // The trade is counted in hulls destroyed at least once — the cost a wreck
      // mode used to charge — and the returns are reported beside it.
      const redLost = new Set<string>();
      const blueLost = new Set<string>();
      let returned = 0;
      let nukeDamage = 0;
      for (let tick = 0; tick < 120 / DT && w.outcome === "playing"; tick++) {
        const baseBefore = w.bases!.blue.hp;
        const aliveBefore = new Set(w.tanks.filter((t) => t.alive).map((t) => t.id));
        stepWorld(w, DT, INPUT);
        // One nuke round is worth several hulls' worth of shells, so the two
        // kinds of base damage are counted apart; the guard below is on guns.
        nukeDamage += Math.floor((baseBefore - w.bases!.blue.hp) / nukeBaseDamage) * nukeBaseDamage;
        for (const tank of w.tanks) {
          if (tank.alive) {
            if (!aliveBefore.has(tank.id)) returned++;
          } else if (tank.team === "red") redLost.add(tank.id);
          else blueLost.add(tank.id);
        }
      }
      const redLosses = redLost.size;
      const blueLosses = blueLost.size;
      const dmg = CONFIG.baseHp - w.bases!.blue.hp;
      const gunDmg = dmg - nukeDamage;
      assert.ok(gunDmg < CONFIG.baseHp * 0.25,
        `${arena}/${seed}: shell fire alone took ${gunDmg} damage (passive)`);
      assert.ok(redLosses > blueLosses,
        `${arena}/${seed}: attackers down ${redLosses}, defence down ${blueLosses}`);
      assert.ok(blueLosses <= 2, `${arena}/${seed}: defence lost ${blueLosses}`);
      console.log(
        `    ${arena}/${seed}: base dmg ${dmg.toFixed(0)} (shells ${gunDmg.toFixed(0)}, ` +
          `nukes ${nukeDamage.toFixed(0)}), attackers down ${redLosses}, defence down ${blueLosses}, ` +
          `respawns ${returned}`,
      );
    }
  }
});

function battle(seed: number, swap: boolean, limit = CONFIG.matchTimeLimitSec) {
  // The side-balance guard below is calibrated on the dense map, named here so
  // a change to the world default cannot silently retune it.
  const w = createWorld("clear", "base-war", "normal", seed, "off", "dense");
  w.controlledId = "";
  w.outcome = "playing";
  const seeds = [seed * 2 + 100, seed * 2 + 101];
  setCommander(w, "blue", "normal", seeds[swap ? 1 : 0]);
  setCommander(w, "red", "normal", seeds[swap ? 0 : 1]);
  for (let tick = 0; tick <= limit / DT && w.outcome === "playing"; tick++) stepWorld(w, DT, INPUT);
  return { outcome: w.outcome, reason: w.outcomeReason, time: w.time,
    logs: TEAMS.map((team) => w.commanders![team]!.orders) };
}
await check("same seed reproduces full simulation and command logs", () => {
  assert.deepEqual(battle(17, false, 30), battle(17, false, 30));
  assert.notDeepEqual(battle(17, false, 30).logs, battle(18, false, 30).logs);
});

if (!process.argv.includes("--quick")) {
  await check("20 seeds with commander sides swapped: neither physical side nor seed stream wins above 65%", () => {
    const tally = { blue: 0, red: 0, draw: 0, first: 0, second: 0 };
    for (let seed = 1; seed <= 20; seed++) for (const swap of [false, true]) {
      const result = battle(seed, swap);
      assert.notEqual(result.outcome, "playing");
      if (result.outcome === "draw") tally.draw++;
      else {
        const blue = result.outcome === "win";
        tally[blue ? "blue" : "red"]++;
        tally[blue !== swap ? "first" : "second"]++;
      }
      console.log(`    seed ${seed}${swap ? " swapped" : ""}: ${result.outcome}, ${result.time.toFixed(1)}s, ${result.reason}`);
    }
    console.log(`    balance ${JSON.stringify(tally)} / 40`);
    for (const wins of [tally.blue, tally.red, tally.first, tally.second]) assert.ok(wins <= 26);
  });
}
console.log(`eval-basewar: ${passed} checks passed${process.argv.includes("--quick") ? " (balance skipped)" : ""}`);
