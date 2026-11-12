/**
 * The gameplay numbers. Every tank stat, armour rule, repair rate, nuke and
 * per-mode loadout lives in this file and nowhere else (AGENTS.md).
 *
 * `src/config.ts` re-exports it as `CONFIG.roles`, so a hull still reads its
 * numbers through `CONFIG.roles[tank.role]`; `role` is the field name the radio,
 * the roster and the network snapshot already use.
 */
import type { GameMode } from "../config";
import type { TeamId } from "../types";

export type TankTypeId =
  | "scout"
  | "heavy"
  | "artillery"
  | "engineer"
  | "nuke"
  /** The plain line gun. Kept for TDM / CTF / Heavy-Light rosters and for the repeat slot. */
  | "shooter";

/**
 * Where a hull wants to fight, derived from its own gun rather than from a
 * global band. Every value is measured against the hull's `range`.
 *
 * - `push`  — close to the target and hold the fight band (the old behaviour).
 * - `hold`  — shoot what comes into reach, do not run anyone down.
 * - `kite`  — keep the stand-off band and back away when something gets close.
 * - `support` — stay with the company, never lead an assault.
 */
export type FightDoctrine = "push" | "hold" | "kite" | "support";

/** Which face of a hull a hit landed on. */
export type ArmorBand = "front" | "side" | "rear";

export interface NukeSpec {
  /** Seconds between launches. Only the nuke carrier has this block at all. */
  cooldownSec: number;
  /** Seconds it stays on cooldown after spawn, so a match cannot open with one. */
  warmupSec: number;
  /** How far the round may be launched, px. Slow and long — it is a lobbed weapon. */
  range: number;
  /** Shell radius this round detonates against, in px. */
  blastRadius: number;
  /** Damage to a tank at ground zero; it still pays that hull's armour multiplier. */
  damageVsTank: number;
  /** Damage to a base. Bypasses CONFIG.baseDamageMultiplier — this is the anti-base round. */
  damageVsBase: number;
  /** Launch speed, px/s. Slow, so it can be intercepted by killing the carrier. */
  speed: number;
}

export interface TankType {
  /** Radio and HUD name. */
  label: string;
  /** Two-letter mark drawn beside the hull number. */
  shortCode: string;
  maxHealth: number;
  /** Drive speed, px/s. */
  speed: number;
  /** Hull rotation, rad/s. The old flat CONFIG.tankTurnRate was this value. */
  turnRate: number;
  /** Shots per second. The fire cooldown is 1 / fireRate. */
  fireRate: number;
  /** Damage per shell, before the target's armour multiplier. */
  damage: number;
  /** Gun reach in px. Shells die here, and a bot will not shoot past it. */
  range: number;
  /**
   * Sight in px: fog reveal, contact reporting and the drawn vision ring.
   * No fog exists yet, so today it only gates what a hull may believe.
   */
  visionRange: number;
  /**
   * Incoming damage multiplier by the arc the shot arrived from. Lower is
   * tougher, so a front-armed hull wants to be pointed at what shoots it.
   */
  armor: { front: number; side: number; rear: number };
  doctrine: FightDoctrine;
  /**
   * Preferred distance from a target, as a fraction of `range`. A hull backs
   * off through this and stops closing at it. Keep it inside `visionRange`:
   * a hull that holds station beyond what it can see loses its target, drives
   * in, finds it again and oscillates.
   */
  standoff: number;
  /**
   * How far a hull will go after something it cannot personally see, in px.
   * It never overrides an order; it is the radius of the AI's own initiative —
   * peeling for a team contact, breaking a soft order to fight a passer-by, and
   * how far a commander will task this hull instead of a nearer one.
   */
  chaseRange: number;
  projectileSpeed: number;
  canShoot: boolean;
  /** Wreck-debug progress per second (TDM / CTF only). */
  debugRate: number;
  /** Engineer only: hp/s given to friendly hulls inside `repairRange`. */
  repairRate?: number;
  repairRange?: number;
  /** Nuke carrier only. */
  nuke?: NukeSpec;
}

/**
 * A shell has to be alive long enough to still land at the edge of its own
 * gun's reach, and no longer than that plus a little travel room.
 */
