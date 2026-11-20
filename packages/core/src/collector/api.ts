// The global API the dialects re-export (Track 5 §Module boundaries → `index.ts`): chainable
// `describe`/`test` with `only`/`skip`/`todo`/`concurrent`/`fails`/`failing`, `skipIf`/`runIf`,
// `.each`/`.for`, and the hooks. Neutral names only; Jest's `fit`/`xit` aliases are dialect code.
import type { EachRowArgs, FileTask, SuiteTask, TestContext } from '@provino/types'
import { currentStore } from '../current/current-test.ts'
import { builderEntry, DefinitionSet, type FixtureOptions } from '../definitions/table.ts'
import { CoreError } from '../errors.ts'
import { addCallback } from '../executor/context.ts'
import type { DeclaredHookKind, SuiteNode } from '../internal/model.ts'
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
export type TestFunction<C extends object = object> = (context: WithFixtures<C>) => unknown

/**
 * The test context with the fixtures `C` on it; the plain context when there are none.
 * @public
 */
export type WithFixtures<C extends object> = [keyof C] extends [never]
  ? TestContext
  : TestContext & C

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
export interface TestApi<C extends object = object> {
  (name: string | StackMarker, fn?: TestFunction<C>, timeoutMs?: number): void
  (name: string | StackMarker, options: TestOptions, fn?: TestFunction<C>): void
  readonly only: TestApi<C>
  readonly skip: TestApi<C>
  readonly todo: TestApi<C>
  readonly concurrent: TestApi<C>
  /** Passes when the body fails (Vitest's name). */
  readonly fails: TestApi<C>
  /** Passes when the body fails (Jest's name). */
  readonly failing: TestApi<C>
  skipIf(condition: unknown): TestApi<C>
  runIf(condition: unknown): TestApi<C>
  readonly each: EachFunction<'test'>
  readonly for: ForFunction<'test'>
}

/**
 * What a fixture passes its value to; the promise settles when the fixture's scope ends, and what
 * the fixture does after it is its cleanup.
 * @public
 */
export type FixtureUse<V> = (value: V) => Promise<void>

/**
 * A fixture function: it reads the keys it destructures from `context` and passes its value to
 * `use`.
 * @public
 */
export type FixtureFunction<V, C extends object> = (
  context: TestContext & C,
  use: FixtureUse<V>,
) => unknown

/**
 * One entry of `test.extend`'s object form: a value, a fixture function, or either with options.
 * @public
 */
export type FixtureEntry<V, C extends object> =
  | V
  | FixtureFunction<V, C>
  | readonly [V | FixtureFunction<V, C>, FixtureOptions]

/**
 * `test.extend`'s object form for the keys `T`, over the context `C` the test already has.
 * @public
 */
export type Fixtures<T extends object, C extends object = object> = {
  readonly [K in keyof T]: FixtureEntry<T[K], C & T>
}

/**
 * What a builder-form fixture gets beside the context.
 * @public
 */
export interface FixtureTools {
  /** Runs once the value's scope ends; call it at most once. */
  onCleanup(fn: () => unknown): void
}

/**
 * A builder-form fixture: it returns its value.
 * @public
 */
export type FixtureBuilder<V, C extends object> = (
  context: TestContext & C,
  tools: FixtureTools,
) => V

/**
 * `test` with fixtures (T5.9): `extend` returns a test whose tests and hooks read the keys it adds;
 * `override` replaces keys in the describe block it is called in. Present only where
 * `CorePolicy.definitions.extendApi` is `expose`.
 * @public
 */
