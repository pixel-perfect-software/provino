# Provino-native projects

A native project has a `provino.config.*` that names no dialect, and its tests import `describe`, `it`, `expect`, `fn` and the rest from `provino`. It runs on Provino's own policy: nothing from Jest or Vitest is installed or loaded.

Pick native for a new project, or for a suite you are willing to port. Pick [`provino jest`](compatibility.md) to run a Jest suite as it is: Jest's config, flags, matchers and snapshots. A repository can have both: the nearest config decides which kind a directory is.

## Install

```bash
pnpm add -D provino@rc
```

That is all. There is no Jest dialect to add, and no Jest, Babel or Chai package comes with it. It needs Node.js 22.15 or later, or 24 or later. A jsdom environment needs the `jsdom` package as well (see [the config](#the-config)).

## A first test

```ts
// provino.config.ts
import { defineConfig } from 'provino/config'

export default defineConfig({
  include: ['src/**/*.test.ts'],
})
```

```ts
// src/native.test.ts
import { describe, expect, fn, it, test } from 'provino'

describe('native', () => {
  it('adds', () => {
    expect(1 + 1).toBe(2)
  })
  it('records a call', () => {
    const f = fn()
    f('a')
    expect(f.mock.calls).toEqual([['a']])
  })
})

test('an async test', async () => {
  expect(await Promise.resolve(3)).toBeGreaterThan(2)
})
```

Run it with `pnpm exec provino`. On a terminal, it ends with:

<!-- capture: a real run of this project (--reporter provino, since a pipe gets the default reporter); the lines are the ones a terminal ends with -->
```console
✅ src/native.test.ts · 3 tests · 28ms

🎉 3 tests passed in 1 file · 166ms
🐢 slowest: src/native.test.ts 28ms
```

`provino` with no command finds the config and runs it. Both take the flags of `provino run` (`provino --help`). [Output](output.md) says what a run prints, on a terminal and elsewhere.

## Finding the config

`provino` and `provino run` look for a config from the working directory up, and stop at the first directory that holds one. They also stop after a directory that has a `.git` or a `pnpm-workspace.yaml`, so a config above a repository or a workspace is never used.

- A `provino.config.ts` (or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`) wins over a Jest config in the same directory.
- The nearest config of any kind wins, so a Jest config in a sub-directory beats a `provino.config.*` above it. Bare `provino` then runs that directory as a Jest project. `provino run` takes a `provino.config.*` only: it exits 2 and says "nearest config is a Jest config in <directory>".
- Nothing found is exit 2: "found no provino.config.*, Jest config or Vitest config in <directory> or a parent directory".
- `--config <file>` (`-c`) names the file and skips the search.

## File arguments

`provino run [pattern…]` (and bare `provino [pattern…]`) runs only the files whose path matches a pattern. A pattern is a case-insensitive regular expression tested against the path, as Jest's test path patterns are, so `src/a.test.ts` and `__tests__/a/b.test.ts` both work, and two patterns select the union of what each matches. A first word that is not a command (`run`, `jest`, `vitest`) is a pattern for the bare form: `provino math` runs the files with `math` in their path, and a mistyped command reads as a pattern that matches nothing, which the message names.

- A run whose patterns match no file is the no-tests outcome: exit 1, with the patterns named; `--passWithNoTests` passes it. A pattern that isn't a valid regular expression is a usage error (exit 2).
- With `--watch`, every rerun, a related one included, stays inside the patterns.
- `-t <pattern>` narrows further, to the tests whose full name matches.

## The config

A config is an object, or a function of `{ command, mode }` that returns one (it may be async). Today it is called with `{ command: 'run', mode: 'test' }`. `defineConfig` types it and returns it as it is.

Node itself reads the config file, so a `.ts` config needs Node 22.18 or later, where Node strips types by default. On 22.15 to 22.17 use a `provino.config.mjs` (or `.js`), which works on every supported version; `NODE_OPTIONS=--experimental-strip-types` also works there. Your test files don't depend on this: Provino compiles them itself.

| Key | What it does |
| --- | --- |
| `include` | Globs of the test files, relative to `root`. Default `**/*.{test,spec}.?(c\|m)[jt]s?(x)` |
| `exclude` | Globs to leave out. Default `**/node_modules/**` and `**/dist/**`. A list you give **replaces** the default, so keep `**/node_modules/**` in it |
| `root` | The project's directory, relative to the config file's directory (default: that directory). It must exist |
| `name` | The project's name, printed before its files when a run has several projects |
| `environment` | `node` (default) or `jsdom`. `jsdom` needs the `jsdom` package (`>=26 <31`) |
| `environmentOptions` | Options for the environment, as JSON (`{ url: 'http://example.test/' }` for `jsdom`) |
| `isolation` | How files are kept apart in a worker: `registry` (default, for `jsdom` too: a fresh module registry per file), `none` (modules load once per worker and are shared), `process` (a worker per file). `realm` is not available yet |
| `globals` | `true` installs the API as globals (see [globals](#globals)) |
| `setupFiles` | Modules imported before each test file: a path (`./test/setup.ts`) or a package name |
| `timeouts` | `{ test, hook, teardown }` in ms. Defaults 5000, 10000 and 10000; `0` is no limit. A timeout given to a test or hook wins |
| `resolve` | `conditions` (export conditions added after the environment's, such as `['development']`), `aliases` (`{ '@/*': './src/*' }`) and `tsconfig` (`'auto'` is the nearest `tsconfig.json`, a path, or `false`) |
| `define` | Compile-time replacements in your own modules, as a bundler's `define` makes them: see [define](#define) |
| `coverage` | Code coverage: see [Coverage](#coverage). Top level only |
| `projects` | See [Projects](#projects). Top level only |
| `pool` | `forks` (default), `threads` or `inline`: the pool when the command line names none. Top level only |
| `maxWorkers` | The most workers when the command line names no number (default: the cores, less one). Top level only |
| `execArgv` | Node flags each forked or threaded worker starts with, such as `['--conditions=development']` for a test that calls `createRequire(import.meta.url).resolve(...)`. They are added after the flags the coordinator itself runs with (its `process.execArgv`). Each entry is one argument (`['--require', file]` is two), and the first must be a flag. Node reads a relative path in a flag from the working directory, not the config's, so give an absolute one. A thread refuses V8 and process-wide flags such as `--max-old-space-size`, in this list and, once the key is set, on the coordinator's own command line: pass those in `NODE_OPTIONS`, which every worker gets. The flags do not apply to `--pool inline`, or to a run that goes in band, which share the coordinator's process (no error). Top level only |

Reporters are not config keys: name them on the command line (`--reporter`). A key the config does not know is a usage error that names the nearest one: `unknown config key "incude"; did you mean "include"?` (exit 2). A non-empty `plugins` or `alsoServe` is refused by name too.

Naming a dialect (`dialect: 'jest'`) makes the project a Jest project, which needs [`@provino/dialect-jest`](compatibility.md) installed.

### define

`define` replaces an expression with a value where your modules read it, before they run, as esbuild, Vite and webpack's DefinePlugin do. Provino emulates nothing of a bundler, so a project names what its own bundler substitutes. A Vite app reads `import.meta.env` in its source, and Vite fills it in when it builds the app; a native run has no such object, so the module throws `Cannot read properties of undefined (reading 'DEV')`. Give the same values here:

```ts
export default defineConfig({
  define: {
    'import.meta.env.DEV': true,
    'import.meta.env.MODE': '"test"',
    __APP_VERSION__: '"1.2.3"',
  },
})
```

A key is an identifier or a dotted chain of identifiers (`__APP_VERSION__`, `process.env.NODE_ENV`, `import.meta.env.DEV`, `import.meta.env`); any other key is a config error naming `define["<key>"]`. A string value is the source text of an expression, so `'"test"'` is the string `test` and `'true'` is the boolean. Any other JSON value (a number, boolean, `null`, array or object) is written as its JSON text, which is how `{ 'import.meta.env': { DEV: true, BASE_URL: '/' } }` makes both `import.meta.env.DEV` and `import.meta.env[key]` work. Give the whole object or the single members; a more specific key wins where both match.

- **Reach.** Only the modules Provino transforms take it: your test files, your source and a `node_modules` package a transform claims. A `node_modules` package that Node loads itself does not, as a bundler's `define` leaves a dependency it does not bundle alone. Any other `import.meta` (`import.meta.url`) still works as before.
- **Coverage.** With `define` set, every file takes Oxc's transform and its source map. Without it, a `.ts` file collected for coverage is instead stripped in place (types become spaces, so positions stay put and no map is needed). So under `--coverage` a project with `define` maps positions through Oxc's map, which can differ slightly from the in-place strip's.
- The key is for a project with no dialect; a Jest project's config has no such key, and Vitest's own `define` handling is unchanged.

## Coverage

`provino run --coverage`, or `coverage.enabled: true` in the config, collects code coverage for the whole run: one report directory, one set of reporters and one set of thresholds. `coverage` is a top-level key only; inside a project it is a config error.

```ts
import { defineConfig } from 'provino/config'

export default defineConfig({
  coverage: {
    include: ['src/**/*.ts', '!src/generated/**'],
    thresholds: { global: { statements: 80, branches: 70 } },
  },
})
```

| Key | What it does |
| --- | --- |
| `enabled` | Collect coverage on every run. Default `false`; `--coverage` turns it on for one run |
| `provider` | `v8` (default: no instrumentation) or `istanbul` (instruments each file as it loads) |
| `include` | Globs of the files that count, relative to the run's root; a leading `!` leaves files out. Default: every file the tests load. A file it names that no test loaded counts at zero |
| `exclude` | Globs of files that never count. `**/node_modules/**` never counts, with either provider; a list you give adds to it |
| `reporters` | Istanbul's report names, each a name or `[name, options]`: `text`, `text-summary`, `lcov`, `lcovonly`, `json`, `json-summary`, `html`, `clover`, `cobertura` and the rest. Default `['text', 'lcovonly']`; an unknown name is a config error |
| `directory` | Where the reports go, relative to the run's root. Default `coverage` |
| `thresholds` | Jest's `coverageThreshold` shape: `global`, or a path or glob, each with a minimum percentage per metric (`statements`, `branches`, `functions`, `lines`). A negative number is the most uncovered items allowed. A missed threshold prints a line on stderr and the run exits 1 |

- A run with no coverage loads none of the coverage code.
- `--coverage` with `--watch` is a usage error. A config with `coverage.enabled` under watch runs without coverage and says so once on stderr.
- The totals and the files in `lcov.info` equal what `provino jest --coverage` reports for an equivalent project and provider.

## Projects

`projects` runs several projects in one invocation. An entry is a glob, a directory, or an inline object:

```ts
import { defineConfig } from 'provino/config'

export default defineConfig({
  projects: [
    'packages/*',
    '!packages/legacy',
    { name: 'scripts', root: 'scripts', include: ['*.test.ts'] },
  ],
})
```

- A directory that has its own `provino.config.*` uses it, and is named for the directory unless the config names it. A glob matches directories, never `node_modules`, and never the config's own directory.
- An entry that starts with `!` leaves out what the globs matched.
- Each project has its own `include`, `setupFiles`, `environment`, `isolation`, `timeouts` and `resolve`. The top level's keys are **not** inherited. A project has no `projects`, `pool`, `maxWorkers` or `execArgv`.
- Names must be unique. A glob that matches nothing is an error.
- Projects may share a `root`, so one directory can run some files in node and others in jsdom (the native runner reads no per-file environment docblock; projects are how a file picks its environment):

  ```ts
  export default defineConfig({
    projects: [
      { name: 'node', include: ['src/**/*.test.ts'] },
      { name: 'window', include: ['src/**/*.test.tsx'], environment: 'jsdom' },
    ],
  })
  ```

  A file must belong to one project only, judged by real path (a project whose root is a symlink into another's tree counts too). Projects whose roots nest (`.` and `packages/a`) are checked the same way: if both select one file, the run is refused, where earlier versions ran that file twice without a word. When two projects discover the same file the run exits 2 before any test starts: `Provino: projects "node" and "window" both run src/a.test.ts: give their include globs no file in common` (at most three files are named, then a count). The check reads each project's discovered files before file arguments or `-t` narrow the run, and a watch run repeats it every time it starts (a new file that causes an overlap fails that run with the same message and exit code 2, and the session keeps watching). `provino jest` is not checked: Jest runs a file in every project that matches it.
- With several projects a file's line starts with its project's name: `PASS core packages/core/src/core.test.ts`.

## Writing tests

Everything comes from `provino`. Every module of a test file, a helper included, gets the same `expect` and `fn`.

### Suites and tests

```ts
import { describe, expect, it, test } from 'provino'

