// Native module mocks end to end (B27j, D202): `mock`, `unmock` and `importActual` imported from
// `provino` in a project with no dialect, through `provino run` on the source bin and the built one,
// in forks, threads and inline. Every `mock` call sits below the imports it replaces: the hoister
// (`nativeHoistPolicy`) moves it above them. Two files share one worker (`--maxWorkers 1`), each
// with its own mocks, so a mock that leaked from one file into the next fails the other.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BUILT_BIN, childEnv, spawnCli, viewOfNormalized } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

const MOCKING = `import { describe, expect, importActual, isMockFunction, it } from 'provino'
import def, { Greeter, value } from '../src/dep.ts'
import { viaHelper } from '../src/uses-dep.ts'
import { consume } from '../src/consumer.ts'
import { a, b } from '../src/actual.ts'
import { compute, config, Store } from '../src/auto.ts'
import { kept } from '../src/unmocked.ts'
import { fn, mock as replace, unmock } from 'provino'

describe('native module mocks', () => {
  it('a factory replaces the module: its named exports and its default', () => {
    expect(value()).toBe('mocked')
    expect(isMockFunction(value)).toBe(true)
    expect(def).toBe('mocked-default')
    expect(new Greeter().greet()).toBe('mock hello')
  })

  it('a module the test file imports sees the mock', () => {
    expect(viaHelper()).toBe('mocked')
  })

  it('an async factory mocks a module the test file never imports', () => {
    expect(consume()).toBe('consumed mocked-indirect')
  })

  it('importActual inside a factory reaches the real module', () => {
    expect(a).toBe(1)
    expect(b).toBe(20)
  })

  it('importActual from a test reaches the real module past the mock', async () => {
    const real = await importActual<typeof import('../src/dep.ts')>('../src/dep.ts')
    expect(real.value()).toBe('real')
    expect(real.default).toBe('real-default')
  })

  it('no factory is an automock of the real module', () => {
    expect(isMockFunction(compute)).toBe(true)
    expect(compute()).toBe(undefined)
    expect(new Store().get()).toBe(undefined)
    expect(config.level).toBe(1)
  })

  it('unmock takes a mock away again', () => {
    expect(kept).toBe('real')
  })
})

// Below everything on purpose: hoisted above the imports. \`replace\` is \`mock\` under another name.
replace('../src/dep.ts', () => ({
  value: fn(() => 'mocked'),
  default: 'mocked-default',
  Greeter: class {
    greet() {
      return 'mock hello'
    }
  },
}))
replace('../src/indirect.ts', async () => ({ indirect: () => 'mocked-indirect' }))
replace('../src/actual.ts', async (importOriginal) => ({ ...(await importOriginal()), b: 20 }))
replace('../src/auto.ts')
replace('../src/unmocked.ts', () => ({ kept: 'mocked' }))
unmock('../src/unmocked.ts')
`

const OTHER = `import { describe, expect, isMockFunction, it, mock } from 'provino'
import { value } from '../src/dep.ts'
import { compute } from '../src/auto.ts'

describe('another file in the same worker', () => {
  it('sees none of the first file\\'s mocks, only its own', () => {
    expect(value()).toBe('real')
    expect(isMockFunction(value)).toBe(false)
    expect(compute()).toBe('mine')
  })
})

mock('../src/auto.ts', () => ({ compute: () => 'mine' }))
`

const SOURCES: Readonly<Record<string, string>> = {
  'src/dep.ts': `export const value = (): string => 'real'
export default 'real-default'
export class Greeter {
  greet(): string {
    return 'hello'
  }
}
`,
  'src/uses-dep.ts': `import { value } from './dep.ts'

export const viaHelper = (): string => value()
`,
  'src/indirect.ts': "export const indirect = (): string => 'real-indirect'\n",
  'src/consumer.ts': `import { indirect } from './indirect.ts'

export const consume = (): string => \`consumed \${indirect()}\`
`,
  'src/actual.ts': 'export const a = 1\nexport const b = 2\n',
  'src/auto.ts': `export function compute(): number | string {
  return 42
}
export class Store {
  get(): string | undefined {
    return 'real'
  }
}
export const config = { level: 1 }
`,
  'src/unmocked.ts': "export const kept = 'real'\n",
}

/** What each test ends as. */
const EXPECTED: ReadonlyMap<string, string> = new Map([
  [
    'native module mocks > a factory replaces the module: its named exports and its default',
    'passed',
  ],
  ['native module mocks > a module the test file imports sees the mock', 'passed'],
  ['native module mocks > an async factory mocks a module the test file never imports', 'passed'],
  ['native module mocks > importActual inside a factory reaches the real module', 'passed'],
  [
    'native module mocks > importActual from a test reaches the real module past the mock',
    'passed',
  ],
  ['native module mocks > no factory is an automock of the real module', 'passed'],
  ['native module mocks > unmock takes a mock away again', 'passed'],
  ["another file in the same worker > sees none of the first file's mocks, only its own", 'passed'],
])

async function project(tests: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-native-mocks-'))
  after(() => rm(dir, { recursive: true, force: true }))
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    'provino.config.mjs': "export default { include: ['tests/**/*.test.ts'] }\n",
    ...SOURCES,
    ...tests,
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(PACKAGE, join(dir, 'node_modules', 'provino'), 'dir')
  return dir
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

async function assertMocksRun(dir: string, status: number | null, output: string): Promise<void> {
  const text = await readFile(join(dir, 'results.json'), 'utf8').catch(() => output)
  assert.equal(status, 0, `${output}\n${text}`)
  const view = viewOfNormalized(text)
  const tests = new Map<string, string>()
  for (const file of view.files.values()) {
    assert.equal(file.fileError, undefined, file.fileError)
    for (const [name, outcome] of file.tests) tests.set(name, String(outcome))
  }
  assert.deepEqual(tests, EXPECTED, text)
}

const POOLS = ['forks', 'threads', 'inline'] as const
const TESTS = { 'tests/mocking.test.ts': MOCKING, 'tests/other.test.ts': OTHER }

describe('native module mocks through provino run (source bin)', () => {
  for (const pool of POOLS) {
    test(`--pool ${pool}`, async () => {
      const dir = await project(TESTS)
      const run = await spawnCli(runArgs(pool), { cwd: dir })
      await assertMocksRun(dir, run.code, `${run.stdout}\n${run.stderr}`)
    })
  }
})

describe('native module mocks through provino run (built bin)', () => {
  for (const pool of POOLS) {
    test(`--pool ${pool}`, async () => {
      const dir = await project(TESTS)
      const run = spawnSync(process.execPath, [BUILT_BIN, ...runArgs(pool)], {
        cwd: dir,
        encoding: 'utf8',
        env: childEnv(),
        timeout: 120_000,
      })
      await assertMocksRun(dir, run.status, `${run.stdout}\n${run.stderr}`)
    })
  }
})

describe('misplaced mocks', () => {
  test("a mock inside a test fails its file with the hoister's message", async () => {
    const dir = await project({
      'tests/nested.test.ts': `import { expect, it, mock } from 'provino'

it('mocks too late', () => {
  mock('../src/dep.ts')
  expect(1).toBe(1)
})
`,
    })
    const run = await spawnCli(runArgs('forks'), { cwd: dir })
    assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
    const [file] = [
      ...viewOfNormalized(await readFile(join(dir, 'results.json'), 'utf8')).files.values(),
    ]
    assert.match(file?.fileError ?? '', /mock\(\) must be called at the top level of the file/)
  })
})
