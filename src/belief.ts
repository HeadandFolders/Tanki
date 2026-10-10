import { CONFIG } from "./config";
import { canSeeTank } from "./fog";
import type { Tank, TeamContact, WorldState } from "./types";

/** Who feeds blue team belief this frame, based on share mode. */
export function beliefViewers(world: WorldState): Tank[] {
  const blues = world.tanks.filter((t) => t.team === "blue" && t.alive);
  if (world.shareMode === "clear" || world.shareMode === "auto") {
    return blues;
  }
  if (world.shareMode === "report") {
    // AI gets live contacts from every blue; player fog still needs report-in.
    return blues;
  }
  // none: only the controlled tank contributes to company belief
  return blues.filter((t) => t.id === world.controlledId);
}

function upsertContact(
  world: WorldState,
  enemy: Tank,
  viewer: Tank,
): void {
  const list = world.teamBelief.contacts;
  const existing = list.find((c) => c.enemyId === enemy.id);
  if (existing) {
    existing.x = enemy.x;
    existing.y = enemy.y;
    existing.seenAt = world.time;
    existing.seenBy = viewer.id;
    return;
  }
  list.push({
    enemyId: enemy.id,
    x: enemy.x,
    y: enemy.y,
    seenAt: world.time,
    seenBy: viewer.id,
  });
}

/** Refresh + expire shared enemy contacts for AI (not only the player map). */
export function updateTeamBelief(world: WorldState): void {
  const ttl = CONFIG.ai.beliefTtlSec;
  world.teamBelief.contacts = world.teamBelief.contacts.filter(
    (c) => world.time - c.seenAt <= ttl,
  );

  const viewers = beliefViewers(world);
  for (const v of viewers) {
    for (const e of world.tanks) {
      if (e.team !== "red" || !e.alive) continue;
      if (canSeeTank(v, e, world.walls)) {
        upsertContact(world, e, v);
      }
    }
  }

  // Drop contacts for dead enemies
  const livingRed = new Set(
    world.tanks.filter((t) => t.team === "red" && t.alive).map((t) => t.id),
  );
  world.teamBelief.contacts = world.teamBelief.contacts.filter((c) =>
    livingRed.has(c.enemyId),
  );
}

/** Live LOS enemies for this tank. */
export function liveVisibleEnemies(world: WorldState, tank: Tank): Tank[] {
  return world.tanks.filter(
    (e) => e.team !== tank.team && e.alive && canSeeTank(tank, e, world.walls),
  );
}

/**
 * Team-known enemy tanks: live LOS first, else last contact if still believed.
 * Used so gunners can react to scout contacts under fog.
 */
export function knownEnemyTanks(world: WorldState, tank: Tank): Tank[] {
  const live = liveVisibleEnemies(world, tank);
  if (live.length) return live;

  if (tank.team !== "blue") return [];

  const out: Tank[] = [];
  for (const c of world.teamBelief.contacts) {
    const e = world.tanks.find((t) => t.id === c.enemyId && t.alive);
    if (e) out.push(e);
  }
  return out;
}

export function freshestContact(
  world: WorldState,
): TeamContact | null {
  let best: TeamContact | null = null;
  for (const c of world.teamBelief.contacts) {
    if (!best || c.seenAt > best.seenAt) best = c;
  }
  return best;
}
