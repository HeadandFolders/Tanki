import type { WorldState } from "../types";
import type { NetStateSnap } from "./protocol";

export function worldToSnap(world: WorldState): NetStateSnap {
  const winner =
    world.outcome === "win"
      ? "blue"
      : world.outcome === "lose"
        ? "red"
        : world.outcome === "draw"
          ? "draw"
          : null;

  return {
    time: world.time,
    matchLeft: world.matchLeft,
    outcome: world.outcome,
    winner,
    controlledBlue: world.controlledId,
    controlledRed: world.remoteControlledId,
    tanks: world.tanks.map((t) => ({
      id: t.id,
      team: t.team,
      number: t.number,
      role: t.role,
      x: Math.round(t.x * 10) / 10,
      y: Math.round(t.y * 10) / 10,
      angle: Math.round(t.angle * 1000) / 1000,
      hp: Math.round(t.hp),
      maxHp: t.maxHp,
      alive: t.alive,
      goal: t.goal.kind,
      goalSource: t.goal.source,
    })),
    projectiles: world.projectiles.map((p) => ({
      id: p.id,
      team: p.team,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      vx: Math.round(p.vx),
      vy: Math.round(p.vy),
      life: Math.round(p.life * 100) / 100,
    })),
    deathFx: world.deathFx.map((d) => ({
      id: d.id,
      team: d.team,
      tankNumber: d.tankNumber,
      role: d.role,
      x: d.x,
      y: d.y,
      angle: d.angle,
      startedAt: d.startedAt,
    })),
    chat: world.chat.slice(-12).map((c) => ({ text: c.text, kind: c.kind })),
    events: world.events.slice(-16).map((e) => ({ text: e.text, kind: e.kind })),
  };
}

/** Apply host snapshot onto guest world (mutates). Outcome flipped for red. */
export function applySnap(
  world: WorldState,
  snap: NetStateSnap,
  localTeam: "blue" | "red",
): void {
  world.time = snap.time;
  world.matchLeft = snap.matchLeft;
  world.controlledId = snap.controlledBlue;
  world.remoteControlledId = snap.controlledRed;

  if (snap.winner === "draw") world.outcome = "draw";
  else if (snap.winner === "blue") {
    world.outcome = localTeam === "blue" ? "win" : "lose";
  } else if (snap.winner === "red") {
    world.outcome = localTeam === "red" ? "win" : "lose";
  } else if (
    snap.outcome === "playing" ||
    snap.outcome === "countdown" ||
    snap.outcome === "ready"
  ) {
    world.outcome = snap.outcome as WorldState["outcome"];
  }

  for (const s of snap.tanks) {
    const t = world.tanks.find((x) => x.id === s.id);
    if (!t) continue;
    t.x = s.x;
    t.y = s.y;
    t.angle = s.angle;
    t.hp = s.hp;
    t.maxHp = s.maxHp;
    t.alive = s.alive;
    t.goal = {
      kind: s.goal as typeof t.goal.kind,
      source: (s.goalSource as "player" | "system" | undefined) ?? t.goal.source,
      params: t.goal.params,
    };
    t.lastKnownPos = { x: s.x, y: s.y };
  }

  world.projectiles = snap.projectiles.map((p) => ({
    id: p.id,
    team: p.team,
    ownerId: `${p.team}-net`,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    damage: 20,
    life: p.life,
    fromShooter: true,
  }));

  world.deathFx = snap.deathFx.map((d) => ({
    id: d.id,
    team: d.team,
    tankNumber: d.tankNumber,
    role: d.role as "scout" | "shooter",
    x: d.x,
    y: d.y,
    angle: d.angle,
    startedAt: d.startedAt,
  }));

  // Replace chat/events tails when longer (avoid spam flicker)
  if (snap.chat.length) {
    const mapped = snap.chat.map((c) => ({
      t: world.time,
      text: c.text,
      kind: c.kind as "ally" | "sys" | "warn",
    }));
    if (mapped.length >= world.chat.length) world.chat = mapped;
  }
  if (snap.events.length) {
    const mapped = snap.events.map((e) => ({
      t: world.time,
      text: e.text,
      kind: e.kind as "ally" | "sys" | "warn",
    }));
    if (mapped.length >= world.events.length) world.events = mapped;
  }
}
