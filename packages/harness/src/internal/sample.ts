// The harness self-test's sample (`packages/harness/sample/`, T12.6): which of its files a runner's
// copy gets, and how a recording made from it is kept free of this machine's paths.
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedRun, RunEnvironment } from '@provino/types'
import { HarnessError } from '../errors.ts'
import { type Fixture, runnersForTestFile } from '../fixture.ts'
import type { RecordPaths } from '../record.ts'
import { escapeRegExp } from './guards.ts'

/** The sample's directory. */
export const SAMPLE_DIR: string = path.resolve(import.meta.dirname, '..', '..', 'sample')

/** Where the recorded runs live, under the sample. */
export const RECORDED_DIR = '__recorded__'

/** The sample's exclusions file: the calibration rules. */
export const EXCLUSIONS_FILE = 'exclusions.json'

/** The suite id every sample run carries. */
export const SAMPLE_SUITE = 'harness/sample'

/** The sample's file that must crash at collection under both runners, and why. */
export const EXPECTED_CRASH = { file: 'crash.test.ts', cause: 'does-not-exist' } as const

/** The test files Jest's and Vitest's runs list, and a run's dialect. */
export type SampleDialect = 'jest' | 'vitest'

/**
 * What one runner's copy holds: every sample file but the exclusions and the recordings, with a
 * per-dialect pair (`x.jest.test.ts`, `x.vitest.test.ts`) reduced to the dialect's own file, named
 * `x.test.ts`, so both runners report it under one file key. `files` maps each copied path to its
 * source; `testFiles` are the copy's test files, sorted.
 */
export function sampleCopy(
  fixture: Fixture,
  dialect: SampleDialect,
): { files: Map<string, string>; testFiles: string[] } {
  const files = new Map<string, string>()
  for (const file of fixture.files) {
    if (file === EXCLUSIONS_FILE || file.startsWith(`${RECORDED_DIR}/`)) continue
    const runners = runnersForTestFile(file)
    let target = file
    if (runners !== undefined && runners.length === 1) {
      if (runners[0] !== dialect) continue
      target = file.replace(new RegExp(`\\.${dialect}\\.test\\.ts$`), '.test.ts')
    }
    if (files.has(target)) {
      throw new HarnessError(
        'HARNESS_SELF_TEST_FAILED',
        `the sample has both ${files.get(target)} and ${file}, which a ${dialect} copy would both name ${target}`,
        { path: fixture.dir },
      )
    }
    files.set(target, file)
  }
  const testFiles = [...files.keys()].filter((file) => runnersForTestFile(file) !== undefined)
  return { files, testFiles: testFiles.toSorted() }
}

/** Copies `files` (copy path to sample path) from the sample into `workDir`. */
export async function writeSampleCopy(
  fixture: Fixture,
  files: ReadonlyMap<string, string>,
  workDir: string,
): Promise<void> {
  for (const [target, source] of files) {
    const to = path.join(workDir, target)
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(path.join(fixture.dir, source), to)
  }
}

/**
 * What can be wrong with a sample run. `missing-file` and `unexpected-file` say the run doesn't
 * cover the sample's files at all; the others are about how the files ran.
 */
export type SampleProblemKind =
  | 'missing-file'
  | 'unexpected-file'
  | 'crash-missing'
  | 'crash-cause'
  | 'crashed'
  | 'no-tests'
  | 'run-error'

/** One problem with a sample run: its kind, and the line a person reads. */
export interface SampleProblem {
  readonly kind: SampleProblemKind
  readonly message: string
}

const COVERAGE_KINDS: ReadonlySet<SampleProblemKind> = new Set(['missing-file', 'unexpected-file'])

/**
 * Only the problems that say a run doesn't cover the sample's files, whatever its results: a
 * candidate that crashes a file the reference runs is a parity difference, not a broken run.
 */
export function coverageProblems(run: NormalizedRun, testFiles: readonly string[]): string[] {
  return sampleRunProblems(run, testFiles)
    .filter((problem) => COVERAGE_KINDS.has(problem.kind))
    .map((problem) => problem.message)
}

