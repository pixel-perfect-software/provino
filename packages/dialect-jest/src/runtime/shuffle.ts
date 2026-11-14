// Jest's shuffle (`--randomize`, `--seed`), rebuilt from jest-circus 30.5.2 `src/shuffleArray.ts`
// (L12-L38): pure-rand's xoroshiro128+ seeded with the run's seed, `unsafeUniformIntDistribution`
// for each index, and a forward Fisher-Yates pass that draws once per element, the last included.
// Same generator and same calls, so a seed gives Jest's order.
import { unsafeUniformIntDistribution, xoroshiro128plus } from 'pure-rand'

/**
 * `core.shuffle` for the Jest dialect: builds the shuffle of one file from the run's seed. The
 * function it returns reorders an array in place and draws from one generator, so the suites of a
 * file, shuffled in the order they first run, consume it in jest-circus's order.
 * @public
 */
export function jestShuffle(seed: number): <T>(items: T[]) => T[] {
  const generator = xoroshiro128plus(seed)
  return <T>(items: T[]): T[] => {
    const length = items.length
    for (let i = 0; i < length; i++) {
      const n = unsafeUniformIntDistribution(i, length - 1, generator)
      const value = items[i] as T
      items[i] = items[n] as T
      items[n] = value
    }
    return items
  }
}
