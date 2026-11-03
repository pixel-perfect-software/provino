// The global API the dialects re-export (Track 5 §Module boundaries → `index.ts`): chainable
// `describe`/`test` with `only`/`skip`/`todo`/`concurrent`/`fails`/`failing`, `skipIf`/`runIf`,
// `.each`/`.for`, and the hooks. Neutral names only; Jest's `fit`/`xit` aliases are dialect code.
import type { EachRowArgs, FileTask, SuiteTask, TestContext } from '@provino/types'
import { currentStore } from '../current/current-test.ts'
import { CoreError } from '../errors.ts'
import { addCallback } from '../executor/context.ts'
import type { DeclaredHookKind } from '../internal/model.ts'
import {
  type Collector,
  type EachTable,
  type Flags,
  formatName,
  type SuiteOptions,
  type TestOptions,
} from './collector.ts'
import type { StackMarker } from './location.ts'

/**
 * A test body. Under `firstArg: 'context'` it receives the test context; the Jest dialect types
 * its own `done` form.
 * @public
 */
export type TestFunction = (context: TestContext) => unknown

/**
 * `.each` over rows (array rows spread into arguments) or a tagged-template table.
 * @public
 */
export interface EachFunction<Register> {
  (
    table: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Register extends 'test'
    ? (
        name: string,
        fn: (row: Readonly<Record<string, unknown>>) => unknown,
        timeoutMs?: number,
      ) => void
    : (
        name: string,
        body: (row: Readonly<Record<string, unknown>>) => unknown,
        timeoutMs?: number,
      ) => void
  <const Row>(
    rows: readonly Row[],
  ): Register extends 'test'
    ? (name: string, fn: (...args: EachRowArgs<Row>) => unknown, timeoutMs?: number) => void
    : (name: string, body: (...args: EachRowArgs<Row>) => unknown, timeoutMs?: number) => void
}

/**
 * `.for` over rows: the row is passed unspread (and, for tests, the context second).
 * @public
 */
export type ForFunction<Register> = <const Row>(
  rows: readonly Row[],
) => Register extends 'test'
  ? (name: string, fn: (row: Row, context: TestContext) => unknown) => void
  : (name: string, body: (row: Row) => unknown) => void

/**
 * `test`/`it`: declares a test. Chain modifiers (`test.only.concurrent`), or pass options second.
 * @public
 */
export interface TestApi {
  (name: string | StackMarker, fn?: TestFunction, timeoutMs?: number): void
  (name: string | StackMarker, options: TestOptions, fn?: TestFunction): void
  readonly only: TestApi
  readonly skip: TestApi
  readonly todo: TestApi
  readonly concurrent: TestApi
  /** Passes when the body fails (Vitest's name). */
  readonly fails: TestApi
  /** Passes when the body fails (Jest's name). */
  readonly failing: TestApi
  skipIf(condition: unknown): TestApi
  runIf(condition: unknown): TestApi
  readonly each: EachFunction<'test'>
  readonly for: ForFunction<'test'>
}

/**
 * A describe body. It may be async only where the policy awaits it (`asyncDescribe: 'await'`).
 * @public
 */
export type SuiteBody = () => unknown

/**
 * `describe`/`suite`: declares a block. Chain modifiers, or pass options second. A timeout third
 * is `{ timeout }`: the block's tests inherit it.
 * @public
 */
export interface SuiteApi {
  (name: string | StackMarker, body?: SuiteBody, timeoutMs?: number): void
  (name: string | StackMarker, options: SuiteOptions, body?: SuiteBody): void
  readonly only: SuiteApi
  readonly skip: SuiteApi
  readonly todo: SuiteApi
  readonly concurrent: SuiteApi
  skipIf(condition: unknown): SuiteApi
  runIf(condition: unknown): SuiteApi
  readonly each: EachFunction<'suite'>
  readonly for: ForFunction<'suite'>
}

/**
 * The task a suite hook receives: the suite (or file) it's declared on, or the test's innermost
 * suite for each-hooks.
 * @public
 */
export type HookSuite = SuiteTask | FileTask

/**
 * The global functions a runtime provides. Dialects re-export them under their names.
 * @public
 */
export interface RuntimeApi {
  readonly describe: SuiteApi
  readonly suite: SuiteApi
  readonly test: TestApi
  readonly it: TestApi
  beforeAll(fn: (suite: HookSuite) => unknown, timeoutMs?: number): void
  afterAll(fn: (suite: HookSuite) => unknown, timeoutMs?: number): void
  beforeEach(fn: (context: TestContext, suite: HookSuite) => unknown, timeoutMs?: number): void
  afterEach(fn: (context: TestContext, suite: HookSuite) => unknown, timeoutMs?: number): void
  /** Wraps each test's hooks and body; call `runTest` exactly once. `suite` is the test's innermost. */
  aroundEach(
    fn: (runTest: () => Promise<void>, context: TestContext, suite: HookSuite) => unknown,
    timeoutMs?: number,
  ): void
  /** Wraps a suite's hooks and tests; call `runSuite` exactly once. */
  aroundAll(
    fn: (runSuite: () => Promise<void>, suite: HookSuite) => unknown,
    timeoutMs?: number,
  ): void
  /** Runs after the current test (and its teardowns), last registered first. */
  onTestFinished(fn: (context: TestContext) => unknown, timeoutMs?: number): void
  /** Runs after the current test when it failed. */
  onTestFailed(fn: (context: TestContext) => unknown, timeoutMs?: number): void
}

type Args = { readonly options: object; readonly fn: unknown; readonly timeout: number | undefined }

/** `(name, fn, timeout)` or `(name, options, fn)`, as Vitest's `parseArguments`. */
function parseArguments(second: unknown, third: unknown): Args {
  if (typeof second === 'object' && second !== null) {
    if (typeof third === 'object' && third !== null) {
      throw new CoreError('CORE_INVALID_ARGUMENT', 'Pass options as the second argument only')
    }
    return { options: second, fn: third, timeout: undefined }
  }
  if (typeof third === 'object' && third !== null) {
    throw new CoreError(
      'CORE_INVALID_ARGUMENT',
      'Options go in the second argument: `test(name, options, fn)`',
    )
  }
  return { options: {}, fn: second, timeout: typeof third === 'number' ? third : undefined }
}

/** A describe's arguments: a number in the third position is `{ timeout }`, which its tests inherit (Vitest). */
function suiteArguments(second: unknown, third: unknown): { options: SuiteOptions; body: unknown } {
  const { options, fn, timeout } = parseArguments(second, third)
  const suiteOptions = options as SuiteOptions
  return { options: timeout === undefined ? suiteOptions : { ...suiteOptions, timeout }, body: fn }
}

/** Builds the global API over a collector. */
export function createApi(collector: Collector): RuntimeApi {
  const test = makeTest(collector, {})
  const describe = makeSuite(collector, {})
  const hook = (kind: DeclaredHookKind) =>
    function register(fn: unknown, timeoutMs?: number): void {
      collector.addHook(kind, fn, timeoutMs, register)
    }
  return {
    describe,
    suite: describe,
    test,
    it: test,
    beforeAll: hook('beforeAll'),
    afterAll: hook('afterAll'),
    beforeEach: hook('beforeEach'),
    afterEach: hook('afterEach'),
    aroundEach: hook('aroundEach'),
    aroundAll: hook('aroundAll'),
    onTestFinished(fn: unknown, timeoutMs?: number): void {
      addCallback(currentStore()?.attempt, 'onTestFinished', fn, timeoutMs)
    },
    onTestFailed(fn: unknown, timeoutMs?: number): void {
      addCallback(currentStore()?.attempt, 'onTestFailed', fn, timeoutMs)
    },
  }
}

const TEST_MODIFIERS = ['only', 'skip', 'todo', 'concurrent', 'fails', 'failing'] as const
const SUITE_MODIFIERS = ['only', 'skip', 'todo', 'concurrent'] as const

type Modifier = (typeof TEST_MODIFIERS)[number]

function flagFor(modifier: Modifier): Flags {
  return modifier === 'failing' ? { fails: true } : { [modifier]: true }
}

function makeTest(collector: Collector, flags: Flags): TestApi {
  const spec = (name: unknown, second: unknown, third: unknown, entry: StackMarker) => {
    const { options, fn, timeout } = parseArguments(second, third)
    return { name: formatName(name), fn, options: options as TestOptions, flags, timeout, entry }
  }
  const register = function test(name: unknown, second?: unknown, third?: unknown): void {
    collector.addTest(spec(name, second, third, register))
  }
  return chainable<TestApi>(
    register,
    TEST_MODIFIERS,
    flags,
    (next) => makeTest(collector, next),
    (table, name, second, third, entry) =>
      collector.addTestTable(spec(name, second, third, entry), table),
  )
}

function makeSuite(collector: Collector, flags: Flags): SuiteApi {
  const spec = (name: unknown, second: unknown, third: unknown, entry: StackMarker) => {
    const { options, body } = suiteArguments(second, third)
    return { name: formatName(name), body, options, flags, entry }
  }
  const register = function describe(name: unknown, second?: unknown, third?: unknown): void {
    collector.addSuite(spec(name, second, third, register))
  }
  return chainable<SuiteApi>(
    register,
    SUITE_MODIFIERS,
    flags,
    (next) => makeSuite(collector, next),
    (table, name, second, third, entry) =>
      collector.addSuiteTable(spec(name, second, third, entry), table),
  )
}

/**
 * Makes `register` the chainable API: each modifier is a lazy getter returning the API with that
 * flag added (built on first use, then cached); `skipIf`/`runIf` add `conditionSkip` when the
 * condition says so; `each`/`for` return a function that registers one table (`addTable`).
 */
function chainable<Api>(
  register: StackMarker,
  modifiers: readonly Modifier[],
  flags: Flags,
  make: (flags: Flags) => Api,
  addTable: (
    table: EachTable,
    name: unknown,
    second: unknown,
    third: unknown,
    entry: StackMarker,
  ) => void,
): Api {
  for (const modifier of modifiers) {
    let cached: Api | undefined
    Object.defineProperty(register, modifier, {
      enumerable: true,
      get(): Api {
        cached ??= make({ ...flags, ...flagFor(modifier) })
        return cached
      },
    })
  }
  const skipIf = (condition: unknown): Api =>
    make(condition ? { ...flags, conditionSkip: true } : flags)
  const rows = (mode: 'each' | 'for') =>
    function rows(cases: unknown, ...values: readonly unknown[]) {
      const perRow = function each(name: unknown, second?: unknown, third?: unknown): void {
        addTable({ cases, values, mode }, name, second, third, perRow)
      }
      return perRow
    }
  return Object.assign(register, {
    skipIf,
    runIf: (condition: unknown): Api => skipIf(!condition),
    each: rows('each'),
    for: rows('for'),
  }) as Api
}
