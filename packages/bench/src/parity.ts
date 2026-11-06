import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  convertJest,
  diffRuns,
  HarnessError,
  type ParityDiff,
  parseJestJson,
  parseNormalizedRun,
  readRunEnvironment,
} from '@provino/harness'
import type { NormalizedRun } from '@provino/types'
import { type BenchPaths, DEFAULT_PATHS, type SuiteSpec, suiteDir } from './suites.ts'

/**
 * How Provino's run of a suite compares with Jest's, test by test.
 * @public
 */
export interface StatusParity {
  /** True when no diff but `passing-assertions` remains: statuses and files agree, and no test is in one run only. */
  readonly ok: boolean
  /** Reference (Jest) tests. */
  readonly referenceTests: number
  /** Reference tests whose status Provino's run matches. */
  readonly statusMatched: number
  /** Tests only Provino's run has. Reported; they also fail the check as `missing-in-reference`. */
  readonly candidateOnlyTests: number
  /** Files in either run, and how many of them have the same status in both. */
  readonly files: number
  readonly filesMatched: number
  /** Every diff except `passing-assertions`: these fail the check. */
  readonly failing: readonly ParityDiff[]
  /** The `passing-assertions` diffs: reported, never failing (the check is on statuses). */
  readonly assertionDiffs: readonly ParityDiff[]
  /** Set when the two reports could not be compared at all, with the reason. */
  readonly unavailable?: string
}

/** What an unavailable comparison reports in place of counts. */
const ZERO_COUNTS = {
  referenceTests: 0,
  statusMatched: 0,
  candidateOnlyTests: 0,
  files: 0,
  filesMatched: 0,
} as const

/**
 * A parity that fails the gate closed: nothing could be compared, for this reason.
 * @public
 */
export function unavailableParity(reason: string): StatusParity {
  return {
    ok: false,
    ...ZERO_COUNTS,
    failing: [],
    assertionDiffs: [],
    unavailable: reason,
  }
}

/**
 * Compares the reports `checkRunner` wrote for Jest and Provino on a suite
 * (`<suite>/check/jest.json` and `provino.json`). Jest's is converted with the suite's `jest/`
 * directory as the root (its real path, the way Provino reports it), and `diffRuns` compares them
 * by test key with no exclusions, messages, console or trace off: the check is on statuses. Any
 * diff but `passing-assertions` fails it, so a file or test in one run only does too. A report
 * the caller has already parsed (`CheckResult.parsed`) goes in `options.reports`, so it is not read
 * and validated a second time; one that is left out is read from its file.
 * @public
 */
export async function checkStatusParity(
  spec: SuiteSpec,
  versions: { readonly jest: string; readonly provino: string },
  options?: {
    readonly paths?: BenchPaths
    readonly reports?: {
      readonly jest?: ReturnType<typeof parseJestJson>
      readonly provino?: NormalizedRun
    }
  },
): Promise<StatusParity> {
  const paths = options?.paths ?? DEFAULT_PATHS
  const dir = suiteDir(spec, paths.suitesRoot)
  const jestPath = join(dir, 'check', 'jest.json')
  const provinoPath = join(dir, 'check', 'provino.json')
  try {
    const rootDir = await realpath(join(dir, 'jest'))
    const jestJson =
      options?.reports?.jest ?? parseJestJson(await readFile(jestPath, 'utf8'), jestPath)
    const jestRun = convertJest(jestJson, {
      rootDir,
      suite: spec.name,
      runnerVersion: versions.jest,
      env: readRunEnvironment({ jest: versions.jest, provino: versions.provino }),
    })
    const provinoRun =
      options?.reports?.provino ??
      parseNormalizedRun(await readFile(provinoPath, 'utf8'), provinoPath)
    const report = diffRuns(jestRun, provinoRun, {
      messageMode: 'none',
      compareConsole: false,
      compareTrace: false,
      exclusions: [],
    })
    const failing = report.diffs.filter((diff) => diff.kind !== 'passing-assertions')
    return {
      ok: failing.length === 0,
      ...report.counts,
      failing,
      assertionDiffs: report.diffs.filter((diff) => diff.kind === 'passing-assertions'),
    }
  } catch (error) {
    // A report the check already read can still fail the converter or the diff (a repeated test
    // key, say). That is a failed comparison, not a crash of the bench.
    if (!(error instanceof HarnessError)) throw error
    return unavailableParity(`${error.code}: ${error.message}`)
  }
}

function describeDiff(diff: ParityDiff): string {
  return `${diff.key} ${diff.kind}: jest ${diff.ref ?? '(none)'}, provino ${diff.cand ?? '(none)'}`
}

/**
 * The lines the check prints for a comparison: the verdict with the counts, then up to `limit`
 * examples of each kind of diff.
 * @public
 */
export function parityLines(parity: StatusParity, limit = 3): readonly string[] {
  if (parity.unavailable !== undefined) {
    return [`FAIL status parity: could not compare jest and provino: ${parity.unavailable}`]
  }
  const lines = [
    `${parity.ok ? 'PASS' : 'FAIL'} status parity: ${parity.statusMatched}/${parity.referenceTests} reference tests have the same status; ${parity.filesMatched}/${parity.files} files; ${parity.candidateOnlyTests} candidate-only tests`,
  ]
  for (const diff of parity.failing.slice(0, limit)) lines.push(`  ${describeDiff(diff)}`)
  if (parity.failing.length > limit) lines.push(`  ... and ${parity.failing.length - limit} more`)
  if (parity.assertionDiffs.length === 0) {
    lines.push('passing-assertion diffs: 0')
  } else {
    lines.push(
      `passing-assertion diffs: ${parity.assertionDiffs.length} tests (reported, not a failure: the check is on statuses)`,
    )
    for (const diff of parity.assertionDiffs.slice(0, limit)) lines.push(`  ${describeDiff(diff)}`)
  }
  return lines
}
