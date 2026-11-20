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
 * registered at (an `Error` captured then). `message-first` puts the message where the site's
 * header was, with nothing before it (Vitest's `error.message + stack.replace(message, '')`);
 * `header` keeps the site's header and puts the message in its place.
 */
export interface ErrorSite {
  readonly error: Error
  readonly mode: 'message-first' | 'header'
}

/** One definition error, worded and coded. */
export function definitionError(
  words: DefinitionWords,
  info: DefinitionErrorInfo,
  site?: ErrorSite,
): Error {
  const code = CODES[info.kind]
  let error: Error
  if (words.format === undefined) {
    error = new CoreError(code, info.message)
  } else {
    const worded = words.format(info)
    error = new Error(worded.message)
    error.name = worded.name
    // Not enumerable: a reporter that prints an error's own properties prints what the runner did.
    Object.defineProperty(error, 'code', { value: code, configurable: true, writable: true })
  }
  if (site !== undefined) placeAt(error, site)
  return error
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
  Object.defineProperty(error, 'code', {
    value: CODES.dependency,
    configurable: true,
    writable: true,
  })
  return error
}

function placeAt(error: Error, site: ErrorSite): void {
  const stack = site.error.stack
  if (stack === undefined) return
  error.stack =
    site.mode === 'message-first'
      ? error.message + stack.replace(site.error.message, '')
      : stack.replace(site.error.message, error.message)
}
