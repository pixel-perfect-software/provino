// The public API of @provino/dialect-vitest/vite-bridge (B25d).

import {
  type LoadedViteBridge,
  loadViteBridge,
  type ViteBridgeOptions,
  type ViteBridgePlugin,
  type ViteBridgeResult,
  type ViteJsxSettings,
  viteJsxSettings,
} from '@provino/dialect-vitest/vite-bridge'
import { expectTypeOf } from 'expect-type'

expectTypeOf(
  loadViteBridge({ root: '/p', configFile: false, mode: 'test' }),
).resolves.toEqualTypeOf<LoadedViteBridge>()
expectTypeOf<LoadedViteBridge['result']>().toEqualTypeOf<ViteBridgeResult>()
expectTypeOf<ViteBridgeResult['plugins']>().toEqualTypeOf<readonly ViteBridgePlugin[]>()
expectTypeOf<ViteBridgeResult['jsx']>().toEqualTypeOf<ViteJsxSettings | null>()
expectTypeOf<ViteJsxSettings['runtime']>().toEqualTypeOf<'automatic' | 'classic'>()
expectTypeOf<ViteBridgePlugin['version']>().toEqualTypeOf<string | null>()
expectTypeOf(viteJsxSettings({})).toEqualTypeOf<ViteJsxSettings | null>()

// @ts-expect-error: `mode` is required
loadViteBridge({ root: '/p', configFile: false })
// @ts-expect-error: `configFile` is a path or `false`
loadViteBridge({ root: '/p', configFile: true, mode: 'test' } satisfies ViteBridgeOptions)
// @ts-expect-error: the result is read-only
;({}) as ViteBridgeResult satisfies { plugins: ViteBridgePlugin[] }
