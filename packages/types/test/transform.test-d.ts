// Track 3 §Types → "Type tests (gate CI)" (T3.1). Cases 4 (`createResolver` rejects an explicit
// `custom: undefined`) and 6 (`Pipeline.transform` is sync) need `@provino/resolver` and
// `@provino/transform`, so they move to B05.
import type { AsyncTransformer, SyncTransformer } from '@jest/transform'
import type {
  DefineHoistPolicy,
  HoistArgRule,
  JestTransformer,
  ResolveResult,
  StaticMockCall,
  TransformRecord,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// 1. Real Jest transformers assign to ours, so babel-jest and ts-jest keep working. Plain
//    assignments, not toExtend: expect-type's DeepBrand is too strict for method unions.
declare const sync: SyncTransformer<{ x: 1 }>
declare const asyncTransformer: AsyncTransformer
export const t1: JestTransformer<{ x: 1 }> = sync
export const t2: JestTransformer = asyncTransformer
// @ts-expect-error a transformer needs `process` or `processAsync`
export const t3: JestTransformer = { canInstrument: true }
// @ts-expect-error `process` returns `{ code }`, not a string
export const t4: JestTransformer = { process: () => 'code' }

// 2. ResolveResult narrows by `type`.
declare const r: ResolveResult
if (r.type === 'file') expectTypeOf(r.path).toEqualTypeOf<string>()
if (r.type === 'builtin') expectTypeOf(r.id).toEqualTypeOf<`node:${string}`>()
// @ts-expect-error builtin results have no path
void r.path

// 3. defineHoistPolicy keeps literal method names.
declare const defineHoistPolicy: DefineHoistPolicy
const p = defineHoistPolicy({
  id: 'x',
  objects: [],
  hoistCalls: { mock: 'any', unmock: 'one-string' },
  hoistValues: ['hoisted'],
  rewriteImportArg: [],
  chainable: false,
  placement: 'top-level-only',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
})
expectTypeOf(p.hoistCalls).toEqualTypeOf<{
  readonly mock: HoistArgRule
  readonly unmock: HoistArgRule
}>()
expectTypeOf(p.hoistValues).toEqualTypeOf<readonly 'hoisted'[]>()

// 5. Records are deeply readonly for consumers.
declare const rec: TransformRecord
// @ts-expect-error readonly
rec.staticMocks.push({} as StaticMockCall)
// @ts-expect-error readonly
rec.imports[0].specifier = 'x'
