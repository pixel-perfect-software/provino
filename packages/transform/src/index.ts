// @provino/transform: the transform pipeline (Track 3). The shared records (`TransformRecord`,
// `TransformRequest`, `Pipeline`) live in @provino/types.

export type { PruneResult, TransformCache } from './cache/index.ts'
export {
  createTransformCache,
  DEFAULT_CACHE_MAX_BYTES,
  lockfileHash,
  prepareCache,
  pruneCache,
  pruneCacheIfWritten,
} from './cache/index.ts'
export type { TransformErrorCode } from './errors.ts'
export { TransformError } from './errors.ts'
export { LATE_IMPORT } from './hoist/apply.ts'
export type { HoistOptions, HoistOutput } from './hoist/index.ts'
export { hoistMocks } from './hoist/index.ts'
export type { HostedSource, JestHost } from './jest-host/index.ts'
export { createJestHost } from './jest-host/index.ts'
export type { ModuleRunnerOutput } from './module-runner.ts'
export { toModuleRunner } from './module-runner.ts'
export type { CreatePipeline, PipelineJsxOptions, PipelineOptions } from './pipeline.ts'
export { createPipeline, transformCodeIdentity } from './pipeline.ts'