export const PROJECTILE_LIFE_SLACK = 1.25;

/** Hit points of a Base War structure. Shells reduce it by `baseDamageMultiplier`. */
export const BASE_HP = 2000;

/**
 * Slow respawn for the multiplayer ruleset (see `isMpRules`): a destroyed hull
 * waits out the delay, then returns to the base it spawned at. TDM, CTF and
 * Heavy/Light keep their one-life rules.
 */
export const RESPAWN = {
  /** Seconds a hull stays in the ground. A countdown ticked at `getRespawnRate`. */
  delaySec: 25,
  /** Seconds of incoming-hull-damage immunity after a hull appears. */
  protectionSec: 2,
};

/**
 * The only place a respawn clock is scaled. 1.0 today: the delay is the same
 * wherever the fight is. Zone control is what makes the two sides' clocks
 * differ, so it changes this number and nothing else.
 */
export function getRespawnRate(_team: TeamId): number {
  return 1;
}

/** Half-width of each armour arc, degrees off the hull's own facing. */
export const ARMOR_ARC_DEG = { front: 60, rear: 45 } as const;

export const TANK_TYPES: Record<TankTypeId, TankType> = {
  scout: {
    label: "Scout",
    shortCode: "SC",
    maxHealth: 60,
    speed: 165,
    turnRate: 5.6,
    fireRate: 1.1,
    damage: 9,
    range: 175,
    visionRange: 240,
    armor: { front: 0.9, side: 1, rear: 1.2 },
    doctrine: "kite",
    standoff: 0.55,
    chaseRange: 420,
    projectileSpeed: 470,
    canShoot: true,
    debugRate: 0.55,
  },
  heavy: {
    label: "Heavy",
    shortCode: "HV",
    maxHealth: 260,
    speed: 78,
    turnRate: 2.6,
    fireRate: 0.55,
    damage: 42,
    range: 170,
    visionRange: 150,
    armor: { front: 0.5, side: 1.1, rear: 1.45 },
    doctrine: "hold",
    standoff: 0.45,
    chaseRange: 150,
    projectileSpeed: 400,
    canShoot: true,
    debugRate: 0.12,
  },
  artillery: {
    label: "Artillery",
    shortCode: "AR",
    maxHealth: 70,
    speed: 72,
    turnRate: 2.2,
    fireRate: 0.16,
    damage: 70,
    range: 380,
    visionRange: 200,
    armor: { front: 0.85, side: 1.15, rear: 1.3 },
    doctrine: "hold",
    standoff: 0.5,
    chaseRange: 120,
    projectileSpeed: 300,
    canShoot: true,
    debugRate: 0.1,
  },
  engineer: {
    label: "Engineer",
    shortCode: "EN",
    maxHealth: 130,
    speed: 118,
    turnRate: 4.2,
    fireRate: 0.9,
    damage: 12,
    range: 165,
    visionRange: 165,
    armor: { front: 0.8, side: 1, rear: 1.2 },
    doctrine: "support",
    standoff: 0.6,
    chaseRange: 220,
    projectileSpeed: 440,
    canShoot: true,
    debugRate: 0.35,
    repairRate: 5,
    repairRange: 85,
  },
  nuke: {
    label: "Nuke carrier",
    shortCode: "NK",
    maxHealth: 170,
    speed: 82,
    turnRate: 2.8,
    fireRate: 0.7,
    damage: 16,
    range: 185,
    visionRange: 160,
    armor: { front: 0.7, side: 1, rear: 1.25 },
    doctrine: "hold",
    standoff: 0.7,
    chaseRange: 140,
    projectileSpeed: 420,
    canShoot: true,
    debugRate: 0.12,
    nuke: {
      cooldownSec: 45,
      warmupSec: 20,
      range: 420,
      blastRadius: 90,
      damageVsTank: 45,
      damageVsBase: 400,
      speed: 210,
    },
  },
  shooter: {
    label: "Gunner",
    shortCode: "GU",
    maxHealth: 110,
    speed: 130,
    turnRate: 4.2,
    fireRate: 6.25,
    damage: 22,
    range: 220,
    visionRange: 95,
    armor: { front: 0.8, side: 1, rear: 1.2 },
    doctrine: "push",
    standoff: 0.4,
    chaseRange: 9999,
    projectileSpeed: 480,
    canShoot: true,
    debugRate: 0.18,
  },
};

