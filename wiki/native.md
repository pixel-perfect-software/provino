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

<!-- capture: a real run of this project, the final lines of a pipe with the provino reporter named -->
```console
$ pnpm exec provino
✅ src/native.test.ts · 3 tests · 28ms

🎉 3 tests passed in 1 file · 166ms
🐢 slowest: src/native.test.ts 28ms
```

`provino` with no command finds the config and runs it. `provino run` does the same and takes the flags below. [Output](output.md) says what a run prints, on a terminal and elsewhere.

## Finding the config

`provino` and `provino run` look for a config from the working directory up, and stop at the first directory that holds one. They also stop after a directory that has a `.git` or a `pnpm-workspace.yaml`, so a config above a repository or a workspace is never used.

- A `provino.config.ts` (or `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`) wins over a Jest config in the same directory.
- The nearest config of any kind wins, so a Jest config in a sub-directory beats a `provino.config.*` above it. Bare `provino` then runs that directory as a Jest project. `provino run` takes a `provino.config.*` only: it exits 2 and says "nearest config is a Jest config in <directory>".
- Nothing found is exit 2: "found no provino.config.*, Jest config or Vitest config in <directory> or a parent directory".
- `--config <file>` (`-c`) names the file and skips the search.

`provino run` takes no file argument. Narrow a run with `include`, a project of its own, or `-t <pattern>`, which runs the tests whose full name matches.

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
| `projects` | See [Projects](#projects). Top level only |
| `pool` | `forks` (default), `threads` or `inline`: the pool when the command line names none. Top level only |
| `maxWorkers` | The most workers when the command line names no number (default: the cores, less one). Top level only |

Reporters are not config keys: name them on the command line (`--reporter`). A key the config does not know is a usage error that names the nearest one: `unknown config key "incude"; did you mean "include"?` (exit 2). A non-empty `plugins` or `alsoServe` is refused by name too.

Naming a dialect (`dialect: 'jest'`) makes the project a Jest project, which needs [`@provino/dialect-jest`](compatibility.md) installed.

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
- Each project has its own `include`, `setupFiles`, `environment`, `isolation`, `timeouts` and `resolve`. The top level's keys are **not** inherited. A project has no `projects`, `pool` or `maxWorkers`.
- Names must be unique, and two projects can't share a `root`. A glob that matches nothing is an error.
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
- The test body takes a context: `ctx.skip()` skips from inside the test, and `ctx.signal` is aborted on a timeout, a bail or an interrupt.
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
- `expect.extend` adds matchers, in a test file or in a setup file.
- An assertion on a promise (`.resolves`, `.rejects`, `expect.poll`) must be awaited. One that is not fails the test and says so.
- There are no snapshot matchers (see [what is not there yet](#not-there-yet)).

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

`mock(specifier, factory?)`, `unmock(specifier)` and `importActual(specifier)` replace a module for one test file. A `mock` or `unmock` at the top level of the file is **hoisted** above the file's imports, which then load after it, so it can sit below them:

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
- `importActual` gives the real module past any mock of it. Its own imports are still mocked.
- Each file has mocks of its own, and none reaches the next file.
- A factory runs while the file's imports load, so it can read an import written above the `mock` call, but not one below it or a top-level binding of the file. That fails the file: ``mock('../src/a.ts'): the factory read the import `b` before it was initialized``.
- A `mock` or `unmock` inside a function or block fails the file: `mock() must be called at the top level of the file`. `mock('…', notAFunction)` and a specifier that is not a string are errors too (`API_MOCK_FACTORY`, `API_MOCK_SPECIFIER`).
- A mock in a helper module applies to every file that imports it, under the default `registry` isolation. Under `isolation: 'none'` the helper loads once per worker, so a `mock` made from it is refused (`API_MOCK_SHARED_MODULE`).

### Lazy variables

`lazy` comes from `provino` too: values built on first read, kept for one test, overridden in a nested `describe`. See [Lazy variables](lazy-variables.md).

## Globals

```ts
// provino.config.ts
import { defineConfig } from 'provino/config'

export default defineConfig({ globals: true })
```

With `globals: true`, `describe`, `suite`, `it`, `test`, the hooks, `aroundEach`, `aroundAll`, `onTestFinished`, `onTestFailed`, `expect`, `fn`, `spyOn`, `replaceProperty`, `isMockFunction`, `mocks` and `timers` are globals, so a suite can drop its imports. `mock`, `unmock` and `importActual` are never globals, because a global `mock` would not be hoisted. `lazy` never is either.

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

Off a terminal (CI, a pipe, an agent) it reruns on change and reads no keys. The command ends with the exit code of the last run that finished. `--coverage`, `--shard`, `--detectOpenHandles`, `--timings`, `--update-timings` and `--forceExit` with watch are a usage error that names them.

## Not there yet

| What | Today | Status |
| --- | --- | --- |
| Snapshots | `toMatchSnapshot` and the other snapshot matchers don't exist: the types list them, but a call fails the test with `… is not a function` | Not yet planned |
| Coverage under `provino run` | `--coverage` is refused (`--coverage is not supported by provino run yet`), and `coverage` is not a config key | Planned |
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
