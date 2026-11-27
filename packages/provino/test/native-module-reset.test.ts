// Native module reset end to end (B28, D210): `resetModules`, `isolateModules` and
// `isolateModulesAsync` imported from `provino` in a project with no dialect, through `provino run`
// on the source bin and the built one. A `mock` at the top of an isolation's callback is hoisted to
// the top of that callback (`HoistPolicy.callbackScopes`), not of the file, so it registers inside
// the isolation. On the sync path (a `require`) a mock settles at once when it can (the neutral
// `ModulePolicy.syncMocks: 'settle'`); the async form loads the mock through `await import`. The subject project uses the new API; this file itself never imports it (it runs
// on the pinned runner).
import assert from 'node:assert/strict'
import { describe, test } from 'provino'
import {
  NATIVE_CONFIG,
  nativeProject,
  nativeRunArgs,
  outcomesByFile,
  POOLS,
  runBuilt,
  spawnCli,
} from './support.ts'

const SOURCES: Readonly<Record<string, string>> = {
  // A module-level memo: each instance counts from 1.
  'src/counter.ts': 'let n = 0\nexport const count = (): number => ++n\n',
  'src/dep.ts': "export const value = (): string => 'real'\n",
  'src/other.ts': "export const other = (): string => 'real'\n",
  'src/uses-dep.ts':
    "import { value } from './dep.ts'\n\nexport const viaDep = (): string => value()\n",
  'src/auto.ts': 'export const compute = (): number => 42\n',
  'src/later.ts': "export const later = (): string => 'real'\n",
  'src/tla.ts': 'await Promise.resolve()\nexport const late = 1\n',
}

const RESET = `import {
  expect,
  isMockFunction,
  isolateModules,
  isolateModulesAsync,
  it,
  mock,
  resetModules,
} from 'provino'
import { count } from '../src/counter.ts'
import { value } from '../src/dep.ts'
import { other } from '../src/other.ts'

it('a module-level memo is fresh after resetModules()', async () => {
  expect(count()).toBe(1)
  expect(count()).toBe(2)
  resetModules()
  const fresh = await import('../src/counter.ts')
  expect(fresh.count()).toBe(1)
  // A binding imported before the reset keeps the instance it had.
  expect(count()).toBe(3)
})

it('isolateModules loads its own instances and returns the callback\\'s value', () => {
  const inside = isolateModules(() => require('../src/counter.ts').count())
  expect(inside).toBe(1)
})

// The sync path settles a mock at once when it can: a factory whose result is no thenable, and an
// automock built from the sync actual load. A factory that returns a Promise, and an automock of a
// graph with top-level await, are refused by name.
it('isolateModules with a factory mock inside: a module required there sees it; the outside keeps the real one', () => {
  const inside = isolateModules(() => {
    mock('../src/dep.ts', () => ({ value: () => 'isolated' }))
    return require('../src/uses-dep.ts')
  })
  expect(inside.viaDep()).toBe('isolated')
  expect(isMockFunction(value)).toBe(false)
  expect(value()).toBe('real')
})

it('isolateModules with an automock inside: the required module is the automock', () => {
  const inside = isolateModules(() => {
    mock('../src/auto.ts')
    return require('../src/auto.ts')
  })
  expect(isMockFunction(inside.compute)).toBe(true)
  expect(inside.compute()).toBe(undefined)
})

it('a factory that returns a Promise is refused on the sync path by name', () => {
  const message = isolateModules(() => {
    mock('../src/later.ts', async () => ({ later: () => 'mocked' }))
    try {
      require('../src/later.ts')
      return 'loaded'
    } catch (error) {
      return error.message
    }
  })
  expect(message).toMatch(/its mock is asynchronous/)
})

it('an automock of a graph with top-level await is refused on the sync path', () => {
  const message = isolateModules(() => {
    mock('../src/tla.ts')
    try {
      require('../src/tla.ts')
      return 'loaded'
    } catch (error) {
      return String(error.code) + ' ' + error.message
    }
  })
  // The real load's refusal, not the mock's: the automock was built from the sync actual path.
  expect(message).toMatch(/ERR_REQUIRE_ASYNC_MODULE/)
  expect(message).not.toMatch(/its mock is asynchronous/)
})

it('isolateModulesAsync does the same with await import', async () => {
  const inside = await isolateModulesAsync(async () => {
    const other = await import('../src/other.ts')
    mock('../src/other.ts', () => ({ other: () => 'isolated' }))
    return other
  })
  expect(inside.other()).toBe('isolated')
  // The binding imported before the isolation is still the real module's.
  expect(other()).toBe('real')
})

it('a nested isolation is refused, sync and async', async () => {
  const codes = []
  isolateModules(() => {
    try {
      isolateModules(() => {})
    } catch (error) {
      codes.push(error.code)
    }
  })
  await isolateModulesAsync(async () => {
    try {
      await isolateModulesAsync(async () => {})
    } catch (error) {
      codes.push(error.code)
    }
    try {
      isolateModules(() => {})
    } catch (error) {
      codes.push(error.code)
    }
  })
  expect(codes).toEqual(['nested-isolation', 'nested-isolation', 'nested-isolation'])
})
`

