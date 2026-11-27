// The native API's types as a test file sees them through `provino` (B27b): `describe.each`,
// `test.extend`, `fn<T>`, `spyOn`'s keys, `timers`, and misuse.
import { expectTypeOf } from 'expect-type'
import {
  describe,
  expect,
  fn,
  importActual,
  isMockFunction,
  isolateModules,
  isolateModulesAsync,
  type Mock,
  type Mocked,
  type MockedClass,
  type MockedFunction,
  type MockedObject,
  type MockImplementation,
  type MockInstance,
  mock,
  mocked,
  mocks,
  type ProvinoApi,
  type ProvinoMockFactory,
  type ProvinoTimers,
  replaceProperty,
  requireActual,
  resetModules,
  spyOn,
  stubEnv,
  stubGlobal,
  test,
  timers,
  unmock,
  unstubAllEnvs,
  unstubAllGlobals,
} from 'provino'

// `describe.each` spreads an array row into the body's parameters.
describe.each([
  [1, 'one'],
  [2, 'two'],
] as const)('row %s', (n, word) => {
  expectTypeOf(n).toEqualTypeOf<1 | 2>()
  expectTypeOf(word).toEqualTypeOf<'one' | 'two'>()
})
// @ts-expect-error `.each` takes rows, not a number
describe.each(3)

// `test.extend` adds its keys to the test's context.
const withDb = test.extend({ db: { url: 'mem://' } })
withDb('reads the fixture', ({ db }) => {
  expectTypeOf(db).toEqualTypeOf<{ url: string }>()
})
// @ts-expect-error 'cache' is not a fixture of this test
withDb('reads a missing fixture', ({ cache }) => cache)

// `fn` infers its implementation; `fn<T>` types one given later.
const add = fn((a: number, b: number) => a + b)
expectTypeOf(add(1, 2)).toEqualTypeOf<number>()
const later = fn<(name: string) => boolean>()
expectTypeOf(later.mock.calls).toEqualTypeOf<[name: string][]>()
// @ts-expect-error the mock takes its type's parameters
later(1)
expectTypeOf(isMockFunction(add)).toEqualTypeOf<boolean>()

// `spyOn` takes a method's key; a value property goes through `replaceProperty`.
const service = { load: (id: number) => `item ${id}`, retries: 3 }
const spy = spyOn(service, 'load')
expectTypeOf(spy.mock.calls).toEqualTypeOf<[id: number][]>()
// @ts-expect-error 'retries' is not a method
spyOn(service, 'retries')
// @ts-expect-error 'missing' is not a key of the object
spyOn(service, 'missing')
replaceProperty(service, 'retries', 5)
// @ts-expect-error the replacement has the property's type
replaceProperty(service, 'retries', 'five')

// `mocks` and `timers`.
expectTypeOf(mocks.restoreAll()).toEqualTypeOf<void>()
expectTypeOf(timers.useFakeTimers()).toEqualTypeOf<ProvinoTimers>()
expectTypeOf(timers.advanceTimersByTimeAsync(10)).toEqualTypeOf<Promise<ProvinoTimers>>()
// @ts-expect-error advancing takes milliseconds
timers.advanceTimersByTime('10ms')

// `expect` is the worker's, typed as the API types it.
expectTypeOf(expect).toEqualTypeOf<ProvinoApi['expect']>()
// @ts-expect-error a test needs a name
test()

// Module mocks (B27j): `mock` takes a specifier and an optional factory of the module's exports.
interface Dep {
  readonly value: () => string
  readonly count: number
}
expectTypeOf(mock('./dep.ts')).toEqualTypeOf<void>()
mock<Dep>('./dep.ts', () => ({ value: () => 'mocked' }))
// A factory may be async, and is given the real module.
mock<Dep>('./dep.ts', async (importOriginal) => {
  const real = await importOriginal()
  expectTypeOf(real).toEqualTypeOf<Dep>()
  return { ...real, count: 2 }
})
expectTypeOf<ProvinoMockFactory<Dep>>().parameters.toEqualTypeOf<[() => Promise<Dep>]>()
// @ts-expect-error the specifier is a string
mock(1)
// @ts-expect-error the factory is a function, not the exports themselves
mock('./dep.ts', { value: () => 'mocked' })
// @ts-expect-error the factory's exports have the module's types
mock<Dep>('./dep.ts', () => ({ count: 'two' }))
// @ts-expect-error a factory returns the exports as an object
mock<Dep>('./dep.ts', () => 5)
expectTypeOf(unmock('./dep.ts')).toEqualTypeOf<void>()
// @ts-expect-error unmock takes one specifier
unmock()
expectTypeOf(importActual<Dep>('./dep.ts')).toEqualTypeOf<Promise<Dep>>()
expectTypeOf(importActual('./dep.ts')).toEqualTypeOf<Promise<Record<string, unknown>>>()
// @ts-expect-error the specifier is a string
importActual(['./dep.ts'])

