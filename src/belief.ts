import { CONFIG } from "./config";
import { canSeeTank } from "./fog";
import type { Tank, TeamBelief, TeamContact, TeamId, WorldState } from "./types";

export function beliefFor(world: WorldState, team: TeamId): TeamBelief {
  return team === "blue" ? world.teamBelief : (world.redTeamBelief ??= { contacts: [] });
}

export function beliefViewers(world: WorldState, team: TeamId = "blue"): Tank[] {
  const friends = world.tanks.filter((t) => t.team === team && t.alive);
  if (world.shareMode !== "none") return friends;
  const leader = team === "blue" ? world.controlledId :
    (world.remoteControlledId ?? friends[0]?.id);
  return friends.filter((t) => t.id === leader);
}

function upsertContact(
  world: WorldState,
  enemy: Tank,
  viewer: Tank,
): void {
  const list = beliefFor(world, viewer.team).contacts;
  const observed = {
    number: enemy.number, team: enemy.team, role: enemy.role,
    hp: enemy.hp, maxHp: enemy.maxHp, angle: enemy.angle,
  };
  const existing = list.find((c) => c.enemyId === enemy.id);
  if (existing) {
    existing.x = enemy.x;
    existing.y = enemy.y;
    existing.seenAt = world.time;
    existing.seenBy = viewer.id;
    existing.observed = observed;
    return;
  }
  list.push({
    enemyId: enemy.id,
    x: enemy.x,
    y: enemy.y,
    seenAt: world.time,
    seenBy: viewer.id,
    observed,
  });
}

/** Refresh + expire shared enemy contacts for AI (not only the player map). */
export function updateTeamBelief(world: WorldState): void {
  for (const team of ["blue", "red"] as const) {
    const belief = beliefFor(world, team);
    belief.contacts = belief.contacts.filter((c) => world.time - c.seenAt <= CONFIG.ai.beliefTtlSec);
    const viewers = beliefViewers(world, team);
    for (const viewer of viewers) {
      for (const enemy of world.tanks) {
        if (enemy.team === team || !enemy.alive) continue;
        if (canSeeTank(viewer, enemy, world.walls)) upsertContact(world, enemy, viewer);
      }
    }
    const living = new Set(world.tanks.filter((t) => t.team !== team && t.alive).map((t) => t.id));
    belief.contacts = belief.contacts.filter((c) => living.has(c.enemyId));
  }
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