describe('cart', () => {
  it('starts empty', () => {
    expect([]).toHaveLength(0)
  })

  it.skip('is skipped', () => {})
  it.todo('prices a coupon')
  it.skipIf(process.platform === 'win32')('uses posix paths', () => {})

  it.each([
    [1, 1, 2],
    [1, 2, 3],
  ])('adds %i and %i', (a, b, sum) => {
    expect(a + b).toBe(sum)
  })

  it('takes options', { timeout: 1000 }, () => {})
})
```

- `describe` and `suite` are one function, as are `it` and `test`. A test is named by its titles joined with `>`.
- Modifiers: `.only`, `.skip`, `.todo`, `.concurrent`, `.skipIf(condition)`, `.runIf(condition)`, and for a test `.fails` (`.failing` is the same: the test passes when its body fails). They chain: `it.only.concurrent(…)`.
- `.each(rows)` spreads an array row into the arguments; `.for(rows)` passes the row whole. Titles take `%s`, `%i`, `%j`, `%#` (the row's index) and `$key` for an object row. A tagged table works too.
- The second argument can be options (`timeout`, `retry`, `repeats`, `concurrent`, `skip`, `only`, `todo`, `tags`) and a number third is a timeout in ms.
- A test with no body is a todo. A `describe` body can't be async.
- On CI (the `CI` variable) a test marked `.only` fails with "Unexpected .only modifier", so a stray `.only` can't shrink a CI run.
- The test body takes a context: `ctx.skip()` skips from inside the test, and `ctx.signal` is aborted when the test times out.
- Tests marked `.concurrent` run together, at most five at a time.

