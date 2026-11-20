// T5.9: the types of `test.extend` and `test.override` (`FixtureTestApi`): the keys each form adds
// are inferred, tests and hooks see them, and misuse is a compile error.
import type { FixtureTestApi } from '@provino/core'
import type { TestContext } from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const test: FixtureTestApi

// The builder form infers each key's value, awaited, and later builders read earlier keys.
const built = test
  .extend('base', () => 1)
  .extend('name', async ({ base }) => `n${base}`)
  .extend('file', { scope: 'file' }, ({ name }, { onCleanup }) => {
    onCleanup(() => undefined)
    return { name }
  })
built('reads every key', ({ base, name, file, task }) => {
  expectTypeOf(base).toEqualTypeOf<number>()
  expectTypeOf(name).toEqualTypeOf<string>()
  expectTypeOf(file).toEqualTypeOf<{ name: string }>()
  expectTypeOf(task).toEqualTypeOf<TestContext['task']>()
})

// The object form, with the keys given: values, use() functions and [value, options] entries.
const object = test.extend<{ answer: number; list: number[] }>({
  answer: 42,
  list: [async ({ answer }, use) => use([answer]), { scope: 'file' }],
})
object('reads', ({ answer, list }) => {
  expectTypeOf(answer).toEqualTypeOf<number>()
  expectTypeOf(list).toEqualTypeOf<number[]>()
})
// A use() function passes the key's own type.
// @ts-expect-error a string is not a number[]
test.extend<{ list: number[] }>({ list: async ({ task: _task }, use) => use('no') })

// A modifier keeps the keys.
built.only('a focused test', ({ base }) => {
  expectTypeOf(base).toEqualTypeOf<number>()
})

// override keeps each key's type and reads the parent.
built.override('base', ({ base }) => base + 1)
built.override({ name: 'static' })
// @ts-expect-error an override keeps the key's type
built.override('base', () => 'one')
// @ts-expect-error only a key the test has can be overridden
built.override('missing', () => 1)

// test.beforeAll gets the fixtures first and the suite second.
built.beforeAll(({ file }, suite) => {
  expectTypeOf(file).toEqualTypeOf<{ name: string }>()
  expectTypeOf(suite.name).toEqualTypeOf<string>()
})

// A test reads only the keys it has.
// @ts-expect-error `nope` is not a key of this test
built('unknown key', ({ nope }) => nope)
