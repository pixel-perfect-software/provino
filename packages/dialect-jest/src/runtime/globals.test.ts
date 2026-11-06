import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'
import { createMockRegistry, type MockRegistry } from '@provino/mock'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { FileRegistry, LeakReport, RuntimeEvent, TaskNode, TestTask } from '@provino/types'
import { jestDialect, jestPolicy } from '../dialect.ts'
import { type JestGlobals, jestGlobals } from './globals.ts'
import { runRegistered, setUpJestExpect } from './internal/test-support.ts'

const jestCore = resolvePolicy(jestPolicy).core
const jestMock = resolvePolicy(jestPolicy).mock

/** The two host members the mock functions read: a registry that can be swapped, and the policy. */
function mockHost(mocks?: () => MockRegistry) {
  const own = createMockRegistry()
  return { mocks: mocks ?? (() => own), mockPolicy: jestMock }
}

/** A registry that records the calls the `jest` object makes, and runs the function it is given. */
function recordingRegistry(label: string, calls: string[]): FileRegistry {
  const unused = (name: string) => (): never => {
    throw new Error(`${label}.${name} is not part of the test`)
  }
  const report: LeakReport = {
    restored: [],
    prototypePatches: [],
    listenersAdded: [],
    activeResources: [],
    inlinedForMocks: [],
  }
  return {
    file: `/${label}.test.ts`,
    tier: 'registry',
    import: unused('import'),
    require: unused('require'),
    requireActual: unused('requireActual'),
    importActual: unused('importActual'),
    registerMock: unused('registerMock'),
    unregisterMock: unused('unregisterMock'),
    invalidate: unused('invalidate'),
    loadedModules: unused('loadedModules'),
    resetModules() {
      calls.push(`${label}.resetModules`)
    },
    isolateModules(fn) {
      calls.push(`${label}.isolateModules`)
      return fn()
    },
    async isolateModulesAsync(fn) {
      calls.push(`${label}.isolateModulesAsync`)
      return await fn()
    },
    [Symbol.dispose]() {},
    dispose: () => report,
  }
}

function unusedRegistry(): never {
  throw new Error('this test does not use the registry')
}

/**
 * `jestGlobals` built over a real core runtime's API and the Jest dialect's `expect`, in the
 * worker's boot order. The runtime ran one empty file to hand over its API, and the globals stay
 * usable afterwards.
 */
async function globalsFor(
  t: TestContext,
  registry: () => FileRegistry = unusedRegistry,
  mocks?: () => MockRegistry,
): Promise<JestGlobals> {
  const { expect } = setUpJestExpect(t)
  let built: JestGlobals | undefined
  await runRegistered((api) => {
    built = jestGlobals({ api, expect, registry, ...mockHost(mocks) })
  }, jestCore)
  assert.ok(built)
  return built
}

const testsIn = (events: readonly RuntimeEvent[]): TestTask[] =>
  events.flatMap((event) =>
    event.type === 'file-collect-end'
      ? event.tasks.filter((task): task is TestTask => task.type === 'test')
      : [],
  )

const nodesIn = (events: readonly RuntimeEvent[]): readonly TaskNode[] =>
  events.flatMap((event) => (event.type === 'file-collect-end' ? event.tasks : []))

/** Each test's final state, by name. */
function statesOf(events: readonly RuntimeEvent[]): Record<string, string> {
  const names = new Map(testsIn(events).map((task) => [task.id, task.name]))
  const states: Record<string, string> = {}
  for (const event of events) {
    if (event.type !== 'test-end') continue
    states[names.get(event.id) ?? event.id] = event.result.state
  }
  return states
}

test('the globals are exactly the names the dialect lists', async (t) => {
  const names = jestDialect.globals?.names ?? []
  assert.equal(new Set(names).size, names.length, 'no name is listed twice')
  const globals = await globalsFor(t)
  assert.deepEqual(Object.keys(globals).sort(), [...names].sort())
  assert.deepEqual(Object.keys(globals).sort(), [
    'afterAll',
    'afterEach',
    'beforeAll',
    'beforeEach',
    'describe',
    'expect',
    'fdescribe',
    'fit',
    'it',
    'jest',
    'test',
    'xdescribe',
    'xit',
    'xtest',
  ])
})