`test.extend` adds fixtures to the context. A fixture is a value, or a function that returns one: its first parameter destructures the fixtures it reads, and `onCleanup` registers what runs when the test is done.

```ts
import { expect, test } from 'provino'

const withLabel = test.extend({ label: 'main' })

const withDb = withLabel.extend('db', ({ label }, { onCleanup }) => {
  const db = { name: label, open: true }
  onCleanup(() => {
    db.open = false
  })
  return db
})

withDb('reads fixtures', ({ db, label }) => {
  expect(db.open).toBe(true)
  expect(db.name).toBe(label)
})
```

### Hooks

`beforeAll`, `afterAll`, `beforeEach` and `afterEach` take a function and an optional timeout. An outer `beforeEach` runs before an inner one and an inner `afterEach` before an outer one; hooks of one level run in the order written, except `afterEach` and `afterAll`, which run last written first. A `beforeEach` may return a function, which runs as a cleanup after the test's `afterEach` hooks.

- `aroundEach(async (runTest) => { … })` wraps each test with its hooks. `aroundAll(async (runSuite) => { … })` wraps a suite. Call the function exactly once.
- `onTestFinished(fn)` runs after the current test, its hooks and its cleanups; `onTestFailed(fn)` runs when it failed. Several run last registered first. Call them from a test or a hook; the test context has both as methods too.

