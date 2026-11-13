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

// The entry is the Jest dialect's test-definition globals, and no more.
expectTypeOf<keyof typeof import('provino')>().toEqualTypeOf<
  | 'afterAll'
  | 'afterEach'
  | 'beforeAll'
  | 'beforeEach'
  | 'describe'
  | 'expect'
  | 'it'
  | 'test'
  | 'ProvinoWorkerApiError'
>()
expectTypeOf(describe).toEqualTypeOf<WorkerApi['describe']>()
expectTypeOf(it).toEqualTypeOf<WorkerApi['it']>()
expectTypeOf(test).toEqualTypeOf<WorkerApi['test']>()
expectTypeOf(expect).toEqualTypeOf<WorkerApi['expect']>()
expectTypeOf(beforeAll).toEqualTypeOf<WorkerApi['beforeAll']>()
expectTypeOf(afterAll).toEqualTypeOf<WorkerApi['afterAll']>()
expectTypeOf(beforeEach).toEqualTypeOf<WorkerApi['beforeEach']>()
expectTypeOf(afterEach).toEqualTypeOf<WorkerApi['afterEach']>()

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
expectTypeOf<ProvinoWorkerApiError['code']>().toEqualTypeOf<'PROVINO_NO_WORKER_API'>()
expectTypeOf<ProvinoWorkerApiError>().toExtend<Error>()

// `provino/globals` declares the same API on `globalThis`, so a project can use it with no import.
expectTypeOf(globalThis.describe).toEqualTypeOf<WorkerApi['describe']>()
expectTypeOf(globalThis.expect).toEqualTypeOf<WorkerApi['expect']>()

// `provino/jest` is the dialect value a config's `dialects` lists.
expectTypeOf(jestDialect).toEqualTypeOf<Dialect<'jest'>>()
expectTypeOf(jestDialect.name).toEqualTypeOf<'jest'>()

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
