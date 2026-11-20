// The public API of `provino`'s entry points beside /node (T1.10): the worker API, the ambient
// globals, the dialect, the environments and the reporters.
import type { Dialect, Environment, Reporter } from '@provino/types'
import { expectTypeOf } from 'expect-type'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  lazy,
  type ProvinoApi,
  type ProvinoWorkerApiError,
  test,
  type WorkerApi,
} from 'provino'
import type { ConfigError, ProjectConfig, ProvinoConfigInput } from 'provino/config'
import {
  defineEnvironment,
  jsdomEnvironment,
  nodeEnvironment,
  type Pragmas,
} from 'provino/environment'
import 'provino/globals'
import { jestDialect } from 'provino/jest'
import { defaultReporter, defineReporter } from 'provino/reporters'
import { vitestDialect } from 'provino/vitest'

// The entry is the native API (B27b) and the lazy variables, and no more.
expectTypeOf<keyof typeof import('provino')>().toEqualTypeOf<
  | 'afterAll'
  | 'afterEach'
  | 'aroundAll'
  | 'aroundEach'
  | 'beforeAll'
  | 'beforeEach'
  | 'describe'
  | 'evaluatedLazies'
  | 'expect'
  | 'fn'
  | 'isMockFunction'
  | 'mocks'
  | 'onTestFailed'
  | 'onTestFinished'
  | 'replaceProperty'
  | 'spyOn'
  | 'suite'
  | 'timers'
  | 'includeContext'
  | 'includeExamples'
  | 'it'
  | 'itBehavesLike'
  | 'lazy'
  | 'LazyError'
  | 'sharedContext'
  | 'sharedExamples'
  | 'test'
  | 'ProvinoWorkerApiError'
>()
// The entry's exports are the native API (`ProvinoApi`). `WorkerApi` (deprecated) is the Jest
// dialect's eight, as the Jest dialect types them: `test` and `it` there have no `extend`.
expectTypeOf(describe).toEqualTypeOf<ProvinoApi['describe']>()
expectTypeOf(it).toEqualTypeOf<ProvinoApi['it']>()
expectTypeOf(test).toEqualTypeOf<ProvinoApi['test']>()
expectTypeOf(expect).toEqualTypeOf<ProvinoApi['expect']>()
expectTypeOf(beforeAll).toEqualTypeOf<ProvinoApi['beforeAll']>()
expectTypeOf<keyof WorkerApi>().toEqualTypeOf<
  'afterAll' | 'afterEach' | 'beforeAll' | 'beforeEach' | 'describe' | 'expect' | 'it' | 'test'
>()
expectTypeOf<WorkerApi['describe']>().toEqualTypeOf<ProvinoApi['describe']>()
expectTypeOf<WorkerApi['expect']>().toEqualTypeOf<ProvinoApi['expect']>()
declare const jestTest: WorkerApi['test']
// @ts-expect-error the Jest dialect's `test` has no `extend`
jestTest.extend({ db: 1 })

// `lazy` is typed by chaining: a read of a key that was never defined is an error.
const $lazy = lazy.let('user', () => ({ name: 'Ada' })).let('greeting', ({ user }) => user.name)
expectTypeOf($lazy.greeting).toEqualTypeOf<string>()
// @ts-expect-error 'missing' was never defined
$lazy.missing

// A suite takes a name and a body; a test takes a name and a function.
describe('suite', () => {
  it('passes', () => {
    expect(1).toBe(1)
  })
})
// @ts-expect-error a suite needs a name and a body
describe()
// @ts-expect-error a test's body is a function
it('x', 'not a function')

// The error a use outside a worker throws names the cause by code.
expectTypeOf<ProvinoWorkerApiError['code']>().toEqualTypeOf<
  'PROVINO_NO_WORKER_API' | 'PROVINO_NATIVE_ONLY'
>()
expectTypeOf<ProvinoWorkerApiError>().toExtend<Error>()

// `provino/globals` declares the Jest dialect's eight on `globalThis`, typed as Jest types them,
// and none of the native API's own names.
expectTypeOf(globalThis.describe).toEqualTypeOf<WorkerApi['describe']>()
expectTypeOf(globalThis.expect).toEqualTypeOf<WorkerApi['expect']>()
expectTypeOf(globalThis.test).toEqualTypeOf<WorkerApi['test']>()
// @ts-expect-error `fn` is the native API's; a Jest project's globals have no `fn`
globalThis.fn
// @ts-expect-error nor `timers`
globalThis.timers
// @ts-expect-error the Jest-typed global `test` has no `extend`
globalThis.test.extend({ db: 1 })

// `provino/jest` is the dialect value a config's `dialects` lists.
expectTypeOf(jestDialect).toEqualTypeOf<Dialect<'jest'>>()
expectTypeOf(jestDialect.name).toEqualTypeOf<'jest'>()

// `provino/vitest` is the Vitest dialect's.
expectTypeOf(vitestDialect).toEqualTypeOf<Dialect<'vitest'>>()
expectTypeOf(vitestDialect.name).toEqualTypeOf<'vitest'>()
// @ts-expect-error: the dialect is the Vitest one, not Jest's.
expectTypeOf(vitestDialect.name).toEqualTypeOf<'jest'>()

// `provino/environment`: the shipped environments and `defineEnvironment`, which keeps the type.
expectTypeOf(defineEnvironment(nodeEnvironment)).toEqualTypeOf<Environment<'node'>>()
expectTypeOf(nodeEnvironment).toExtend<Environment<'node'>>()
expectTypeOf(jsdomEnvironment.name).toEqualTypeOf<'jsdom'>()
expectTypeOf<Pragmas>().toExtend<Readonly<Record<string, string | readonly string[]>>>()
// @ts-expect-error an environment needs a name, `setup` and the rest
defineEnvironment({ name: 'incomplete' })

// `provino/reporters`: a reporter is an object of hooks, built by `defineReporter`.
expectTypeOf(defineReporter).toBeFunction()
expectTypeOf(defineReporter({ name: 'x' })).toExtend<Reporter>()
// @ts-expect-error a reporter has a name
defineReporter({})
expectTypeOf(defaultReporter).toBeFunction()

// `provino/config`: the config types and the error a bad config throws.
expectTypeOf<ProvinoConfigInput>().toExtend<ProjectConfig>()
expectTypeOf<ConfigError>().toExtend<Error>()

// @ts-expect-error `defineConfig` is not built yet (T1.4)
import { defineConfig } from 'provino/config'

void defineConfig
