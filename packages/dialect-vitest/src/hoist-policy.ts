// The Vitest dialect's mock-hoisting rules (T3.4), from `@vitest/mocker` 5.0.5 `hoistMocks.ts` and
// `hoistMocksPlugin.ts`, moved here from the harness (B13b). The hoist corpus
// (`@provino/harness`'s `hoist-corpus.test.ts`) runs every case through the real hoister and
// ours, and flips each key; `src/policy-truth/claims/hoist.ts` there lists the evidence per key.
import type { HoistPolicy } from '@provino/types'

/**
 * Vitest 5.0's mock-hoisting policy.
 * @public
 */
export const vitestHoistPolicy: HoistPolicy = {
  // Ours: it only goes into the transform cache's fingerprint.
  id: 'vitest-5.0',
  // hoistMocks.ts L139: utilsObjectNames
  objects: [
    { kind: 'name', name: 'vi' },
    { kind: 'name', name: 'vitest' },
  ],
  // hoistMocks.ts L136: hoistableMockMethodNames
  hoistCalls: { mock: 'any', unmock: 'any' },
  // hoistMocks.ts L138: hoistedMethodNames
  hoistValues: ['hoisted'],
  // hoistMocks.ts L137: dynamicImportMockMethodNames
  rewriteImportArg: ['mock', 'unmock', 'doMock', 'doUnmock'],
  // `vi.mock(a).mock(b)` is not a hoisted chain. The engine never reads it under `top-level-only`.
  chainable: false,
  // hoistMocks.ts L531-L567
  placement: 'top-level-only',
  // hoistMocks.ts L266 (`isImportMetaVitestCheck`)
  topLevelGuards: ['import.meta.vitest'],
  // Factories may use imports (they are rewritten); no case can tell it from `forbid`'s allowances.
  factoryReferences: 'allow',
  // hoistMocks.ts L140 and L110
  runnerModules: ['vitest', 'vite-plus/test'],
  // hoistMocks.ts rewrites only ImportDeclaration
  reExports: 'static',
  // `mod-import-this`: a bare call and a tag through a named import see the namespace as `this`;
  // hoistMocks.ts L313 is a plain `s.update`.
  rewrittenCalls: 'member',
  messages: {
    // Vitest never raises these two: it allows factory references and takes any arguments.
    HOIST_FACTORY_OUT_OF_SCOPE: '',
    HOIST_FACTORY_NOT_FUNCTION: '',
    // hoistMocks.ts L551-L563, the one-call wording without the file and location
    HOIST_NOT_TOP_LEVEL:
      "{call} was defined outside of the module's top level scope. Although it appears nested, it will be hoisted and executed before anything in this file. Move it to the top level to reflect its actual execution order.\nSee: https://vitest.dev/guide/mocking/modules#how-it-works",
    // hoistMocks.ts L506-L510; `{call}` and `{name}` are the inner and outer calls, each with its
    // argument (`getNodeName`, L466-L481)
    HOIST_NESTED:
      'Cannot call {call} inside {name}: both methods are hoisted to the top of the file and not actually called inside each other.',
    // hoistMocks.ts L349 and L355 (`vi.mock`/`vi.unmock`)
    HOIST_EXPORTED:
      'Cannot export the result of "{call}". Remove export declaration because "{call}" doesn\'t return anything.',
    // hoistMocks.ts L438 and L445 (`vi.hoisted`)
    HOIST_EXPORTED_VALUE:
      'Cannot export hoisted variable. You can control hoisting behavior by placing the import from this file first.',
  },
}
