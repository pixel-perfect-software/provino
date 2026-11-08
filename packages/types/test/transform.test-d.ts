// Track 3 §Types → "Type tests (gate CI)" (T3.1), all six cases. `createResolver` is declared
// with its signature from here; `@provino/resolver` implements it (B05).
import type { AsyncTransformer, SyncTransformer } from '@jest/transform'
import type {
  CreateResolver,
  DefineHoistPolicy,
  HoistArgRule,
  ImportRecord,
  JestTransformer,
  ModuleTransformer,
  Pipeline,
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
  reExports: 'static',
  rewrittenCalls: 'member',
  messages: {
    HOIST_FACTORY_OUT_OF_SCOPE: '',
    HOIST_NOT_TOP_LEVEL: '',
    HOIST_NESTED: '',
    HOIST_EXPORTED: '',
    HOIST_EXPORTED_VALUE: '',
    HOIST_FACTORY_NOT_FUNCTION: '',
  },
})
expectTypeOf(p.hoistCalls).toEqualTypeOf<{
  readonly mock: HoistArgRule
  readonly unmock: HoistArgRule
}>()
expectTypeOf(p.hoistValues).toEqualTypeOf<readonly 'hoisted'[]>()

// 4. exactOptionalPropertyTypes: explicit undefined is rejected.
declare const createResolver: CreateResolver
// @ts-expect-error custom must be omitted, not undefined
createResolver({ root: '/', mappers: [], extensions: ['.ts'], custom: undefined })
createResolver({ root: '/', mappers: [], extensions: ['.ts'] })

// 5. Records are deeply readonly for consumers.
declare const rec: TransformRecord
// @ts-expect-error readonly
rec.staticMocks.push({} as StaticMockCall)
declare const imported: ImportRecord
// @ts-expect-error readonly
imported.specifier = 'x'

// 6. Pipeline.transform is sync (Track 2's load hook cannot await), and a pipeline is what the
//    loader takes.
expectTypeOf<Pipeline['transform']>().returns.toEqualTypeOf<TransformRecord>()
expectTypeOf<Pipeline>().toExtend<ModuleTransformer>()
