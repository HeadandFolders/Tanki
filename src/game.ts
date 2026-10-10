import { CONFIG, type ShareMode } from './config';
import { buildWalls, circleHitsAny, dist, rotateToward, tryMove } from './arena';
import { alignForShot, updateBots } from './ai';
import { createFog, gunsLive, nearestSeenEnemy, paintVision, rebuildSharedVision, tankSeesPoint } from './fog';
import { firstGunnerId, spawnTeams } from './spawn';
import type { ChatKind, OrderResult, PickResult, PlayerInput, Projectile, Tank, WorldState, Wreck } from './types';

let matchSerial = 1;

export function pushChat(world: WorldState, kind: ChatKind, text: string) {
  world.chat.push({ kind, text });
  if (world.chat.length > CONFIG.chatCap) world.chat.splice(0, world.chat.length - CONFIG.chatCap);
  world.chatRev++;
}

export function pushEvent(world: WorldState, text: string) {
  world.events.push(text);
  if (world.events.length > CONFIG.eventCap) world.events.splice(0, world.events.length - CONFIG.eventCap);
  world.eventRev++;
}

export function createMatch(shareMode: ShareMode = CONFIG.shareModeDefault): WorldState {
  const walls = buildWalls();
  const tanks = spawnTeams(walls, Math.random);
  const fog = createFog();
  const world: WorldState = {
    matchId: matchSerial++,
    tanks,
    projectiles: [],
    wrecks: [],
    walls,
    fog: fog.fog,
    live: fog.live,
    fogCols: fog.cols,
    fogRows: fog.rows,
    markers: [],
    time: 0,
    phase: 'playing',
    endReason: '',
    shareMode,
    controlledId: firstGunnerId(tanks),
    chat: [],
    events: [],
    chatRev: 0,
    eventRev: 0,
    nextProjectileId: 1,
    nextWreckId: 1,
    nextWreckLetter: 0,
    redWipeAnnounced: false,
    scoutHintAt: -99,
    noContactHintAt: -99,
  };
  const controlled = tanks.find((t) => t.id === world.controlledId);
  pushEvent(world, 'Match start. Home strip is mapped — push north and find the enemy code carrier.');
  pushChat(world, 'sys', 'Net open. Southern band is ours; the rest is blank.');
  if (controlled) {
    pushEvent(world, `You have the conn on #${controlled.number} (${controlled.role === 'scout' ? 'scout' : 'gunner'}).`);
  }
  rebuildSharedVision(world);
  return world;
}

export function setShareMode(world: WorldState, mode: ShareMode) {
  if (world.shareMode === mode) return;
  world.shareMode = mode;
  pushEvent(world, `Share mode set to ${mode}.`);
  pushChat(world, 'sys', `Vision share: ${mode}.`);
}

export function switchToTank(world: WorldState, id: number) {
  const tank = world.tanks.find((t) => t.id === id && t.team === 'blue' && t.alive);
  if (!tank || tank.id === world.controlledId) return;
  world.controlledId = tank.id;
  pushEvent(world, `Control switched to #${tank.number}.`);
}

