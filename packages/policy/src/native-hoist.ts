import type { HoistPolicy } from '@provino/types'

/**
 * The specifier the native API is served as (`NativeRuntimeRefs.modules`): the hoister recognises
 * `mock` and `unmock` imported from it.
 */
const NATIVE_MODULE = 'provino'

/**
 * The native API's mock hoisting (B27j, D202): `mock` and `unmock` imported from `provino`
 * (under any local name, or through `import * as p`) move above the file's imports, so a mock is
 * registered before any module it replaces loads. Provino's own values (no ground truth applies;
 * `native-hoist.test.ts` pins them), each chosen for the reason beside it. `@provino/config`
 * applies it to a project with no dialect when the caller gives the native runtime.
 * @public
 */
export const nativeHoistPolicy: HoistPolicy = Object.freeze({
  // Part of the transform cache's fingerprint: bump it when a value here changes.
  id: 'provino-native-1',
  // Import-aware, not a global name: a local `mock` of the test's own is never hoisted.
  objects: Object.freeze([
    Object.freeze({ kind: 'imported-call', module: NATIVE_MODULE, exportName: 'mock' } as const),
    Object.freeze({ kind: 'imported-call', module: NATIVE_MODULE, exportName: 'unmock' } as const),
  ]),
  // Every top-level call hoists whatever its arguments; the API checks them when it runs, with a
  // code (`API_MOCK_SPECIFIER`, `API_MOCK_FACTORY`), so nothing stays behind silently.
  hoistCalls: Object.freeze({ mock: 'any', unmock: 'any' } as const),
  hoistValues: Object.freeze([]),
  rewriteImportArg: Object.freeze([]),
  chainable: false,
  // A call nested in a function or block fails the file: it would run before the code around it.
  placement: 'top-level-only',
  topLevelGuards: Object.freeze([]),
  // A factory runs after the imports it reads have been rewritten to late imports, so it may read
  // any of them (and `fn` from `provino`, which stays static).
  factoryReferences: 'allow',
  runnerModules: Object.freeze([NATIVE_MODULE]),
  // A mock applies to what `export … from` re-exports too: each loads in source order.
  reExports: 'in-order',
  // ES module semantics: a call through an imported binding has `this` undefined.
  rewrittenCalls: 'detached',
  messages: Object.freeze({
    HOIST_FACTORY_OUT_OF_SCOPE: '{call}(): the factory reads {name}, which it may not.',
    HOIST_FACTORY_NOT_FUNCTION: '{call}(): the factory must be a function.',
    HOIST_NOT_TOP_LEVEL:
      "{call}() must be called at the top level of the file: it is hoisted above the file's imports and runs before anything else in it, so a call inside a function or block would not run where it is written. Move it to the top level.",
    HOIST_NESTED:
      'Cannot call {call} inside {name}: both are hoisted to the top of the file and run before anything else in it.',
    HOIST_EXPORTED: 'Cannot export the result of {call}(): it returns nothing.',
    HOIST_EXPORTED_VALUE: 'Cannot export the result of {call}(): it returns nothing.',
  }),
})
