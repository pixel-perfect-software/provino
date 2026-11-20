// The errors of the definition table (T5.9). Core finds each one as a `DefinitionErrorInfo` and
// words it with `CorePolicy.definitions.messages` when the dialect gives one (Vitest's
// `FixtureParseError`, `FixtureDependencyError` and `FixtureAccessError` texts), else in its own
// words on a `CoreError`. Either way the error carries the code of its kind.
import type {
  DefinitionErrorInfo,
  DefinitionErrorKind,
  FormatDefinitionError,
} from '@provino/types'
import { CoreError, type CoreErrorCode } from '../errors.ts'
import type { ErrorSiteSource } from '../internal/model.ts'

/** The `CoreError` code of each kind. */
const CODES: { readonly [K in DefinitionErrorKind]: CoreErrorCode } = {
  parse: 'CORE_DEFINITION_PARSE',
  dependency: 'CORE_DEFINITION_DEPENDENCY',
  access: 'CORE_DEFINITION_ACCESS',
}

/** What the table needs to word its errors. */
export interface DefinitionWords {
  readonly format: FormatDefinitionError | undefined
}

/**
 * Where an error's stack comes from, beside its message: the site a fixture or hook was
 * registered at. `message-first` puts the message where the site's header was, with nothing before
 * it (Vitest's `error.message + stack.replace(message, '')`); `header` keeps the site's header and
 * puts the message in its place. Only a dialect's words rewrite a stack: core's own errors keep
 * the stack they were thrown with.
 */
export interface ErrorSite {
  readonly error: ErrorSiteSource
  readonly mode: 'message-first' | 'header'
}

/**
 * Where the caller of `entry` is, as a bounded stack (10 frames) on a holder whose header reads
 * `Error: STACK_TRACE_ERROR`, as Vitest's `stackTraceError` does.
 */
export function captureSite(entry: Parameters<typeof Error.captureStackTrace>[1]): ErrorSiteSource {
  const holder: { name: string; message: string; stack?: string } = {
    name: 'Error',
    message: 'STACK_TRACE_ERROR',
  }
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 10
  Error.captureStackTrace(holder, entry)
  Error.stackTraceLimit = limit
  return holder
}

/** One definition error, worded and coded. */
export function definitionError(
  words: DefinitionWords,
  info: DefinitionErrorInfo,
  site?: ErrorSite,
): Error {
  if (words.format === undefined) return new CoreError(CODES[info.kind], info.message)
  const worded = words.format(info)
  const error = new Error(worded.message)
  error.name = worded.name
  setCode(error, CODES[info.kind])
  if (site !== undefined) placeAt(error, site)
  return error
}

/** A `dependency` error: the kind most of the table's checks raise. */
export function dependencyError(
  words: DefinitionWords,
  code: string,
  key: string,
  message: string,
  params: Readonly<Record<string, string>> = {},
  site?: ErrorSite,
): Error {
  return definitionError(words, { kind: 'dependency', code, key, message, params }, site)
}

/** Many errors from one registration: one `AggregateError` (Vitest's), or the one alone. */
export function oneOf(words: DefinitionWords, errors: readonly Error[], key: string): Error {
  if (errors.length === 1) return errors[0] as Error
  const info: DefinitionErrorInfo = {
    kind: 'dependency',
    code: 'many',
    key,
    message: `${errors.length} definitions are invalid; see the errors for each.`,
    params: { count: String(errors.length) },
  }
  const worded = words.format?.(info)
  const error = new AggregateError(errors, worded?.message ?? info.message)
  if (worded !== undefined) error.name = worded.name
  setCode(error, CODES.dependency)
  return error
}

/** Not enumerable: a reporter that prints an error's own properties prints what the runner did. */
function setCode(error: Error, code: CoreErrorCode): void {
  Object.defineProperty(error, 'code', { value: code, configurable: true, writable: true })
}

function placeAt(error: Error, site: ErrorSite): void {
  const stack = site.error.stack
  if (stack === undefined) return
  error.stack =
    site.mode === 'message-first'
      ? error.message + stack.replace(site.error.message, '')
      : stack.replace(site.error.message, error.message)
}
