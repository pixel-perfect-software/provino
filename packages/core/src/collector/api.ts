// The global API the dialects re-export (Track 5 §Module boundaries → `index.ts`): chainable
// `describe`/`test` with `only`/`skip`/`todo`/`concurrent`/`fails`/`failing`, `skipIf`/`runIf`,
// `.each`/`.for`, and the hooks. Neutral names only; Jest's `fit`/`xit` aliases are dialect code.
import type { EachRowArgs, FileTask, FormatEachTitle, SuiteTask, TestContext } from '@provino/types'
import { currentStore } from '../current/current-test.ts'
import { CoreError } from '../errors.ts'
import { addCallback } from '../executor/context.ts'
import {
  type AnyFunction,
  type Collector,
  expandRows,
  type Flags,
  formatName,
  type SuiteOptions,
  type TestOptions,
} from './collector.ts'

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
    : (name: string, body: (row: Readonly<Record<string, unknown>>) => unknown) => void
  <const Row>(
    rows: readonly Row[],
  ): Register extends 'test'
    ? (name: string, fn: (...args: EachRowArgs<Row>) => unknown, timeoutMs?: number) => void
    : (name: string, body: (...args: EachRowArgs<Row>) => unknown) => void
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
  (name: string | AnyFunction, fn?: TestFunction, timeoutMs?: number): void
  (name: string | AnyFunction, options: TestOptions, fn?: TestFunction): void
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
 * `describe`/`suite`: declares a block. Chain modifiers, or pass options second.
 * @public
 */
export interface SuiteApi {
  (name: string | AnyFunction, body?: SuiteBody): void
  (name: string | AnyFunction, options: SuiteOptions, body?: SuiteBody): void
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
  /** Wraps each test's hooks and body; call `runTest` exactly once. */
  aroundEach(
    fn: (runTest: () => Promise<void>, context: TestContext) => unknown,
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

/** Builds the global API over a collector. */
export function createApi(collector: Collector, formatEachTitle: FormatEachTitle): RuntimeApi {
  const test = makeTest(collector, formatEachTitle, {})
  const describe = makeSuite(collector, formatEachTitle, {})
  const hook = (
    kind: 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach' | 'aroundEach' | 'aroundAll',
  ) =>
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

function flagFor(modifier: (typeof TEST_MODIFIERS)[number]): Flags {
  return modifier === 'failing' ? { fails: true } : { [modifier]: true }
}

function makeTest(collector: Collector, format: FormatEachTitle, flags: Flags): TestApi {
  const register = function test(name: unknown, second?: unknown, third?: unknown): void {
    const { options, fn, timeout } = parseArguments(second, third)
    collector.addTest({
      name: formatName(name),
      fn,
      options: options as TestOptions,
      flags,
      timeout,
      entry: register,
    })
  }
  const each = (mode: 'each' | 'for') =>
    function rows(cases: unknown, ...values: readonly unknown[]) {
      const perRow = function each(name: unknown, second?: unknown, third?: unknown): void {
        const { options, fn, timeout } = parseArguments(second, third)
        for (const row of expandRows(format, cases, values, formatName(name), mode)) {
          collector.addTest({
            name: row.title,
            fn,
            options: options as TestOptions,
            flags,
            timeout,
            entry: perRow,
            each: { args: row.args, passContext: mode === 'for' },
          })
        }
      }
      return perRow
    }
  return chainable(register, TEST_MODIFIERS, (modifier) =>
    makeTest(collector, format, { ...flags, ...flagFor(modifier) }),
  )({
    skipIf: (condition: unknown) =>
      condition
        ? makeTest(collector, format, { ...flags, conditionSkip: true })
        : makeTest(collector, format, flags),
    runIf: (condition: unknown) =>
      condition
        ? makeTest(collector, format, flags)
        : makeTest(collector, format, { ...flags, conditionSkip: true }),
    each: each('each'),
    for: each('for'),
  }) as TestApi
}

function makeSuite(collector: Collector, format: FormatEachTitle, flags: Flags): SuiteApi {
  const register = function describe(name: unknown, second?: unknown, third?: unknown): void {
    const { options, fn } = parseArguments(second, third)
    collector.addSuite({
      name: formatName(name),
      body: fn,
      options: options as SuiteOptions,
      flags,
      entry: register,
    })
  }
  const each = (mode: 'each' | 'for') =>
    function rows(cases: unknown, ...values: readonly unknown[]) {
      const perRow = function each(name: unknown, second?: unknown, third?: unknown): void {
        const { options, fn } = parseArguments(second, third)
        for (const row of expandRows(format, cases, values, formatName(name), mode)) {
          collector.addSuite({
            name: row.title,
            body: fn,
            options: options as SuiteOptions,
            flags,
            entry: perRow,
            each: { args: row.args },
          })
        }
      }
      return perRow
    }
  return chainable(register, SUITE_MODIFIERS, (modifier) =>
    makeSuite(collector, format, { ...flags, [modifier]: true }),
  )({
    skipIf: (condition: unknown) =>
      condition
        ? makeSuite(collector, format, { ...flags, conditionSkip: true })
        : makeSuite(collector, format, flags),
    runIf: (condition: unknown) =>
      condition
        ? makeSuite(collector, format, flags)
        : makeSuite(collector, format, { ...flags, conditionSkip: true }),
    each: each('each'),
    for: each('for'),
  }) as SuiteApi
}

/**
 * Makes `register` chainable: each modifier is a lazy getter returning the API with that flag
 * set (built on first use, then cached), and `methods` are attached as they are.
 */
function chainable<Modifier extends string, Api>(
  register: AnyFunction,
  modifiers: readonly Modifier[],
  next: (modifier: Modifier) => Api,
): (methods: Record<string, unknown>) => AnyFunction {
  return (methods) => {
    for (const modifier of modifiers) {
      let cached: Api | undefined
      Object.defineProperty(register, modifier, {
        enumerable: true,
        get(): Api {
          cached ??= next(modifier)
          return cached
        },
      })
    }
    return Object.assign(register, methods)
  }
}
