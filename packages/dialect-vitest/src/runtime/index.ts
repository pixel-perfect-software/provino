// @provino/dialect-vitest/runtime: what the Vitest dialect runs in the worker. A stub until the
// `vitest` facade is built (T11.16, Phase 2): `vitestDialect.globals.factory` names it, and
// `provino` doesn't list the dialect among its built-ins, so no run reaches it.
import type { GlobalsHost } from '@provino/types'

// `formatEachTitle` (T5.4) is the dialect's `core.formatEachTitle` behaviour, built; the globals
// below are still the stub.
export { formatEachTitle } from '../each/format-each-title.ts'
export { vitestSnapshotPrinter } from './snapshot-printer.ts'

/**
 * The code a `VitestDialectError` carries.
 * @public
 */
export type VitestDialectErrorCode = 'VITEST_DIALECT_NOT_BUILT'

/**
 * An error from the Vitest dialect.
 * @public
 */
export class VitestDialectError extends Error {
  override readonly name = 'VitestDialectError'
  readonly code: VitestDialectErrorCode

  constructor(code: VitestDialectErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * The Vitest dialect's globals factory. Not built yet: it throws `VITEST_DIALECT_NOT_BUILT`.
 * @public
 */
export function vitestGlobals(_host: GlobalsHost): Readonly<Record<string, unknown>> {
  throw new VitestDialectError(
    'VITEST_DIALECT_NOT_BUILT',
    "The Vitest dialect's globals (`describe`, `vi`, ...) are not built yet (T11.16, Phase 2)",
  )
}
