// Track 2 §Types → "Type tests that gate CI" (T2.1).
import type {
  FileRegistry,
  Loader,
  ModuleId,
  ModuleTransformer,
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

export { bad }
