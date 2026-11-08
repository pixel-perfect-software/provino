// The harness self-test's sample (`packages/harness/sample/`, T12.6): which of its files a runner's
// copy gets, and how a recording made from it is kept free of this machine's paths.
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedRun } from '@provino/types'
import { HarnessError } from '../errors.ts'
import { type Fixture, runnersForTestFile } from '../fixture.ts'
import type { RecordPaths } from '../record.ts'

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
 * Checks that a sample run is whole: its files are exactly the copy's test files, exactly the
 * expected file crashed at collection and for the expected reason, every other file ran tests,
 * and the run has no run-level errors. `assertRunComplete` can't say this: it refuses one crash
 * among passing files. Returns the problems, empty when there are none.
 */
export function sampleRunProblems(run: NormalizedRun, testFiles: readonly string[]): string[] {
  const problems: string[] = []
  const listed = new Set(run.files.map((file) => file.file))
  for (const file of testFiles) {
    if (!listed.has(file)) problems.push(`${file} is missing from the run`)
  }
  const expected = new Set(testFiles)
  for (const file of run.files) {
    if (!expected.has(file.file)) problems.push(`${file.file} is not a sample test file`)
    if (file.file === EXPECTED_CRASH.file) {
      const message = file.fileError?.message ?? ''
      if (file.status !== 'crashed') problems.push(`${file.file} did not crash (${file.status})`)
      else if (!message.includes(EXPECTED_CRASH.cause)) {
        problems.push(`${file.file} crashed for another reason: ${message}`)
      }
    } else if (file.status === 'crashed') {
      problems.push(`${file.file} crashed: ${file.fileError?.message ?? '(no message)'}`)
    } else if (file.tests.length === 0) {
      problems.push(`${file.file} has no tests`)
    }
  }
  for (const error of run.runErrors) problems.push(`run error: ${error.message}`)
  return problems
}

/** What each of this machine's directories becomes in a committed recording. */
export const PATH_PLACEHOLDERS = {
  root: '/__root__',
  repo: '/__repo__',
  home: '/__home__',
} as const

/**
 * Replaces this machine's directories in a runner's output with placeholders: the work
 * directory (both spellings) with `/__root__`, the repository with `/__repo__`, the home
 * directory with `/__home__`, longest first so a nested directory wins over its parent. The
 * repository is public, so a recording holds no path of the machine it was made on.
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
  let out = text
  for (const [from, to] of pairs.toSorted((a, b) => b[0].length - a[0].length)) {
    if (from.length < 2) continue
    out = out.replaceAll(from, to)
    const escaped = JSON.stringify(from).slice(1, -1)
    if (escaped !== from) out = out.replaceAll(escaped, JSON.stringify(to).slice(1, -1))
  }
  return out
}
