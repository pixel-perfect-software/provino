// `jestModuleScope` (B13c Gap 2): each module gets its own `jest`, as jest-runtime's
// `_createJestObjectFor(from)` does. The module-mock calls resolve from that module; the rest is
// the global's. The harness's mod corpus checks it against real Jest; these pin the wiring.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMockRegistry, isMockFunction } from '@provino/mock'
import { resolvePolicy } from '@provino/policy'
import type {
  FileRegistry,
  LeakReport,
  MockDecision,
  ModuleId,
  ModuleMockRegistry,
} from '@provino/types'
import { jestPolicy } from '../dialect.ts'
import { type JestGlobalsHost, type JestModuleObject, jestModuleScope } from './globals.ts'
import { timerHost } from './internal/test-support.ts'

const jestMock = resolvePolicy(jestPolicy).mock

/** A file registry that records the module-mock calls the `jest` object makes. */
function recordingRegistry(calls: string[]): FileRegistry {
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not part of the test`)
  }
  const report: LeakReport = {
    restored: [],
    prototypePatches: [],
    listenersAdded: [],
    activeResources: [],
    inlinedForMocks: [],
  }
  return {
    file: '/root/a.test.ts',
    tier: 'registry',
    import: unused('import'),
    require: unused('require'),
    importActual: unused('importActual'),
    requireActual<T>(specifier: string, parent?: ModuleId | null): T {
      calls.push(`requireActual ${specifier} from ${parent}`)
      return { actual: specifier } as T
    },
    registerMock(specifier, parent, spec, options) {
      calls.push(
        `registerMock ${specifier} from ${parent} ${spec.kind} ${JSON.stringify(options ?? {})}`,
      )
    },
    unregisterMock(specifier, parent) {
      calls.push(`unregisterMock ${specifier} from ${parent}`)
    },
    invalidate: unused('invalidate'),
    loadedModules: unused('loadedModules'),
    resetModules() {
      calls.push('resetModules')
    },
    isolateModules(fn) {
      calls.push('isolateModules')
      return fn()
    },
    async isolateModulesAsync(fn) {
      calls.push('isolateModulesAsync')
      return await fn()
    },
    [Symbol.dispose]() {},
    dispose: () => report,
  }
}

/** A module-mock registry that records what the `jest` object asks of it. */
function recordingModuleMocks(calls: string[]): ModuleMockRegistry {
  const unused = (name: string) => (): never => {
    throw new Error(`${name} is not part of the test`)
  }
  const no: MockDecision = { mocked: false }
  return {
    register: unused('register'),
    decide: () => no,
    decideUnresolved: () => no,
    materialize: unused('materialize'),
    mockFor(specifier, from) {
      calls.push(`mockFor ${specifier} from ${from}`)
      return { mock: specifier }
    },
    createMockFromModule(specifier, from) {
      calls.push(`createMockFromModule ${specifier} from ${from}`)
      return { automock: specifier }
    },
    onResetModules: unused('onResetModules'),
    setAutomock(enabled) {
      calls.push(`setAutomock ${enabled}`)
    },
    enterIsolation: unused('enterIsolation'),
    exitIsolation: unused('exitIsolation'),
    dispose: unused('dispose'),
  }
}

function setUp(): {
  readonly calls: string[]
  readonly forModule: (from: string) => JestModuleObject
} {
  const calls: string[] = []
  const registry = recordingRegistry(calls)
  const moduleMocks = recordingModuleMocks(calls)
  const mocks = createMockRegistry()
  const host: JestGlobalsHost = {
    // The per-module `jest` never reads core's API or `expect`.
    api: Object.create(null) as JestGlobalsHost['api'],
    expect: Object.create(null) as JestGlobalsHost['expect'],
    registry: () => registry,
    mocks: () => mocks,
    moduleMocks: () => moduleMocks,
    mockPolicy: jestMock,
    ...timerHost(),
  }
  const scope = jestModuleScope(host)
  return {
    calls,
    forModule: (from) => {
      const values = scope(from)
      assert.deepEqual(Object.keys(values), ['jest'], 'the binding is named as the dialect says')
      return values.jest as JestModuleObject
    },
  }
}

test('a module’s jest registers mocks from that module, hoisted or not, and chains itself', () => {
  const { calls, forModule } = setUp()
  const jest = forModule('/root/src/helper.ts')
  const factory = () => ({ a: 1 })
  assert.equal(jest.mock('./a', factory), jest)
  assert.equal(jest.mock('./b'), jest)
  assert.equal(jest.doMock('virtual-thing', factory, { virtual: true }), jest)
  assert.equal(jest.unmock('./c').dontMock('./d'), jest)
  assert.deepEqual(calls, [
    'registerMock ./a from /root/src/helper.ts factory {"hoisted":true}',
    'registerMock ./b from /root/src/helper.ts automock {"hoisted":true}',
    'registerMock virtual-thing from /root/src/helper.ts factory {"virtual":true,"hoisted":false}',
    'unregisterMock ./c from /root/src/helper.ts',
    'unregisterMock ./d from /root/src/helper.ts',
  ])
})

test('requireActual, requireMock and createMockFromModule resolve from the calling module', () => {
  const { calls, forModule } = setUp()
  const jest = forModule('/root/x.test.ts')
  assert.deepEqual(jest.requireActual('./real'), { actual: './real' })
  assert.deepEqual(jest.requireMock('./mocked'), { mock: './mocked' })
  assert.deepEqual(jest.createMockFromModule('./auto'), { automock: './auto' })
  assert.deepEqual(calls, [
    'requireActual ./real from /root/x.test.ts',
    'mockFor ./mocked from /root/x.test.ts',
    'createMockFromModule ./auto from /root/x.test.ts',
  ])
})

test('enableAutomock and disableAutomock reach the file’s module-mock registry', () => {
  const { calls, forModule } = setUp()
  const jest = forModule('/root/x.test.ts')
  assert.equal(jest.enableAutomock().disableAutomock(), jest)
  assert.deepEqual(calls, ['setAutomock true', 'setAutomock false'])
})

test('each module gets its own object, and the shared members chain to it', () => {
  const { calls, forModule } = setUp()
  const a = forModule('/root/a.ts')
  const b = forModule('/root/b.ts')
  assert.notEqual(a, b)
  assert.equal(a.resetModules(), a)
  assert.equal(
    b.isolateModules(() => {}),
    b,
  )
  assert.equal(a.clearAllMocks().resetAllMocks().restoreAllMocks(), a)
  assert.ok(isMockFunction(jestMock, a.fn()))
  assert.deepEqual(calls, ['resetModules', 'isolateModules'])
  b.mock('./x')
  assert.match(calls.at(-1) ?? '', /from \/root\/b\.ts/)
})

test('a nested isolateModules through a module’s jest throws Jest’s error', () => {
  const { forModule } = setUp()
  const jest = forModule('/root/a.ts')
  assert.throws(() => jest.isolateModules(() => jest.isolateModules(() => {})), {
    message:
      'isolateModules cannot be nested inside another isolateModules or isolateModulesAsync.',
  })
})
