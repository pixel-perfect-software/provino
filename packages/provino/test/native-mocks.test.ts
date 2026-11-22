// Native module mocks end to end (B27j, D202): `mock`, `unmock` and `importActual` imported from
// `provino` in a project with no dialect, through `provino run` on the source bin and the built one,
// in forks, threads and inline. Every `mock` call sits below the imports it replaces: the hoister
// (`nativeHoistPolicy`) moves it above them. Two files share one worker (`--maxWorkers 1`), each
// with its own mocks, so a mock that leaked from one file into the next fails the other.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  NATIVE_CONFIG,
  nativeProject,
  nativeRunArgs,
  runBuilt,
  spawnCli,
  viewOfNormalized,
} from './support.ts'

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
  'src/a.ts': "export const a = 'a'\n",
  'src/b.ts': "export const b = 'b'\n",
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
      const dir = await nativeProject({ ...SOURCES, ...TESTS })
      const run = await spawnCli(nativeRunArgs(pool), { cwd: dir })
      await assertMocksRun(dir, run.code, `${run.stdout}\n${run.stderr}`)
    })
  }
})

describe('native module mocks through provino run (built bin)', () => {
  for (const pool of POOLS) {
    test(`--pool ${pool}`, async () => {
      const dir = await nativeProject({ ...SOURCES, ...TESTS })
      const run = runBuilt(nativeRunArgs(pool), { cwd: dir })
      await assertMocksRun(dir, run.status, `${run.stdout}\n${run.stderr}`)
    })
  }
})

/** Each file's error (or `passed`), by file name, from a run's normalized JSON. */
async function outcomes(dir: string): Promise<ReadonlyMap<string, string>> {
  const view = viewOfNormalized(await readFile(join(dir, 'results.json'), 'utf8'))
  const found = new Map<string, string>()
  for (const [path, file] of view.files) {
    const name = path.split('/').at(-1) ?? path
    const statuses = [...file.tests.values()].map(String)
    found.set(name, file.fileError ?? statuses.join(','))
  }
  return found
}

/** Test files whose factories read bindings the hoist has moved below them, and a misplaced mock. */
const PLACEMENT: Readonly<Record<string, string>> = {
  'tests/nested.test.ts': `import { expect, it, mock } from 'provino'

it('mocks too late', () => {
  mock('../src/dep.ts')
  expect(1).toBe(1)
})
`,
  // \`b\` has loaded by the time \`a\` (the mocked module) is first imported.
  'tests/earlier-import.test.ts': `import { b } from '../src/b.ts'
import { a } from '../src/a.ts'
import { expect, it, mock } from 'provino'

it('reads an earlier import', () => {
  expect(a).toBe('b')
})

mock('../src/a.ts', () => ({ a: b }))
`,
  // \`a\` loads first, so its factory runs before \`b\`'s import has.
  'tests/later-import.test.ts': `import { a } from '../src/a.ts'
import { b } from '../src/b.ts'
import { expect, it, mock } from 'provino'

it('never runs', () => {
  expect(a).toBe(b)
})

mock('../src/a.ts', () => ({ a: b }))
`,
  'tests/top-level.test.ts': `import { a } from '../src/a.ts'
import { expect, it, mock } from 'provino'

const mine = 'mine'

it('never runs', () => {
  expect(a).toBe(mine)
})

mock('../src/a.ts', () => ({ a: mine }))
`,
}

describe('factories and placement', () => {
  test('a factory may read an earlier import; a later import, a top-level binding or a nested mock fail their file by name', async () => {
    const dir = await nativeProject({ ...SOURCES, ...PLACEMENT })
    const run = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
    const found = await outcomes(dir)
    assert.equal(found.get('earlier-import.test.ts'), 'passed')
    assert.match(
      found.get('nested.test.ts') ?? '',
      /mock\(\) must be called at the top level of the file/,
    )
    assert.match(
      found.get('later-import.test.ts') ?? '',
      /mock\('\.\.\/src\/a\.ts'\): the factory read the import `b` before it was initialized/,
    )
    assert.match(
      found.get('top-level.test.ts') ?? '',
      /mock\('\.\.\/src\/a\.ts'\): the factory read `mine` before it was initialized/,
    )
  })
})

/** Two test files that take their mock from a helper module's top level. */
const SHARED_HELPER: Readonly<Record<string, string>> = {
  'tests/setup-mock.ts': `import { mock } from 'provino'

mock('../src/dep.ts', () => ({ value: () => 'helped' }))
`,
  'tests/first.test.ts': `import './setup-mock.ts'
import { value } from '../src/dep.ts'
import { expect, it } from 'provino'

it('first', () => {
  expect(value()).toBe('helped')
})
`,
  'tests/second.test.ts': `import './setup-mock.ts'
import { value } from '../src/dep.ts'
import { expect, it } from 'provino'

it('second', () => {
  expect(value()).toBe('helped')
})
`,
}

describe('a mock in a helper module', () => {
  test("applies to every file under isolation 'registry' (the native default)", async () => {
    const dir = await nativeProject({ ...SOURCES, ...SHARED_HELPER })
    const run = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`)
    const found = await outcomes(dir)
    assert.deepEqual(
      [found.get('first.test.ts'), found.get('second.test.ts')],
      ['passed', 'passed'],
    )
  })

  test("is refused under isolation 'none', where the helper loads once per worker", async () => {
    const config = NATIVE_CONFIG.replace('] }', "], isolation: 'none' }")
    const dir = await nativeProject({ ...SOURCES, ...SHARED_HELPER }, config)
    const run = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
    const found = await outcomes(dir)
    // The first file to load the helper fails on the refusal; the next gets no mock, and fails.
    const texts = [found.get('first.test.ts') ?? '', found.get('second.test.ts') ?? '']
    assert.ok(
      texts.some((text) => /isolation 'none' loads once per worker/.test(text)),
      texts.join('\n'),
    )
    assert.ok(!texts.includes('passed'), texts.join('\n'))
  })
})
