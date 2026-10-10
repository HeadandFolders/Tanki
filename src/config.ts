export type ShareMode = 'auto' | 'report' | 'none';
export type Role = 'scout' | 'shooter';

export interface RoleStats {
  count: number;
  speed: number;
  maxHp: number;
  visionRadius: number;
  canShoot: boolean;
  damage: number;
  fireCooldown: number;
  projectileSpeed: number;
  projectileLife: number;
  debugRate: number;
}

export const CONFIG = {
  canvasWidth: 960,
  canvasHeight: 640,
  tileSize: 16,
  matchSeconds: 300,
  tankRadius: 11,
  tankTurnRate: 4.2,
  separationForce: 90,
  separationRadius: 36,
  homeTerritoryFraction: 0.2,
  debugRange: 42,
  reportInSeconds: 3,
  markerFadeSeconds: 10,
  shareModeDefault: 'report' as ShareMode,
  fogCell: 16,
  hiddenAlpha: 0.99,
  exploredAlpha: 0.35,
  retreatHpFraction: 0.28,
  holdRadius: 42,
  escortDistance: 72,
  arriveRadius: 26,
  stillSpeed: 18,
  projectileRadius: 3,
  muzzleOffset: 18,
  pushbackChance: 0.18,
  chatCap: 80,
  eventCap: 100,
  llmTimeoutMs: 12000,
  llmModel: 'gpt-4o-mini',
  roles: {
    scout: {
      count: 2,
      speed: 95,
      maxHp: 55,
      visionRadius: 165,
      canShoot: false,
      damage: 0,
      fireCooldown: 0.38,
      projectileSpeed: 420,
      projectileLife: 0.9,
      debugRate: 0.55,
    },
    shooter: {
      count: 4,
      speed: 130,
      maxHp: 110,
      visionRadius: 95,
      canShoot: true,
      damage: 22,
      fireCooldown: 0.38,
      projectileSpeed: 420,
      projectileLife: 0.9,
      debugRate: 0.18,
    },
  } satisfies Record<Role, RoleStats>,
};

export function homeTerritoryBounds(width = CONFIG.canvasWidth, height = CONFIG.canvasHeight) {
  const y = height * (1 - CONFIG.homeTerritoryFraction);
  return { x: 0, y, w: width, h: height - y };
}

export function fogGridSize() {
  return {
    cols: Math.floor(CONFIG.canvasWidth / CONFIG.fogCell),
    rows: Math.floor(CONFIG.canvasHeight / CONFIG.fogCell),
  };
}
