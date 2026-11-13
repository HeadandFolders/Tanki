/**
 * The gameplay numbers. Every tank stat, armour rule, repair rate, nuke and
 * per-mode loadout lives in this file and nowhere else (AGENTS.md).
 *
 * `src/config.ts` re-exports it as `CONFIG.roles`, so a hull still reads its
 * numbers through `CONFIG.roles[tank.role]`; `role` is the field name the radio,
 * the roster and the network snapshot already use.
 */
import type { GameMode } from "../config";
import type { BaseTile, MiddleZoneState, Projectile, TeamId } from "../types";

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
 * The contested zone in the middle of the map. A team with a living hull inside
 * it, and no enemy hull inside, brings its dead hulls back twice as fast.
 */
export const MIDDLE_ZONE = {
  /** Zone centre as a fraction of the arena extent — 0.5,0.5 is the exact middle. */
  centerFraction: { x: 0.5, y: 0.5 },
  /**
   * Radius as a fraction of map height, so the 80x50 and the 144x90 maps get the
   * same relative footprint (~6% of the map) and the same reach from either base.
   */
  radiusFraction: 0.18,
  /** Respawn clock multiplier for the team that holds the zone alone. */
  holdRate: 2,
  /** Multiplier for everyone else — the number the game ran at before the zone existed. */
  baseRate: 1,
};

/** Circle in world px resolved from the arena extent; see `MIDDLE_ZONE`. */
export function middleZoneGeometry(width: number, height: number): {
  x: number;
  y: number;
  radius: number;
} {
  return {
    x: width * MIDDLE_ZONE.centerFraction.x,
    y: height * MIDDLE_ZONE.centerFraction.y,
    radius: height * MIDDLE_ZONE.radiusFraction,
  };
}

/** The two fields that decide a team's respawn clock. */
export type RespawnRateControl = Pick<MiddleZoneState, "holder" | "contested">;

/**
 * The only place a respawn clock is scaled. A team alone in the middle zone
 * counts down at `MIDDLE_ZONE.holdRate`; everyone else counts down at
 * `MIDDLE_ZONE.baseRate`, including both teams sharing it, which is recorded on
 * the zone as no holder at all.
 */
