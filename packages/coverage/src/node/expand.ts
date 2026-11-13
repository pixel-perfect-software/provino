// The coordinator's half of `MapInterner`: a worker's later takes carry a file's counters without
// its maps, and this puts the maps back from the first take that had them.
import type { IstanbulFileCoverageData } from '@provino/types'
import { CoverageError } from '../errors.ts'

/**
 * The maps seen so far, by path and `hash`: keep one per worker (or per run) and pass it to every
 * `expandIstanbulData` call, in the order the takes arrived.
 * @public
 */
export type KnownMaps = Map<string, IstanbulFileCoverageData>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * One take's `data` with every file's maps in place. A file that has no maps and whose maps no
 * earlier take carried is `COVERAGE_BAD_DATA`.
 * @public
 */
export function expandIstanbulData(
  known: KnownMaps,
  data: Readonly<Record<string, unknown>>,
): Record<string, IstanbulFileCoverageData> {
  const expanded: Record<string, IstanbulFileCoverageData> = {}
  for (const [path, entry] of Object.entries(data)) {
    if (!isRecord(entry) || typeof entry.path !== 'string') {
      throw new CoverageError('COVERAGE_BAD_DATA', `the coverage of ${path} is not file data`)
    }
    const key = `${entry.path}\0${typeof entry.hash === 'string' ? entry.hash : ''}`
    if ('statementMap' in entry) {
      const full = entry as unknown as IstanbulFileCoverageData
      known.set(key, full)
      expanded[path] = full
      continue
    }
    const maps = known.get(key)
    if (maps === undefined) {
      throw new CoverageError(
        'COVERAGE_BAD_DATA',
        `the coverage of ${path} came without its maps, and no earlier take had them`,
      )
    }
    expanded[path] = {
      ...maps,
      s: entry.s as IstanbulFileCoverageData['s'],
      f: entry.f as IstanbulFileCoverageData['f'],
      b: entry.b as IstanbulFileCoverageData['b'],
    }
  }
  return expanded
}
