// The public API of @provino/mock: first-cut `fn` and `spyOn` inference and misuse (T4.5 ports the
// rest).
import {
  type AutomockMaker,
  automock,
  createMockFn,
  createMockRegistry,
  createModuleMockRegistry,
  createStubs,
  findManualMock,
  isMockFunction,
  type ManualMock,
  MOCK_BRAND,
  type Mock,
  type MockCleanupConfig,
  type MockDecision,
  type MockError,
  type MockInstance,
  type MockRegistry,
  type MockTypeError,
  type ModuleMockRegistry,
  type RegisterOptions,
  type Replaced,
  replaceProperty,
  type Stubs,
  spyOn,
  type UnknownFunction,
} from '@provino/mock'
import type { MockPolicy, ModulePolicy, Resolver } from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const policy: MockPolicy
const registry = createMockRegistry()
expectTypeOf(registry).toEqualTypeOf<MockRegistry>()
expectTypeOf(registry.nextInvocationOrder()).toEqualTypeOf<number>()
expectTypeOf(MOCK_BRAND).toBeSymbol()

// `fn()` and `fn(impl)`.
const bare = createMockFn(policy, registry)
expectTypeOf(bare).toEqualTypeOf<Mock<UnknownFunction>>()
expectTypeOf(bare(1, 'a')).toBeUnknown()

const add = createMockFn(policy, registry, { impl: (a: number, b: number) => a + b })
expectTypeOf(add(1, 2)).toEqualTypeOf<number>()
expectTypeOf(add.mock.calls).toEqualTypeOf<Array<[a: number, b: number]>>()
expectTypeOf(add.mockReturnValue(3)).toEqualTypeOf(add)
expectTypeOf(add.getMockImplementation()).toEqualTypeOf<
  ((a: number, b: number) => number) | undefined
>()
expectTypeOf(add).toExtend<(a: number, b: number) => number>()
expectTypeOf(add).toExtend<MockInstance<(a: number, b: number) => number>>()

const load = createMockFn(policy, registry, { impl: async (id: string) => id.length })
load.mockResolvedValue(1)
// @ts-expect-error the resolved value is a number
load.mockResolvedValue('no')

class Klass {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
}
const klass = createMockFn<typeof Klass>(policy, registry)
expectTypeOf(new klass('x')).toEqualTypeOf<Klass>()

// @ts-expect-error the arguments are numbers
add('1', 2)
// @ts-expect-error the return value is a number
add.mockReturnValue('three')
// @ts-expect-error an implementation has the target's shape
add.mockImplementation((a: string) => a)
// @ts-expect-error `mock` is read-only
add.mock = bare.mock
// @ts-expect-error an implementation is a function
createMockFn(policy, registry, { impl: 1 })
// @ts-expect-error a mock needs a policy and a registry
createMockFn()

// `isMockFunction`.
declare const unknownValue: unknown
if (isMockFunction(policy, unknownValue)) {
  expectTypeOf(unknownValue).toEqualTypeOf<Mock<UnknownFunction>>()
}

// `spyOn`.
const subject = {
  count: 1,
  name: 'subject',
  greet(who: string): string {
    return who
  },
  Klass,
  get size(): number {
    return 1
  },
  set size(_value: number) {},
}
const greet = spyOn(policy, registry, subject, 'greet')
expectTypeOf(greet).toEqualTypeOf<Mock<(who: string) => string>>()
expectTypeOf(greet.mock.calls[0]).toEqualTypeOf<[who: string] | undefined>()
const getter = spyOn(policy, registry, subject, 'size', 'get')
expectTypeOf(getter).toEqualTypeOf<Mock<() => number>>()
const setter = spyOn(policy, registry, subject, 'size', 'set')
expectTypeOf(setter).toEqualTypeOf<Mock<(value: number) => void>>()
const spiedClass = spyOn(policy, registry, subject, 'Klass')
expectTypeOf(new spiedClass('x')).toEqualTypeOf<Klass>()

// @ts-expect-error `count` is not a function: use an access type or `replaceProperty`
spyOn(policy, registry, subject, 'count')
// @ts-expect-error there is no such key
spyOn(policy, registry, subject, 'missing')
// @ts-expect-error there is no such key
spyOn(policy, registry, subject, 'missing', 'get')
// @ts-expect-error the access type is `get` or `set`
spyOn(policy, registry, subject, 'size', 'value')
// @ts-expect-error a primitive can't be spied on
spyOn(policy, registry, 1, 'toFixed')