export function getRespawnRate(team: TeamId, zone?: RespawnRateControl | null): number {
  return zone && zone.holder === team ? MIDDLE_ZONE.holdRate : MIDDLE_ZONE.baseRate;
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

/**
 * A hull fields one round at a time. A round leaves the field by hitting
 * something, never by wearing out, so the gun is loaded again the instant its
 * last one collides and not before.
 */
export function hasRoundInAir(projectiles: readonly Projectile[], tankId: string): boolean {
  return projectiles.some((p) => p.ownerId === tankId);
}

export function turnRateOf(role: TankTypeId): number {
  return TANK_TYPES[role].turnRate;
}

/**
 * Firing costs the tracks. A hull that has let a shell go inside `windowSec`
 * drives at `factor` of its top speed, so standing off and running are a real
 * choice: to get back up to speed a gunner has to stop shooting.
 *
 * The window is a fixed beat rather than a fraction of the gun's cycle because
 * a hull fields one round at a time — the reload is the shell's flight, not the
 * cooldown, and only the shell knows how long that will be.
 */
export const FIRE_SLOWDOWN = {
  /** Drive speed multiplier while the hull counts as shooting. */
  factor: 0.55,
  /** Seconds after a shell leaves the gun that the hull is still "shooting". */
  windowSec: 1.5,
};

/**
 * Drive speed in px/s: the hull's top speed, or the braced speed of one that
 * shot a moment ago. Every mover reads speed through here — the player's keys,
 * the friendly and enemy brains — so a hull cannot be fast in one mode and slow
 * in another.
 */
export function driveSpeedOf(
  hull: { role: TankTypeId; lastShotAt: number },
  time: number,
): number {
  const top = TANK_TYPES[hull.role].speed;
  const shooting = time - hull.lastShotAt <= FIRE_SLOWDOWN.windowSec;
  return shooting ? top * FIRE_SLOWDOWN.factor : top;
}

/**
 * A turret outruns the hull it sits on: a hull can answer a threat without
 * first swinging its whole vehicle around.
 */
export const TURRET_TRAVERSE_MULTIPLIER = 2.5;

/** Turret slew, rad/s. */
export function turretTurnRateOf(role: TankTypeId): number {
  return TANK_TYPES[role].turnRate * TURRET_TRAVERSE_MULTIPLIER;
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
 * Tiles on a side of a base's square footprint, and the px on a tile side.
 * `src/config.ts` owns the same two numbers, but it imports this file, so
 * reading them back here would be a cycle. Keep them in step with `CONFIG`.
 */
const BASE_FOOTPRINT_TILES = 3;
const TILE_PX = 16;

/**
 * Seeded map generation. One generator, one symmetry, one set of acceptance
 * rules — every number a generated map is built to or judged by is here.
 */
export const MAP_GEN = {
  /** Layout seed used when nothing names one (the game; the batch takes `--map-seed`). */
  seedDefault: 20261112,

  /** The map the area target is measured against: the current hand-built 144x90 default. */
  referenceArena: { cols: 144, rows: 90 },
  /** New map area as a multiple of that reference. */
  areaMultiplier: 3,

  /**
   * How long the shortest tank route from base to base should take, in seconds,
   * driven at `averageHullSpeed()`. The size chooser searches map shapes at the
   * target area for the one that lands in this window.
   */
  baseToBaseSec: { min: 35, max: 45 },
  /** Width/height ratios the chooser may consider, and the one it prefers. */
  aspect: { min: 1.0, max: 1.6, preferred: 1.25 },
  /**
   * Route length as a multiple of the base-to-base straight line. Measured on
   * generated maps: the shortest way from base to base leaves the axis, runs
   * the length of the map one lane out, and returns — so it is this much
   * longer than a line the walls never let a hull drive. The size chooser needs
   * it to turn a wanted travel time into a size before anything is built.
   */
  detourFactor: 1.44,

  /** Tile grid the border ring occupies on every side. */
  borderTiles: 2,
  /** Tiles on a side of a base's square footprint; `config.ts` calls the same thing BASE_FOOTPRINT. */
  footprintTiles: 3,

  /** Carved door and gap width in tiles. 3 tiles = 48px for a 22px hull. */
  corridorTiles: 3,

  /**
   * How the half-map is drawn before anything is measured. The field starts as
   * solid brick, and the three routes are carved lanes through it, so a lane
   * leaving the brick is a detour by construction rather than by luck.
   *
   * Each lane is a row band offset from the midline between the bases, and the
   * offset is a share of the half-height, so the same number works at any size
   * and every band has an exact 180° twin.
   */
  layout: {
    /** The short open avenue, this far north of the midline, in half-heights. */
    avenueFraction: 0.52,
    /** ... and how many rows it is wide: wide enough to drive in, never to hide in. */
    avenueRows: 6,
    /** The long covered alley, this far south of the midline, in half-heights. */
    trenchFraction: 0.75,
    /**
     * An alley is ground this many rows (or columns) across, run straight, with
     * a block of cover `baffleTiles` long stood `baffleDepthTiles` deep into one
     * flank, the other, the other, alternating, every `baffleEveryTiles` along.
     * Four numbers, and each is doing one of the two jobs, never both:
     *
     * - No sight may run it. One flank's blocks are `baffleEveryTiles` apart and
     *   `baffleTiles` long, so a line down the alley sees open ground for
     *   `2 * baffleEveryTiles - baffleTiles` tiles at most — under `sight.firingRunTiles`,
     *   and no line crosses this many rows or columns without meeting a block.
     *   Which needs the blocks to reach past the middle: `2 * baffleDepthTiles
     *   >= alleyRows`, or the centre row is a firing line the whole length.
     * - A hull must get through. The open band left on the far side of a block is
     *   `alleyRows - baffleDepthTiles` rows, and a hull's stance needs the row
     *   either side of it, so that is at least 3. And to change flank it needs a
     *   stretch with nothing stood in it: `baffleEveryTiles - baffleTiles` tiles,
     *   at least 3, or the alley is a dead end at the first block.
     */
    alleyRows: 6,
    baffleTiles: 2,
    baffleDepthTiles: 3,
    baffleEveryTiles: 5,
    /** The wave that crosses the midline, in half-heights of swing. */
    serpentineFraction: 0.3,
    /** Wave rows thick, and half-waves across the map: each one crosses the midline. */
    serpentineRows: 5,
    serpentineLegs: 6,
    /** Carved door and trunk width, and how far a lane runs outside the aprons. */
    trunkTiles: 3,
    /** Open ground carved in front of each base: wide, tall, in tiles. */
    apron: { cols: 18, rows: 26 },
    /**
     * Alcoves cut off the lanes: a trunk wide, this many tiles long, closed by a
     * block of cover at the back. Short enough that no line of fire runs down
     * one and out into the lane it opens on, deep enough to park a hull behind.
     * They are the one thing that does leak sightlines into the alleys — a slant
     * line out of an alley's flank picks up a bay standing in it — so their
     * count, not just their length, is what the protected route's exposure
     * measure is paid in.
     */
    bays: { count: 16, length: [4, 5], backTiles: 2, clearanceTiles: 2 },
    /** Cover blocks a hull cannot shoot through; steel is the rarer, unwreckable one. */
    steelShare: 0.2,
    /** Attempts allowed to land every bay. */
    maxPlaceAttempts: 4000,
  },

  /** What a "sightline" is, for the exposure measure and the baffle rule. */
  sight: {
    /** Ray length used to count how walled-in a point is. */
    probePx: 40,
    /** Of 8 rays, this many must hit a wall for the point to count as covered. */
    coverRaysMin: 2,
    /** An unbroken open run this many tiles long is a firing line: never covered. */
    firingRunTiles: 10,
  },

  /**
   * The acceptance rules. A generated map that fails any of these is thrown
   * away and the generator retries with a new seed.
   */
  rules: {
    /** Share of the shortest route that must be uncovered — it has to be the exposed one. */
    exposedShareMin: 0.5,
    /** Share of the protected route allowed to be uncovered. */
    protectedShareMax: 0.25,
    /** The two routes must differ this much on exposure, or the map has no real choice. */
    exposureGapMin: 0.3,
    /** Shortest route over the base-to-base straight line: walls must force a detour. */
    detourRatioMin: 1.1,
    /** The protected route is the long one: at least this many times the short one. */
    protectedLengthMin: 1.15,
    /** ... but it may not be a slog, or nobody takes it. */
    protectedLengthMax: 2.2,
    /** The middle-zone route, same bound. */
    zoneLengthMax: 2.2,
    /**
     * Cost weight of one uncovered step, in steps, when looking for the
     * protected route. This is what makes A* prefer cover over distance.
     */
    exposureCostWeight: 3,
    /** How near the other route's ground counts as riding it, in tiles. */
    routeSeparationTiles: 3,
    /**
     * ... and how much of a route may do it. Corridors cross each other on
     * their way round the map, which costs a handful of tiles; a route that
     * follows another one's corridor costs most of its length.
     */
    routeOverlapShareMax: 0.12,
    /**
     * Inside this many tiles of a base, routes are allowed to share ground:
     * every lane leaves a base through its apron, and the apron is the one
     * piece of terrain all three ways have in common.
     */
    baseMergeTiles: 21,
    /** Share of the tank-fit lattice that must be reachable from a base. */
    reachableShareMin: 0.9,
    /** Seeds tried before giving up on a requested map seed. */
    maxAttempts: 24,
  },
} as const;

/** Drive speed averaged over the hulls a side fields — the map's ruler in px/s. */
export function averageHullSpeed(loadout: readonly TankTypeId[] = LOADOUTS.company): number {
  return loadout.reduce((sum, role) => sum + TANK_TYPES[role].speed, 0) / loadout.length;
}

/**
 * Where a generated map seats blue's base; red is the 180° mirror of this.
 *
 * Mid-wall, not in a corner: a base in a corner would put one team's spawn
 * beside the lane that reaches the map's far end first, and the generator's
 * lanes are built to run past the middle rather than around a corner.
 */
export function generatedBaseTile(rows: number): BaseTile {
  return {
    tileX: MAP_GEN.borderTiles,
    tileY: Math.round(rows / 2) - 1,
  };
}

/**
 * The open ground carved in front of blue's base, in tiles, inclusive. Red's is
 * the 180° mirror. The generator carves it, the route measure gives it away and
 * the teams spawn inside it, so all three read this one rect rather than each
 * keeping their own copy of where it is.
 */
export function generatedApronTiles(rows: number): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = MAP_GEN.borderTiles;
  const y0 = (rows >> 1) - Math.floor(MAP_GEN.layout.apron.rows / 2);
  return {
    x0,
    y0,
    x1: x0 + MAP_GEN.layout.apron.cols - 1,
    y1: y0 + MAP_GEN.layout.apron.rows - 1,
  };
}

/**
 * The width and height a generated map gets: the shape at `areaMultiplier` x
 * the reference area whose base-to-base drive time, worked out from the hull
 * speeds, sits closest to the middle of the wanted window.
 */
export interface GeneratedMapSize {
  cols: number;
  rows: number;
  /** Base centre to base centre, px. */
  straightPx: number;
  /** The shortest route the generator is expected to yield, px. */
  estRoutePx: number;
  /** ... and how long that takes at the average hull speed. */
  estSec: number;
  avgSpeed: number;
  aspect: number;
}

/** A shape the size chooser scored on its way to picking one. */
interface SizeCandidate extends GeneratedMapSize {
  score: number;
  inside: boolean;
}

export function chooseMapSize(): GeneratedMapSize {
  const target = MAP_GEN.referenceArena.cols * MAP_GEN.referenceArena.rows * MAP_GEN.areaMultiplier;
  const avgSpeed = averageHullSpeed();
  const wanted = (MAP_GEN.baseToBaseSec.min + MAP_GEN.baseToBaseSec.max) / 2;
  const candidates: SizeCandidate[] = [];
  // Every whole-numbered height, but keep both counts even: the generator
  // builds one half and mirrors it, and an odd row count leaves a row that is
  // its own mirror.
  for (let rows = 40; rows <= 600; rows += 2) {
    const cols = Math.round(target / rows / 2) * 2;
    if (cols < 40) continue;
    const aspect = cols / rows;
    if (aspect < MAP_GEN.aspect.min || aspect > MAP_GEN.aspect.max) continue;
    const b = generatedBaseTile(rows);
    const s = TILE_PX;
    const bx = (b.tileX + BASE_FOOTPRINT_TILES / 2) * s;
    const by = (b.tileY + BASE_FOOTPRINT_TILES / 2) * s;
    // Red's base is blue's centre rotated 180° about the map centre, so each
    // base-to-edge gap cancels into `cols * s - 2 * bx`.
    const straightPx = Math.hypot(cols * s - 2 * bx, rows * s - 2 * by);
    const estRoutePx = straightPx * MAP_GEN.detourFactor;
    const estSec = estRoutePx / avgSpeed;
    const inside = estSec >= MAP_GEN.baseToBaseSec.min && estSec <= MAP_GEN.baseToBaseSec.max;
    const score =
      Math.abs(estSec - wanted) / wanted + Math.abs(aspect - MAP_GEN.aspect.preferred) * 0.25;
    candidates.push({
      cols, rows, straightPx, estRoutePx, estSec, avgSpeed, aspect, score, inside,
    });
  }
  if (candidates.length === 0) {
    throw new Error("MAP_GEN: no aspect ratio in range at the target area");
  }
  let best: SizeCandidate = candidates[0]!;
  for (const c of candidates) {
    if ((c.inside && !best.inside) || (c.inside === best.inside && c.score < best.score)) best = c;
  }
  return best;
}

/** Chosen once, because ARENA_SPECS needs a fixed size for the generated map. */
export const MAP_GEN_SIZE = chooseMapSize();

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
