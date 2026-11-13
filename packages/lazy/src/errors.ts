// Every lazy error is a `LazyError` with a stable `code`, so tests assert the code and not the text.
import type { SourceLocation } from '@provino/types'

/**
 * Where a thrown definition value keeps the chain of lazies that were being evaluated, for
 * reporters.
 * @public
 */
export const LAZY_CHAIN: unique symbol = Symbol.for('provino.lazy.chain')

/**
 * Every code a `LazyError` carries.
 * @public
 */
export const LAZY_ERROR_CODES: readonly [
  'LAZY_RESERVED',
  'LAZY_DUPLICATE',
  'LAZY_INVALID',
  'LAZY_NOT_COLLECTING',
  'LAZY_NO_TEST',
  'LAZY_UNDEFINED',
  'LAZY_SCOPE',
  'LAZY_CYCLE',
  'LAZY_EAGER_PENDING',
  'LAZY_IN_CLEANUP',
  'LAZY_BAD_CONTEXT',
  'LAZY_READONLY',
  'LAZY_NO_RUNTIME',
  'LAZY_TIMEOUT',
] = [
  'LAZY_RESERVED',
  'LAZY_DUPLICATE',
  'LAZY_INVALID',
  'LAZY_NOT_COLLECTING',
  'LAZY_NO_TEST',
  'LAZY_UNDEFINED',
  'LAZY_SCOPE',
  'LAZY_CYCLE',
  'LAZY_EAGER_PENDING',
  'LAZY_IN_CLEANUP',
  'LAZY_BAD_CONTEXT',
  'LAZY_READONLY',
  'LAZY_NO_RUNTIME',
  'LAZY_TIMEOUT',
]

/**
 * The code of a `LazyError`.
 * @public
 */
export type LazyErrorCode = (typeof LAZY_ERROR_CODES)[number]

/**
 * What a `LazyError` can carry besides its message.
 * @public
 */
export interface LazyErrorOptions {
  /** The definition or call the error is about (a `file:line:column` the reporter prints). */
  readonly site?: SourceLocation
  /** Every site involved, when more than one is (a cycle, a scope clash). */
  readonly sites?: readonly SourceLocation[]
  readonly cause?: unknown
}

const BRAND: symbol = Symbol.for('provino.lazy.error')

/**
 * The error every lazy failure throws. `instanceof LazyError` holds across copies of this module
 * (the umbrella's and a test file's own), because it checks a `Symbol.for` brand.
 * @public
 */
export class LazyError extends Error {
  readonly code: LazyErrorCode
  readonly site: SourceLocation | undefined
  readonly sites: readonly SourceLocation[]

  constructor(code: LazyErrorCode, message: string, options: LazyErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LazyError'
    this.code = code
    this.site = options.site ?? options.sites?.[0]
    this.sites = options.sites ?? (options.site === undefined ? [] : [options.site])
    Object.defineProperty(this, BRAND, { value: true })
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && BRAND in value
  }
}