function nearestLivingBlue(world: WorldState, x: number, y: number): Tank | null {
  let best: Tank | null = null;
  let bestD = Infinity;
  for (const t of world.tanks) {
    if (!t.alive || t.team !== 'blue') continue;
    const d = dist(x, y, t.x, t.y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function letterFor(index: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return alphabet[index] ?? `W${index}`;
}

function killTank(world: WorldState, tank: Tank) {
  if (!tank.alive) return;
  tank.alive = false;
  tank.hp = 0;
  tank.debugProgress = 0;
  const wreck: Wreck = {
    id: world.nextWreckId++,
    label: letterFor(world.nextWreckLetter++),
    team: tank.team,
    tankNumber: tank.number,
    x: tank.x,
    y: tank.y,
    wasCodeCarrier: tank.isCodeCarrier,
    marked: false,
    debugged: false,
    debugResult: null,
  };
  world.wrecks.push(wreck);
  const who = tank.team === 'blue' ? 'Blue' : 'Red';
  pushChat(world, 'warn', `${tank.team === 'blue' ? 'Blue' : 'Red'} #${tank.number} down.`);
  pushEvent(world, `${who} #${tank.number} destroyed. Wreck ${wreck.label}.`);
  if (tank.team === 'blue' && tank.id === world.controlledId) {
    const next = nearestLivingBlue(world, tank.x, tank.y);
    if (next) {
      world.controlledId = next.id;
      pushEvent(world, `Control switched to #${next.number}.`);
    }
  }
  if (world.phase === 'playing' && !world.tanks.some((t) => t.alive && t.team === 'blue')) {
    endMatch(world, 'lose', 'Company wiped.');
  }
}

function endMatch(world: WorldState, phase: WorldState['phase'], reason: string) {
  if (world.phase !== 'playing') return;
  world.phase = phase;
  world.endReason = reason;
  pushEvent(world, reason);
  if (phase === 'win') pushChat(world, 'sys', 'STAGE CLEAR — code recovered.');
  else if (phase === 'lose') pushChat(world, 'warn', 'GAME OVER.');
  else pushChat(world, 'sys', 'DRAW — timer expired, code unconfirmed.');
}

function spawnProjectile(world: WorldState, tank: Tank) {
  const stats = CONFIG.roles[tank.role];
  if (!stats.canShoot) return;
  const ox = Math.cos(tank.angle) * CONFIG.muzzleOffset;
  const oy = Math.sin(tank.angle) * CONFIG.muzzleOffset;
  const shot: Projectile = {
    id: world.nextProjectileId++,
    team: tank.team,
    ownerId: tank.id,
    x: tank.x + ox,
    y: tank.y + oy,
    vx: Math.cos(tank.angle) * stats.projectileSpeed,
    vy: Math.sin(tank.angle) * stats.projectileSpeed,
    life: stats.projectileLife,
    damage: stats.damage,
  };
  world.projectiles.push(shot);
  tank.fireCooldown = stats.fireCooldown;
}

function movePlayer(world: WorldState, input: PlayerInput, dt: number) {
  const tank = world.tanks.find((t) => t.id === world.controlledId && t.alive);
  if (!tank) return;
  const desired = Math.atan2(input.aimY - tank.y, input.aimX - tank.x);
  tank.angle = rotateToward(tank.angle, desired, CONFIG.tankTurnRate * dt);
  let ax = input.ax;
  let ay = input.ay;
  const mag = Math.hypot(ax, ay);
  if (mag > 0) {
    ax /= mag;
    ay /= mag;
  }
  const speed = CONFIG.roles[tank.role].speed;
  const beforeX = tank.x;
  const beforeY = tank.y;
  const next = tryMove(tank.x, tank.y, ax * speed * dt, ay * speed * dt, CONFIG.tankRadius, world.walls);
  tank.x = next.x;
  tank.y = next.y;
  const moved = dist(beforeX, beforeY, tank.x, tank.y);
  if (moved < 0.35) tank.stillTime += dt;
  else {
    tank.stillTime = 0;
    tank.reportLatched = false;
  }
}

function tryFire(world: WorldState, tank: Tank, dt: number, player: boolean) {
  const stats = CONFIG.roles[tank.role];
  if (!tank.alive || !stats.canShoot || tank.fireCooldown > 0) return;
  const live = gunsLive(world, tank.team, player);
  if (!live) {
    if (player && world.time - world.noContactHintAt > 2.5) {
      world.noContactHintAt = world.time;
      pushChat(world, 'warn', 'No contact on the net — guns hold.');
    }
    return;
  }
  if (!player) {
    const lined = alignForShot(tank, world, dt);
    if (!lined || !nearestSeenEnemy(world, tank)) return;
  }
  spawnProjectile(world, tank);
}

function stepProjectiles(world: WorldState, dt: number) {
  const step = 8;
  for (let i = world.projectiles.length - 1; i >= 0; i--) {
    const p = world.projectiles[i];
    if (!p) continue;
    const distTravel = Math.hypot(p.vx, p.vy) * dt;
    const parts = Math.max(1, Math.ceil(distTravel / step));
    const hdt = dt / parts;
    let dead = false;
    for (let s = 0; s < parts; s++) {
      p.x += p.vx * hdt;
      p.y += p.vy * hdt;
      p.life -= hdt;
      if (p.life <= 0 || circleHitsAny(p.x, p.y, CONFIG.projectileRadius, world.walls)) {
        dead = true;
        break;
      }
      for (const tank of world.tanks) {
        if (!tank.alive || tank.team === p.team) continue;
        if (dist(p.x, p.y, tank.x, tank.y) > CONFIG.tankRadius + CONFIG.projectileRadius) continue;
        tank.hp -= p.damage;
        tank.hurtFlash = 0.12;
        tank.stillTime = 0;
        tank.debugProgress = 0;
        tank.reportLatched = false;
        dead = true;
        if (tank.hp <= 0) killTank(world, tank);
        break;
      }
      if (dead) break;
    }
    if (dead) world.projectiles.splice(i, 1);
  }
}

function updateDebug(world: WorldState, dt: number) {
  if (world.phase !== 'playing') return;
  for (const tank of world.tanks) {
    if (!tank.alive) continue;
    const speedStill = tank.stillTime > 0.12;
    if (!speedStill) {
      tank.debugProgress = 0;
      continue;
    }
    const wreck = debugTarget(world, tank);
    if (!wreck || dist(tank.x, tank.y, wreck.x, wreck.y) > CONFIG.debugRange) {
      tank.debugProgress = 0;
      tank.debugWreckId = null;
      continue;
    }
    if (tank.debugWreckId !== wreck.id) {
      tank.debugWreckId = wreck.id;
      tank.debugProgress = 0;
    }
    tank.debugProgress += CONFIG.roles[tank.role].debugRate * dt;
    if (tank.debugProgress < 1) continue;
    tank.debugProgress = 1;
    finishDebug(world, tank, wreck);
  }
}

function debugTarget(world: WorldState, tank: Tank): Wreck | null {
  if (tank.team === 'red') {
    const assigned = world.wrecks.find((w) => w.id === tank.goal.wreckId && !w.debugged && w.team === 'blue');
    if (assigned && dist(tank.x, tank.y, assigned.x, assigned.y) <= CONFIG.debugRange) return assigned;
    let best: Wreck | null = null;
    let bestD = Infinity;
    for (const w of world.wrecks) {
      if (w.team !== 'blue' || w.debugged) continue;
      const d = dist(tank.x, tank.y, w.x, w.y);
      if (d <= CONFIG.debugRange && d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }
  const ordered = world.wrecks.find((w) => w.id === tank.goal.wreckId && !w.debugged && w.team === 'red');
  if (ordered && (ordered.marked || tank.goal.kind === 'debug')) return ordered;
  let best: Wreck | null = null;
  let bestD = Infinity;
  for (const w of world.wrecks) {
    if (w.team !== 'red' || w.debugged || !w.marked) continue;
    const d = dist(tank.x, tank.y, w.x, w.y);
    if (d <= CONFIG.debugRange && d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return best;
}

function finishDebug(world: WorldState, tank: Tank, wreck: Wreck) {
  if (wreck.debugged || world.phase !== 'playing') return;
  wreck.debugged = true;
  wreck.marked = true;
  if (wreck.wasCodeCarrier) {
    wreck.debugResult = 'code';
    const voice = tank.team === 'blue' ? `#${tank.number}` : `Red #${tank.number}`;
    pushChat(world, tank.team === 'blue' ? 'ally' : 'warn', `${voice}: found the code on wreck ${wreck.label}!`);
    if (tank.team === 'blue') endMatch(world, 'win', `Blue found the code on wreck ${wreck.label}.`);
    else endMatch(world, 'lose', `Red found the code on wreck ${wreck.label}.`);
  } else {
    wreck.debugResult = 'clean';
    const who = tank.team === 'blue' ? 'Blue' : 'Red';
    pushChat(world, tank.team === 'blue' ? 'ally' : 'warn', `${who} #${tank.number}: wreck ${wreck.label} is clean.`);
    pushEvent(world, `#${tank.number} cleared wreck ${wreck.label} — no code.`);
  }
  tank.debugProgress = 0;
  tank.debugWreckId = null;
  if (tank.goal.kind === 'debug') tank.goal = { kind: 'holdPosition', x: tank.x, y: tank.y, label: 'clear' };
}

function updateReports(world: WorldState) {
  if (world.shareMode !== 'report' || world.phase !== 'playing') return;
  for (const tank of world.tanks) {
    if (!tank.alive || tank.team !== 'blue' || tank.id === world.controlledId) continue;
    if (tank.stillTime < CONFIG.reportInSeconds) {
      if (tank.stillTime < 0.2) tank.reportLatched = false;
      continue;
    }
    if (tank.reportLatched) continue;
    const seen = paintVision(world, tank, true, true, false);
    tank.reportLatched = true;
    if (seen.fresh < 6) continue;
    const cellWord = seen.fresh === 1 ? 'cell' : 'cells';
    pushChat(world, 'ally', `#${tank.number}: report in — ${seen.fresh} ${cellWord} logged.`);
    pushEvent(world, `#${tank.number} reported ${seen.fresh} ${cellWord}.`);
  }
}

function rareContacts(world: WorldState) {
  if (world.shareMode !== 'none' || world.phase !== 'playing') return;
  for (const tank of world.tanks) {
    if (!tank.alive || tank.team !== 'blue' || tank.id === world.controlledId) continue;
    if (world.time - tank.lastContactChat < 9) continue;
    const foe = world.tanks.find((f) => f.alive && f.team === 'red' && tankSeesPoint(tank, f.x, f.y, world.walls));
    if (!foe) continue;
    if (Math.random() > 0.08) continue;
    tank.lastContactChat = world.time;
    const dir = compass(tank.x, tank.y, foe.x, foe.y);
    pushChat(world, 'ally', `#${tank.number}: contact ${dir}.`);
  }
}

function compass(x: number, y: number, tx: number, ty: number): string {
  const ang = Math.atan2(ty - y, tx - x);
  const dirs = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
  const idx = Math.round((((ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return dirs[idx] ?? 'nearby';
}

function announceRedWipe(world: WorldState) {
  if (world.phase !== 'playing' || world.redWipeAnnounced) return;
  if (world.tanks.some((t) => t.alive && t.team === 'red')) return;
  const carrier = world.wrecks.find((w) => w.team === 'red' && w.wasCodeCarrier);
  if (carrier?.debugResult === 'code') return;
  world.redWipeAnnounced = true;
  pushEvent(world, 'Enemy armor is gone. Debug their code-carrier wreck to win.');
  pushChat(world, 'sys', 'Red company is silent. Find the carrier wreck and debug it.');
}

export function step(world: WorldState, input: PlayerInput, dt: number) {
  if (world.phase !== 'playing') return;
  const capped = Math.min(dt, 0.05);
  world.time += capped;
  if (world.time >= CONFIG.matchSeconds) {
    endMatch(world, 'draw', "Time's up — code unconfirmed.");
    return;
  }
  for (const tank of world.tanks) {
    if (tank.fireCooldown > 0) tank.fireCooldown = Math.max(0, tank.fireCooldown - capped);
    if (tank.hurtFlash > 0) tank.hurtFlash = Math.max(0, tank.hurtFlash - capped);
  }
  movePlayer(world, input, capped);
  updateBots(world, capped);
  const controlled = world.tanks.find((t) => t.id === world.controlledId && t.alive);
  if (controlled && input.shoot) {
    if (!CONFIG.roles[controlled.role].canShoot) {
      if (world.time - world.scoutHintAt > 2.5) {
        world.scoutHintAt = world.time;
        pushChat(world, 'sys', 'Scouts don\'t mount a gun.');
      }
    } else {
      tryFire(world, controlled, capped, true);
    }
  }
  for (const tank of world.tanks) {
    if (!tank.alive || tank.id === world.controlledId) continue;
    tryFire(world, tank, capped, false);
  }
  stepProjectiles(world, capped);
  if (world.phase !== 'playing') return;
  rebuildSharedVision(world);
  updateReports(world);
  updateDebug(world, capped);
  rareContacts(world);
  for (const m of world.markers) m.life -= capped;
  world.markers = world.markers.filter((m) => m.life > 0);
  announceRedWipe(world);
}

export function markWreck(world: WorldState, id: number) {
  const wreck = world.wrecks.find((w) => w.id === id);
  if (!wreck || wreck.debugged) return;
  wreck.marked = true;
  pushEvent(world, `Wreck ${wreck.label} marked for debug.`);
  pushChat(world, 'sys', `Wreck ${wreck.label} marked. Stand on it or order a debug.`);
}

export function pick(world: WorldState, x: number, y: number): PickResult {
  let bestTank: Tank | null = null;
  let bestTd = 22;
  for (const t of world.tanks) {
    if (!t.alive || t.team !== 'blue') continue;
    const d = dist(x, y, t.x, t.y);
    if (d < bestTd) {
      bestTd = d;
      bestTank = t;
    }
  }
  if (bestTank) return { kind: 'tank', id: bestTank.id };
  let bestWreck: Wreck | null = null;
  let bestWd = 20;
  for (const w of world.wrecks) {
    if (!cellVisibleEnough(world, w.x, w.y) && w.team !== 'blue') continue;
    const d = dist(x, y, w.x, w.y);
    if (d < bestWd) {
      bestWd = d;
      bestWreck = w;
    }
  }
  if (bestWreck) return { kind: 'wreck', id: bestWreck.id };
  return { kind: 'empty' };
}

function cellVisibleEnough(world: WorldState, x: number, y: number): boolean {
  const col = Math.floor(x / CONFIG.fogCell);
  const row = Math.floor(y / CONFIG.fogCell);
  if (col < 0 || row < 0 || col >= world.fogCols || row >= world.fogRows) return false;
  const idx = row * world.fogCols + col;
  return world.fog[idx] === 1 || world.live[idx] === 1;
}

export function applyOrderResults(world: WorldState, results: OrderResult[]) {
  if (world.phase !== 'playing') return;
  for (const result of results) {
    const tank = world.tanks.find((t) => t.id === result.tankId && t.alive && t.team === 'blue');
    if (!tank) continue;
    tank.goal = { ...result.goal };
    tank.reportLatched = false;
    if (result.goal.kind === 'debug' && result.goal.wreckId) {
      const wreck = world.wrecks.find((w) => w.id === result.goal.wreckId);
      if (wreck) wreck.marked = true;
    }
    if (result.goal.kind === 'reportIn') tank.stillTime = Math.max(tank.stillTime, 0);
    pushChat(world, 'ally', result.chatLine);
  }
  pushEvent(world, `Interpreted ${results.length} order${results.length === 1 ? '' : 's'}.`);
}

export function controlledTank(world: WorldState): Tank | undefined {
  return world.tanks.find((t) => t.id === world.controlledId);
}
