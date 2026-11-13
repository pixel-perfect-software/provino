// Jest's `jest-matcher-utils`, `jest-message-util` and `jest-util`, loaded on first use (T7.12).
//
// The vendored matchers print their messages with these packages, but a passing assertion prints
// nothing. Loaded at import, `jest-message-util` costs about 21 ms of a cold start and
// `jest-matcher-utils` about 14 (they pull Chalk, `jest-diff`, Babel's code frame and
// `graceful-fs`), which is most of what separates the worker-side `expect` from T7.12's 40 ms. So
// each name here is a stand-in that calls the real function on the first call, through a
// synchronous `require` of the same package at the same pinned version (DECISIONS D18): every
// message stays byte-identical, and nothing is forked or re-vendored.
//
// A function stands in as a function, and Chalk's colour functions (`RECEIVED_COLOR` and the
// rest, which also carry `.bold`) as a function whose other properties read through.
import { createRequire } from 'node:module'
import type * as MatcherUtils from 'jest-matcher-utils'
import type * as MessageUtil from 'jest-message-util'
import type * as JestUtil from 'jest-util'

const require = createRequire(import.meta.url)

// What these packages do when they first load stays at load time, as when they were imported:
// the first assertion to fail in a test must not be where it happens. Chalk (through
// `supports-color`) fixes its colour level from FORCE_COLOR, NO_COLOR and the terminal, and
// `picocolors`, which Babel's code frame uses, reads the same; `graceful-fs` patches the real
// `fs.close`, `fs.closeSync`, `process.cwd` and `process.chdir`. A test that sets FORCE_COLOR or
// spies on `fs` would otherwise change what the first failure prints, or have its spy wrapped.
// Each is loaded from the package that depends on it, so it is the one instance that package
// later uses. Only these few leaf modules: the heavy parts (`jest-diff`, the code frame itself,
// `micromatch`, `jest-util`) stay deferred.
function loadFromDependent(dependent: string, ...path: readonly string[]): void {
  let from = require.resolve(dependent)
  for (const dependency of path.slice(0, -1)) from = createRequire(from).resolve(dependency)
  const last = path.at(-1)
  if (last !== undefined) createRequire(from)(last)
}
loadFromDependent('jest-matcher-utils', 'chalk')
loadFromDependent('jest-message-util', 'chalk')
loadFromDependent('jest-message-util', 'graceful-fs')
loadFromDependent('jest-message-util', '@babel/code-frame', 'picocolors')

/** A loader that runs once, on the first call. */
function once<T>(load: () => T): () => T {
  let value: T | undefined
  return () => {
    value ??= load()
    return value
  }
}

/**
 * The real `jest-matcher-utils`.
 * @internal
 */
export const matcherUtils: () => typeof MatcherUtils = once(() => require('jest-matcher-utils'))

/**
 * The real `jest-message-util`.
 * @internal
 */
export const messageUtil: () => typeof MessageUtil = once(() => require('jest-message-util'))

/**
 * The real `jest-util`.
 * @internal
 */
export const jestUtil: () => typeof JestUtil = once(() => require('jest-util'))

type AnyFunction = (...args: never[]) => unknown

/** The functions of `M`, by name. */
type FunctionKeys<M> = {
  [K in keyof M]: M[K] extends AnyFunction ? K : never
}[keyof M]

/** A stand-in for `real()[key]`: calling it calls the real function with the same arguments. */
function lazyFunction<M, K extends FunctionKeys<M>>(real: () => M, key: K): M[K] {
  const stand = (...args: unknown[]): unknown =>
    (real()[key] as (...a: unknown[]) => unknown)(...args)
  return stand as M[K]
}

/** As `lazyFunction`, and the real function's own properties (`.bold`) read through. */
function lazyChalk<K extends FunctionKeys<typeof MatcherUtils>>(key: K): (typeof MatcherUtils)[K] {
  const stand = (...args: unknown[]): unknown =>
    (matcherUtils()[key] as (...a: unknown[]) => unknown)(...args)
  return new Proxy(stand, {
    get: (target, property, receiver) =>
      property in target
        ? Reflect.get(target, property, receiver)
        : Reflect.get(matcherUtils()[key], property),
    has: (target, property) => property in target || property in matcherUtils()[key],
  }) as (typeof MatcherUtils)[K]
}

const matcher = <K extends FunctionKeys<typeof MatcherUtils>>(key: K): (typeof MatcherUtils)[K] =>
  lazyFunction(matcherUtils, key)