```ts
import { aroundEach, beforeEach, expect, it, onTestFinished } from 'provino'

const log: string[] = []

aroundEach(async (runTest) => {
  log.push('start')
  await runTest()
  log.push('end')
})

beforeEach(() => {
  log.push('beforeEach')
  return () => log.push('cleanup')
})

it('registers a callback', () => {
  onTestFinished(() => log.push('finished'))
  expect(log).toEqual(['start', 'beforeEach'])
})

it('sees what the first one did', () => {
  expect(log).toEqual(['start', 'beforeEach', 'cleanup', 'finished', 'end', 'start', 'beforeEach'])
})
```

### expect

`expect` has the usual matchers: `toBe`, `toEqual`, `toStrictEqual`, `toMatchObject`, `toContain`, `toContainEqual`, `toHaveLength`, `toHaveProperty`, `toMatch`, `toThrow`, `toBeInstanceOf`, `toBeTypeOf`, `toSatisfy`, the truthiness and comparison ones (`toBeTruthy`, `toBeNull`, `toBeDefined`, `toBeNaN`, `toBeGreaterThan`, `toBeCloseTo`, …) and the mock matchers (`toHaveBeenCalled`, `toHaveBeenCalledWith`, `toHaveReturned`, … with their Times, Last and Nth forms). It also has `.not`, `.resolves`, `.rejects`, `expect.any`, `expect.anything`, `expect.objectContaining`, `expect.arrayContaining`, `expect.stringContaining`, `expect.stringMatching`, `expect.closeTo`, `expect.assertions`, `expect.hasAssertions`, `expect.soft` (the test goes on after a failure, and fails at the end) and `expect.poll`.

