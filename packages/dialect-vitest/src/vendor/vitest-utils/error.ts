import type { DiffOptions } from './diff/index.ts'
import type { TestError } from './types.ts'
import { format as prettyFormat } from '../pretty-format/index.ts'
import { getDefaultFormatOptions, printDiffOrStringify } from './diff/index.ts'
import { serializeValue } from './serialize.ts'

export { serializeValue as serializeError }

export function processError(
  _err: any,
  diffOptions?: DiffOptions,
  seen: WeakSet<WeakKey> = new WeakSet(),
): TestError {
  if (!_err || typeof _err !== 'object') {
    return { message: String(_err) }
  }
  const err = _err as TestError

  if (
    err.showDiff ||
    (err.showDiff === undefined && err.expected !== undefined && err.actual !== undefined)
  ) {
    const options = {
      ...diffOptions,
      ...(err.diffOptions as DiffOptions),
    }
    err.diff = printDiffOrStringify(err.actual, err.expected, options, err)

    err.expected = prettifyValue(err.expected, options)
    err.actual = prettifyValue(err.actual, options)
  }

  // some Error implementations may not allow rewriting cause
  // in most cases, the assignment will lead to "err.cause = err.cause"
  try {
    if (!seen.has(err) && typeof err.cause === 'object') {
      seen.add(err)
      err.cause = processError(err.cause, diffOptions, seen)
    }
  } catch {}

  try {
    return serializeValue(err)
  } catch (e: any) {
    return serializeValue(
      new Error(
        `Failed to fully serialize error: ${e?.message}\nInner error message: ${err?.message}`,
      ),
    )
  }
}

function prettifyValue(value: unknown, options: DiffOptions): string | undefined {
  if (typeof value !== 'string') {
    return prettyFormat(value, getDefaultFormatOptions(options))
  }
  return value
}
