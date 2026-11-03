// The public API of @provino/transform.
import {
  type CreatePipeline,
  createPipeline,
  type PipelineOptions,
  type TransformError,
  type TransformErrorCode,
} from '@provino/transform'
import type { ModuleTransformer, Pipeline, TransformRecord } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(createPipeline).toEqualTypeOf<CreatePipeline>()
const options: PipelineOptions = {
  root: '/',
  typescript: 'oxc',
  tsconfig: 'auto',
  hoist: null,
  cache: false,
}
const pipeline = createPipeline(options)
expectTypeOf(pipeline).toEqualTypeOf<Pipeline>()
// The loader takes a pipeline as its transformer.
expectTypeOf(pipeline).toExtend<ModuleTransformer>()
expectTypeOf(
  pipeline.transform({
    filename: '/a.ts',
    source: '',
    role: 'test',
    consumer: 'import',
    instrument: false,
  }),
).toEqualTypeOf<TransformRecord>()
expectTypeOf<TransformError['code']>().toEqualTypeOf<TransformErrorCode>()

// @ts-expect-error the hoist policy is required (null to skip)
createPipeline({ root: '/', typescript: 'oxc', tsconfig: 'auto', cache: false })
// @ts-expect-error not a TypeScript mode
createPipeline({ ...options, typescript: 'babel' })
// @ts-expect-error the transform cache arrives with T3.6
createPipeline({ ...options, cache: { dir: '/tmp' } })
// @ts-expect-error not a JSX runtime
createPipeline({ ...options, jsx: { runtime: 'preserve' } })