- A failure is an `AssertionError` with Jest's layout: `expect(received).toBe(expected)`, a blank line, then `Expected:` and `Received:`, and a diff for objects.
- `expect(value, message)` (and `expect.soft(value, message)`) labels an assertion. On a failure the message is the first line, then a blank line, then the matcher's usual text, so the measured values stay in it:

  ```ts
  expect(contrast, 'ink on the card').toBeGreaterThanOrEqual(3)
  // ink on the card
  //
  // expect(received).toBeGreaterThanOrEqual(expected)
  // Expected: >= 3
  // Received: 2.1
  ```

- `expect.poll` takes no message.
- `expect.extend` adds matchers, in a test file or in a setup file.
- An assertion on a promise (`.resolves`, `.rejects`, `expect.poll`) must be awaited. One that is not fails the test and says so.
- `toMatchSnapshot`, `toMatchInlineSnapshot`, `toThrowErrorMatchingSnapshot` and `toThrowErrorMatchingInlineSnapshot` are there: see [Snapshots](#snapshots).

### Mocks

```ts
import { expect, fn, isMockFunction, it, mocks, replaceProperty, spyOn } from 'provino'

const api = { load: (id: number) => 'item ' + id, retries: 3 }

it('records calls', () => {
  const add = fn((a: number, b: number) => a + b)
  add.mockReturnValueOnce(10)
  expect(add(1, 2)).toBe(10)
  expect(add).toHaveBeenCalledWith(1, 2)
  expect(isMockFunction(add)).toBe(true)
})

it('spies and replaces', () => {
  const spy = spyOn(api, 'load').mockImplementation((id) => 'fake ' + id)
  expect(api.load(2)).toBe('fake 2')
  expect(spy.mock.calls).toEqual([[2]])
  replaceProperty(api, 'retries', 9)
  expect(api.retries).toBe(9)
})
```

- `fn(impl?)` makes a mock function. Its `.mock` holds `calls`, `results`, `instances` and `lastCall`, and it has `mockReturnValue`, `mockImplementation`, `mockResolvedValue`, `mockRejectedValue`, `mockClear`, `mockReset`, `mockRestore`, `whenCalledWith` and the `Once` forms.
- `spyOn(object, key)` replaces a method with a mock that calls through; `spyOn(object, key, 'get' | 'set')` spies on an accessor. `replaceProperty(object, key, value)` replaces a plain value and returns something with `restore()` and `replaceValue()`.
- `mocks.clearAll()`, `mocks.resetAll()` and `mocks.restoreAll()` act on every mock of the file.
- Between tests Provino clears each mock's calls and puts spies and replaced properties back, so none leaks into the next test. A mock's implementation stays unless you reset it.

### Typing mocks

`mocked(value)` is the identity function, typed as `Mocked<T>`: it gives a function or an automocked module object its mock members without a cast. `Mock<T>`, `MockInstance<T>`, `Mocked<T>`, `MockedFunction<T>`, `MockedClass<T>` and `MockedObject<T>` are exported as types from `provino`. `Mocked<T>` is deep, matching how automock shapes an object.

```ts
import { expect, it, mock, mocked } from 'provino'
import { send } from '../src/mailer.ts'

mock('../src/mailer.ts')

it('types the mock', () => {
  mocked(send).mockReturnValue('queued')
  expect(send('ada@example.com')).toBe('queued')
})
```

#### Coming from @types/jest

Provino's mock types are stricter than `@types/jest` in five places. Each has a one-line fix:

- `fn()` with no implementation is `Mock<(...args: unknown[]) => unknown>`. Give it the function type, `fn<(out: string) => boolean>()`, or an implementation.
- `mockImplementation` needs an implementation. To silence a method, write `spyOn(console, 'log').mockImplementation(() => {})`.
- `Mock` and `MockInstance` default to unknown arguments. Annotate with the function type, `MockInstance<typeof process.exit>`.
- `fn(impl)` infers its type from the implementation. Annotate the parameters, or pass the type argument, `fn<Apply>(…)`.
- `requireActual` returns a record of unknown values without a type argument, so a mock factory that spreads it loses the module's types. Write `requireActual<typeof import('node:path')>('node:path')`.

A mocked or spied overloaded function takes an implementation of its last overload, as its call signature already does. `.each` rows give a callback one parameter per column, and a callback may take only the first columns.

### Resetting modules

`resetModules()` drops the file's module cache: the next `import` or `require` of a module runs it again, so a module-level memo is fresh. Registered mocks stay.

`isolateModules(fn)` and `isolateModulesAsync(fn)` run the callback in a module registry of its own and return what it returns; the registry is dropped after. A `mock()` at the top of the callback is hoisted to the top of the callback, so it registers inside the isolation, whether `isolateModules` is imported or is the global under `globals: true` (`mock` itself is always imported from `provino`; `globals: true` installs no global `mock`, and only the bare call `isolateModules(…)` counts, not `globalThis.isolateModules(…)`): a `require` there sees the mock, while the code outside sees the real module. They can't nest (the second call fails with a `nested-isolation` error).

```ts
import { expect, isolateModules, it, mock } from 'provino'

it('loads a module with its dependency mocked', () => {
  const total = isolateModules(() => {
    mock('../src/prices.ts', () => ({ price: () => 10 }))
    return require('../src/cart.ts').total()
  })
  expect(total).toBe(10)
})
```

- Under `isolation: 'none'`, `resetModules` resets the worker's shared module instances, which every file of that worker sees.
- All three are globals under `globals: true`. `requireActual` is not (like `mock`, it resolves from the calling module).

### Timers

`timers` is the file's fake clock. Each member that changes the clock returns `timers`, so calls chain.

```ts
import { afterEach, expect, it, timers } from 'provino'

afterEach(() => {
  timers.useRealTimers()
})

it('fakes the clock', async () => {
  timers.useFakeTimers()
  let ticks = 0
  setInterval(() => ticks++, 100)
  timers.advanceTimersByTime(350)
  expect(ticks).toBe(3)
  await timers.advanceTimersByTimeAsync(100)
  expect(ticks).toBe(4)
})
```

The members are `useFakeTimers`, `useRealTimers`, `isFakeTimers`, `runAllTimers`, `runOnlyPendingTimers`, `advanceTimersByTime`, `advanceTimersToNextTimer` (each with an `Async` form), `advanceTimersToNextFrame`, `runAllTicks`, `clearAllTimers`, `getTimerCount`, `setSystemTime`, `getRealSystemTime`, `getMockedSystemTime`, `setTimerTickMode` and `now`.

### Module mocks

`mock(specifier, factory?)`, `unmock(specifier)`, `importActual(specifier)` and `requireActual(specifier)` replace a module for one test file, or reach the real one. A `mock` or `unmock` at the top level of the file is **hoisted** above the file's imports, which then load after it, so it can sit below them:

```ts
import { expect, fn, importActual, it, mock } from 'provino'
import { signup } from '../src/signup.ts'
import { send } from '../src/mailer.ts'

mock('../src/mailer.ts', () => ({ send: fn(async (to: string) => 'fake: ' + to) }))

it('sends through the mock', async () => {
  expect(await signup('ada@example.com')).toBe('fake: ada@example.com')
  expect(send).toHaveBeenCalledWith('ada@example.com')
})

it('reaches the real module', async () => {
  const real = await importActual<typeof import('../src/mailer.ts')>('../src/mailer.ts')
  expect(await real.send('grace@example.com')).toBe('sent to grace@example.com')
})
```

- The specifier is resolved from the file that calls `mock`, and every module that imports it sees the mock, a helper module too.
- A factory returns the module's exports as an object (`default` for the default export) and may be async. It is given `importOriginal`, which loads the real module. Reading an export the factory left out throws.
- With no factory, the module is automocked: its functions and class methods become mocks, its other values stay.
- `importActual` gives the real module past any mock of it. Its own imports are still mocked. `requireActual<T>(specifier)` is the synchronous form, with `require` semantics (Jest's `jest.requireActual`): it works in a test and in a synchronous factory, and a module graph with a top-level `await` fails with `ERR_REQUIRE_ASYNC_MODULE`.
- With no factory, `mock('@/utils/logger')` finds the manual mock `src/utils/__mocks__/logger.ts` when the specifier goes through `resolve.aliases`, and a helper that imports `./utils/logger` sees the same mock.
- A factory may be synchronous: one that returns no Promise settles at once, so a `require` of the mocked module works. A factory that returns a Promise, or an automock of a graph with a top-level `await`, is refused by name when it is reached through `require`.
- Each file has mocks of its own, and none reaches the next file.
- A factory runs while the file's imports load, so it can read an import written above the `mock` call, but not one below it or a top-level binding of the file. That fails the file: ``mock('../src/a.ts'): the factory read the import `b` before it was initialized``.
- A `mock` or `unmock` inside a function or block fails the file: `mock() must be called at the top level of the file`. `mock('…', notAFunction)` and a specifier that is not a string are errors too (`API_MOCK_FACTORY`, `API_MOCK_SPECIFIER`).
- A mock in a helper module applies to every file that imports it, under the default `registry` isolation. Under `isolation: 'none'` the helper loads once per worker, so a `mock` made from it is refused (`API_MOCK_SHARED_MODULE`).

### Snapshots

The four snapshot matchers write and read **Jest 30.5's `.snap` format**, byte for byte, so a suite moved off Jest keeps its snapshot files and a native run leaves them unchanged. The files sit in `__snapshots__/<test file>.snap` beside the test, and the value is printed with a vendored copy of Jest's pretty-format, including its plugins for React elements, DOM nodes, immutable collections and asymmetric matchers.

```ts
import { expect, it } from 'provino'

it('snapshots a value', () => {
  expect({ id: 1, tags: ['a'] }).toMatchSnapshot()
  expect(() => { throw new Error('boom') }).toThrowErrorMatchingInlineSnapshot()
})
```

- A new snapshot is written; one that differs fails the test; `-u` (`--updateSnapshot`) rewrites it and drops the obsolete entries of a file it ran. With `--ci`, or the `CI` variable, nothing is written and a missing snapshot fails, unless `-u` is also given (`-u` wins and rewrites).
- An inline snapshot, new or updated, is written into the test file as a template literal, escaped as Jest escapes it and starting at column 0: there is no formatter, so a project that ran Prettier on Jest's output gets unformatted text. Only the template changes; the rest of the call keeps its layout. Jest reprints the whole call with Babel's generator, so where the call has a callback body (`toThrowErrorMatchingInlineSnapshot` after a thrown error, an updated snapshot) or an object argument over several lines with a comment inside, Jest's file is laid out differently from Provino's. The snapshot text differs in neither case; only the call's layout does. Those three cases are not held against Jest's recordings (the corpus lists them as excluded, "Babel reprint"). Two snapshots written for one call (a helper called twice) fail the test file, as in Jest.
- The printer and the writer load on the first snapshot a worker takes (the writer's parser on the first inline write), so a run with no snapshots pays nothing.
- The failure messages and diffs are Provino's own, not Jest's text. `.snap` files with no test file are not looked for (the obsolete-file crawl is off), and there is no `snapshotResolver` or `toMatchFileSnapshot`.
- The printer loads with `require` of an ES module (Node 22.12 and later), which `--no-require-module` turns off; Provino adds no message for that, so the first snapshot then fails with Node's own error.

### Lazy variables

`lazy` comes from `provino` too: values built on first read, kept for one test, overridden in a nested `describe`. See [Lazy variables](lazy-variables.md).

## Importing assets and styles

A test file, or a module it imports, can import a file that is not code, as it would in a Vite app. Provino makes a module for it and never reads or transforms the file:

| File | What it imports as |
| --- | --- |
| An image, audio, video, font, `.webmanifest`, `.pdf` or `.txt` file (the list is Vite's `KNOWN_ASSET_TYPES`) | `export default` its URL: `/` and the path from the project root (`/src/logo.svg`), or `/@fs/` and the absolute path for a file outside the root |
| `.css`, `.scss`, `.sass`, `.less`, `.styl`, `.stylus`, `.pcss`, `.postcss`, `.sss` | An empty module whose default export is `''` |
| `*.module.<style extension>` | A default export where every name reads as itself (`styles.foo === 'foo'`); symbols, `then` and `__esModule` read as `undefined` |

`require()` of one from a CommonJS module sees what it would see for any ES module with that default export. A `mock('./logo.svg', () => ({ default: 'x' }))` replaces it as it replaces any module.

- **Queries.** `?raw` imports the file's text (UTF-8) and `?url` its URL, as in Vite; any other query imports as none. They apply to the files in the table only.
- **Dependencies.** A package's asset or stylesheet (`import 'some-lib/dist/style.css'`) is built in too, and so is a `./button.css` a package you `inline` imports. A package Node loads itself keeps Node's behaviour for its own imports, so a `.css` import there fails as it does outside Provino.
- **Your own transform.** A Jest-style `transform` entry that matches the file takes it, and nothing is built in.
- **Limits.** A CSS module has a default export only: a named import reads `undefined`, as in Vitest without CSS processing. A small `.svg` that Vite would inline as a `data:` URL is still its path here, and URLs are not percent-encoded (Vite's dev server writes them as they are).

This is on for a project with no dialect only. A Jest project maps these files with `moduleNameMapper`, and a Vitest project leaves them to Vite.

## Globals

```ts
// provino.config.ts
import { defineConfig } from 'provino/config'

export default defineConfig({ globals: true })
```

With `globals: true`, `describe`, `suite`, `it`, `test`, the hooks, `aroundEach`, `aroundAll`, `onTestFinished`, `onTestFailed`, `expect`, `fn`, `spyOn`, `replaceProperty`, `isMockFunction`, `mocks` and `timers` are globals, so a suite can drop its imports. `mock`, `unmock`, `importActual` and `requireActual` are never globals, because a global `mock` would not be hoisted and the others resolve from the calling module. `mocked`, `resetModules`, `isolateModules` and `isolateModulesAsync` are. `lazy` never is.

For TypeScript, add the globals' types, in `tsconfig.json` or with `import 'provino/globals/native'` in a `.d.ts` file:

```json
{ "compilerOptions": { "types": ["provino/globals/native"] } }
```

Don't use it with `provino/globals`, which types the Jest dialect's globals: the two disagree about `test` and `it`.

## Watch mode

`provino run --watch` (or `provino --watch`) runs every file, then reruns the files a change reaches. A change to the root `package.json`, a lockfile, a `tsconfig`, a setup file or the config file reruns every file; `--watchAll` reruns every file on any change. A change to the config file loads it again and says so on stderr. If it no longer loads, the error is shown and the last good config keeps running.

On a terminal, keys control the session:

| Key | What it does |
| --- | --- |
| `a` | Run every file |
| `f` | Run the files that failed in the last run |
| Enter | Run again |
| `q`, Ctrl+C or Ctrl+D | Quit |
| Ctrl+Z | Suspend, with the terminal put back |

Off a terminal (CI, a pipe, an agent) it reruns on change and reads no keys. The command ends with the exit code of the last run that finished. `--coverage`, `--shard`, `--detectOpenHandles`, `--timings`, `--update-timings` and `--forceExit` with watch are a usage error that names them. A config with `coverage.enabled` runs without coverage under watch and says so once. File arguments keep every rerun inside the patterns.

## Not there yet

| What | Today | Status |
| --- | --- | --- |
| Snapshot files with no test file | Not reported as obsolete, and `-u` leaves them: only the entries inside a file that ran are checked | Not planned |
| `snapshotResolver`, `toMatchFileSnapshot` | Not there: snapshots sit in `__snapshots__` beside the test | Not planned |
| Coverage `--merge-reports`, and the AST converter for V8 coverage | A run converts V8's data with `v8-to-istanbul`; reports from earlier runs are not merged | Planned |
| `plugins`, `alsoServe` | A non-empty list is refused by name | Planned |
| `environment: 'happy-dom'` | Not available: a native project's environments are `node` and `jsdom`, and any other name is refused (`unknown environment "happy-dom"; the known environments are "node", "jsdom"`) | Planned |
| `isolation: 'realm'` | Not available yet: asking for it fails the file with "the realm tier is not implemented yet". A `jsdom` project runs on the `registry` tier like any other | Planned |

## Coming from node:test

```ts
// before
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// after
import assert from 'node:assert/strict'
import { describe, it } from 'provino'
```

- `node:assert/strict` still works inside a test, and a failed assertion is reported with its own message. Provino's `expect` is there beside it.
- `before` and `after` are `beforeAll` and `afterAll`. There are no aliases.
- `t.after(fn)` is `onTestFinished(fn)`. Provino runs the callbacks last registered first, where node:test runs a test's `t.after` callbacks in the order they were registered.
- `{ skip: 'why' }` is `it.skip`, or `it.skipIf(condition)`. Neither keeps the reason text. `ctx.skip()` skips from inside the test.
- `t.diagnostic` has no equivalent.
- `t.mock` is `fn` and `spyOn`, which Provino restores between tests.
- `{ concurrency }` is `describe.concurrent` or `it.concurrent`. Provino runs at most five concurrent tests at a time, and there is no config key for the number. node:test runs the children of a concurrent suite without a cap.

## When something goes wrong

The errors a native project meets (`PROVINO_NO_WORKER_API`, a config error, the exit codes) and how a syntax error reads are in [Troubleshooting](troubleshooting.md#native-projects).