// `replaceProperty`.
const replaced = replaceProperty(policy, registry, subject, 'count', 2)
expectTypeOf(replaced).toEqualTypeOf<Replaced<number>>()
expectTypeOf(replaced.replaceValue(3)).toEqualTypeOf<Replaced<number>>()
// @ts-expect-error the value has the property's type
replaceProperty(policy, registry, subject, 'count', 'two')
// @ts-expect-error there is no such key
replaceProperty(policy, registry, subject, 'missing', 1)

// `createStubs`.
const stubs = createStubs(registry, {})
expectTypeOf(stubs).toEqualTypeOf<Stubs>()
expectTypeOf(stubs.stubEnv('A', 'b')).toEqualTypeOf<Stubs>()
expectTypeOf(createStubs(registry, {}, globalThis)).toEqualTypeOf<Stubs>()
// @ts-expect-error an environment holds strings
stubs.stubEnv('A', 1)

// The registry.
const cleanup: MockCleanupConfig = { clear: true, unstubEnvs: false }
registry.beforeEach(cleanup, policy.between)
// @ts-expect-error `clearMocks` is Jest's name; the registry takes the neutral one
registry.beforeEach({ clearMocks: true }, policy.between)

// Errors carry a code, and stay an `Error` and a `TypeError`.
expectTypeOf<MockError['code']>().toEqualTypeOf<string>()
expectTypeOf<MockError>().toExtend<Error>()
expectTypeOf<MockTypeError>().toExtend<TypeError>()

// The module-mock registry (T4.7).
declare const resolver: Resolver
declare const modulePolicy: ModulePolicy

const modules = createModuleMockRegistry({
  policy: modulePolicy,
  mockPolicy: policy,
  mocks: registry,
  resolver,
  roots: ['/proj'],
  extensions: ['.ts'],
  loadActual: () => ({}),
})
expectTypeOf(modules).toEqualTypeOf<ModuleMockRegistry>()
expectTypeOf(modules.decide('/a.ts', '/b.ts', 'esm')).toEqualTypeOf<MockDecision>()
expectTypeOf(modules.decide('/a.ts', '/b.ts', 'cjs', './a')).toEqualTypeOf<MockDecision>()
expectTypeOf(modules.decideUnresolved('x', '/b.ts')).toEqualTypeOf<MockDecision>()
expectTypeOf(modules.materialize('/a.ts')).toBeUnknown()
expectTypeOf<RegisterOptions['from']>().toEqualTypeOf<string>()
modules.register('./a', { kind: 'factory', factory: () => ({}) }, { from: '/b.ts' })
modules.register(
  './a',
  {
    kind: 'factory',
    factory: async (importOriginal) => ({ ...((await importOriginal()) as object) }),
  },
  { from: '/b.ts', virtual: true },
)
modules.register('./a', { kind: 'unmock' }, { from: '/b.ts' })

// A decision is a union on `mocked`.
declare const decision: MockDecision
if (decision.mocked) expectTypeOf(decision.id).toEqualTypeOf<string>()
// @ts-expect-error `id` exists only on a mocked decision
decision.id

// @ts-expect-error a registration needs the importer
modules.register('./a', { kind: 'unmock' }, {})
modules.register(
  './a',
  // @ts-expect-error the factory's result shape is the policy's, not the spec's
  { kind: 'factory', factory: () => ({}), shape: 'namespace' },
  { from: '/b.ts' },
)
// @ts-expect-error the kind of an import edge is esm, cjs or builtin
modules.decide('/a.ts', '/b.ts', 'dynamic')
// @ts-expect-error the registry takes a resolver
createModuleMockRegistry({ policy: modulePolicy, mockPolicy: policy, mocks: registry })

// `findManualMock` and `automock`.
expectTypeOf(
  findManualMock('pkg', { roots: [], extensions: [] }),
).toEqualTypeOf<ManualMock | null>()
// @ts-expect-error the search needs its roots and extensions
findManualMock('pkg', {})
const maker: AutomockMaker = (options) => createMockFn(policy, registry, options)
expectTypeOf(automock({}, 'metadata', 'automock', maker)).toBeUnknown()
expectTypeOf(automock({}, 'deep', 'autospy', maker)).toBeUnknown()
// @ts-expect-error the shape is the policy's `metadata` or `deep`
automock({}, 'jest-metadata', 'automock', maker)
// @ts-expect-error the mode is automock or autospy
automock({}, 'deep', 'spy', maker)
