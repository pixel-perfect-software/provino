// The names of the reporters `run()` and the command line can name, in a module that imports
// nothing: the usage text lists them, and the bin answers `--help` before it loads anything else.

/**
 * The reporters `run()` and the command line can name. A new one goes here, in `builtIn`'s switch
 * (which the compiler holds to this list) and in `ReporterChoice`.
 * @internal
 */
export const BUILT_IN_REPORTERS = [
  'default',
  'verbose',
  'dot',
  'agent',
  'json',
  'normalized-json',
  'junit',
  'github-actions',
  'summary',
] as const

/**
 * A built-in reporter's name.
 * @internal
 */
export type BuiltInReporterName = (typeof BUILT_IN_REPORTERS)[number]

/**
 * The reporters that write a document, to a file or to stdout: they go last, so each sees every
 * other reporter's failure before it writes.
 * @internal
 */
export const DOCUMENT_REPORTERS = ['json', 'normalized-json', 'junit'] as const

/**
 * The name of a reporter that writes a document.
 * @internal
 */
export type DocumentReporterName = (typeof DOCUMENT_REPORTERS)[number]

/**
 * Whether `name` is a built-in reporter.
 * @internal
 */
export function isBuiltInReporter(name: string): name is BuiltInReporterName {
  return BUILT_IN_REPORTERS.some((known) => known === name)
}

/**
 * Whether `name` is a reporter that writes a document.
 * @internal
 */
export function isDocumentReporter(name: string): name is DocumentReporterName {
  return DOCUMENT_REPORTERS.some((known) => known === name)
}
