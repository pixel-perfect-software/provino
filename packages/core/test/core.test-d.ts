// The public API of @provino/core, and B07's check for T6.1 (build-plan §4 D.23): the runtime's
// host satisfies Track 6's `LazyHost`, which replaces the "Track 5 acknowledges" sign-off.
import {
  type CoreError,
  type CoreErrorCode,
  type CurrentTestService,
  createRuntime,
  currentTest,
  type HookSuite,
  type RunFileOptions,
  type Runtime,
  type RuntimeApi,
  type RuntimeOptions,
  serializeError,
  type TestApi,
} from '@provino/core'
import type {
  CurrentTest,
  ImportFile,
  LazyHost,
  SerializedError,
  TaskResult,
  TestContext,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// T6.1 / §4 D.23: the executor's host is a `LazyHost`, and the lookup is a `CurrentTest`.
expectTypeOf<Runtime['lazyHost']>().toExtend<LazyHost>()
expectTypeOf(currentTest).toExtend<CurrentTest>()
expectTypeOf<CurrentTestService['running']>().returns.toEqualTypeOf<
  ReturnType<CurrentTest['get']>
>()

// Building a runtime and running a file.
declare const options: RuntimeOptions
expectTypeOf(createRuntime(options)).toEqualTypeOf<Promise<Runtime>>()
expectTypeOf<Runtime['runFile']>().returns.toEqualTypeOf<Promise<TaskResult>>()
expectTypeOf<RuntimeOptions['importFile']>().toEqualTypeOf<ImportFile>()
// @ts-expect-error the worker must pass the loader's import: core never imports the loader
createRuntime({ ...options, importFile: undefined })
// @ts-expect-error exactOptionalPropertyTypes: `ci` is omitted, not undefined
createRuntime({ ...options, ci: undefined })

// A line filter belongs to one file, so it's a `runFile` option, not a runtime one.
declare const runtime: Runtime
expectTypeOf<Parameters<Runtime['runFile']>[1]>().toEqualTypeOf<RunFileOptions | undefined>()
expectTypeOf<RunFileOptions['lines']>().toEqualTypeOf<readonly number[] | undefined>()
void runtime.runFile('/a.test.ts', { lines: [3, 7] })
void runtime.runFile('/a.test.ts')
// @ts-expect-error `lines` moved to `runFile`: each file has its own
createRuntime({ ...options, lines: [3] })
// @ts-expect-error a line is a number
void runtime.runFile('/a.test.ts', { lines: ['3'] })

// Errors carry a stable code.
expectTypeOf<CoreError['code']>().toEqualTypeOf<CoreErrorCode>()
expectTypeOf<'CORE_LATE_REGISTRATION'>().toExtend<CoreErrorCode>()
// @ts-expect-error not a core error code
expectTypeOf<'CORE_NOPE'>().toExtend<CoreErrorCode>()
expectTypeOf(serializeError(new Error('x'))).toEqualTypeOf<SerializedError>()

declare const api: RuntimeApi
const { test, describe, beforeEach, beforeAll, aroundEach, onTestFinished } = api

// Tests: a context-first body, a timeout third, or options second.
test('ctx', (ctx) => {
  expectTypeOf(ctx).toEqualTypeOf<TestContext>()
  expectTypeOf(ctx.skip('note')).toBeNever()
})
test('timeout', () => undefined, 100)
test('options', { timeout: 100, retry: 2, concurrent: true, tags: ['slow'] }, () => undefined)
test('todo without a body')
// @ts-expect-error options go second, never third
test('options third', () => undefined, { timeout: 100 })
// @ts-expect-error the timeout is a number of ms
test('bad timeout', () => undefined, '100')
// @ts-expect-error an unknown option
test('bad option', { timeot: 100 }, () => undefined)

// Modifiers chain, and every chain is a TestApi.
expectTypeOf(test.only.concurrent.skip).toEqualTypeOf<TestApi>()
expectTypeOf(test.skipIf(true)).toEqualTypeOf<TestApi>()
expectTypeOf(test.failing).toEqualTypeOf<TestApi>()
// @ts-expect-error `sequential` was removed in Vitest 5.0 and never existed in the neutral API
void test.sequential

// `.each` spreads tuple rows with literal types; object rows are one argument.
test.each([
  [1, 'a'],
  [2, 'b'],
] as const)('row %s', (n, s) => {
  expectTypeOf(n).toEqualTypeOf<1 | 2>()
  expectTypeOf(s).toEqualTypeOf<'a' | 'b'>()
})
test.each([{ user: 'ann' }])('$user', (row) => {
  expectTypeOf(row).toEqualTypeOf<{ readonly user: 'ann' }>()
})
// `.for` passes the row unspread and the context second.
test.for([[1, 2]] as const)('sum', (row, ctx) => {
  expectTypeOf(row).toEqualTypeOf<readonly [1, 2]>()
  expectTypeOf(ctx).toEqualTypeOf<TestContext>()
})
// A tagged-template table gives object rows.
test.each`
  a    | b
  ${1} | ${2}
`('table', (row) => {
  expectTypeOf(row).toEqualTypeOf<Readonly<Record<string, unknown>>>()
})

// Describes: a body, options second, the same modifiers.
describe('block', () => undefined)
describe('options', { timeout: 100, concurrent: true }, () => undefined)
// A number third is the timeout the describe's tests inherit (Vitest).
describe('timeout', () => undefined, 100)
// @ts-expect-error the timeout is a number of ms
describe('bad timeout', () => undefined, '100')
describe.each([['x']] as const)('each %s', (x) => {
  expectTypeOf(x).toEqualTypeOf<'x'>()
})
// @ts-expect-error `fails` is a test modifier, not a describe one
void describe.fails

// Hooks: suite hooks get the suite task, each-hooks the context and the test's suite.
beforeAll((suite) => {
  expectTypeOf(suite).toEqualTypeOf<HookSuite>()
})
beforeEach((ctx, suite) => {
  expectTypeOf(ctx).toEqualTypeOf<TestContext>()
  expectTypeOf(suite).toEqualTypeOf<HookSuite>()
})
aroundEach(async (runTest, ctx, suite) => {
  expectTypeOf(runTest).toEqualTypeOf<() => Promise<void>>()
  expectTypeOf(ctx).toEqualTypeOf<TestContext>()
  expectTypeOf(suite).toEqualTypeOf<HookSuite>()
  await runTest()
})
onTestFinished((ctx) => {
  expectTypeOf(ctx).toEqualTypeOf<TestContext>()
})
// @ts-expect-error a hook takes a function
beforeEach('not a function')
// @ts-expect-error the hook timeout is a number of ms
beforeAll(() => undefined, '5s')
