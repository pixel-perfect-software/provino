// The coverage thresholds of a run (T8.11), as Jest's `CoverageReporter._checkThreshold` applies
// them (jest-reporters CoverageReporter.ts L242-L444). The words come from the policy
// (`coverage.thresholdMessages`); the dialect that supplies them is not named here.
import { isAbsolute, resolve, sep } from 'node:path'
import type { CoverageMetric, CoveragePolicy, CoverageThresholdGroup } from '@provino/types'
import type libCoverage from 'istanbul-lib-coverage'
import { globSync } from 'tinyglobby'
import { CoverageError } from '../errors.ts'

/** The order Jest checks a group's metrics in (not the order the config lists them). */
const METRICS: readonly CoverageMetric[] = ['statements', 'branches', 'lines', 'functions']

/**
 * The slice of the policy the check reads.
 * @public
 */
export type ThresholdPolicy = Pick<
  CoveragePolicy,
  'thresholdGrouping' | 'globThresholdScope' | 'thresholdMessages'
>

/**
 * What `checkThresholds` reads besides the map and the groups.
 * @public
 */
export interface CheckThresholdsOptions {
  /** What a relative group (a path or a glob) is resolved against (Jest: the process's directory). */
  readonly cwd: string
  /**
   * The absolute paths a glob names, absolute. Defaults to tinyglobby (Jest: `glob.sync`, dotfiles
   * left out).
   */
  readonly globFiles?: (pattern: string, cwd: string) => readonly string[]
}

type GroupType = 'glob' | 'global' | 'path'

function defaultGlobFiles(pattern: string, cwd: string): readonly string[] {
  return globSync(pattern, { cwd, absolute: true, expandDirectories: false })
}

function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key]
    return value === undefined ? whole : String(value)
  })
}

/**
 * The messages for one group against what a set of files covers: a percentage below its minimum,
 * a negative threshold's cap on the uncovered count.
 */
function check(
  policy: ThresholdPolicy,
  name: string,
  group: CoverageThresholdGroup,
  actuals: libCoverage.CoverageSummary,
): string[] {
  const errors: string[] = []
  for (const metric of METRICS) {
    const threshold = group[metric]
    if (threshold === undefined) continue
    const { total, covered, pct } = actuals[metric]
    const uncovered = total - covered
    if (threshold < 0) {
      if (threshold * -1 < uncovered) {
        errors.push(
          fill(policy.thresholdMessages.aboveMaximumUncovered, {
            metric,
            actual: uncovered,
            name,
            threshold: -1 * threshold,
          }),
        )
      }
    } else if (pct < threshold) {
      errors.push(
        fill(policy.thresholdMessages.belowMinimum, { metric, actual: pct, name, threshold }),
      )
    }
  }
  return errors
}

/**
 * The failures of `groups` against `map`, in the order Jest reports them; empty when every
 * threshold is met. Jest's grouping: each file counts for every path or glob group that names it
 * (a path group is a prefix of the file's path, a glob is expanded once), and `global` takes the
 * files no other group named, or every file when none was left over; a glob group is checked file
 * by file, `global` and path groups on their files' sum; a group that no file matched is "not
 * found" (except `global`). A policy whose grouping is not Jest's is refused: Vitest's is B25's.
 * @public
 */
export function checkThresholds(
  map: libCoverage.CoverageMap,
  groups: readonly CoverageThresholdGroup[],
  policy: ThresholdPolicy,
  options: CheckThresholdsOptions,
): readonly string[] {
  if (policy.thresholdGrouping !== 'first-match' || policy.globThresholdScope !== 'per-file') {
    throw new CoverageError(
      'COVERAGE_NOT_IMPLEMENTED',
      `Coverage thresholds with grouping "${policy.thresholdGrouping}" and glob scope "${policy.globThresholdScope}" are not built yet (B25).`,
    )
  }
  if (groups.length === 0) return []
  const globFiles = options.globFiles ?? defaultGlobFiles
  const coveredFiles = map.files()
  const names = groups.map((group) => group.name)
  const typeOf = new Map<string, GroupType>()
  const filesByGlob = new Map<string, readonly string[]>()
  const hasGlobal = names.includes('global')

  const sorted: [string, string | undefined][] = []
  for (const file of coveredFiles) {
    const matches: [string, string][] = []
    for (const name of names) {
      if (name === 'global') continue
      // Jest keeps a trailing separator the user wrote, which `path.resolve` drops.
      const resolved = resolve(options.cwd, name)
      const suffix = name.endsWith(sep) && !resolved.endsWith(sep) ? sep : ''
      const absolute = `${resolved}${suffix}`
      if (file.startsWith(absolute)) {
        typeOf.set(name, 'path')
        matches.push([file, name])
        continue
      }
      let expanded = filesByGlob.get(absolute)
      if (expanded === undefined) {
        expanded = globFiles(absolute, options.cwd).map((path) =>
          isAbsolute(path) ? resolve(path) : resolve(options.cwd, path),
        )
        filesByGlob.set(absolute, expanded)
      }
      if (expanded.includes(file)) {
        typeOf.set(name, 'glob')
        matches.push([file, name])
      }
    }
    if (matches.length > 0) sorted.push(...matches)
    else if (hasGlobal) {
      typeOf.set('global', 'global')
      sorted.push([file, 'global'])
    } else sorted.push([file, undefined])
  }
  if (hasGlobal) typeOf.set('global', 'global')

  const filesIn = (name: string): string[] =>
    sorted.filter(([, group]) => group === name).map(([file]) => file)
  const combine = (files: readonly string[]): libCoverage.CoverageSummary | undefined => {
    let combined: libCoverage.CoverageSummary | undefined
    for (const file of files) {
      const summary = map.fileCoverageFor(file).toSummary()
      combined = combined === undefined ? summary : combined.merge(summary)
    }
    return combined
  }

  const errors: string[] = []
  for (const group of groups) {
    const { name } = group
    switch (typeOf.get(name)) {
      case 'global': {
        const files = filesIn('global')
        const coverage = combine(files.length > 0 ? files : coveredFiles)
        if (coverage) errors.push(...check(policy, name, group, coverage))
        break
      }
      case 'path': {
        const coverage = combine(filesIn(name))
        if (coverage) errors.push(...check(policy, name, group, coverage))
        break
      }
      case 'glob':
        for (const file of filesIn(name)) {
          errors.push(...check(policy, file, group, map.fileCoverageFor(file).toSummary()))
        }
        break
      default:
        errors.push(fill(policy.thresholdMessages.notFound, { path: name }))
    }
  }
  return errors.filter((error) => error.length > 0)
}
