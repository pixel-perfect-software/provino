// Deterministic entries for the cache's tests: key `n` always has the same record.
import type { TransformRecord } from '@provino/types'
import { hashParts } from './fingerprint.ts'

export const KEY_COUNT = 500

export function keyFor(n: number): string {
  return hashParts([`entry-${n}`])
}

/** About 1 KB to 200 KB of code, so some writes span many pages. */
export function entryFor(n: number): Omit<TransformRecord, 'cacheKey' | 'fromCache'> {
  return {
    code: `// entry ${n}\n${`const v${n} = ${n}\n`.repeat(50 + ((n * 37) % 5000))}export {}\n`,
    map: null,
    format: 'esm',
    imports: Array.from({ length: n % 7 }, (_, i) => ({
      specifier: `./dep-${i}`,
      kind: 'static' as const,
      names: '*' as const,
      start: i,
      end: i + 1,
    })),
    staticMocks: [],
    hasTopLevelAwait: false,
    lateDeps: [],
    diagnostics: [],
  }
}
