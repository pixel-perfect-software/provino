# Lazy variables

Lazy variables are RSpec-style values: you define a value once, it is built the first time a test reads it, and it is remembered for the rest of that test. A nested `describe` can override it, and everything defined from it sees the override.

They are a Provino extra, not a Jest feature, so they are imported and never a global:

```ts
import { lazy } from 'provino'
```

This works in a TypeScript or JavaScript test file under both `provino jest` and `provino run`, and also with `injectGlobals: false`. `describe`, `it` and `expect` stay what the dialect makes them: Jest's globals under `provino jest` (or `@jest/globals`).

## Defining and reading

```ts
import { lazy } from 'provino'

const $ = lazy
  .let('user', () => ({ name: 'Ada' }))
  .let('greeting', ({ user }) => `hello ${user.name}`)

it('builds what it reads', () => {
  expect($.greeting).toBe('hello Ada')
})
```

- `.let(key, fn)` defines a value. `fn` receives the other values (by name) and may be async: a read then gives the promise, and `await $.key` works.
- A value is built on its first read in a test and is the same object for the rest of that test. The next test gets a new one.
- `lazy.let` and its chain are typed: reading a key you did not define is a type error.
- A key can't be named like a handle method (`let`, `eager`, `override`, `from`) or a protocol key such as `then`.

## Overriding

```ts
describe('for Grace', () => {
  $.override('user', (_deps, { parent }) => ({ name: `${parent().name} (Grace)` }))
  it('late-binds', () => expect($.greeting).toBe('hello Ada (Grace)'))
})
```

`$.override(key, fn)` replaces a value for the tests in that `describe`. `parent()` reads the definition it replaces. Values that depend on `user` see the override, however far the definition is from the test. `$.let(key, fn)` inside a `describe` re-declares a key.

## Eager values

`lazy.eager(key, fn)` runs `fn` in a `beforeEach` at the place it is written, so it sits in order with your other hooks. A read before it has run is an error (`LAZY_EAGER_PENDING`).

## Scopes

```ts
lazy.let('conn', () => open(), { scope: 'file' })
lazy.let('pool', () => start(), { scope: 'worker' })
```

| Scope | Built | Lives |
|---|---|---|
| `test` (default) | on the first read in a test | that test |
| `file` | once per file, from the file's top level | the file; cleaned up after its last test |
| `worker` | once per worker, keyed by where it is defined | the worker; shared by every file that runs there |

A wider value can't read a narrower one (`LAZY_SCOPE`, naming both definitions). `{ timeout }` bounds an async definition. A value's cleanup is run in reverse order of creation, after `afterEach` for a test value.

## Shared examples

```ts
import { itBehavesLike, lazy, sharedExamples } from 'provino'

const aNumber = sharedExamples<{ subject: number }, [label: string]>('a number', ($, label) => {
  const $g = $.let('double', ({ subject }) => subject * 2)
  it(`${label} doubles`, () => expect($g.double).toBe($g.subject * 2))
})

const $ = lazy.let('subject', () => 1)
itBehavesLike(aNumber, $, 'plain')
describe('over', () => {
  $.override('subject', () => 5)
  itBehavesLike(aNumber, $, 'big') // sees the override
})
```

`itBehavesLike` opens a `describe('behaves like <name>')`. `includeExamples` adds the tests in the current suite instead. `sharedContext` and `includeContext` do the same for definitions only.

## Errors

A mistake throws a `LazyError` with a `code` and the file and line of the definition, as written in your source (mapped back through the compile step): a duplicate key (`LAZY_DUPLICATE`), an override with nothing to override (`LAZY_INVALID`), a cycle (`LAZY_CYCLE`, with every site), a read outside a test (`LAZY_NO_TEST`), and `LAZY_NO_RUNTIME` when `lazy` is used outside a test file that Provino is running.

## Limits

- A cycle through `$` after an `await` waits for the test's timeout; read the other value through the dependencies argument to get `LAZY_CYCLE`.
- The failure report lists the lazy values a failed test evaluated (key, where it is defined, time) in the text reporters (`default`, `verbose`, `agent`, `dot`), and for a definition that threw, the chain of reads that led to it (`chain: cart -> user`). The JSON, JUnit and GitHub Actions reporters do not carry it.
- An async definition that rejects is not marked as the one that failed in that list. Provino hands you the promise your definition returned, untouched, and never attaches a handler to it, so it cannot see the rejection; the test still fails with the error wherever you await it. A rejection that nothing awaits stays an unhandled rejection, as it would without Provino. The exception is an `eager` value: its hook awaits the promise itself, so its rejection is marked, with its chain.
- Lazy variables work in a jsdom file, but under `provino run` such a file needs `isolation: 'registry'` in the config today: the default for jsdom is the realm tier, which is not built yet. `provino jest` with `testEnvironment: 'jsdom'` runs the project's own `jest-environment-jsdom` and needs no setting.
