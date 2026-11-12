// The public API of @provino/dialect-jest (B08: the `expect` slice; B10: the dialect value and
// its globals).
import {
  type JestDialectOptions,
  jestDialect,
  jestExpectPolicy,
  jestMockPolicy,
  jestPolicy,
} from '@provino/dialect-jest'
import {
  type JestGlobals,
  type JestGlobalsHost,
  type JestModuleObject,
  type JestObject,
  jestExpectTable,
  jestGlobals,
  jestModuleScope,
} from '@provino/dialect-jest/runtime'
import { moduleRef } from '@provino/policy'
import type {
  Dialect,
  DialectName,
  ExpectPolicy,
  ExpectTable,
  GlobalsFactory,
  GlobalsHost,
  MatcherTableFactory,
  MockPolicy,
  ModuleRef,
  ModuleScopeFactory,
  PolicyOverrides,
  ProjectConfig,
  ProvinoConfigInput,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(jestExpectPolicy).toEqualTypeOf<ExpectPolicy>()
expectTypeOf(jestMockPolicy).toEqualTypeOf<MockPolicy>()
// @ts-expect-error the policy is read-only
jestMockPolicy.newCall = 'construct'
expectTypeOf(jestExpectTable).toExtend<MatcherTableFactory>()
expectTypeOf(jestExpectTable).returns.toEqualTypeOf<ExpectTable>()

// @ts-expect-error the factory takes no arguments
jestExpectTable({})
// @ts-expect-error the policy is read-only
jestExpectPolicy.expand = true

// The dialect value.
expectTypeOf(jestDialect).toEqualTypeOf<Dialect<'jest'>>()
expectTypeOf(jestDialect.name).toEqualTypeOf<'jest'>()
expectTypeOf(jestPolicy).toEqualTypeOf<PolicyOverrides>()
expectTypeOf(jestDialect.globals).toEqualTypeOf<Dialect<'jest'>['globals']>()

// @ts-expect-error a dialect is not renamed
jestDialect.version = '31'
// @ts-expect-error the policy overrides are read-only
jestPolicy.core = {}
declare function define(dialect: Dialect): void
define({
  name: 'x',
  version: '1',
  policy: {},
  // @ts-expect-error `globals` is a factory ref and names; the old `{ module, names }` shape is gone
  globals: { module: 'a', names: [] },
})

// Importing the package registers the dialect: its name is a `DialectName`, `{ dialect: 'jest' }`
// is a `ProjectConfig`, and `jest` is a config key (a `DialectRegistry` augmentation).
expectTypeOf<'jest'>().toExtend<DialectName>()
expectTypeOf<ProjectConfig['dialect']>().toEqualTypeOf<DialectName | undefined>()
expectTypeOf<ProjectConfig['jest']>().toEqualTypeOf<JestDialectOptions | undefined>()
expectTypeOf<JestDialectOptions>().toEqualTypeOf<Record<string, never>>()
expectTypeOf<{ readonly dialect: 'jest' }>().toExtend<ProjectConfig>()
expectTypeOf<{
  readonly dialect: 'jest'
  readonly alsoServe: readonly ['jest']
}>().toExtend<ProvinoConfigInput>()
expectTypeOf<{
  readonly dialect: 'jest'
  readonly jest: Record<never, never>
}>().toExtend<ProjectConfig>()
expectTypeOf<{
  readonly dialect: 'jest'
  readonly include: readonly string[]
}>().toExtend<ProjectConfig>()
// @ts-expect-error an unregistered dialect name is not a `ProjectConfig`
const jasmine: ProjectConfig = { dialect: 'jasmine' }
void jasmine
// @ts-expect-error `alsoServe` takes registered names too
const alsoJasmine: ProjectConfig = { alsoServe: ['jasmine'] }
void alsoJasmine
// @ts-expect-error the Jest dialect has no options yet
const jestOptions: ProjectConfig = { dialect: 'jest', jest: { verbose: true } }
void jestOptions

// The globals factory.
expectTypeOf(jestGlobals).toExtend<GlobalsFactory>()
expectTypeOf(jestGlobals).parameter(0).toEqualTypeOf<JestGlobalsHost>()
expectTypeOf(jestGlobals).returns.toEqualTypeOf<JestGlobals>()
expectTypeOf<JestGlobalsHost>().toExtend<GlobalsHost>()
expectTypeOf<JestGlobalsHost['mocks']>().returns.not.toEqualTypeOf<object>()
expectTypeOf<JestGlobals>().toExtend<Readonly<Record<string, unknown>>>()
expectTypeOf<JestGlobals['jest']>().toEqualTypeOf<JestObject>()
expectTypeOf<JestObject['isolateModules']>().returns.toEqualTypeOf<JestObject>()
expectTypeOf<JestObject['isolateModulesAsync']>().returns.toEqualTypeOf<Promise<void>>()
expectTypeOf<JestObject['resetModules']>().returns.toEqualTypeOf<JestObject>()

// `jestGlobals` can be the target of the ref `Dialect.globals` takes.
expectTypeOf<ModuleRef<typeof jestGlobals>>().toExtend<ModuleRef<GlobalsFactory>>()
declare function useRef(ref: ModuleRef<GlobalsFactory>): void
useRef(moduleRef<typeof jestGlobals>('file:///x.ts', 'jestGlobals'))
// @ts-expect-error a function that does not build a record of globals is not a GlobalsFactory
useRef(moduleRef<() => number>('file:///x.ts', 'count'))

declare const host: JestGlobalsHost
const globals = jestGlobals(host)
// The mock functions and the timer members are here; the rest of the `jest` object (`mock`, ...) is not.
expectTypeOf(globals.jest.fn).toBeFunction()
expectTypeOf(globals.jest.clearAllMocks).returns.toEqualTypeOf<JestObject>()
expectTypeOf(globals.jest.isMockFunction).parameter(0).toBeUnknown()
const spied = globals.jest.spyOn({ run: (n: number) => n }, 'run')
expectTypeOf(spied.mock.calls).toEqualTypeOf<[n: number][]>()
// @ts-expect-error `jest.mock` is B13c's
globals.jest.mock('./module')
expectTypeOf(globals.jest.useFakeTimers()).toEqualTypeOf<JestObject>()
expectTypeOf(globals.jest.advanceTimersByTime).returns.toBeVoid()
expectTypeOf(globals.jest.advanceTimersByTimeAsync).returns.toEqualTypeOf<Promise<void>>()
expectTypeOf(globals.jest.getTimerCount).returns.toBeNumber()
expectTypeOf(globals.jest.now).returns.toBeNumber()
// @ts-expect-error a Vitest option name: Jest's `useFakeTimers` takes `doNotFake`
globals.jest.useFakeTimers({ toFake: ['setTimeout'] })
// @ts-expect-error `advanceTimersByTime` takes milliseconds
globals.jest.advanceTimersByTime('10')
// @ts-expect-error `isFakeTimers` is Vitest's, not Jest's
globals.jest.isFakeTimers()
// @ts-expect-error a key that is not on the object can't be spied on
globals.jest.spyOn({ run: () => 1 }, 'nope')
// @ts-expect-error `replaceProperty` takes a value of the property's type
globals.jest.replaceProperty({ n: 1 }, 'n', 'one')
// @ts-expect-error a host needs the mock registry and policy
jestGlobals({ api: host.api, expect: host.expect, registry: host.registry })
// @ts-expect-error the globals are read-only
globals.fit = globals.it
// @ts-expect-error a host needs core's API and an `expect`
jestGlobals({ registry: host.registry })
// @ts-expect-error `isolateModules` takes a function
globals.jest.isolateModules('./module')

// B13c: each module's own `jest`, from the dialect's module-scope factory.
expectTypeOf(jestModuleScope).toExtend<ModuleScopeFactory>()
expectTypeOf(jestDialect.moduleScope?.names).toEqualTypeOf<readonly string[] | undefined>()
expectTypeOf(jestDialect.moduleScope?.factory).toEqualTypeOf<
  ModuleRef<ModuleScopeFactory> | undefined
>()
declare const moduleJest: JestModuleObject
expectTypeOf(moduleJest).toExtend<JestObject>()
expectTypeOf(moduleJest.mock('./a')).toEqualTypeOf<JestModuleObject>()
expectTypeOf(
  moduleJest.mock('./a', () => ({ a: 1 }), { virtual: true }),
).toEqualTypeOf<JestModuleObject>()
expectTypeOf(
  moduleJest.doMock('./a').unmock('./b').dontMock('./c'),
).toEqualTypeOf<JestModuleObject>()
expectTypeOf(moduleJest.requireActual<{ a: number }>('./a')).toEqualTypeOf<{ a: number }>()
expectTypeOf(moduleJest.requireMock('./a')).toEqualTypeOf<unknown>()
expectTypeOf(moduleJest.createMockFromModule<{ f: () => void }>('./a')).toEqualTypeOf<{
  f: () => void
}>()
expectTypeOf(moduleJest.enableAutomock().disableAutomock()).toEqualTypeOf<JestModuleObject>()
expectTypeOf(moduleJest.resetModules().isolateModules(() => {})).toEqualTypeOf<JestModuleObject>()
// The global `jest` has no module-mock calls: it doesn't know its caller.
// @ts-expect-error `mock` is only on a module's own `jest`
globals.jest.mock('./a')
// @ts-expect-error a module name is a string
moduleJest.mock(42)
// @ts-expect-error `virtual` is a boolean
moduleJest.mock('./a', () => ({}), { virtual: 'yes' })
// @ts-expect-error a factory is a function, not the module itself
moduleJest.doMock('./a', { a: 1 })
