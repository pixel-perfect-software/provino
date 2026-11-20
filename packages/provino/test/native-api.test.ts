// The native test API end to end (B27b, D185, acceptance rows 1 and 2): a project with no dialect
// and no globals, whose TypeScript test files `import { … } from 'provino'`, runs through
// `provino run` over the source bin and the built one, in forks, threads and inline. The served
// module gives every module of a file the worker's own objects (`expect === expect`). Until B27c's
// table is wired (B27e), the matcher table is a fixture the run names by ref
// (`PROVINO_NATIVE_MATCHER_TABLE`, `internal/built-ins.ts`).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { run } from 'provino/node'
import { BUILT_BIN, Collect, childEnv, QUIET_ENV, spawnCli, viewOfNormalized } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** A small matcher table: `toBe` and `toEqual`, with messages a test can find. */
const TABLE = `const describeCall = ({ matcherName, isNot, promise }) =>
  \`\${promise}\${isNot ? '.not' : ''}.\${matcherName}\`

export function table() {
  return {
    matchers: {
      toBe(received, expected) {
        return {
          pass: Object.is(received, expected),
          message: () => \`native-fixture toBe: \${String(received)} vs \${String(expected)}\`,
        }
      },
      toEqual(received, expected) {
        return {
          pass: this.equals(received, expected),
          message: () => 'native-fixture toEqual',
        }
      },
    },
    promiseMatchers: {},
    asymmetric: {},
    asymmetricNot: {},
    utils: {},
    messages: {
      tooManyArguments: () => 'too many arguments',
      noMessage: () => 'no message',
      invalidResult: (result) => \`invalid result: \${typeof result}\`,
      notAPromise: (call) => \`not a promise: \${describeCall(call)}\`,
      rejectedInsteadOfResolved: (call) => \`rejected instead of resolved: \${describeCall(call)}\`,
      resolvedInsteadOfRejected: (call) => \`resolved instead of rejected: \${describeCall(call)}\`,
      invalidMatcher: (name) => \`invalid matcher: \${name}\`,
      invalidTesters: () => 'invalid testers',
      ensureNoExpected: (expected, name) => {
        if (expected !== undefined) throw new Error(\`\${name} takes no argument\`)
      },
      assertionCount: (expected, actual) => \`expected \${expected} assertions, made \${actual}\`,
      noAssertions: () => 'expected an assertion, made none',
      requiredAssertions: () => 'every test must make an assertion',
      unawaited: ({ call }) => \`\${describeCall(call)} was not awaited\`,
      pollTimeout: (stage) => \`poll \${stage} timed out\`,
      pollUnsupported: (name) => \`poll cannot use \${name}\`,
      outsideTest: (name) => \`\${name} needs a running test\`,
      unreachable: (message) => \`unreachable\${message === undefined ? '' : \`: \${message}\`}\`,
    },
    assertionError: (_result, message) => Object.assign(new Error(message), { name: 'AssertionError' }),
    customAsymmetric: () => () => {
      throw new Error('the fixture table has no custom asymmetric matchers')
    },
  }
}
`

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

async function project(): Promise<{ readonly dir: string; readonly env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-native-'))
  after(() => rm(dir, { recursive: true, force: true }))
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    // No dialect and no globals: the native runtime.
    'provino.config.mjs': "export default { include: ['tests/**/*.test.ts'] }\n",
    'table.mjs': TABLE,
    'tests/native.test.ts': NATIVE,
    'tests/helper.ts': HELPER,
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(PACKAGE, join(dir, 'node_modules', 'provino'), 'dir')
  return {
    dir,
    env: { PROVINO_NATIVE_MATCHER_TABLE: `${pathToFileURL(join(dir, 'table.mjs')).href}#table` },
  }
}

function runArgs(pool: string): string[] {
  return [
    'run',
    '--config',
    'provino.config.mjs',
    '--pool',
    pool,
    '--maxWorkers',
    '1',
    '--reporter',
    'normalized-json',
    '--outputFile',
    'results.json',
  ]
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
  assert.match(text, /native-fixture toBe: 1 vs 2/)
  assert.doesNotMatch(text, /hook order:/)
}

const POOLS = ['forks', 'threads', 'inline'] as const

describe('the native API through provino run (source bin)', () => {
  for (const pool of POOLS) {
    test(`--pool ${pool}`, async () => {
      const { dir, env } = await project()
      const run = await spawnCli(runArgs(pool), { cwd: dir, env })
      await assertNativeRun(dir, run.code, `${run.stdout}\n${run.stderr}`)
    })
  }
})

describe('the native API through provino run (built bin)', () => {
  for (const pool of POOLS) {
    test(`--pool ${pool}`, async () => {
      const { dir, env } = await project()
      const run = spawnSync(process.execPath, [BUILT_BIN, ...runArgs(pool)], {
        cwd: dir,
        encoding: 'utf8',
        env: childEnv([], env),
        timeout: 120_000,
      })
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
    after(() => rm(dir, { recursive: true, force: true }))
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
    const first = await run({
      config: 'provino.config.mjs',
      cwd: native.dir,
      pool: 'inline',
      stdout: new Collect(),
      stderr: new Collect(),
      env: { ...QUIET_ENV, ...native.env },
      reporters: [['normalized-json', { outputFile: 'results.json' }]],
    })
    await assertNativeRun(native.dir, first.exitCode, 'the inline native run')
    // A boolean: a failed assertion on the API object itself would print the whole runtime.
    assert.equal(
      Object.hasOwn(globalThis, Symbol.for('provino.api')),
      false,
      'the slot is still installed',
    )

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
