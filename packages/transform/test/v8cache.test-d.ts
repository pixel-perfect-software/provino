// The public API of @provino/transform/v8cache (T3.7).

import type { Script } from 'node:vm'
import {
  type CacheMode,
  cacheModeFor,
  createV8Cache,
  enableNativeCompileCache,
  type NativeCompileCacheResult,
  type V8Cache,
  V8CacheError,
  type V8CacheErrorCode,
  type V8CacheOptions,
  type V8CacheStats,
  v8CacheTag,
} from '@provino/transform/v8cache'
import { expectTypeOf } from 'expect-type'

expectTypeOf<CacheMode>().toEqualTypeOf<'on' | 'off'>()
expectTypeOf(cacheModeFor({ coverage: true })).toEqualTypeOf<CacheMode>()
// @ts-expect-error: `coverage` is required
cacheModeFor({})
// @ts-expect-error: `coverage` is a boolean
cacheModeFor({ coverage: 'yes' })

expectTypeOf(v8CacheTag()).toBeString()

expectTypeOf<V8CacheOptions>().toEqualTypeOf<{
  readonly dir: string
  readonly mode?: CacheMode
}>()
// @ts-expect-error: `dir` is required
createV8Cache({})
// @ts-expect-error: a mode is `'on'` or `'off'`
createV8Cache({ dir: '/cache', mode: 'auto' })

const cache = createV8Cache({ dir: '/cache' })
expectTypeOf(cache).toEqualTypeOf<V8Cache>()
expectTypeOf(cache.loadScript('1', 'a.js', 'ab12')).toEqualTypeOf<Script>()
expectTypeOf(cache.flush()).toEqualTypeOf<Promise<void>>()
expectTypeOf(cache.stats).toEqualTypeOf<V8CacheStats>()
expectTypeOf<V8CacheStats>().toEqualTypeOf<{
  readonly hits: number
  readonly misses: number
  readonly rejected: number
  readonly written: number
  readonly writeFailures: number
}>()
// @ts-expect-error: the key is required
cache.loadScript('1', 'a.js')
// @ts-expect-error: the stats are read-only
cache.stats = { hits: 0, misses: 0, rejected: 0, written: 0, writeFailures: 0 }

expectTypeOf(enableNativeCompileCache('/cache')).toEqualTypeOf<NativeCompileCacheResult>()
expectTypeOf(enableNativeCompileCache('/cache', 'off')).toEqualTypeOf<NativeCompileCacheResult>()
expectTypeOf<NativeCompileCacheResult['status']>().toEqualTypeOf<
  'enabled' | 'already-enabled' | 'disabled' | 'unsupported' | 'failed'
>()
// @ts-expect-error: the directory is required
enableNativeCompileCache()
// @ts-expect-error: a mode is `'on'` or `'off'`
enableNativeCompileCache('/cache', 'sometimes')

expectTypeOf<V8CacheError['code']>().toEqualTypeOf<V8CacheErrorCode>()
expectTypeOf<V8CacheErrorCode>().toEqualTypeOf<'V8_CACHE_KEY_INVALID'>()
expectTypeOf(new V8CacheError('V8_CACHE_KEY_INVALID', 'a key')).toExtend<Error>()
// @ts-expect-error: the code is one of V8CacheErrorCode
new V8CacheError('V8_CACHE_OTHER', 'a key')
