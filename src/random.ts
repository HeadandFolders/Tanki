export interface RandomState {
  seed: number;
  state: number;
}

export function createRandom(seed: number): RandomState {
  return { seed: seed >>> 0, state: seed >>> 0 };
}

export function nextRandom(rng: RandomState): number {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(rng.state ^ (rng.state >>> 15), 1 | rng.state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