test('describe, it, test and the hooks are core`s; the f and x forms are its only and skip', async (t) => {
  const { expect } = setUpJestExpect(t)
  let api: Parameters<Parameters<typeof runRegistered>[0]>[0] | undefined
  let g: JestGlobals | undefined
  await runRegistered((registered) => {
    api = registered
    g = jestGlobals({ api: registered, expect, registry: unusedRegistry, ...mockHost() })
  }, jestCore)
  assert.ok(api && g)
  assert.equal(g.describe, api.describe)
  assert.equal(g.it, api.it)
  assert.equal(g.test, api.test)
  assert.equal(g.beforeAll, api.beforeAll)
  assert.equal(g.beforeEach, api.beforeEach)
  assert.equal(g.afterEach, api.afterEach)
  assert.equal(g.afterAll, api.afterAll)
  assert.equal(g.fdescribe, api.describe.only)
  assert.equal(g.xdescribe, api.describe.skip)
  assert.equal(g.fit, api.it.only)
  assert.equal(g.xit, api.it.skip)
  assert.equal(g.xtest, api.test.skip)
  assert.equal(g.expect, expect, 'expect is the host`s')
})

test('fit registers a focused test; xit and xtest skipped ones', async (t) => {
  const { expect } = setUpJestExpect(t)
  const events = await runRegistered((api) => {
    const g = jestGlobals({ api, expect, registry: unusedRegistry, ...mockHost() })
    g.it('plain', () => {})
    g.fit('focused', () => {})
    g.xit('skipped by xit', () => {})
    g.xtest('skipped by xtest', () => {})
  }, jestCore)
  const modes = Object.fromEntries(testsIn(events).map((task) => [task.name, task.mode]))
  assert.deepEqual(modes, {
    plain: 'run',
    focused: 'only',
    'skipped by xit': 'skip',
    'skipped by xtest': 'skip',
  })
  // Jest's `.only` narrows the whole file: the plain test does not run either.
  assert.deepEqual(statesOf(events), {
    plain: 'skip',
    focused: 'pass',
    'skipped by xit': 'skip',
    'skipped by xtest': 'skip',
  })
})

test('fdescribe focuses a suite and xdescribe skips one', async (t) => {
  const { expect } = setUpJestExpect(t)
  const events = await runRegistered((api) => {
    const g = jestGlobals({ api, expect, registry: unusedRegistry, ...mockHost() })
    g.describe('plain suite', () => g.it('outside', () => {}))
    g.fdescribe('focused suite', () => g.it('inside focused', () => {}))
    g.xdescribe('skipped suite', () => g.it('inside skipped', () => {}))
  }, jestCore)
  const suites = Object.fromEntries(
    nodesIn(events)
      .filter((node) => node.type === 'suite')
      .map((node) => [node.name, node.mode]),
  )
  assert.deepEqual(suites, {
    'plain suite': 'run',
    'focused suite': 'only',
    'skipped suite': 'skip',
  })
  assert.deepEqual(statesOf(events), {
    outside: 'skip',
    'inside focused': 'pass',
    'inside skipped': 'skip',
  })
})

test('the hooks run around the tests, and expect is the one the host gave', async (t) => {
  const { expect } = setUpJestExpect(t)
  const order: string[] = []
  const events = await runRegistered((api) => {
    const g = jestGlobals({ api, expect, registry: unusedRegistry, ...mockHost() })
    g.beforeAll(() => void order.push('beforeAll'))
    g.beforeEach(() => void order.push('beforeEach'))
    g.afterEach(() => void order.push('afterEach'))
    g.afterAll(() => void order.push('afterAll'))
    g.test('passes', () => {
      order.push('body')
      g.expect(1).toBe(1)
    })
    g.test('fails', () => {
      g.expect(1).toBe(2)
    })
  }, jestCore)
  assert.deepEqual(order, [
    'beforeAll',
    'beforeEach',
    'body',
    'afterEach',
    'beforeEach',
    'afterEach',
    'afterAll',
  ])
  assert.deepEqual(statesOf(events), { passes: 'pass', fails: 'fail' })
  const failure = events.find((event) => event.type === 'test-end' && event.result.state === 'fail')
  assert.ok(failure?.type === 'test-end')
  assert.equal(
    failure.result.errors[0]?.matcherResult?.name,
    'toBe',
    'Jest`s expect, with its error',
  )
})

