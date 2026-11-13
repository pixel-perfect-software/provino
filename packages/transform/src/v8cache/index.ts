// @provino/transform/v8cache: the V8 code cache helpers (T3.7). A leaf of its own so the `provino`
// bin can import it without loading Oxc: it uses Node built-ins only (and the transform cache's
// `CACHEDIR.TAG` writer, which is just as light).

export type { V8Cache, V8CacheOptions, V8CacheStats } from './cache.ts'
export { createV8Cache, v8CacheTag } from './cache.ts'
export type { V8CacheErrorCode } from './errors.ts'
export { V8CacheError } from './errors.ts'
export type { CacheMode } from './mode.ts'
export { cacheModeFor } from './mode.ts'
export type { NativeCompileCacheResult } from './native.ts'
export { enableNativeCompileCache } from './native.ts'
