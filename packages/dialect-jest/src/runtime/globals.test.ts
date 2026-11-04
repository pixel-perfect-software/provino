import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { FileRegistry, LeakReport, RuntimeEvent, TaskNode, TestTask } from '@provino/types'
import { jestDialect, jestPolicy } from '../dialect.ts'
import { type JestGlobals, jestGlobals } from './globals.ts'
import { runRegistered, setUpJestExpect } from './internal/test-support.ts'

const jestCore = resolvePolicy(jestPolicy).core

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
): Promise<JestGlobals> {
  const { expect } = setUpJestExpect(t)
  let built: JestGlobals | undefined
  await runRegistered((api) => {
    built = jestGlobals({ api, expect, registry })
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
    g = jestGlobals({ api: registered, expect, registry: unusedRegistry })
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
    const g = jestGlobals({ api, expect, registry: unusedRegistry })
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
    const g = jestGlobals({ api, expect, registry: unusedRegistry })
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
    const g = jestGlobals({ api, expect, registry: unusedRegistry })
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

test('the jest object has the registry methods and nothing else', async (t) => {
  const { jest } = await globalsFor(t)
  assert.deepEqual(Object.keys(jest).sort(), [
    'isolateModules',
    'isolateModulesAsync',
    'resetModules',
  ])
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
