// The public API of @provino/transform/vite (T3.9).

import {
  classifyViteId,
  createViteHost,
  type ViteHost,
  type ViteHostError,
  type ViteHostErrorCode,
  type ViteHostOptions,
  type VitePlugin,
  type VitePluginIdentity,
  type ViteResolvedId,
  type ViteSource,
  viteHostFingerprint,
} from '@provino/transform/vite'
import { expectTypeOf } from 'expect-type'

expectTypeOf<ViteHostErrorCode>().toEqualTypeOf<'VITE_HOOK_UNSUPPORTED' | 'VITE_PLUGIN_FAILED'>()
expectTypeOf<ViteHostError['code']>().toEqualTypeOf<ViteHostErrorCode>()
expectTypeOf<ViteHostError['plugin']>().toBeString()

declare const plugin: VitePlugin
const host = createViteHost({ root: '/p', plugins: [plugin] })
expectTypeOf(host).toEqualTypeOf<ViteHost>()
expectTypeOf(host.pluginNames).toEqualTypeOf<readonly string[]>()
expectTypeOf(host.resolveId('./a', undefined)).resolves.toEqualTypeOf<ViteResolvedId | null>()
expectTypeOf(host.load('/p/a.ts')).resolves.toEqualTypeOf<ViteSource | null>()
expectTypeOf(host.transform('', '/p/a.ts')).resolves.toEqualTypeOf<ViteSource | null>()
expectTypeOf(host.buildStart()).resolves.toBeVoid()

// A resolved id is a file, a virtual module only the host loads, or an external.
expectTypeOf<Extract<ViteResolvedId, { type: 'virtual' }>['owner']>().toEqualTypeOf<'vite-host'>()
expectTypeOf(classifyViteId('\0x', false)).toEqualTypeOf<ViteResolvedId>()

expectTypeOf(viteHostFingerprint([] as readonly VitePluginIdentity[], null)).toBeString()

// @ts-expect-error: `root` and `plugins` are required
createViteHost({})
// @ts-expect-error: `strict` is a boolean
createViteHost({ root: '/p', plugins: [], strict: 'yes' } satisfies ViteHostOptions)
// @ts-expect-error: a plugin has a name
createViteHost({ root: '/p', plugins: [{ enforce: 'pre' }] })
// @ts-expect-error: `enforce` is `pre` or `post`
createViteHost({ root: '/p', plugins: [{ name: 'p', enforce: 'mid' }] })
