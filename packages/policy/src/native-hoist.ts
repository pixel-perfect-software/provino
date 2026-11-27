import type { HoistPolicy } from '@provino/types'
import { defineHoistPolicy } from './dialect.ts'

/**
 * The native API's calls the hoister moves (B27j): the one list both `hoistCalls` and
 * `importedCalls` come from, so a call can't be recognised without a rule, or ruled and never
 * recognised.
 * @public
 */
export const NATIVE_HOISTED_CALLS: readonly ['mock', 'unmock'] = ['mock', 'unmock'] as const

/**
 * The native API's calls whose callback is a scope of its own for hoisting (B28,
 * `HoistPolicy.callbackScopes`): a `mock` written in the callback moves to the top of it, so it
 * is registered before the isolated loads that follow it.
 * @public
 */
export const NATIVE_CALLBACK_SCOPES: readonly ['isolateModules', 'isolateModulesAsync'] = [
  'isolateModules',
  'isolateModulesAsync',
] as const

/**
 * A name in `NATIVE_HOISTED_CALLS`.
 * @public
 */
export type NativeHoistedCall = (typeof NATIVE_HOISTED_CALLS)[number]

/**
 * The native API's mock hoisting (B27j, D202): `mock` and `unmock` imported from `module` (the
 * specifier the native runtime serves, `'provino'`: `NativeRuntimeRefs.modules`) move above the
 * file's imports, under any local name or through `import * as p`, so a mock is registered before
 * any module it replaces loads. Provino's own values (no ground truth applies), each chosen for the
 * reason beside it. `provino` builds it for `NativeRuntimeRefs.hoist`; `@provino/config` passes it
 * on for a project with no dialect.
 * @public
 */
export function nativeHoistPolicy(module: string): HoistPolicy<NativeHoistedCall, never> {
  return defineHoistPolicy<NativeHoistedCall, never>({
    // Part of the transform cache's fingerprint: bump it when a value here changes.
    id: `provino-native-2:${module}`,
    // No mock object: each call is a named import itself (import-aware, never a global name).
    objects: [],
    // Every top-level call hoists whatever its arguments; the API checks them when it runs, with a
    // code (`API_MOCK_SPECIFIER`, `API_MOCK_FACTORY`), so nothing stays behind silently.
    hoistCalls: { mock: 'any', unmock: 'any' },
    importedCalls: NATIVE_HOISTED_CALLS.map((exportName) => ({ module, exportName })),
    // A `mock` inside `isolateModules(() => { … })` moves to the top of the callback, not of the
    // file, so it runs before the callback's own imports. The registration is the file's, as any
    // other is (it outlives the callback); only the mock's value is the isolation's overlay.
    callbackScopes: NATIVE_CALLBACK_SCOPES.map((exportName) => ({ module, exportName })),
    hoistValues: [],
    rewriteImportArg: [],
    chainable: false,
    // A call nested in a function or block fails the file: it would run before the code around it.
    // The one exception is the callback of `callbackScopes`, above.
    placement: 'top-level-only',
    topLevelGuards: [],
    // Not checked here. A factory runs when the module it replaces first loads, which is during the
    // file's imports: it can read the `provino` import (kept static), globals and `importOriginal`,
    // and an import that has loaded by then; reading a later import or a top-level binding of the
    // file is a TDZ error, which the API rethrows as `API_MOCK_FACTORY_UNINITIALIZED` naming it.
    factoryReferences: 'allow',
    runnerModules: [module],
    // A mock applies to what `export … from` re-exports too: each loads in source order.
    reExports: 'in-order',
    // ES module semantics: a call through an imported binding has `this` undefined.
    rewrittenCalls: 'detached',
    messages: {
      // Never raised under `factoryReferences: 'allow'` and `hoistCalls` of `any`; worded anyway.
      HOIST_FACTORY_OUT_OF_SCOPE: '{call}(): the factory reads {name}, which it may not.',
      HOIST_FACTORY_NOT_FUNCTION: '{call}(): the factory must be a function.',
      HOIST_NOT_TOP_LEVEL:
        "{call}() must be called at the top level of the file: it is hoisted above the file's imports and runs before anything else in it, so a call inside a function or block would not run where it is written. Move it to the top level.",
      HOIST_NESTED:
        'Cannot call {call} inside {name}: both are hoisted to the top of the file and run before anything else in it.',
      HOIST_EXPORTED: 'Cannot export the result of {call}(): it returns nothing.',
      HOIST_EXPORTED_VALUE: 'Cannot export the result of {call}(): it returns nothing.',
    },
  })
}