// What a registration made inside an isolation leaves behind: the module-mock registry keeps it
// (`mockValueOwner: 'registration'`, neutral), so a load after the isolation is mocked too. Jest
// also keeps the registration; Phase 8 documents it.
const AFTER = `import { expect, isMockFunction, isolateModules, it, mock } from 'provino'

it('a mock registered inside an isolation follows the registry after it', async () => {
  isolateModules(() => {
    mock('../src/dep.ts')
  })
  const after = await import('../src/dep.ts')
  expect(isMockFunction(after.value)).toBe(true)
})
`

const FILES = { ...SOURCES, 'tests/reset.test.ts': RESET, 'tests/after.test.ts': AFTER }
const PASSED = {
  'after.test.ts': 'passed',
  'reset.test.ts': 'passed,passed,passed,passed,passed,passed,passed,passed',
}

async function assertRun(dir: string, code: number | null, output: string): Promise<void> {
  // The outcomes first: a failing test's text says more than the exit code.
  assert.deepEqual(Object.fromEntries(await outcomesByFile(dir)), PASSED)
  assert.equal(code, 0, output)
}

describe('native module reset through provino run (source bin)', () => {
  for (const pool of POOLS) {
    test(`--pool ${pool}`, async () => {
      const dir = await nativeProject(FILES)
      const run = await spawnCli(nativeRunArgs(pool), { cwd: dir })
      await assertRun(dir, run.code, `${run.stdout}\n${run.stderr}`)
    })
  }
})

describe('native module reset through provino run (built bin)', () => {
  test('--pool forks', async () => {
    const dir = await nativeProject(FILES)
    const run = runBuilt(nativeRunArgs('forks'), { cwd: dir })
    await assertRun(dir, run.status, `${run.stdout}\n${run.stderr}`)
  })
})

// Under `globals: true` `isolateModules` and `isolateModulesAsync` are globals (no import), and a
// `mock` at the top of their callback is hoisted to the top of it, as with the imported ones.
const GLOBAL_ISOLATION = `import { mock } from 'provino'

it('a mock at the top of the global isolateModules callback is registered inside it', () => {
  const read = isolateModules(() => {
    mock('../src/dep.ts', () => ({ value: () => 'mocked' }))
    return require('../src/uses-dep.ts').viaDep()
  })
  expect(read).toBe('mocked')
})

it('a mock at the top of the global isolateModulesAsync callback is registered inside it', async () => {
  const read = await isolateModulesAsync(async () => {
    mock('../src/dep.ts', () => ({ value: () => 'mocked' }))
    const user = await import('../src/uses-dep.ts')
    return user.viaDep()
  })
  expect(read).toBe('mocked')
})
`

describe('the global isolation calls under globals: true', () => {
  test('a mock at the top of their callback hoists inside it', async () => {
    const config = "export default { include: ['tests/**/*.test.ts'], globals: true }\n"
    const dir = await nativeProject(
      { ...SOURCES, 'tests/global.test.ts': GLOBAL_ISOLATION },
      config,
    )
    const run = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    const output = `${run.stdout}\n${run.stderr}`
    assert.deepEqual(
      Object.fromEntries(await outcomesByFile(dir)),
      { 'global.test.ts': 'passed,passed' },
      output,
    )
    assert.equal(run.code, 0, output)
  })
})

/** Two files sharing one worker under isolation `none`: each counts, then resets. */
const SHARED: Readonly<Record<string, string>> = {
  ...SOURCES,
  'tests/first.test.ts': `import { expect, it, resetModules } from 'provino'
import { count } from '../src/counter.ts'

it('counts from 1, then resets the worker\\'s instances', () => {
  expect(count()).toBe(1)
  resetModules()
})
`,
  'tests/second.test.ts': `import { expect, it, resetModules } from 'provino'
import { count } from '../src/counter.ts'

it('counts from 1, then resets the worker\\'s instances', () => {
  expect(count()).toBe(1)
  resetModules()
})
`,
}

describe("resetModules under isolation 'none'", () => {
  test("resets the worker's shared instances, so the next file in it loads the module afresh", async () => {
    const config = NATIVE_CONFIG.replace('] }', "], isolation: 'none' }")
    const dir = await nativeProject(SHARED, config)
    const run = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    const output = `${run.stdout}\n${run.stderr}`
    assert.equal(run.code, 0, output)
    assert.deepEqual(
      Object.fromEntries(await outcomesByFile(dir)),
      { 'first.test.ts': 'passed', 'second.test.ts': 'passed' },
      output,
    )
  })

  test("without the reset, the second file shares the first one's instance", async () => {
    const config = NATIVE_CONFIG.replace('] }', "], isolation: 'none' }")
    const files = Object.fromEntries(
      Object.entries(SHARED).map(([name, text]) => [name, text.replace('  resetModules()\n', '')]),
    )
    const dir = await nativeProject(files, config)
    const run = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
    const found = [...(await outcomesByFile(dir)).values()].toSorted()
    assert.deepEqual(found, ['failed', 'passed'])
  })
})
