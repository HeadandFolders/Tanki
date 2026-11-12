import { planRoute } from "./ai";
import { CONFIG } from "./config";
import type { BodyStep } from "./motion";
import type { Tank, WorldState } from "./types";

export interface StuckState {
  movementKey: string | null;
  stillFor: number;
  stuck: boolean;
  sinceTime: number | null;
  blockerAllyIds: string[];
  lastStuckAt: number | null;
}

export interface StuckSample {
  time: number;
  dt: number;
  movementKey: string | null;
  held: boolean;
  arrived: boolean;
  shootingInFightBand: boolean;
  fittedStep: BodyStep;
}

export function detectStuck(
  previous: Readonly<StuckState> | undefined,
  sample: StuckSample,
): StuckState {
  const wantsToMove =
    sample.movementKey !== null && !sample.held && !sample.arrived && !sample.shootingInFightBand;
  // One pixel per second reads as no displacement at both 30 and 60 Hz.
  const stationary = wantsToMove && Math.hypot(sample.fittedStep.x, sample.fittedStep.y) <= sample.dt;
  const streaking =
    stationary && previous?.movementKey === sample.movementKey && previous.sinceTime !== null;
  const stillFor = (streaking ? previous.stillFor : 0) + (stationary ? sample.dt : 0);
  const stuck = stationary && stillFor >= CONFIG.ai.stuckAfterSec - 1e-9;
  return {
    movementKey: sample.movementKey,
    stillFor,
    stuck,
    sinceTime: stationary ? (streaking ? previous.sinceTime : sample.time - sample.dt) : null,
    blockerAllyIds: stationary ? [...new Set(sample.fittedStep.blockerAllyIds)].sort() : [],
    lastStuckAt: stuck ? sample.time : previous?.lastStuckAt ?? null,
  };
}

/**
 * The living allies a stalled hull is pressing on. Sampled into the state while
 * the hull is still, so a reroute gets the bodies that were near it at the time.
 */
export function stuckBlockers(
  world: WorldState,
  tank: Tank,
  state: Readonly<StuckState>,
): Tank[] {
  const ids = new Set(state.blockerAllyIds);
  return world.tanks.filter((ally) =>
    ally.alive && ally.team === tank.team && ally.id !== tank.id && ids.has(ally.id));
}

export function replanStuckRoute(
  world: WorldState,
  tank: Tank,
  target: { x: number; y: number },
  state: Readonly<StuckState>,
  foes: { id: string; x: number; y: number; gunRange: number }[],
): { x: number; y: number }[] | null {
  if (!state.stuck) return null;
  const allies = stuckBlockers(world, tank, state);
  const points = planRoute(tank.x, tank.y, target.x, target.y, world.walls, CONFIG.tankRadius, foes, allies);
  const end = points[points.length - 1];
  if (points.length < 2 || !end || Math.hypot(end.x - target.x, end.y - target.y) > 8) return null;
  return points;
}
