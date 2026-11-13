// Track 2 §Types → "Type tests that gate CI" (T2.1).
import type {
  FileRegistry,
  FileRegistryOptions,
  IsolationTier,
  LoadActual,
  LoadActualOptions,
  Loader,
  LoaderOptions,
  LoaderWarning,
  MockDecision,
  ModuleId,
  ModuleMockRegistry,
  ModuleMocksContext,
  ModuleMocksFactory,
  ModulePolicy,
  ModuleScopeNames,
  ModuleTransformer,
  Pragmas,
  RegisterMockOptions,
  Resolver,
  TierChoice,
  TierSource,
  TierSources,
  TransformRecord,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const loader: Loader
declare const reg: FileRegistry

// No implicit any; return types flow.
expectTypeOf(reg.import('x')).toEqualTypeOf<Promise<unknown>>()
expectTypeOf(reg.require<{ a: number }>('x')).toEqualTypeOf<{ a: number }>()
expectTypeOf(reg.isolateModules(() => 42)).toEqualTypeOf<number>()
expectTypeOf(reg.isolateModulesAsync(async () => 'x')).toEqualTypeOf<Promise<string>>()

// @ts-expect-error the process tier is not a registry tier
loader.createFileRegistry('f', { tier: 'process' })
// @ts-expect-error ModuleId is branded
const bad: ModuleId = '/abs/path.ts'
// @ts-expect-error redirect needs `to`
reg.registerMock('./a', null, { kind: 'redirect' })
// @ts-expect-error a factory mock needs its factory
reg.registerMock('./a', null, { kind: 'factory' })
// A zero-argument factory still satisfies `MockFactory`, and so does one that takes importOriginal.
reg.registerMock('./a', null, { kind: 'factory', factory: () => ({}) })
reg.registerMock('./a', null, {
  kind: 'factory',
  factory: async (importOriginal) => ({ ...((await importOriginal()) as object) }),
})
reg.registerMock('./a', null, { kind: 'unmock' })
// @ts-expect-error the factory's result shape is the policy's, not the spec's
reg.registerMock('./a', null, { kind: 'factory', factory: () => ({}), shape: 'namespace' })

// `using reg = …` works.
expectTypeOf(reg).toExtend<Disposable>()
expectTypeOf(loader).toExtend<Disposable>()

// The loader evaluates Track 3's transform record, synchronously.
expectTypeOf<ReturnType<ModuleTransformer['transform']>>().toEqualTypeOf<TransformRecord>()
expectTypeOf<TransformRecord['hasTopLevelAwait']>().toEqualTypeOf<boolean>()
// D38: the hoister's rewritten imports, as specifiers.
expectTypeOf<TransformRecord['lateDeps']>().toEqualTypeOf<readonly string[]>()

// B13c: `registerMock` takes `{ virtual?, hoisted? }`.
reg.registerMock('virtual-thing', null, { kind: 'unmock' }, { virtual: true, hoisted: false })
reg.registerMock('./a', '/abs/a.ts' as ModuleId, { kind: 'automock', spy: true }, {})
// @ts-expect-error an option the loader doesn't take
reg.registerMock('./a', null, { kind: 'unmock' }, { spy: true })
// @ts-expect-error `virtual` is a boolean
reg.registerMock('./a', null, { kind: 'unmock' }, { virtual: 'yes' })
expectTypeOf<RegisterMockOptions>().toEqualTypeOf<{
  readonly virtual?: boolean
  readonly hoisted?: boolean
}>()

// B13c: a file's module-mock registry is built by a factory the loader calls with its own
// `loadActual`, resolver and conditions; the per-module bindings come per module.
declare const registry: ModuleMockRegistry
loader.createFileRegistry('/f.test.ts', {
  tier: 'registry',
  moduleMocks: (context) => {
    expectTypeOf(context).toEqualTypeOf<ModuleMocksContext>()
    expectTypeOf(context.loadActual).toEqualTypeOf<LoadActual>()
    expectTypeOf(context.resolver).toEqualTypeOf<Resolver>()
    return registry
  },
  moduleScope: (from) => {
    expectTypeOf(from).toEqualTypeOf<ModuleId>()
    return { jest: {} }
  },
})
// @ts-expect-error the factory must return a registry
loader.createFileRegistry('/f.test.ts', { tier: 'none', moduleMocks: () => ({}) })
// @ts-expect-error the bindings are a record by name, not a list
loader.createFileRegistry('/f.test.ts', { tier: 'none', moduleScope: () => [1] })
expectTypeOf<FileRegistryOptions['moduleMocks']>().toEqualTypeOf<ModuleMocksFactory | undefined>()
expectTypeOf<LoaderOptions['moduleScope']>().toEqualTypeOf<ModuleScopeNames | undefined>()
const scratchLoad: LoadActual = (id, importer, options?: LoadActualOptions) =>
  options?.scratch === true ? `${id} from ${importer}` : null
// @ts-expect-error `scratch` is a boolean
const badLoad: LoadActual = (_id, _importer, options?: { scratch: string }) => options
expectTypeOf(registry.decide('/a.ts', '/b.ts', 'esm', './a')).toEqualTypeOf<MockDecision>()
// @ts-expect-error an edge is `esm`, `cjs` or `builtin`
registry.decide('/a.ts', '/b.ts', 'import')
expectTypeOf(registry.mockFor('./a', '/b.ts')).toEqualTypeOf<unknown>()
expectTypeOf(registry.createMockFromModule('./a', '/b.ts')).toEqualTypeOf<unknown>()
declare const decision: MockDecision
if (decision.mocked) expectTypeOf(decision.id).toEqualTypeOf<string>()
// @ts-expect-error only a mocked decision has an id
decision.id

export { bad, badLoad, scratchLoad }

// T2.6 (B13d): where the node_modules graph is cached, where the loader's warnings go, and whether
// a module-mock registry has anything to decide.
declare const loaderOptions: LoaderOptions
expectTypeOf(loaderOptions.graphCache).toEqualTypeOf<string | null | undefined>()
expectTypeOf(loaderOptions.inlineBudget).toEqualTypeOf<number | undefined>()
expectTypeOf(loaderOptions.onWarning).toEqualTypeOf<
  ((warning: LoaderWarning) => void) | undefined
>()
expectTypeOf<LoaderWarning['code']>().toEqualTypeOf<
  'PROVINO_INLINE_BUDGET' | 'PROVINO_INLINE_DYNAMIC'
>()
expectTypeOf<LoaderWarning['level']>().toEqualTypeOf<'warn' | 'debug'>()
// @ts-expect-error a warning has a known code
const unknownCode: LoaderWarning = { code: 'PROVINO_OTHER', level: 'warn', message: '' }
void unknownCode
// @ts-expect-error exactOptionalPropertyTypes: the cache is `null` for memory, not `undefined`
const undefinedCache: LoaderOptions = { ...loaderOptions, graphCache: undefined }
void undefinedCache
declare const moduleMocks: ModuleMockRegistry
expectTypeOf(moduleMocks.active).returns.toEqualTypeOf<boolean>()
expectTypeOf(moduleMocks.generation).returns.toEqualTypeOf<number>()
expectTypeOf<ModulePolicy['mocksReachShared']>().toEqualTypeOf<boolean>()
expectTypeOf<ModulePolicy['stackFrameNames']>().toEqualTypeOf<'mapped-name' | 'engine'>()

// T2.11: `tierFor` takes the sources of a tier and says which one won.
expectTypeOf(loader.tierFor).parameters.toEqualTypeOf<[string, TierSources]>()
expectTypeOf(loader.tierFor).returns.toEqualTypeOf<TierChoice>()
expectTypeOf<TierSources['configured']>().toEqualTypeOf<IsolationTier>()
expectTypeOf<TierSources['docblock']>().toEqualTypeOf<Pragmas | undefined>()
expectTypeOf<TierSources['learned']>().toEqualTypeOf<IsolationTier | undefined>()
expectTypeOf<TierSource>().toEqualTypeOf<'config' | 'docblock' | 'learned'>()
expectTypeOf<TierChoice['tier']>().toEqualTypeOf<IsolationTier>()
expectTypeOf<TierChoice['source']>().toEqualTypeOf<TierSource>()
expectTypeOf<TierChoice['warnings']>().toEqualTypeOf<readonly string[]>()
loader.tierFor('f', { configured: 'process' })
loader.tierFor('f', {
  configured: 'none',
  docblock: { 'provino-isolate': ['realm', 'process'] },
  learned: 'realm',
})
// @ts-expect-error the configured tier is the floor, and it is required
loader.tierFor('f', {})
// @ts-expect-error the old three-argument form is gone
loader.tierFor('f', 'registry', {})
// @ts-expect-error a learned tier is a tier
loader.tierFor('f', { configured: 'registry', learned: 'jail' })
// @ts-expect-error a docblock value is text, or a list of text
loader.tierFor('f', { configured: 'registry', docblock: { 'provino-isolate': 1 } })
// @ts-expect-error exactOptionalPropertyTypes: leave `learned` out, don't give it `undefined`
loader.tierFor('f', { configured: 'registry', learned: undefined })
// @ts-expect-error the choice is read-only
loader.tierFor('f', { configured: 'registry' }).warnings.push('x')