test('jest.isolateModules, isolateModulesAsync and resetModules act on the registry of the moment', async (t) => {
  const calls: string[] = []
  const first = recordingRegistry('first', calls)
  const second = recordingRegistry('second', calls)
  let current = first
  const { jest } = await globalsFor(t, () => current)
  assert.equal(calls.length, 0, 'building the globals reads no registry')

  const ran: string[] = []
  assert.equal(
    jest.isolateModules(() => void ran.push('sync')),
    jest,
  )
  assert.equal(jest.resetModules(), jest)
  current = second
  assert.equal(jest.resetModules(), jest)
  assert.deepEqual(ran, ['sync'], 'the function ran, inside the registry')

  const pending = jest.isolateModulesAsync(async () => {
    calls.push('async body')
  })
  assert.ok(pending instanceof Promise)
  assert.equal(await pending, undefined)
  assert.deepEqual(calls, [
    'first.isolateModules',
    'first.resetModules',
    'second.resetModules',
    'second.isolateModulesAsync',
    'async body',
  ])
})

// Jest 30.5 refuses to nest the two isolation calls, in either order, and to overlap them. Its
// registries check this when an isolation is entered (jest-runtime
// `src/internals/ModuleRegistries.ts` L125-L134), and the text names the call being made first,
// then the other one. The loader's registry no longer checks, so the facade does.
const NESTED_SYNC =
  'isolateModules cannot be nested inside another isolateModules or isolateModulesAsync.'
const NESTED_ASYNC =
  'isolateModulesAsync cannot be nested inside another isolateModulesAsync or isolateModules.'

test('isolateModules inside isolateModules throws Jest’s error, and the outer call carries on', async (t) => {
  const calls: string[] = []
  const registry = recordingRegistry('r', calls)
  const { jest } = await globalsFor(t, () => registry)
  const ran: string[] = []
  jest.isolateModules(() => {
    ran.push('outer')
    assert.throws(() => jest.isolateModules(() => ran.push('inner')), { message: NESTED_SYNC })
    ran.push('outer again')
  })
  assert.deepEqual(ran, ['outer', 'outer again'], 'the inner function never ran')
  assert.deepEqual(calls, ['r.isolateModules'], 'the refused call never reached the registry')
})

test('isolateModules inside isolateModulesAsync throws, and the other way round rejects', async (t) => {
  const calls: string[] = []
  const registry = recordingRegistry('r', calls)
  const { jest } = await globalsFor(t, () => registry)
  await jest.isolateModulesAsync(async () => {
    assert.throws(() => jest.isolateModules(() => {}), { message: NESTED_SYNC })
    await Promise.resolve()
    assert.throws(() => jest.isolateModules(() => {}), { message: NESTED_SYNC })
  })

  let inner: Promise<void> | undefined
  jest.isolateModules(() => {
    inner = jest.isolateModulesAsync(async () => {})
  })
  assert.ok(inner)
  await assert.rejects(inner, { message: NESTED_ASYNC })
  assert.deepEqual(calls, ['r.isolateModulesAsync', 'r.isolateModules'])
})

test('isolateModulesAsync inside isolateModulesAsync rejects', async (t) => {
  const calls: string[] = []
  const registry = recordingRegistry('r', calls)
  const { jest } = await globalsFor(t, () => registry)
  await jest.isolateModulesAsync(async () => {
    await assert.rejects(
      jest.isolateModulesAsync(async () => {}),
      { message: NESTED_ASYNC },
    )
  })
  assert.deepEqual(calls, ['r.isolateModulesAsync'])
})

test('two overlapping isolateModulesAsync calls: the second rejects while the first is pending', async (t) => {
  const registry = recordingRegistry('r', [])
  const { jest } = await globalsFor(t, () => registry)
  const gate = Promise.withResolvers<void>()
  const first = jest.isolateModulesAsync(async () => await gate.promise)
  await assert.rejects(
    jest.isolateModulesAsync(async () => {}),
    { message: NESTED_ASYNC },
  )
  assert.throws(() => jest.isolateModules(() => {}), { message: NESTED_SYNC })
  gate.resolve()
  await first
})

test('sequential isolation calls work, also after one threw or rejected', async (t) => {
  const calls: string[] = []
  const registry = recordingRegistry('r', calls)
  const { jest } = await globalsFor(t, () => registry)
  jest.isolateModules(() => {})
  jest.isolateModules(() => {})
  await jest.isolateModulesAsync(async () => {})
  await jest.isolateModulesAsync(async () => {})
  assert.throws(
    () =>
      jest.isolateModules(() => {
        throw new Error('the function threw')
      }),
    { message: 'the function threw' },
  )
  await assert.rejects(
    jest.isolateModulesAsync(async () => {
      throw new Error('the function rejected')
    }),
    { message: 'the function rejected' },
  )
  jest.isolateModules(() => {})
  await jest.isolateModulesAsync(async () => {})
  assert.equal(calls.length, 8, 'every sequential call reached the registry')
})

