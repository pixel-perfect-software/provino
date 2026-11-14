// T8.10, the coordinator's merge: every file's Istanbul counters from every worker, added up into one
// coverage map, as Jest's CoverageReporter merges each test file's `testResult.coverage`
// (`CoverageReporter.ts` `onTestResult`). A file no test loaded joins it with its initial coverage.
import type { IstanbulFileCoverageData, RawCoverage } from '@provino/types'
import libCoverage from 'istanbul-lib-coverage'
import { CoverageError } from '../errors.ts'

/**
 * The run's coverage as it is collected.
 * @public
 */
export interface CoverageAggregate {
  /** Adds one take of a worker (its maps already expanded). V8 takes are T8.12's (`COVERAGE_NOT_IMPLEMENTED`). */
  add(raw: RawCoverage): void
  /** Adds a file's initial coverage (a file no test loaded), unless the map already has the file. */
  addUntested(data: IstanbulFileCoverageData): void
  /** Whether a file at this absolute path has data. */
  has(path: string): boolean
  /** The merged map, as `istanbul-lib-coverage` holds it. */
  readonly map: libCoverage.CoverageMap
}

/**
 * Creates the aggregate of one run.
 * @public
 */
export function createCoverageAggregate(): CoverageAggregate {
  const map = libCoverage.createCoverageMap({})
  return {
    map,
    add(raw) {
      if (raw.kind !== 'istanbul') {
        throw new CoverageError(
          'COVERAGE_NOT_IMPLEMENTED',
          "V8 coverage isn't merged into reports yet (T8.12)",
        )
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
    has: (path) => map.data[path] !== undefined,
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
