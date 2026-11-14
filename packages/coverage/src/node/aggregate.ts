// T8.10, the coordinator's merge: every file's Istanbul counters from every worker, added up into one
// coverage map, as Jest's CoverageReporter merges each test file's `testResult.coverage`
// (`CoverageReporter.ts` `onTestResult`). A file no test loaded joins it with its initial coverage.
// V8 takes are kept as they came: `convertV8Coverage` merges and converts them once the run is over.
import { fileURLToPath } from 'node:url'
import type { IstanbulFileCoverageData, RawCoverage } from '@provino/types'
import libCoverage from 'istanbul-lib-coverage'
import { CoverageError } from '../errors.ts'
import type { V8Coverage } from './v8.ts'

/**
 * The run's coverage as it is collected.
 * @public
 */
export interface CoverageAggregate {
  /** Adds one take of a worker (an Istanbul take's maps already expanded). */
  add(raw: RawCoverage): void
  /** Adds a file's initial coverage (a file no test loaded), unless the map already has the file. */
  addUntested(data: IstanbulFileCoverageData): void
  /** Whether a file at this absolute path has data (Istanbul's, or a V8 script of that path). */
  has(path: string): boolean
  /** The merged Istanbul map, as `istanbul-lib-coverage` holds it. */
  readonly map: libCoverage.CoverageMap
  /** The V8 takes, in the order they came. */
  readonly v8: readonly V8Coverage[]
}

/**
 * Creates the aggregate of one run.
 * @public
 */
export function createCoverageAggregate(): CoverageAggregate {
  const map = libCoverage.createCoverageMap({})
  const v8: V8Coverage[] = []
  /** The paths the V8 takes have a script of. */
  const v8Paths = new Set<string>()
  return {
    map,
    v8,
    add(raw) {
      if (raw.kind === 'v8') {
        v8.push(raw)
        for (const script of raw.scripts) {
          v8Paths.add(script.url.startsWith('file:') ? fileURLToPath(script.url) : script.url)
        }
        return
      }
      for (const [path, entry] of Object.entries(raw.data)) {
        if (typeof entry !== 'object' || entry === null || !('statementMap' in entry)) {
          throw new CoverageError('COVERAGE_BAD_DATA', `the coverage of ${path} is not file data`)
        }
        // `merge` adds the counters of a file it has; `structuredClone` keeps the take unshared.
        map.merge({ [path]: structuredClone(entry) as libCoverage.FileCoverageData })
      }
    },
    addUntested(data) {
      if (map.data[data.path] !== undefined) return
      map.addFileCoverage(structuredClone(data) as libCoverage.FileCoverageData)
    },
    has: (path) => map.data[path] !== undefined || v8Paths.has(path),
  }
}

/**
 * A coverage map over plain data (what `--json`'s `coverageMap` is, Jest's `createCoverageMap`).
 * @public
 */
export function createCoverageMap(
  data: Readonly<Record<string, IstanbulFileCoverageData>>,
): libCoverage.CoverageMap {
  return libCoverage.createCoverageMap(structuredClone(data) as libCoverage.CoverageMapData)
}