/** Hull ids in table order — for reports and per-type aggregations. */
export const TANK_TYPE_IDS = Object.keys(TANK_TYPES) as TankTypeId[];

/** Which of the five new types fill the numbered slots, per loadout. */
export type LoadoutId = "company" | "tdm" | "heavyLight";

export const LOADOUTS: Record<LoadoutId, readonly TankTypeId[]> = {
  /**
   * One of each new type across #1-#5; #6 repeats the cheapest hull. Both teams
   * get the same array by number, so a mirror match stays symmetric.
   */
  company: ["scout", "heavy", "artillery", "engineer", "nuke", "scout"],
  tdm: ["scout", "scout", "shooter", "shooter", "shooter", "shooter"],
  heavyLight: ["heavy", "heavy", "heavy", "shooter", "shooter", "shooter"],
};

/** The `company` loadout is what the multiplayer ruleset fields. */
export function loadoutFor(mode: GameMode): readonly TankTypeId[] {
  if (mode === "heavy-light") return LOADOUTS.heavyLight;
  // mp-offline, mp-online and base-war are the modes where every hull used to
  // be an identical gunner; TDM and CTF keep their scout/gunner rosters.
  return mode === "tdm" || mode === "ctf" ? LOADOUTS.tdm : LOADOUTS.company;
}

/** True when the mode fields one of each type instead of the legacy roster. */
export function usesCompanyLoadout(mode: GameMode): boolean {
  return loadoutFor(mode) === LOADOUTS.company;
}

export function typeOf(role: TankTypeId): TankType {
  return TANK_TYPES[role];
}

/** Fire cooldown in seconds, from the table's shots-per-second. */
export function fireCooldownOf(role: TankTypeId): number {
  return 1 / TANK_TYPES[role].fireRate;
}

export function turnRateOf(role: TankTypeId): number {
  return TANK_TYPES[role].turnRate;
}

/** Shell reach in seconds: how far the round flies before it is spent. */
export function projectileLifeOf(role: TankTypeId): number {
  const stats = TANK_TYPES[role];
  return (stats.range / stats.projectileSpeed) * PROJECTILE_LIFE_SLACK;
}

/**
 * How far from a base a hull of this type can still damage it: its own gun, or
 * the nuke reach for the carrier that throws one. Replaces the single
 * `CONFIG.mpOffline.shootRange` everyone used to share.
 */
export function baseReachOf(role: TankTypeId): number {
  const nuke = TANK_TYPES[role].nuke;
  return nuke ? Math.max(TANK_TYPES[role].range, nuke.range) : TANK_TYPES[role].range;
}

/**
 * Armour band a shot arriving from `bearing` (world radians, measured from the
 * target's own nose) lands in.
 */
export function armorBand(
  target: { angle: number },
  bearing: number,
): ArmorBand {
  let rel = (bearing - target.angle) % (Math.PI * 2);
  if (rel > Math.PI) rel -= Math.PI * 2;
  if (rel < -Math.PI) rel += Math.PI * 2;
  const off = Math.abs(rel);
  if (off <= (ARMOR_ARC_DEG.front * Math.PI) / 180) return "front";
  if (off >= Math.PI - (ARMOR_ARC_DEG.rear * Math.PI) / 180) return "rear";
  return "side";
}

/** Damage a hull of `role` actually takes from a raw hit of `damage`. */
export function armoredDamage(
  role: TankTypeId,
  damage: number,
  band: "front" | "side" | "rear",
): number {
  return damage * TANK_TYPES[role].armor[band];
}

/**
 * The inverse of `armoredDamage`: the raw shell size needed for a hull of
 * `role` to lose exactly `net` hp from a hit arriving on `band`.
 */
export function rawDamageFor(
  role: TankTypeId,
  band: ArmorBand,
  net: number,
): number {
  return net / TANK_TYPES[role].armor[band];
}
