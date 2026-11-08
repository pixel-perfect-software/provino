// What B13a's corpus check asks of a run: each case (one `observe` line, named by its `id`) is the
// golden's text exactly, and the file's own outcome (status, where the errors are) is the golden's.
// Plain functions, so the comparison is itself under unit test.
import assert from 'node:assert/strict'
import path from 'node:path'
import type { GoldenFile } from '../golden.ts'
import type { CoreRun } from '../runtime-corpus/run-core.ts'

/**
 * Asserts a (non-crashing) run ended the way the golden's file did: the same file status, the same
 * tests carrying errors, and the file carrying an error exactly when the golden's does. A golden
 * with a failed test has no `fileError` to compare (the converters drop a file message that
 * repeats a test's failure, `assembleFile`), so only the status is. Error text is not compared:
 * core's messages are neutral.
 */
export function assertFileOutcome(run: CoreRun, goldenFile: GoldenFile): void {
  assert.equal(run.fileStatus, goldenFile.status, 'file status')
  assert.deepEqual(
    run.tests.map((t) => ({ path: t.path, hasErrors: t.errors.length > 0 })),
    goldenFile.tests.map((t) => ({ path: t.id.path, hasErrors: t.errors.length > 0 })),
    'tests: which carry errors',
  )
  if (!goldenFile.tests.some((t) => t.status === 'failed')) {
    assert.equal(
      run.fileErrors.length > 0,
      goldenFile.fileError !== undefined,
      'whether the file carries an error',
    )
  }
}

/**
 * Asserts the run's tests are the golden's: the same title paths, `dupIndex` and status, in the
 * same order.
 */
export function assertTestsMatchGolden(run: CoreRun, goldenFile: GoldenFile): void {
  assert.deepEqual(
    run.tests.map((t) => ({ path: t.path, dupIndex: t.dupIndex, status: t.status })),
    goldenFile.tests.map((t) => ({
      path: t.id.path,
      dupIndex: t.id.dupIndex,
      status: t.status,
    })),
    'tests: title path, dupIndex and status',
  )
}

/**
 * The `mod-*` fixtures mock modules, which the mock corpus's `jest`/`vi` (no loader) cannot; the
 * mod corpus runs them through the fake loader and counts them there.
 */
export function isModFixture(id: string): boolean {
  return path.posix.basename(id).startsWith('mod-')
}

/**
 * The `timers-*` fixtures fake the global timers, so the timer corpus runs them in a child process
 * and counts them there; the mock corpus leaves them out.
 */
export function isTimerFixture(id: string): boolean {
  return path.posix.basename(id).startsWith('timers-')
}

/**
 * A declared divergence: the DIVERGENCES row, and the exact line the run may give for the case. A
 * run line other than this one fails, so a declared case cannot hide a different bug.
 */
export interface Declared {
  readonly divergence: string
  readonly line: string
}

/**
 * What is wrong with a pair's cases against the declared divergences (by `<label> <case id>`): a
 * difference that is not declared, a declared case that now matches, and a declared case whose
 * line is not the pinned one, so an entry cannot go stale or widen. Every key looked at is added
 * to `seen`, for `undeclaredCases`.
 */
export function declaredProblems(
  label: string,
  results: readonly CaseResult[],
  declared: Readonly<Record<string, Declared>>,
  seen: Set<string>,
): string[] {
  const problems: string[] = []
  for (const result of results) {
    const key = `${label} ${result.id}`
    seen.add(key)
    const entry = declared[key]
    if (entry === undefined) {
      if (!result.matches) {
        problems.push(
          `${key} differs and is not declared\n  want ${result.want}\n  got  ${result.got}`,
        )
      }
    } else if (result.matches) {
      problems.push(`${key} is declared (${entry.divergence}) and now matches the golden`)
    } else if (result.got !== entry.line) {
      problems.push(
        `${key} is declared (${entry.divergence}) but gave another line\n  pinned ${entry.line}\n  got    ${result.got}`,
      )
    }
  }
  return problems
}

/** The declared keys that no pair looked at: each names a case that is not in the corpus. */
export function unseenDeclared(
  declared: Readonly<Record<string, Declared>>,
  seen: ReadonlySet<string>,
): string[] {
  return Object.keys(declared).filter((key) => !seen.has(key))
}

/**
 * The text that names why a file failed to run: the first paragraph after Jest's
 * `● Test suite failed to run` header (Vitest's message has none, so its first paragraph), every
 * line trimmed. What follows it is a code frame or a stack, which the run here does not build. The
 * `Allowed objects:` line is left out, as the Jest transformer leaves it out of the golden (its
 * list follows the Node version). The caller writes the work directory `<root>` first, as the
 * goldens have it.
 */
export function causeText(message: string): string {
  const lines = message.split('\n')
  const header = lines.findIndex((line) => line.trim() === '● Test suite failed to run')
  const body = (header === -1 ? lines : lines.slice(header + 1)).map((line) => line.trim())
  const start = body.findIndex((line) => line !== '')
  if (start === -1) return ''
  const end = body.findIndex((line, index) => index > start && line === '')
  return body
    .slice(start, end === -1 ? undefined : end)
    .filter((line) => !line.startsWith('Allowed objects:'))
    .join('\n')
}

/** One case of a fixture under one profile. */
export interface CaseResult {
  readonly id: string
  readonly matches: boolean
  /** The golden's line, or `undefined` for a case the run made that the golden lacks. */
  readonly want: string | undefined
  /** The run's line, or `undefined` for a case the golden has that the run never made. */
  readonly got: string | undefined
}

/** The `id` of an observation line, or the whole line when it is not one. */
export function caseId(line: string): string {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
      const { id } = parsed
      if (typeof id === 'string') return id
    }
  } catch {
    // Not JSON: the text names itself.
  }
  return line
}

/**
 * Pairs the golden's lines with the run's by case id, in the golden's order, then the run's extra
 * cases. A case is listed once; a repeated id is a fixture bug and throws.
 */
export function compareObservations(
  golden: readonly string[],
  run: readonly string[],
): CaseResult[] {
  const byId = (lines: readonly string[], label: string): Map<string, string> => {
    const map = new Map<string, string>()
    for (const line of lines) {
      const id = caseId(line)
      if (map.has(id)) throw new Error(`the ${label} observes "${id}" twice`)
      map.set(id, line)
    }
    return map
  }
  const wanted = byId(golden, 'golden')
  const got = byId(run, 'run')
  const results: CaseResult[] = []
  for (const [id, want] of wanted) {
    const line = got.get(id)
    results.push({ id, matches: line === want, want, got: line })
  }
  for (const [id, line] of got) {
    if (!wanted.has(id)) results.push({ id, matches: false, want: undefined, got: line })
  }
  return results
}

/**
 * Whether the run made its cases in the golden's order. `compareObservations` pairs by id, so it
 * cannot see a run that observed the same lines in another order; `invocationCallOrder` and every
 * state that builds on an earlier case depend on the order.
 */
export function sameOrder(golden: readonly string[], run: readonly string[]): boolean {
  const ids = (lines: readonly string[]): string => JSON.stringify(lines.map(caseId))
  return ids(golden) === ids(run)
}
