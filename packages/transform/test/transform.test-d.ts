// The public API of @provino/transform.
import {
  type CreatePipeline,
  createJestHost,
  createPipeline,
  type HostedSource,
  type JestHost,
  type PipelineOptions,
  type TransformError,
  type TransformErrorCode,
} from '@provino/transform'
import type {
  ModuleTransformer,
  Pipeline,
  SerializedTransformConfig,
  TransformRecord,
  TransformRequest,
} from '@provino/types'
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

// T3.8: the Jest transformer host. It is created from the serialized config, in the worker.
declare const transformConfig: SerializedTransformConfig
declare const request: TransformRequest
expectTypeOf(createJestHost).parameters.toEqualTypeOf<[SerializedTransformConfig]>()
expectTypeOf(createJestHost).returns.toEqualTypeOf<Promise<JestHost>>()
declare const host: JestHost
expectTypeOf(host.handles).returns.toEqualTypeOf<boolean>()
expectTypeOf(host.transform(request)).toEqualTypeOf<HostedSource>()
expectTypeOf(host.transformAsync(request)).toEqualTypeOf<Promise<HostedSource>>()
// The seam for T3.6's fingerprint: the transformer's own cache key, when it has one.
expectTypeOf(host.cacheKey(request)).toEqualTypeOf<string | null>()
expectTypeOf<HostedSource['transformerCacheKey']>().toEqualTypeOf<string | null>()
createPipeline({ ...options, transformers: host })
// @ts-expect-error the pipeline takes a host, not the serialized config
createPipeline({ ...options, transformers: transformConfig })
// @ts-expect-error a host is built from a config, not from rules alone
createJestHost({ rules: [] })
