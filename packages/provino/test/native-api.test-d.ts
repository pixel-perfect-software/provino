// The native API's types as a test file sees them through `provino` (B27b): `describe.each`,
// `test.extend`, `fn<T>`, `spyOn`'s keys, `timers`, and misuse.
import { expectTypeOf } from 'expect-type'
import {
  describe,
  expect,
  fn,
  isMockFunction,
  mocks,
  type ProvinoApi,
  type ProvinoTimers,
  replaceProperty,
  spyOn,
  test,
  timers,
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