// `requireActual` is the synchronous `importActual`.
expectTypeOf(requireActual<Dep>('./dep.ts')).toEqualTypeOf<Dep>()
expectTypeOf(requireActual('./dep.ts')).toEqualTypeOf<Record<string, unknown>>()
// @ts-expect-error the specifier is a string
requireActual(1)
// It is not a promise: there is nothing to await.
expectTypeOf(requireActual('./dep.ts')).not.toExtend<Promise<unknown>>()

// `mocked` types a function, a class and an object with the mock methods; the value is the same.
class Repo {
  static create(id: number): Repo {
    return new Repo(id)
  }
  readonly id: number
  constructor(id: number) {
    this.id = id
  }
  find(name: string): string {
    return name + this.id
  }
}
const api = {
  load: (id: number): string => String(id),
  nested: { count: (): number => 1 },
  flag: true,
}
const load = mocked(api.load)
expectTypeOf(load).toEqualTypeOf<MockedFunction<(id: number) => string>>()
load.mockReturnValue('one')
expectTypeOf(load.mock.calls).toEqualTypeOf<[id: number][]>()
expectTypeOf(load(1)).toEqualTypeOf<string>()
// @ts-expect-error the return value has the function's type
load.mockReturnValue(1)
// @ts-expect-error a mock method that does not exist
load.notAKey
const deep = mocked(api)
expectTypeOf(deep).toEqualTypeOf<Mocked<typeof api>>()
expectTypeOf(deep).toEqualTypeOf<MockedObject<typeof api>>()
deep.nested.count.mockReturnValue(2)
deep.load.mockImplementation((id) => String(id + 1))
expectTypeOf(deep.flag).toEqualTypeOf<boolean>()
// @ts-expect-error a key the object does not have
deep.notAKey
// @ts-expect-error a plain value has no mock methods
deep.flag.mockReturnValue
const klass = mocked(Repo)
expectTypeOf(klass).toEqualTypeOf<MockedClass<typeof Repo>>()
klass.mockImplementation(() => new Repo(2) as Mocked<Repo>)
klass.create.mockReturnValue(new Repo(3))
expectTypeOf(new klass(1).find).toExtend<(name: string) => string>()
// A value that is no function or object is unchanged.
expectTypeOf(mocked(3)).toEqualTypeOf<number>()
expectTypeOf<Mock<() => void>>().toExtend<() => void>()

// Module reset (B28): `isolateModules` returns its callback's value, the async form a Promise of it.
expectTypeOf(resetModules()).toEqualTypeOf<void>()
expectTypeOf(isolateModules(() => 1)).toEqualTypeOf<number>()
expectTypeOf(isolateModulesAsync(async () => 'one')).toEqualTypeOf<Promise<string>>()
// @ts-expect-error resetModules takes nothing
resetModules('./dep.ts')
// @ts-expect-error isolateModules takes a function
isolateModules('./dep.ts')
// @ts-expect-error isolateModulesAsync takes a function that returns a Promise
isolateModulesAsync(() => 1)

// An overloaded function takes an implementation of its last overload (the full cases are in
// @provino/mock's type tests).
declare function read(path: string): string
declare function read(path: number): number
const overloaded = { read }
const mockedRead = mocked(overloaded).read
mockedRead.mockImplementation((path) => path + 1)
spyOn(overloaded, 'read').mockImplementation((path) => path + 1)
const readImpl: MockImplementation<typeof read> | undefined = mockedRead.getMockImplementation()
expectTypeOf(readImpl).toEqualTypeOf<((path: number) => number) | undefined>()
// @ts-expect-error the implementation takes the last overload's parameter type
mockedRead.mockImplementation((path: string) => path)

// Coming from @types/jest (wiki/native.md): what to write where provino is stricter.
spyOn(console, 'log').mockImplementation(() => {})
const exitSpy: MockInstance<typeof process.exit> = spyOn(process, 'exit')
expectTypeOf(exitSpy.mock.calls).toEqualTypeOf<[code?: number | string | null | undefined][]>()
type Apply = (name: string, count: number) => string
const applied = fn<Apply>((name, count) => name.repeat(count))
expectTypeOf(applied.mock.calls).toEqualTypeOf<[name: string, count: number][]>()
mock('node:path', () => ({
  ...requireActual<typeof import('node:path')>('node:path'),
  sep: '/',
}))

// `stubEnv` takes a string or `undefined` (which deletes the variable), `stubGlobal` any value; the unstubs take nothing.
stubEnv('MODE', 'test')
stubEnv('MODE', undefined)
stubGlobal('flag', { on: true })
expectTypeOf(unstubAllEnvs()).toBeVoid()
expectTypeOf(unstubAllGlobals()).toBeVoid()
// @ts-expect-error an env value is a string or undefined
stubEnv('MODE', 1)
// @ts-expect-error an env variable needs a value
stubEnv('MODE')
// @ts-expect-error a global needs a value
stubGlobal('flag')
