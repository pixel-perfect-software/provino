// The native test API end to end (B27b, D185, acceptance rows 1 and 2): a project with no dialect
// and no globals, whose TypeScript test files `import { … } from 'provino'`, runs through
// `provino run` over the source bin and the built one, in forks, threads and inline. The served
// module gives every module of a file the worker's own objects (`expect === expect`), and the
// matchers are Provino's own table (`@provino/expect/table`, B27c; `NATIVE_RUNTIME` in
// `internal/built-ins.ts`).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, onTestFinished, test } from 'provino'
import { run } from 'provino/node'
import {
  Collect,
  childEnv,
  nativeProject,
  nativeRunArgs,
  QUIET_ENV,
  runBuilt,
  spawnCli,
  viewOfNormalized,
} from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** A helper module of the test file: it gets the same served namespace. */
const HELPER = `import { expect, fn } from 'provino'

export const helperExpect = expect
export const helperFn = fn
`

const NATIVE = `import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  fn,
  it,
  lazy,
  spyOn,
  test,
  timers,
} from 'provino'
import { helperExpect, helperFn } from './helper.ts'

const order: string[] = []
beforeAll(() => void order.push('beforeAll'))
beforeEach(() => void order.push('beforeEach'))
afterEach(() => void order.push('afterEach'))
afterAll(() => {
  // beforeAll once, then each hook around each of the six tests that run.
  const expected = ['beforeAll', ...Array(6).fill(['beforeEach', 'afterEach']).flat()]
  if (order.join(',') !== expected.join(',')) {
    throw new Error(\`hook order: \${order.join(',')}\`)
  }
})

const $ = lazy.let('name', () => 'outer').let('greeting', ({ name }) => \`hi \${name}\`)

describe('the native API', () => {
  it('passes, with no globals and one expect for every module', () => {
    expect(typeof (globalThis as { describe?: unknown }).describe).toBe('undefined')
    expect(typeof (globalThis as { expect?: unknown }).expect).toBe('undefined')
    expect(helperExpect).toBe(expect)
    expect(helperFn).toBe(fn)
    expect(order.join(',')).toBe('beforeAll,beforeEach')
  })

  it('fails with the matcher table\\'s message', () => {
    expect(1).toBe(2)
  })

  it.skip('is skipped', () => {})
  test.todo('is todo')

  describe('a lazy override', () => {
    $.override('name', () => 'inner')
    it('reads the overridden value', () => {
      expect($.greeting).toBe('hi inner')
    })
  })
})

const withDb = test.extend({ db: 'fixture-db' })
withDb('reads a test.extend fixture', ({ db }) => {
  expect(db).toBe('fixture-db')
})

describe('mocks and timers', () => {
  it('records a mock\\'s calls and a spy\\'s', () => {
    const add = fn((a: number, b: number) => a + b)
    expect(add(1, 2)).toBe(3)
    expect(add.mock.calls).toEqual([[1, 2]])
    const target = { greet: (name: string) => \`hi \${name}\` }
    const spy = spyOn(target, 'greet')
    target.greet('ada')
    expect(spy.mock.calls).toEqual([['ada']])
  })

  it('drives fake timers', () => {
    timers.useFakeTimers()
    let fired = 0
    setTimeout(() => void fired++, 1000)
    timers.advanceTimersByTime(999)
    expect(fired).toBe(0)
    timers.advanceTimersByTime(1)
    expect(fired).toBe(1)
    timers.useRealTimers()
  })
})
`

/** What each test of \`NATIVE\` ends as. */
const EXPECTED: ReadonlyMap<string, string> = new Map([
  ['the native API > passes, with no globals and one expect for every module', 'passed'],
  ["the native API > fails with the matcher table's message", 'failed'],
  ['the native API > is skipped', 'skipped'],
  ['the native API > is todo', 'todo'],
  ['the native API > a lazy override > reads the overridden value', 'passed'],
  ['reads a test.extend fixture', 'passed'],
  ["mocks and timers > records a mock's calls and a spy's", 'passed'],
  ['mocks and timers > drives fake timers', 'passed'],
])

async function project(): Promise<{ readonly dir: string }> {
  return {
    dir: await nativeProject({ 'tests/native.test.ts': NATIVE, 'tests/helper.ts': HELPER }),
  }
}

