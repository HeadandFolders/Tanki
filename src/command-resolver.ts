/**
 * Intent → goals. Parsers name tanks and places; this module finds them in
 * the world: hull numbers become living tanks, a marker ref becomes the
 * team's map mark, a relative ref becomes a point off the player's facing.
 */
import { defensiveAnchors } from "./arena-bases";
import { CONFIG } from "./config";
import type { CommandIntent, PlaceRef } from "./command-schema";
import { flankSlots, freePointNear, lineSlots, surroundSlots } from "./formation";
import type { OrderResult, Tank, TeamId, Vec2, WorldState } from "./types";

export interface ResolvedOrders {
  orders: OrderResult[];
  /** Set when the intent was understood but could not be carried out. */
  notice?: string;
}

/** Hull the speaking human drives for a team. */
export function commanderOf(world: WorldState, team: TeamId): Tank | null {
  const id =
    team === "red"
      ? (world.remoteControlledId ??
        world.tanks.find((t) => t.team === "red" && t.alive)?.id)
      : world.controlledId;
  return world.tanks.find((t) => t.id === id && t.alive) ?? null;
}

function friendlyByNumber(world: WorldState, team: TeamId, n: number): Tank | null {
  return world.tanks.find((t) => t.team === team && t.alive && t.number === n) ?? null;
}

function enemyByNumber(world: WorldState, team: TeamId, n: number): Tank | null {
  return world.tanks.find((t) => t.team !== team && t.alive && t.number === n) ?? null;
}

const HEADING: Record<"left" | "right" | "forward" | "back", number> = {
  forward: 0,
  right: Math.PI / 2,
  back: Math.PI,
  left: -Math.PI / 2,
};

/** World point for a place reference, or a reason it has none. */
export function resolvePlace(
  world: WorldState,
  team: TeamId,
  ref: PlaceRef,
): { point: Vec2; heading: number; exact: boolean } | { notice: string } {
  if (ref.type === "marker") {
    const mark = world.playerMarks[team];
    if (!mark) return { notice: "No map mark — hold F and click the map." };
    return { point: { x: mark.x, y: mark.y }, heading: 0, exact: true };
  }
  const player = commanderOf(world, team);
  if (!player) return { notice: "No player tank to move relative to." };
  const heading = player.angle + HEADING[ref.direction];
  const d = CONFIG.needle.relativeMoveDistance;
  const ideal = { x: player.x + Math.cos(heading) * d, y: player.y + Math.sin(heading) * d };
  return { point: freePointNear(ideal, world.walls), heading, exact: false };
}

/** Turn validated intents into one order per tank. */
export function intentsToOrders(
  world: WorldState,
  team: TeamId,
  intents: CommandIntent[],
  issuer?: "ai_commander",
): ResolvedOrders {
  const orders: OrderResult[] = [];
  const notices: string[] = [];
  const player = commanderOf(world, team);
  for (const intent of intents) {
    const bots = intent.tank_ids
      .map((n) => friendlyByNumber(world, team, n))
      .filter((t): t is Tank => t != null);
    if (!bots.length) {
      notices.push(`No living tank among #${intent.tank_ids.join(", #")}.`);
      continue;
    }
    switch (intent.tool) {
      case "attack": {
        const foe = enemyByNumber(world, team, intent.target_id);
        if (!foe) {
          notices.push(`Enemy #${intent.target_id} is not on the field.`);
          continue;
        }
        for (const t of bots) {
          orders.push({
            tankId: t.id,
            goal: "attackNearest",
            params: { targetTankId: foe.id },
            chatLine: `#${t.number}: engaging enemy #${intent.target_id}.`,
          });
        }
        break;
      }
      case "attack_base": {
        const enemyTeam: TeamId = team === "blue" ? "red" : "blue";
        if (!world.bases?.[enemyTeam]?.alive) {
          notices.push("The enemy base is not on the field.");
          continue;
        }
        for (const t of bots) {
          orders.push({
            tankId: t.id,
            goal: "attackBase",
            params: {},
            chatLine: `#${t.number}: attacking the enemy base.`,
          });
        }
        break;
      }
      case "defend_base": {
        const anchors = defensiveAnchors(world.arenaId, team);
        if (!anchors.length || !world.bases?.[team]?.alive) {
          notices.push("The friendly base is not on the field.");
          continue;
        }
        const taken: Vec2[] = [];
        bots.forEach((t, i) => {
          const point = freePointNear(anchors[i % anchors.length]!, world.walls, taken);
          taken.push(point);
          orders.push({
            tankId: t.id,
            goal: "holdPosition",
            params: { x: point.x, y: point.y, exact: true },
            chatLine: `#${t.number}: defending the base.`,
          });
        });
        break;
      }
      case "cover": {
        if (!player) {
          notices.push("No player tank to cover.");
          continue;
        }
        for (const t of bots) {
          if (t.id === player.id) continue;
          orders.push({
            tankId: t.id,
            goal: "escort",
            params: { targetTankId: player.id },
            chatLine: `#${t.number}: covering you.`,
          });
        }
        break;
      }
      case "move_to": {
        const place = resolvePlace(world, team, intent.ref);
        if ("notice" in place) {
          notices.push(place.notice);
          continue;
        }
        const where = intent.ref.type === "marker" ? "the mark" : `your ${intent.ref.direction}`;
        const slots = place.exact
          ? bots.map((t) => ({ tankId: t.id, x: place.point.x, y: place.point.y }))
          : lineSlots(world, bots, place.point, place.heading);
        for (const s of slots) {
          const t = bots.find((b) => b.id === s.tankId)!;
          orders.push({
            tankId: t.id,
            goal: "moveTo",
            params: place.exact ? { x: s.x, y: s.y, exact: true } : { x: s.x, y: s.y },
            chatLine: `#${t.number}: moving to ${where}.`,
          });
        }
        break;
      }
      case "flank": {
        // "the left of 5" flanks enemy #5 when there is one, else friendly #5.
        const ref =
          enemyByNumber(world, team, intent.reference_id) ??
          (issuer === "ai_commander" ? null : friendlyByNumber(world, team, intent.reference_id));
        if (!ref) {
          notices.push(issuer === "ai_commander"
            ? `Contact #${intent.reference_id} lost before acknowledgement.`
            : `Tank #${intent.reference_id} is not on the field.`);
          continue;
        }
        const movers = bots.filter((t) => t.id !== ref.id);
        const slots = flankSlots(
          world,
          movers,
          ref,
          player,
          intent.side,
          player?.angle ?? 0,
        );
        for (const s of slots) {
          const t = movers.find((b) => b.id === s.tankId)!;
          orders.push({
            tankId: t.id,
            goal: "moveTo",
            params: { x: s.x, y: s.y, side: intent.side },
            chatLine: `#${t.number}: taking the ${intent.side} of #${intent.reference_id}.`,
          });
        }
        break;
      }
      case "surround": {
        const foe = enemyByNumber(world, team, intent.target_id);
        if (!foe) {
          notices.push(`Enemy #${intent.target_id} is not on the field.`);
          continue;
        }
        for (const s of surroundSlots(world, bots, foe)) {
          const t = bots.find((b) => b.id === s.tankId)!;
          orders.push({
            tankId: t.id,
            goal: "moveTo",
            params: { x: s.x, y: s.y, exact: true },
            chatLine: `#${t.number}: surrounding enemy #${intent.target_id}.`,
          });
        }
        break;
      }
    }
  }
  return {
    orders,
    notice: notices.length ? notices.join(" ") : undefined,
  };
}
