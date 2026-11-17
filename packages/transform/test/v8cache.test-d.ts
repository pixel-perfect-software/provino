// The public API of @provino/transform/v8cache (T3.7).

import type { Script } from 'node:vm'
import {
  type CacheMode,
  cacheModeFor,
  compactV8Packs,
  createV8Cache,
  enableNativeCompileCache,
  type NativeCompileCacheResult,
  openV8Pack,
  type V8Cache,
  V8CacheError,
  type V8CacheErrorCode,
  type V8CacheOptions,
  type V8CacheStats,
  type V8Pack,
  type V8PackCompaction,
  type V8PackCompactionOptions,
  type V8PackOptions,
  type V8PackScriptOptions,
  type V8PackStats,
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

// B23e: the packs of many scripts, for the loader's wrappers.
expectTypeOf<V8PackOptions>().toEqualTypeOf<{
  readonly dir: string
  readonly mode?: CacheMode
  readonly minLength?: number
}>()
// @ts-expect-error: `dir` is required
openV8Pack({})
const pack = openV8Pack({ dir: '/cache/t' })
expectTypeOf(pack).toEqualTypeOf<V8Pack>()
expectTypeOf(pack.compile('1', { filename: 'a.js', columnOffset: -4 })).toEqualTypeOf<Script>()
expectTypeOf<V8PackScriptOptions>().toEqualTypeOf<{
  readonly filename: string
  readonly lineOffset?: number
  readonly columnOffset?: number
}>()
// @ts-expect-error: the filename is required (the key is the code, the filename and the offsets)
pack.compile('1', {})
expectTypeOf(pack.pending).toBeNumber()
expectTypeOf(pack.write()).toBeVoid()
expectTypeOf(pack.close()).toBeVoid()
expectTypeOf(pack.stats).toEqualTypeOf<V8PackStats>()
expectTypeOf<keyof V8PackStats>().toEqualTypeOf<
  'hits' | 'misses' | 'rejected' | 'skipped' | 'packsRead' | 'written' | 'writeFailures'
>()
// @ts-expect-error: `pending` is read-only
pack.pending = 0
expectTypeOf(compactV8Packs('/cache/t')).toEqualTypeOf<V8PackCompaction>()
expectTypeOf(
  compactV8Packs('/cache/t', { maxPacks: 4, repeatedShare: 0.5 }),
).toEqualTypeOf<V8PackCompaction>()
expectTypeOf<V8PackCompactionOptions>().toEqualTypeOf<{
  readonly maxPacks?: number
  readonly repeatedShare?: number
}>()
// @ts-expect-error: the directory is required
compactV8Packs()

expectTypeOf<V8CacheError['code']>().toEqualTypeOf<V8CacheErrorCode>()
expectTypeOf<V8CacheErrorCode>().toEqualTypeOf<'V8_CACHE_KEY_INVALID'>()
expectTypeOf(new V8CacheError('V8_CACHE_KEY_INVALID', 'a key')).toExtend<Error>()
// @ts-expect-error: the code is one of V8CacheErrorCode
new V8CacheError('V8_CACHE_OTHER', 'a key')
