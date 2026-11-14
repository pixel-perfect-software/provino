// What the recorder checks and does with a finished run: is it a whole run, does the golden hold
// a machine path, and write or compare the golden file.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedFile, NormalizedRun } from '@provino/types'
import { HarnessError } from '../errors.ts'
import type { RecordOutcome } from '../golden.ts'
import { readIfExists } from './guards.ts'
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
  /**
   * Every file must crash at collection (`fixture.json`'s `expectCrash` for the profile, which is
   * `undefined` when it has none), and none may do so otherwise. The text is what each crash's
   * `fileError` message must contain.
   */
  readonly expectCrash?: string | undefined
}

/**
 * The problems every run can have, crash or not, in the order they are reported: a file the runner
 * never reported, then for each result file one that was not expected and what `fileProblem` finds
 * wrong with it, then the run's own errors.
 */
function runProblems(
  run: NormalizedRun,
  expectedFiles: readonly string[],
  fileProblem: (file: NormalizedFile) => string | undefined = () => undefined,
): string[] {
  const problems: string[] = []
  const ran = new Set(run.files.map((file) => file.file))
  for (const file of expectedFiles) {
    if (!ran.has(file)) problems.push(`missing result file: ${file} (the runner never reported it)`)
  }
  const expected = new Set(expectedFiles)
  for (const file of run.files) {
    if (!expected.has(file.file)) problems.push(`unexpected result file: ${file.file}`)
    const problem = fileProblem(file)
    if (problem !== undefined) problems.push(problem)
  }
  for (const error of run.runErrors) {
    problems.push(`run error:\n${quoted(error.message)}`)
  }
  return problems
}

function throwIfIncomplete(label: string, problems: readonly string[]): void {
  if (problems.length === 0) return
  throw new HarnessError(
    'HARNESS_RUN_INCOMPLETE',
    `${label} did not run to completion, so it is not recorded:\n  - ${problems.join('\n  - ')}`,
  )
}

/** The normal rule: no file crashed before its tests ran or has none. */
function assertEveryFileRan(
  run: NormalizedRun,
  expectedFiles: readonly string[],
  label: string,
): void {
  throwIfIncomplete(
    label,
    runProblems(run, expectedFiles, (file) => {
      if (file.status === 'crashed') {
        const reason = file.fileError?.message ?? '(no message)'
        return `${file.file} crashed before running its tests:\n${quoted(reason)}`
      }
      return file.tests.length === 0 ? `${file.file} has no tests` : undefined
    }),
  )
}

/** The `expectCrash` rule: every file crashed at collection, with a `fileError` naming `cause`. */
function assertRunCrashed(
  run: NormalizedRun,
  expectedFiles: readonly string[],
  label: string,
  cause: string,
): void {
  throwIfIncomplete(label, runProblems(run, expectedFiles))
  const notCrashed: string[] = []
  const otherCause: string[] = []
  for (const file of run.files) {
    if (file.status !== 'crashed') {
      notCrashed.push(file.file)
      continue
    }
    const message = file.fileError?.message
    if (message?.includes(cause) !== true) {
      otherCause.push(`${file.file}:\n${quoted(message ?? '(no fileError)')}`)
    }
  }
  if (notCrashed.length > 0) {
    throw new HarnessError(
      'HARNESS_EXPECTED_CRASH_MISSING',
      `${label} lists this runner in "expectCrash", but ${notCrashed.join(', ')} did not crash at collection; remove it from "expectCrash" or fix the fixture`,
    )
  }
  if (otherCause.length > 0) {
    throw new HarnessError(
      'HARNESS_EXPECTED_CRASH_MISMATCH',
      `${label} crashed at collection, but not for the reason "expectCrash" names (its message must contain ${JSON.stringify(cause)}):\n  - ${otherCause.join('\n  - ')}`,
    )
  }
}

/**
 * A golden must show every test file the fixture hands the runner, and show it ran. Otherwise a
 * crashed file, an empty `describe` or a transform error is recorded as if it were a result.
 * Throws `HARNESS_RUN_INCOMPLETE` unless the run's files are exactly `expectedFiles`, none is
 * `crashed` or has no tests, and the run has no run-level errors.
 *
 * With `expectCrash` the rule for crashes inverts: a `crashed` file is the result (its `fileError`
 * is recorded), and a file that did not crash throws `HARNESS_EXPECTED_CRASH_MISSING`. A crash
 * with no `fileError`, or whose message does not contain the `expectCrash` text, is a crash for
 * another reason: `HARNESS_EXPECTED_CRASH_MISMATCH`. A missing file and run-level errors are still
 * `HARNESS_RUN_INCOMPLETE`.
 * @internal
 */
export function assertRunComplete(
  run: NormalizedRun,
  expectedFiles: readonly string[],
  label: string,
  options: CompleteOptions = {},
): void {
  const { expectCrash } = options
  if (expectCrash === undefined) assertEveryFileRan(run, expectedFiles, label)
  else assertRunCrashed(run, expectedFiles, label, expectCrash)
}

/**
 * A `before` run only sets up state for the captured run (Jest's failure history, say), so it must
 * have run: its results exist, name every test file, and show no crashed file and no run error.
 * Failing tests are fine. Otherwise `HARNESS_RUN_INCOMPLETE`, because the captured run would
 * record the same golden whether or not the earlier one worked.
 * @internal
 */
export function assertEarlierRunComplete(
  run: NormalizedRun | null,
  expectedFiles: readonly string[],
  label: string,
): void {
  if (run === null) {
    throw new HarnessError(
      'HARNESS_RUN_INCOMPLETE',
      `${label} did not run to completion, so it is not recorded:\n  - the earlier run wrote no results`,
    )
  }
  assertEveryFileRan(run, expectedFiles, label)
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

// jest-message-util 30.5.1 (`build/index.js`, `JEST_INTERNALS_IGNORE`): a frame whose path has a
// directory naming a Jest package (any name containing `jest`, or `@jest/<name>`) directly followed
// by `build/` or `node_modules/` is Jest's own, and Jest leaves it out of every failure it prints.
const JEST_INTERNAL_FRAME =
  /^\s+at(?:.*[/\\])?(?:@jest[/\\][^/\\]+|[^/\\]*jest[^/\\]*)[/\\](?:build|node_modules)[/\\]/

/**
 * Throws `HARNESS_CHECKOUT_HIDES_JEST_FRAMES` when Jest would take every frame under this checkout's
 * `node_modules/` for its own: a checkout at `…/b23a-jest-results/` hides the `expect` package's
 * frames that CI's checkout prints, so a golden recorded there differs from CI's, and `--check`
 * there agrees with a wrong golden. `repoRoot` is the checkout's real path, as Node prints frames.
 * @internal
 */
export function assertCheckoutKeepsJestFrames(repoRoot: string, label: string): void {
  const frame = `    at f (${path.join(path.resolve(repoRoot), 'node_modules', 'x', 'index.js')}:1:1)`
  if (!JEST_INTERNAL_FRAME.test(frame)) return
  throw new HarnessError(
    'HARNESS_CHECKOUT_HIDES_JEST_FRAMES',
    `${label}: Jest 30.5 hides every stack frame under "${repoRoot}/node_modules/", because a directory in that path is named like a Jest package (it contains "jest" and is followed by node_modules/ or build/). A golden recorded here would differ from one recorded in CI's checkout. Record from a checkout whose path has no such directory`,
  )
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
