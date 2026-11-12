import { stepWorld, type InputState } from "./game";
import { assignOrder, restoreGoal, stackFor, type InterruptStack, type OrderEvent } from "./interrupt-stack";
import type { Goal, Wall, WorldState } from "./types";

export type ReplayHz = 30 | 60;
export type SnapshotWorld = Omit<WorldState, "fogExplored"> & { fogExplored: number[] };

export interface ReplaySnapshot {
  version: 1;
  tick: number;
  hz: ReplayHz;
  wallSignature: string;
  world: SnapshotWorld;
  stacks: Record<string, InterruptStack>;
}

export interface ReplayCommand {
  tick: number;
  utterance: string;
  goals: { tankId: string; goal: Goal }[];
}

export interface ReplayInput {
  tick: number;
  local: Omit<InputState, "keys"> & { keys: string[] };
  remote?: Omit<InputState, "keys"> & { keys: string[] };
}

export interface ReplayRecording {
  snapshot: ReplaySnapshot;
  commands: ReplayCommand[];
  inputs: ReplayInput[];
}

export interface ReplayEvent {
  tick: number;
  tankId: string;
  type: "order_applied" | "shot" | "damaged" | "destroyed" | "goal_changed" | OrderEvent["type"];
  reason?: OrderEvent["reason"];
  caption?: string;
  utterance?: string;
  goal?: Goal;
}

export function wallSignature(walls: Wall[]): string {
  return JSON.stringify(walls.map((w) => [w.x, w.y, w.w, w.h, w.kind]));
}

export function captureReplaySnapshot(
  world: WorldState,
  hz: ReplayHz = 60,
  tick = 0,
  stacks: Record<string, InterruptStack> = Object.fromEntries(world.tanks.map((tank) => [tank.id, stackFor(tank)])),
): ReplaySnapshot {
  return structuredClone({
    version: 1,
    tick,
    hz,
    wallSignature: wallSignature(world.walls),
    world: { ...world, fogExplored: Array.from(world.fogExplored) },
    stacks,
  });
}

function validTick(tick: number): boolean {
  return Number.isSafeInteger(tick) && tick >= 0;
}

function restoreWorld(snapshot: ReplaySnapshot): WorldState {
  if (snapshot.version !== 1) throw new Error("Unsupported replay snapshot version");
  if (snapshot.hz !== 30 && snapshot.hz !== 60) throw new Error("Replay must run at 30 or 60 Hz");
  if (!validTick(snapshot.tick)) throw new Error("Invalid replay tick");
  if (snapshot.wallSignature !== wallSignature(snapshot.world.walls)) {
    throw new Error("Replay wall signature mismatch");
  }
  const { seed, state } = snapshot.world.random;
  if (![seed, state].every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) {
    throw new Error("Invalid replay RNG state");
  }
  const world = structuredClone(snapshot.world);
  return { ...world, fogExplored: Uint8Array.from(world.fogExplored) };
}

export class ReplayRunner {
  readonly world: WorldState;
  readonly hz: ReplayHz;
  readonly stacks: Record<string, InterruptStack>;
  readonly events: ReplayEvent[] = [];
  private readonly commands: ReplayCommand[];
  private readonly inputs: ReplayInput[];
  tick: number;

  constructor(recording: ReplayRecording) {
    this.world = restoreWorld(recording.snapshot);
    this.hz = recording.snapshot.hz;
    this.tick = recording.snapshot.tick;
    this.stacks = structuredClone(recording.snapshot.stacks);
    for (const tank of this.world.tanks) {
      restoreGoal(tank, tank.goal, this.stacks[tank.id] ?? tank.orderStack);
      this.stacks[tank.id] = stackFor(tank);
    }
    this.commands = structuredClone(recording.commands);
    this.inputs = structuredClone(recording.inputs);
    if (![...this.commands, ...this.inputs].every((event) => validTick(event.tick))) {
      throw new Error("Invalid replay event tick");
    }
    const inputTicks = new Set(this.inputs.map((input) => input.tick));
    if (inputTicks.size !== this.inputs.length) throw new Error("Duplicate replay input tick");
    for (const id of Object.keys(this.stacks)) {
      if (!this.world.tanks.some((tank) => tank.id === id)) throw new Error(`Unknown stack tank: ${id}`);
    }
    for (const command of this.commands) {
      for (const order of command.goals) {
        if (!this.world.tanks.some((tank) => tank.id === order.tankId)) {
          throw new Error(`Unknown replay tank: ${order.tankId}`);
        }
      }
    }
  }

  step(): boolean {
    if (this.world.outcome !== "playing") return false;
    const eventStart = this.world.orderEvents?.length ?? 0;
    for (const command of this.commands) {
      if (command.tick !== this.tick) continue;
      for (const order of command.goals) {
        const tank = this.world.tanks.find((t) => t.id === order.tankId)!;
        if (!tank.alive) continue;
        assignOrder(this.world, tank, order.goal);
        this.events.push({
          tick: this.tick, tankId: tank.id, type: "order_applied",
          utterance: command.utterance, goal: structuredClone(order.goal),
        });
      }
    }

    const before = this.world.tanks.map((tank) => ({
      hp: tank.hp, alive: tank.alive, shot: tank.lastShotAt, goal: JSON.stringify(tank.goal),
    }));
    const input = this.inputs.find((frame) => frame.tick === this.tick);
    stepWorld(this.world, 1 / this.hz,
      input?.local ?? { keys: [], mouseX: 0, mouseY: 0, shooting: false }, input?.remote);
    this.world.tanks.forEach((tank, i) => {
      const previous = before[i]!;
      const emit = (type: ReplayEvent["type"]) =>
        this.events.push({ tick: this.tick, tankId: tank.id, type });
      if (tank.lastShotAt !== previous.shot) emit("shot");
      if (tank.hp < previous.hp) emit("damaged");
      if (previous.alive && !tank.alive) emit("destroyed");
      if (JSON.stringify(tank.goal) !== previous.goal) {
        this.events.push({ tick: this.tick, tankId: tank.id, type: "goal_changed", goal: structuredClone(tank.goal) });
      }
    });
    for (const event of (this.world.orderEvents ?? []).slice(eventStart)) {
      if (event.type !== "applied") this.events.push({ tick: this.tick, tankId: event.tankId,
        type: event.type, reason: event.reason, caption: event.caption });
    }
    this.tick++;
    return true;
  }

  run(ticks: number, observe?: (runner: ReplayRunner) => void): void {
    if (!validTick(ticks)) throw new Error("Invalid replay step count");
    for (let i = 0; i < ticks && this.step(); i++) observe?.(this);
  }

  checkpoint(): ReplayRecording {
    return {
      snapshot: captureReplaySnapshot(this.world, this.hz, this.tick, this.stacks),
      commands: structuredClone(this.commands),
      inputs: structuredClone(this.inputs),
    };
  }
}
