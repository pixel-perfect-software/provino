// What the recorder checks and does with a finished run: is it a whole run, does the golden hold
// a machine path, and write or compare the golden file.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedRun } from '@provino/types'
import { HarnessError } from '../errors.ts'
import type { RecordOutcome } from '../golden.ts'
import { isNotFound } from './guards.ts'
import { lineDiff } from './text-diff.ts'

function quoted(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n')
}

/**
 * What `assertRunComplete` allows beyond a plain run.
 * @internal
 */
export interface CompleteOptions {
  /** Every file must crash at collection (`fixture.json`'s `expectCrash`), and none may do so otherwise. */
  readonly expectCrash?: boolean
}

/**
 * A golden must show every test file the fixture hands the runner, and show it ran. Otherwise a
 * crashed file, an empty `describe` or a transform error is recorded as if it were a result.
 * Throws `HARNESS_RUN_INCOMPLETE` unless the run's files are exactly `expectedFiles`, none is
 * `crashed` or has no tests, and the run has no run-level errors.
 *
 * With `expectCrash` the rule for crashes inverts: a `crashed` file is the result (its `fileError`
 * is recorded), and a file that did not crash throws `HARNESS_EXPECTED_CRASH_MISSING`. A missing
 * file and run-level errors are still `HARNESS_RUN_INCOMPLETE`.
 * @internal
 */
export function assertRunComplete(
  run: NormalizedRun,
  expectedFiles: readonly string[],
  label: string,
  options: CompleteOptions = {},
): void {
  const expectCrash = options.expectCrash === true
  const problems: string[] = []
  const notCrashed: string[] = []
  const ran = new Set(run.files.map((file) => file.file))
  for (const file of expectedFiles) {
    if (!ran.has(file)) problems.push(`missing result file: ${file} (the runner never reported it)`)
  }
  const expected = new Set(expectedFiles)
  for (const file of run.files) {
    if (!expected.has(file.file)) problems.push(`unexpected result file: ${file.file}`)
    if (expectCrash) {
      if (file.status !== 'crashed') notCrashed.push(file.file)
    } else if (file.status === 'crashed') {
      const reason = file.fileError?.message ?? '(no message)'
      problems.push(`${file.file} crashed before running its tests:\n${quoted(reason)}`)
    } else if (file.tests.length === 0) {
      problems.push(`${file.file} has no tests`)
    }
  }
  for (const error of run.runErrors) {
    problems.push(`run error:\n${quoted(error.message)}`)
  }
  if (problems.length > 0) {
    throw new HarnessError(
      'HARNESS_RUN_INCOMPLETE',
      `${label} did not run to completion, so it is not recorded:\n  - ${problems.join('\n  - ')}`,
    )
  }
  if (notCrashed.length > 0) {
    throw new HarnessError(
      'HARNESS_EXPECTED_CRASH_MISSING',
      `${label} lists this runner in "expectCrash", but ${notCrashed.join(', ')} did not crash at collection; remove it from "expectCrash" or fix the fixture`,
    )
  }
}

/**
 * A golden is committed and read on other machines, so it must not hold a path from this one.
 * Throws `HARNESS_GOLDEN_LEAKS_PATH` if the serialized golden contains any of `forbidden` (the work
 * directory and its realpath, the repository, the package, the home directory), as written or
 * JSON-escaped. Empty and root-only entries are ignored.
 * @internal
 */
export function assertNoPathLeak(text: string, forbidden: readonly string[], label: string): void {
  for (const candidate of forbidden) {
    if (candidate.length < 2) continue
    const escaped = JSON.stringify(candidate).slice(1, -1)
    if (text.includes(candidate) || text.includes(escaped)) {
      throw new HarnessError(
        'HARNESS_GOLDEN_LEAKS_PATH',
        `${label}: the recorded golden contains the path "${candidate}", which would tie it to this machine. A normalization rule missed it`,
      )
    }
  }
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (cause) {
    if (isNotFound(cause)) return undefined
    throw cause
  }
}

/**
 * Writes the golden, or with `check` compares it with the committed one and writes nothing. `diff`
 * is the differing lines, for `drift`.
 * @internal
 */
export async function commitGolden(
  target: string,
  text: string,
  check: boolean,
): Promise<{ readonly outcome: RecordOutcome; readonly diff?: string }> {
  const committed = await readIfExists(target)
  if (check) {
    if (committed === undefined) return { outcome: 'missing' }
    if (committed === text) return { outcome: 'matches' }
    return { outcome: 'drift', diff: lineDiff(committed, text) }
  }
  if (committed === text) return { outcome: 'unchanged' }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, text)
  return { outcome: 'written' }
}
