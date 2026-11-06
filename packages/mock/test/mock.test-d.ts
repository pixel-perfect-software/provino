// The public API of @provino/mock: first-cut `fn` and `spyOn` inference and misuse (T4.5 ports the
// rest).
import {
  createMockFn,
  createMockRegistry,
  createStubs,
  isMockFunction,
  MOCK_BRAND,
  type Mock,
  type MockCleanupConfig,
  type MockError,
  type MockInstance,
  type MockRegistry,
  type MockTypeError,
  type Replaced,
  replaceProperty,
  type Stubs,
  spyOn,
  type UnknownFunction,
} from '@provino/mock'
import type { MockPolicy } from '@provino/types'
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
