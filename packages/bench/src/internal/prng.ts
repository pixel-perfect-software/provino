/**
 * A seeded pseudo-random generator (mulberry32): the same seed always gives the same sequence of
 * numbers in [0, 1). Bootstrap resampling and the suite generators use it so their output never
 * depends on `Math.random` or the clock.
 * @internal
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A random integer in [0, bound) from a generator made by `seededRandom`.
 * @internal
 */
export function randomBelow(random: () => number, bound: number): number {
  return Math.floor(random() * bound)
}

/**
 * `count` distinct integers in [0, bound), sorted ascending.
 * @internal
 */
export function pickDistinct(random: () => number, bound: number, count: number): number[] {
  const picked = new Set<number>()
  while (picked.size < count) picked.add(randomBelow(random, bound))
  return [...picked].sort((a, b) => a - b)
}
