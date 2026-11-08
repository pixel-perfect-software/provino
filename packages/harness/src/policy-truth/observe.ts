// Reading a policy value out of a golden (T1.7). An `observe` line is `{"id":...,"value":...}`
// (`internal/observe-setup.ts`); the rest of a golden is the converted run (tests, statuses,
// errors, locations) and, for a black-box run, `observed`. These readers are the only code a claim's
// `read` uses, so each is small and fails loudly on a golden it doesn't recognize.
import type { Golden, GoldenTest } from '../golden.ts'

/** A reader found nothing it recognizes: the claim and the golden disagree on the fixture. */
export class ObservationError extends Error {
  override readonly name = 'ObservationError'
}

/** Every `observe` line of a golden's trace, by id. A line that isn't one is skipped. */
export function observations(golden: Golden): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const line of golden.trace ?? []) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) continue
    const { id } = parsed
    if (typeof id !== 'string') continue
    out.set(id, 'value' in parsed ? parsed.value : { threw: (parsed as { threw?: unknown }).threw })
  }
  return out
}

/** The value of the `observe` line with this id. */
export function observation(golden: Golden, id: string): unknown {
  const found = observations(golden)
  if (!found.has(id)) {
    throw new ObservationError(`${golden.suite} (${golden.runner}) observes no "${id}"`)
  }
  return found.get(id)
}

/** The test with this title path, in any file of the golden. */
export function testOf(golden: Golden, ...titles: readonly string[]): GoldenTest {
  const wanted = JSON.stringify(titles)
  for (const file of golden.files) {
    for (const test of file.tests) {
      if (JSON.stringify(test.id.path) === wanted) return test
    }
  }
  throw new ObservationError(`${golden.suite} (${golden.runner}) has no test ${titles.join(' > ')}`)
}

/** Whether the golden has a test with this title path. */
export function hasTest(golden: Golden, ...titles: readonly string[]): boolean {
  const wanted = JSON.stringify(titles)
  return golden.files.some((file) => file.tests.some((t) => JSON.stringify(t.id.path) === wanted))
}

/** A test's status. */
export function statusOf(golden: Golden, ...titles: readonly string[]): string {
  return testOf(golden, ...titles).status
}

/** The messages of a test's errors. */
export function errorsOf(golden: Golden, ...titles: readonly string[]): readonly string[] {
  return testOf(golden, ...titles).errors.map((error) => error.message)
}

/**
 * The number before `ms` in a test's first error (`Exceeded timeout of 5000 ms`, `timed out in
 * 10000ms`), or `null` for a test with no error.
 */
export function timeoutOf(golden: Golden, ...titles: readonly string[]): number | null {
  const [message] = errorsOf(golden, ...titles)
  if (message === undefined) return null
  const match = /(\d+) ?ms\b/.exec(message)
  if (match?.[1] === undefined) {
    throw new ObservationError(`${titles.join(' > ')} failed with no timeout: ${message}`)
  }
  return Number(match[1])
}

/** What a black-box run showed (`observed`). */
export function observedOf(golden: Golden): NonNullable<Golden['observed']> {
  if (golden.observed === undefined) {
    throw new ObservationError(`${golden.suite} (${golden.runner}) is not a black-box run`)
  }
  return golden.observed
}

/** A file a black-box run left, as text. */
export function capturedFile(golden: Golden, file: string): string {
  const text = observedOf(golden).files?.[file]
  if (typeof text !== 'string') {
    throw new ObservationError(`${golden.suite} (${golden.runner}) left no ${file}`)
  }
  return text
}

/** Picks the value whose case holds, or fails naming what the golden showed. */
export function oneOf<T>(shown: unknown, cases: readonly (readonly [T, boolean])[]): T {
  const matching = cases.filter(([, holds]) => holds)
  const [only] = matching
  if (only === undefined || matching.length > 1) {
    throw new ObservationError(
      `the golden shows none or several of the cases: ${JSON.stringify(shown)}`,
    )
  }
  return only[0]
}

/** Every line with its leading space taken off: a runner indents a message it nests. */
function dedent(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n')
}

/**
 * Whether a message template (`Cannot find module '{specifier}' from '{from}'`) appears in `text`,
 * each `{placeholder}` standing for some text. Leading space on every line is ignored.
 */
export function templateIn(template: unknown, text: string): boolean {
  if (typeof template !== 'string' || template === '') return false
  const pattern = dedent(template)
    .split(/(\{[a-z]+\})/i)
    .map((part) =>
      /^\{[a-z]+\}$/i.test(part) ? '[\\s\\S]+?' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('')
  return new RegExp(pattern).test(dedent(text))
}

/** The text a crashed file's golden keeps (`fileError`), from the first file that has one. */
export function fileErrorOf(golden: Golden): string {
  for (const file of golden.files) {
    if (file.fileError !== undefined) return file.fileError.message
  }
  throw new ObservationError(`${golden.suite} (${golden.runner}) has no file error`)
}