async function assertNativeRun(dir: string, status: number | null, output: string): Promise<void> {
  // One test fails on purpose.
  assert.equal(status, 1, output)
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(join(dir, 'results.json'), 'utf8')
  const view = viewOfNormalized(text)
  assert.equal(view.success, false)
  assert.equal(view.runner, 'provino:neutral')
  const [file] = [...view.files.values()]
  assert.ok(file !== undefined, text)
  assert.equal(file.fileError, undefined, file.fileError)
  assert.deepEqual(new Map(file.tests), EXPECTED)
  // Provino's own table (`@provino/expect/table`): its error and its words.
  const results = JSON.parse(text) as {
    readonly files: readonly {
      readonly tests: readonly {
        readonly id: { readonly path: readonly string[] }
        readonly errors: readonly { readonly name: string; readonly message: string }[]
      }[]
    }[]
  }
  const failed = results.files[0]?.tests.find(
    (entry) => entry.id.path.at(-1) === "fails with the matcher table's message",
  )
  assert.deepEqual(
    failed?.errors.map(({ name, message }) => ({ name, message })),
    [
      {
        name: 'AssertionError',
        message: 'expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1',
      },
    ],
    text,
  )
  assert.doesNotMatch(text, /hook order:/)
}

const POOLS = ['forks', 'threads', 'inline'] as const

describe('the native API through provino run (source bin)', () => {
  for (const pool of POOLS) {
    test(`--pool ${pool}`, async () => {
      const { dir } = await project()
      const run = await spawnCli(nativeRunArgs(pool), { cwd: dir })
      await assertNativeRun(dir, run.code, `${run.stdout}\n${run.stderr}`)
    })
  }
})

describe('the native API through provino run (built bin)', () => {
  for (const pool of POOLS) {
    test(`--pool ${pool}`, async () => {
      const { dir } = await project()
      const run = runBuilt(nativeRunArgs(pool), { cwd: dir })
      await assertNativeRun(dir, run.status, `${run.stdout}\n${run.stderr}`)
    })
  }
})

describe('the built entry outside a worker', () => {
  test('every native export throws PROVINO_NO_WORKER_API', async () => {
    const script = `const api = await import(${JSON.stringify(pathToFileURL(join(PACKAGE, 'dist', 'index.js')).href)})
const names = ['describe', 'it', 'test', 'expect', 'fn', 'spyOn', 'timers', 'mocks', 'onTestFinished']
const codes = names.map((name) => {
  try {
    Reflect.get(api[name], 'x')
    return 'none'
  } catch (error) {
    return error.code
  }
})
process.stdout.write(JSON.stringify(codes))`
    // A file, not `node -e`: under `-e` Node's built-in modules are globals, `timers` among them.
    const dir = await mkdtemp(join(tmpdir(), 'provino-native-outside-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'outside.mjs'), script)
    const run = spawnSync(process.execPath, [join(dir, 'outside.mjs')], {
      encoding: 'utf8',
      env: childEnv(),
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), Array(9).fill('PROVINO_NO_WORKER_API'))
  })
})

describe('the native API slot in one process (inline pool)', () => {
  test('a native run takes its slot out at stop, so a later Jest run reaches the Jest globals', async () => {
    const native = await project()
    // What the process held before the run (under a Provino worker, that worker's own API; under
    // node:test, nothing): the run's stop takes its own out and leaves exactly that.
    const found = Reflect.getOwnPropertyDescriptor(globalThis, Symbol.for('provino.api'))
    const first = await run({
      config: 'provino.config.mjs',
      cwd: native.dir,
      pool: 'inline',
      stdout: new Collect(),
      stderr: new Collect(),
      env: QUIET_ENV,
      reporters: [['normalized-json', { outputFile: 'results.json' }]],
    })
    await assertNativeRun(native.dir, first.exitCode, 'the inline native run')
    // Booleans: a failed assertion on the API object itself would print the whole runtime.
    const left = Reflect.getOwnPropertyDescriptor(globalThis, Symbol.for('provino.api'))
    assert.equal(left === undefined, found === undefined, 'the slot is not as the run found it')
    assert.equal(left?.value === found?.value, true, 'the run left its own API in the slot')

    const jest = await project()
    writeFileSync(
      join(jest.dir, 'jest.config.mjs'),
      "export default { dialect: 'jest', include: ['tests/**/*.test.ts'] }\n",
    )
    writeFileSync(
      join(jest.dir, 'tests', 'native.test.ts'),
      `import { describe, expect, it } from 'provino'

describe('the Jest dialect', () => {
  it('reaches its own globals through the provino entry', () => {
    expect(describe).not.toBe(undefined)
    expect(1).toBe(1)
  })
})
`,
    )
    const second = await run({
      config: 'jest.config.mjs',
      cwd: jest.dir,
      pool: 'inline',
      stdout: new Collect(),
      stderr: new Collect(),
      env: QUIET_ENV,
      reporters: [['normalized-json', { outputFile: 'results.json' }]],
    })
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(join(jest.dir, 'results.json'), 'utf8')
    assert.equal(second.exitCode, 0, text)
    const [file] = [...viewOfNormalized(text).files.values()]
    assert.deepEqual([...(file?.tests.values() ?? [])], ['passed'], text)
  })
})
