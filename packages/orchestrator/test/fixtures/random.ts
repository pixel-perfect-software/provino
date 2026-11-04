// A seeded PRNG (mulberry32), so the generated workloads and property cases replay exactly from
// their seed. No dependency: the same approach as B06's generated corpus.
export type Random = () => number

export function seeded(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function int(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

export function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T
}

/** A real asynchronous gap: a microtask, the end of the macrotask, or a timer turn. */
export function gap(how: 'microtask' | 'immediate' | 'timeout'): Promise<void> {
  if (how === 'microtask') return Promise.resolve()
  if (how === 'immediate') return new Promise((resolve) => setImmediate(resolve))
  return new Promise((resolve) => setTimeout(resolve, 0))
}