/**
 * Checks that a sample run is whole: its files are exactly the copy's test files, exactly the
 * expected file crashed at collection and for the expected reason, every other file ran tests,
 * and the run has no run-level errors. `assertRunComplete` can't say this: it refuses one crash
 * among passing files. Returns the problems, empty when there are none.
 */
export function sampleRunProblems(
  run: NormalizedRun,
  testFiles: readonly string[],
): SampleProblem[] {
  const problems: SampleProblem[] = []
  const add = (kind: SampleProblemKind, message: string): void => {
    problems.push({ kind, message })
  }
  const listed = new Set(run.files.map((file) => file.file))
  for (const file of testFiles) {
    if (!listed.has(file)) add('missing-file', `${file} is missing from the run`)
  }
  const expected = new Set(testFiles)
  for (const file of run.files) {
    if (!expected.has(file.file)) add('unexpected-file', `${file.file} is not a sample test file`)
    if (file.file === EXPECTED_CRASH.file) {
      const message = file.fileError?.message ?? ''
      if (file.status !== 'crashed')
        add('crash-missing', `${file.file} did not crash (${file.status})`)
      else if (!message.includes(EXPECTED_CRASH.cause)) {
        add('crash-cause', `${file.file} crashed for another reason: ${message}`)
      }
    } else if (file.status === 'crashed') {
      add('crashed', `${file.file} crashed: ${file.fileError?.message ?? '(no message)'}`)
    } else if (file.tests.length === 0) {
      add('no-tests', `${file.file} has no tests`)
    }
  }
  for (const error of run.runErrors) add('run-error', `run error: ${error.message}`)
  return problems
}

/** What the committed recording says for every machine field it doesn't keep. */
export const UNRECORDED = 'unrecorded'

/**
 * The `env` a committed recording carries: the runner's version and the Node major only. The
 * repository is public, so the machine's OS, CPU and RAM are not kept, and the model's other fields
 * say so (`unrecorded`, 0). A golden drops `env`, so no check reads it.
 */
export function recordedEnv(
  runner: string,
  version: string,
  node: string = process.version,
): RunEnvironment {
  return {
    os: UNRECORDED,
    osRelease: UNRECORDED,
    arch: UNRECORDED,
    cpuModel: UNRECORDED,
    cpuCount: 0,
    memoryMb: 0,
    node: node.split('.')[0] ?? node,
    runners: { [runner]: version },
    ci: false,
  }
}

/** What each of this machine's directories becomes in a committed recording. */
export const PATH_PLACEHOLDERS = {
  root: '/__root__',
  repo: '/__repo__',
  home: '/__home__',
} as const

// A directory ends at a separator, a quote or the end of the text, so `/Users/me` is not
// rewritten inside `/Users/mex/...`.
const DIRECTORY_END = String.raw`(?=[/\\"'\x60]|$)`

/**
 * Replaces this machine's directories in a runner's output with placeholders: the work
 * directory (both spellings) with `/__root__`, the repository with `/__repo__`, the home
 * directory with `/__home__`, longest first so a nested directory wins over its parent, and each
 * only where the directory ends. The repository is public, so a recording holds no path of the
 * machine it was made on; `assertNoPathLeak` checks the result as plain text.
 */
export function rewritePaths(text: string, paths: RecordPaths): string {
  const pairs: [string, string][] = [
    [paths.workDir, PATH_PLACEHOLDERS.root],
    [paths.realWorkDir, PATH_PLACEHOLDERS.root],
    [paths.repoRoot, PATH_PLACEHOLDERS.repo],
    [paths.packageDir, `${PATH_PLACEHOLDERS.repo}/packages/harness`],
    [paths.realPackageDir, `${PATH_PLACEHOLDERS.repo}/packages/harness`],
    [paths.home, PATH_PLACEHOLDERS.home],
  ]
  const replace = (out: string, from: string, to: string): string =>
    out.replace(new RegExp(`${escapeRegExp(from)}${DIRECTORY_END}`, 'g'), () => to)
  let out = text
  for (const [from, to] of pairs.toSorted((a, b) => b[0].length - a[0].length)) {
    if (from.length < 2) continue
    out = replace(out, from, to)
    const escaped = JSON.stringify(from).slice(1, -1)
    if (escaped !== from) out = replace(out, escaped, JSON.stringify(to).slice(1, -1))
  }
  return out
}