/** @internal */
export const BOLD_WEIGHT: typeof MatcherUtils.BOLD_WEIGHT = lazyChalk('BOLD_WEIGHT')
/** @internal */
export const DIM_COLOR: typeof MatcherUtils.DIM_COLOR = lazyChalk('DIM_COLOR')
/** @internal */
export const EXPECTED_COLOR: typeof MatcherUtils.EXPECTED_COLOR = lazyChalk('EXPECTED_COLOR')
/** @internal */
export const INVERTED_COLOR: typeof MatcherUtils.INVERTED_COLOR = lazyChalk('INVERTED_COLOR')
/** @internal */
export const RECEIVED_COLOR: typeof MatcherUtils.RECEIVED_COLOR = lazyChalk('RECEIVED_COLOR')
/** @internal */
export const diff: typeof MatcherUtils.diff = matcher('diff')
/** @internal */
export const ensureExpectedIsNonNegativeInteger: typeof MatcherUtils.ensureExpectedIsNonNegativeInteger =
  matcher('ensureExpectedIsNonNegativeInteger')
/** @internal */
export const ensureNoExpected: typeof MatcherUtils.ensureNoExpected = matcher('ensureNoExpected')
/** @internal */
export const ensureNumbers: typeof MatcherUtils.ensureNumbers = matcher('ensureNumbers')
/** @internal */
export const getLabelPrinter: typeof MatcherUtils.getLabelPrinter = matcher('getLabelPrinter')
/** @internal */
export const matcherErrorMessage: typeof MatcherUtils.matcherErrorMessage =
  matcher('matcherErrorMessage')
/** @internal */
export const matcherHint: typeof MatcherUtils.matcherHint = matcher('matcherHint')
/** @internal */
export const printDiffOrStringify: typeof MatcherUtils.printDiffOrStringify =
  matcher('printDiffOrStringify')
/** @internal */
export const printExpected: typeof MatcherUtils.printExpected = matcher('printExpected')
/** @internal */
export const printReceived: typeof MatcherUtils.printReceived = matcher('printReceived')
/** @internal */
export const printWithType: typeof MatcherUtils.printWithType = matcher('printWithType')
/** @internal */
export const stringify: typeof MatcherUtils.stringify = matcher('stringify')

/**
 * `jest-matcher-utils`' text for a failed `toContain` that wanted `toContainEqual`. A string,
 * so it can only be read, not called: read it where it is used, not at import.
 * @internal
 */
export function suggestToContainEqual(): string {
  return matcherUtils().SUGGEST_TO_CONTAIN_EQUAL
}

/** @internal */
export const formatExecError: typeof MessageUtil.formatExecError = lazyFunction(
  messageUtil,
  'formatExecError',
)
/** @internal */
export const formatStackTrace: typeof MessageUtil.formatStackTrace = lazyFunction(
  messageUtil,
  'formatStackTrace',
)
/** @internal */
export const separateMessageFromStack: typeof MessageUtil.separateMessageFromStack = lazyFunction(
  messageUtil,
  'separateMessageFromStack',
)

/** @internal */
export const pluralize: typeof JestUtil.pluralize = lazyFunction(jestUtil, 'pluralize')

/**
 * An object that reads through to `real()`, which runs on the first operation of any kind: its
 * keys, values and descriptors are the real object's, so a spread or `Object.keys` of it is the
 * real one's too. The target is an empty extensible object, so the proxy may report any keys.
 */
function readThrough<T extends object>(real: () => T): T {
  return new Proxy(Object.create(null) as T, {
    get: (_target, property) => Reflect.get(real(), property),
    set: (_target, property, value) => Reflect.set(real(), property, value),
    has: (_target, property) => Reflect.has(real(), property),
    deleteProperty: (_target, property) => Reflect.deleteProperty(real(), property),
    defineProperty: (_target, property, descriptor) =>
      Reflect.defineProperty(real(), property, descriptor),
    ownKeys: () => Reflect.ownKeys(real()),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(real(), property)
      // The target is extensible, so a property it lacks may only be reported as configurable.
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(real()),
  })
}

/**
 * `import * as matcherUtils from 'jest-matcher-utils'`, for code that reads it by property
 * (`matcherUtils.matcherHint(…)`): the real package loads at the first read.
 * @internal
 */
export const matcherUtilsNamespace: typeof MatcherUtils = readThrough(matcherUtils)

/**
 * What `makeThrowingMatcher` gives matchers as `this.utils`: every export of
 * `jest-matcher-utils`, then `extra`, frozen when `freeze` is set. It reads through to that
 * object, so `jest-matcher-utils` loads when something first looks at it.
 * @internal
 */
export function lazyUtils<T extends object>(
  extra: T,
  freeze: boolean,
): Readonly<typeof MatcherUtils & T> {
  return readThrough(
    once(() => {
      // An ES module namespace lists its names in code-unit order, which `import * as` gave this object.
      const sorted = Object.entries(matcherUtils()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      const all = { ...Object.fromEntries(sorted), ...extra }
      return freeze ? Object.freeze(all) : all
    }),
  ) as Readonly<typeof MatcherUtils & T>
}