test('the ban is per registry: a new file’s registry is not blocked by one still isolating', async (t) => {
  const first = recordingRegistry('first', [])
  const second = recordingRegistry('second', [])
  let current = first
  const { jest } = await globalsFor(t, () => current)
  const gate = Promise.withResolvers<void>()
  // File one's isolation never ends (a test that hung, say) ...
  const stuck = jest.isolateModulesAsync(async () => await gate.promise)
  // ... and file two runs on its own registry.
  current = second
  jest.isolateModules(() => {})
  await jest.isolateModulesAsync(async () => {})
  current = first
  assert.throws(() => jest.isolateModules(() => {}), { message: NESTED_SYNC })
  gate.resolve()
  await stuck
})

test('a second jestGlobals call has its own record of what is isolating', async (t) => {
  const { expect } = setUpJestExpect(t)
  const registry = recordingRegistry('r', [])
  let one: JestGlobals | undefined
  let two: JestGlobals | undefined
  await runRegistered((api) => {
    one = jestGlobals({ api, expect, registry: () => registry, ...mockHost() })
    two = jestGlobals({ api, expect, registry: () => registry, ...mockHost() })
  }, jestCore)
  assert.ok(one && two)
  const gate = Promise.withResolvers<void>()
  const pending = one.jest.isolateModulesAsync(async () => await gate.promise)
  // Another worker's globals over the same registry object is not nested in this one: no state
  // is shared between the two calls.
  two.jest.isolateModules(() => {})
  gate.resolve()
  await pending
})

test('the jest object has the registry methods, the mock functions and nothing else', async (t) => {
  const { jest } = await globalsFor(t)
  assert.deepEqual(Object.keys(jest).sort(), [
    'clearAllMocks',
    'fn',
    'isMockFunction',
    'isolateModules',
    'isolateModulesAsync',
    'replaceProperty',
    'resetAllMocks',
    'resetModules',
    'restoreAllMocks',
    'spyOn',
  ])
})

test('the mock functions act on the registry of the moment, read when they are called', async (t) => {
  let current = createMockRegistry()
  const { jest } = await globalsFor(t, unusedRegistry, () => current)
  const first = jest.fn((a: number) => a + 1)
  assert.equal(first(1), 2)
  assert.deepEqual(first.mock.calls, [[1]])
  assert.ok(jest.isMockFunction(first))
  assert.ok(!jest.isMockFunction(() => {}))
  // `clearAllMocks` reaches the mocks of the registry it is called under, and returns `jest`.
  assert.equal(jest.clearAllMocks(), jest)
  assert.deepEqual(first.mock.calls, [])
  const target = { greet: () => 'hi', value: 1 }
  const spy = jest.spyOn(target, 'greet')
  assert.equal(target.greet(), 'hi')
  assert.equal(spy.mock.calls.length, 1)
  const replaced = jest.replaceProperty(target, 'value', 2)
  assert.equal(target.value, 2)
  // A new file's registry: restoring there leaves the first file's spy alone.
  const second = createMockRegistry()
  current = second
  assert.equal(jest.restoreAllMocks(), jest)
  assert.equal(target.value, 2)
  replaced.restore()
  assert.equal(target.value, 1)
  assert.equal(jest.resetAllMocks(), jest)
  spy.mockRestore()
  assert.equal(target.greet(), 'hi')
})

test('jest.fn follows the dialect`s mock policy and spyOn takes an accessor kind', async (t) => {
  const { jest } = await globalsFor(t)
  const fn = jest.fn()
  assert.equal(fn.getMockName(), jestMock.defaultName)
  const object = {
    get answer() {
      return 42
    },
  }
  const getter = jest.spyOn(object, 'answer', 'get')
  assert.equal(object.answer, 42)
  assert.equal(getter.mock.calls.length, 1)
  getter.mockRestore()
  assert.throws(() => jest.spyOn({}, 'missing' as never), /missing/)
})

test('a registry error reaches the caller', async (t) => {
  const { jest } = await globalsFor(t)
  assert.throws(() => jest.resetModules(), /does not use the registry/)
  await assert.rejects(
    jest.isolateModulesAsync(async () => {}),
    /does not use the registry/,
  )
})

test('the globals factory is a module ref that loads jestGlobals through the behaviour loader', async () => {
  const globals = jestDialect.globals
  assert.ok(globals)
  assert.equal(globals.factory.export, 'jestGlobals')
  assert.match(globals.factory.module, /^file:\/\/.*\/runtime\/index\.ts$/)
  assert.equal(await createBehaviourLoader().load(globals.factory), jestGlobals)
})