export interface FixtureTestApi<C extends object = object> extends TestApi<C> {
  extend<T extends object>(fixtures: Fixtures<T, C>): FixtureTestApi<C & T>
  extend<K extends string, V>(
    key: K,
    build: FixtureBuilder<V, C>,
  ): FixtureTestApi<C & { readonly [P in K]: Awaited<V> }>
  extend<K extends string, V>(
    key: K,
    options: FixtureOptions,
    build: FixtureBuilder<V, C>,
  ): FixtureTestApi<C & { readonly [P in K]: Awaited<V> }>
  override(fixtures: { readonly [K in keyof C]?: FixtureEntry<C[K], C> }): void
  override<K extends keyof C & string>(key: K, build: FixtureBuilder<C[K] | Promise<C[K]>, C>): void
  /** A `beforeAll` that gets this test's file and worker fixtures first, the suite second. */
  beforeAll(fn: (context: C, suite: HookSuite) => unknown, timeoutMs?: number): void
  /** An `afterAll` that gets this test's file and worker fixtures first, the suite second. */
  afterAll(fn: (context: C, suite: HookSuite) => unknown, timeoutMs?: number): void
  beforeEach(fn: (context: TestContext & C, suite: HookSuite) => unknown, timeoutMs?: number): void
  afterEach(fn: (context: TestContext & C, suite: HookSuite) => unknown, timeoutMs?: number): void
  aroundEach(
    fn: (runTest: () => Promise<void>, context: TestContext & C, suite: HookSuite) => unknown,
    timeoutMs?: number,
  ): void
  aroundAll(
    fn: (runSuite: () => Promise<void>, suite: HookSuite) => unknown,
    timeoutMs?: number,
  ): void
  readonly describe: SuiteApi
  readonly suite: SuiteApi
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

/** A hook's registration function; a suite hook given `definitions` reads that test's fixtures. */
function hookOf(collector: Collector, kind: DeclaredHookKind, definitions?: DefinitionSet) {
  return function register(fn: unknown, timeoutMs?: number): void {
    collector.addHook(kind, fn, timeoutMs, register, definitions)
  }
}

/** What every test API shares with the global one: `describe` and the hooks that read no set. */
interface SharedParts {
  readonly describe: SuiteApi
  readonly suite: SuiteApi
  readonly beforeEach: (fn: unknown, timeoutMs?: number) => void
  readonly afterEach: (fn: unknown, timeoutMs?: number) => void
  readonly aroundEach: (fn: unknown, timeoutMs?: number) => void
  readonly aroundAll: (fn: unknown, timeoutMs?: number) => void
}

/** Builds the global API over a collector. */
export function createApi(collector: Collector): RuntimeApi {
  const expose = collector.policy.definitions.extendApi === 'expose'
  const describe = makeSuite(collector, {})
  const shared: SharedParts = {
    describe,
    suite: describe,
    beforeEach: hookOf(collector, 'beforeEach'),
    afterEach: hookOf(collector, 'afterEach'),
    aroundEach: hookOf(collector, 'aroundEach'),
    aroundAll: hookOf(collector, 'aroundAll'),
  }
  const test = makeTest(
    collector,
    {},
    expose ? new DefinitionSet(collector.definitions) : undefined,
    shared,
  )
  return {
    ...shared,
    test,
    it: test,
    beforeAll: hookOf(collector, 'beforeAll'),
    afterAll: hookOf(collector, 'afterAll'),
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

function makeTest(
  collector: Collector,
  flags: Flags,
  definitions: DefinitionSet | undefined,
  shared: SharedParts,
): TestApi {
  const spec = (name: unknown, second: unknown, third: unknown, entry: StackMarker) => {
    const { options, fn, timeout } = parseArguments(second, third)
    return {
      name: formatName(name),
      fn,
      options: options as TestOptions,
      flags,
      timeout,
      entry,
      definitions,
    }
  }
  const register = function test(name: unknown, second?: unknown, third?: unknown): void {
    collector.addTest(spec(name, second, third, register))
  }
  const api = chainable<TestApi>(
    register,
    TEST_MODIFIERS,
    flags,
    (next) => makeTest(collector, next, definitions, shared),
    (table, name, second, third, entry) =>
      collector.addTestTable(spec(name, second, third, entry), table),
  )
  if (definitions === undefined) return api
  // `extend` keeps this node's modifiers; the rest is the set's, built once (`fixtureParts`).
  return Object.assign(api, fixtureParts(collector, definitions, shared), {
    extend(fixtures: unknown, optionsOrValue?: unknown, maybeValue?: unknown): TestApi {
      const entries = builderEntry(definitions.env, fixtures, optionsOrValue, maybeValue)
      return makeTest(
        collector,
        flags,
        definitions.extend(entries, collecting(collector, 'extend')),
        shared,
      )
    },
  })
}

/** The fixture API of each set: `override` and the suite hooks that read its fixtures. */
const partsOfSet = new WeakMap<DefinitionSet, object>()

/**
 * `override`, the hooks and `describe` on a test API, as Vitest 5.0.5's `createTaskCollector`
 * puts them (`runner/suite.ts`): `override` changes the set for the block being collected, and
 * `beforeAll`/`afterAll` read its file fixtures; the rest are the global API's own.
 */
function fixtureParts(
  collector: Collector,
  definitions: DefinitionSet,
  shared: SharedParts,
): object {
  let parts = partsOfSet.get(definitions)
  if (parts === undefined) {
    parts = {
      ...shared,
      override(fixtures: unknown, optionsOrValue?: unknown, maybeValue?: unknown): void {
        const entries = builderEntry(definitions.env, fixtures, optionsOrValue, maybeValue)
        definitions.override(entries, collecting(collector, 'override'))
      },
      beforeAll: hookOf(collector, 'beforeAll', definitions),
      afterAll: hookOf(collector, 'afterAll', definitions),
    }
    partsOfSet.set(definitions, parts)
  }
  return parts
}

/** The suite `test.extend` or `test.override` registers for: only while a file collects. */
function collecting(collector: Collector, what: string): SuiteNode {
  const suite = collector.collecting()
  if (suite === undefined) {
    throw new CoreError(
      'CORE_INVALID_ARGUMENT',
      `test.${what} can only be called while a file or a describe body is being collected`,
    )
  }
  return suite
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
  // A condition that doesn't skip is this API itself; the skipping one is built once.
  let skipped: Api | undefined
  const skipIf = (condition: unknown): Api => {
    if (!condition) return api
    skipped ??= make({ ...flags, conditionSkip: true })
    return skipped
  }
  const rows = (mode: 'each' | 'for') =>
    function rows(cases: unknown, ...values: readonly unknown[]) {
      const perRow = function each(name: unknown, second?: unknown, third?: unknown): void {
        addTable({ cases, values, mode }, name, second, third, perRow)
      }
      return perRow
    }
  const api = Object.assign(register, {
    skipIf,
    runIf: (condition: unknown): Api => skipIf(!condition),
    each: rows('each'),
    for: rows('for'),
  }) as Api
  return api
}
