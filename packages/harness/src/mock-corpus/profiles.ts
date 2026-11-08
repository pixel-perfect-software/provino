// The `mock` policy slice for each recording profile, used to run the mocking corpus (T4.1) through
// `@provino/mock` (B13a). The Jest profile is the Jest dialect's own, so this corpus checks the
// dialect's values. Vitest's stand in for `@provino/dialect-vitest` until B14 (T1.8) builds it; the
// corpus goldens back the values they exercise, and T1.7 verifies every one, so each stays marked
// unverified (CLAUDE.md non-negotiable 2). Messages are `@vitest/spy` 5.0.5's dist text.
import { jestMockPolicy } from '@provino/dialect-jest'
import type { HoistPolicy, MockPolicy, ModulePolicy } from '@provino/types'
import type { FixtureProfile } from '../fixture.ts'

/**
 * Vitest 5.0's `mock` slice. Moves to `@provino/dialect-vitest` with T1.8 (B14a).
 * @public
 */
export const vitestMockPolicy: MockPolicy = {
  // unverified: track-01 L198, track-04 L256 (mock corpus `fn-clear-reset-restore` agrees)
  resetTo: 'original-impl',
  // unverified: track-01 L199, track-04 L253
  defaultName: 'vi.fn()',
  // unverified: track-01 L200, track-04 L275 (mock corpus `config-default` and `config-no-clear`
  // agree on `clear`; `config-reset`, `config-restore`, `config-unstub-envs` and
  // `config-unstub-globals` on their flags. `order` has no corpus backing: no case tells one order
  // from another)
  between: {
    order: ['restore', 'reset', 'clear', 'unstubEnvs', 'unstubGlobals'],
    clear: true,
    reset: false,
    restore: false,
    unstubEnvs: false,
    unstubGlobals: false,
  },
  // unverified: track-01 L201, track-04 L261 (mock corpus `fn-new` agrees)
  classMockPrototype: 'chain-to-impl',
  // unverified: track-04 L254
  spyNameFromMethod: true,
  // unverified: track-04 L255
  functionName: 'impl-or-Mock',
  // unverified: track-04 L257
  newCall: 'construct',
  // unverified: track-04 L258
  valueShorthandsThrowOnNew: true,
  // unverified: track-04 L259
  fnOfMockReturnsSame: true,
  // unverified: track-04 L260
  copyStaticProps: true,
  // unverified: track-04 L262
  settledResults: true,
  // unverified: track-04 L263
  lastCallKey: 'always',
  // unverified: track-04 L264
  clearReplacesStateObject: false,
  // unverified: track-04 L265
  mockPropertyWritable: false,
  // unverified: track-04 L266
  withImplementationReturnsMock: true,
  // unverified: track-04 L267
  getImplPrefersOnce: true,
  // unverified: track-04 L268
  spyReportsBridgeImpl: false,
  // unverified: track-04 L269
  isMockAcceptsObjects: false,
  // unverified: track-04 L270
  spyInstall: 'define',
  // unverified: track-04 L271 (`@vitest/spy` 5.0.5 dist text)
  messages: {
    'spy-nullish':
      'The vi.spyOn() function could not find an object to spy upon. The first argument must be defined.',
    'spy-define-primitive': 'Vitest cannot spy on a primitive value.',
    'spy-define-missing': 'The property "{key}" is not defined on the {type}.',
    'spy-define-not-a-function': 'vi.spyOn() can only spy on a function. Received {type}.',
    'spy-namespace':
      'Cannot spy on export "{key}". Module namespace is not configurable in ESM. See: https://vitest.dev/guide/mocking/modules#mocking-a-module',
    'new-shorthand':
      'Cannot use `{name}` when called with `new`. Use `mockImplementation` with a `class` keyword instead. See https://vitest.dev/api/mock#class-support for more information.',
    'new-not-a-constructor':
      "[vitest] The {name} mock did not use 'function' or 'class' in its implementation, see https://vitest.dev/api/vi#vi-spyon for examples.",
  },
}

/**
 * Vitest 5.0's mock-hoisting rules (T3.4), from `@vitest/mocker` 5.0.5 `hoistMocks.ts` and
 * `hoistMocksPlugin.ts`. Moves to `@provino/dialect-vitest` with T1.8 (B14a), which also verifies
 * each value against a recorded fixture. The hoist corpus (`hoist-corpus.test.ts`) checks that
 * hoisting under these values agrees with the real hoister on every upstream case.
 * @public
 */
export const vitestHoistPolicy: HoistPolicy = {
  // unverified: track-03 L612. No check can prove it: it only goes into the cache fingerprint.
  id: 'vitest-5.0',
  // unverified: track-03 L612 (hoist corpus agrees). hoistMocks.ts L139: utilsObjectNames
  objects: [
    { kind: 'name', name: 'vi' },
    { kind: 'name', name: 'vitest' },
  ],
  // unverified: track-03 L612 (hoist corpus agrees). hoistMocks.ts L136: hoistableMockMethodNames
  hoistCalls: { mock: 'any', unmock: 'any' },
  // unverified: track-03 L612 (hoist corpus agrees). hoistMocks.ts L138: hoistedMethodNames
  hoistValues: ['hoisted'],
  // unverified: track-03 L612 (hoist corpus agrees). hoistMocks.ts L137: dynamicImportMockMethodNames
  rewriteImportArg: ['mock', 'unmock', 'doMock', 'doUnmock'],
  // unverified: track-03 L612. `vi.mock(a).mock(b)` is not a hoisted chain. No check can prove it:
  // the engine never reads `chainable` under `top-level-only` (`UNPROVABLE` in the hoist corpus).
  chainable: false,
  // unverified: track-03 L612 (hoist corpus agrees). hoistMocks.ts L531-L567
  placement: 'top-level-only',
  // unverified: track-03 L612 (hoist corpus agrees). hoistMocks.ts L266 (`isImportMetaVitestCheck`)
  topLevelGuards: ['import.meta.vitest'],
  // unverified: track-03 L612. Factories may use imports (they are rewritten). No check can prove
  // it: no flip fails (`UNPROVABLE` in the hoist corpus).
  factoryReferences: 'allow',
  // unverified: track-03 L612 (hoist corpus agrees). hoistMocks.ts L140 and L110
  runnerModules: ['vitest', 'vite-plus/test'],
  reExports: 'static', // unverified: track-03 L612 (hoist corpus agrees; hoistMocks.ts rewrites only ImportDeclaration)
  // unverified: mod-import-this (the golden agrees: a bare call and a tag through a named import
  // see the namespace as `this`; hoistMocks.ts L313 is a plain `s.update`)
  rewrittenCalls: 'member',
  messages: {
    // Vitest never raises these two: it allows factory references and takes any arguments.
    HOIST_FACTORY_OUT_OF_SCOPE: '',
    HOIST_FACTORY_NOT_FUNCTION: '',
    // unverified: hoistMocks.ts L551-L563, the one-call wording without the file and location
    HOIST_NOT_TOP_LEVEL:
      "{call} was defined outside of the module's top level scope. Although it appears nested, it will be hoisted and executed before anything in this file. Move it to the top level to reflect its actual execution order.\nSee: https://vitest.dev/guide/mocking/modules#how-it-works",
    // unverified: hoistMocks.ts L506-L510; `{call}` and `{name}` are the inner and outer calls, each
    // with its argument (`getNodeName`, L466-L481)
    HOIST_NESTED:
      'Cannot call {call} inside {name}: both methods are hoisted to the top of the file and not actually called inside each other.',
    // unverified: hoistMocks.ts L349 and L355 (`vi.mock`/`vi.unmock`)
    HOIST_EXPORTED:
      'Cannot export the result of "{call}". Remove export declaration because "{call}" doesn\'t return anything.',
    // unverified: hoistMocks.ts L438 and L445 (`vi.hoisted`)
    HOIST_EXPORTED_VALUE:
      'Cannot export hoisted variable. You can control hoisting behavior by placing the import from this file first.',
  },
}

/**
 * Vitest 5.0's `module` slice, for the mod corpus (T4.7). Moves to `@provino/dialect-vitest` with
 * T1.8 (B14a). The texts are copied from `.refs/vitest` (v5.0.5); the two with `{raw}` carry the
 * specifier as written.
 * @public
 */
export const vitestModulePolicy: ModulePolicy = {
  // unverified: track-04 L308 (mod corpus agrees)
  factoryShape: 'namespace',
  // unverified: track-04 L311 (mod corpus agrees)
  rootMocksAutoApply: false,
  // unverified: track-01 L209
  automock: false,
  // unverified: track-01 L210
  actual: 'async-import',
  // unverified: track-01 L213
  resetModulesBetween: false,
  // unverified: track-01 L214
  injectCjsGlobals: true,
  // unverified: track-02 L452 (mod corpus agrees: Node's namespaces, not Babel's; the track says
  // `babel`, the goldens `node`)
  interopDefault: 'node',
  // unverified: track-02 L454
  resetModulesClearsMocks: false,
  // unverified: track-04 L309 (mod corpus agrees)
  awaitFactory: true,
  // unverified: track-04 L310 (mod corpus agrees)
  missingFactoryExport: 'throw',
  // unverified: track-04 L313 (mod corpus agrees)
  requireVirtualFlag: false,
  // unverified: mod corpus `mod-missing`, `mod-virtual` and `mod-virtual-static` (agree)
  virtualRelative: false,
  // Recorded: `mod-reregister` (a second `doMock` after a load gives the next load the second
  // factory's value) and `mod-reset-modules` (`resetModules()` keeps a mock's value), Vitest 5.0.5:
  // the value is on the registered mock.
  mockValueOwner: 'registration',
  // unverified: track-04 L314 (mod corpus agrees)
  automockShape: 'deep',
  // unverified: track-04 L316
  unmockedPathPatterns: [],
  // unverified: track-04 (mod corpus agrees)
  messages: {
    // packages/mocker/src/registry.ts L308-L310 (`assertValidExports`)
    'factory-not-object':
      '[vitest] vi.mock("{raw}", factory?: () => unknown) is not returning an object. Did you mean to return an object with a "default" key?',
    // packages/vitest/src/runtime/moduleRunner/moduleMocker.ts L104-L106 (the code frame that
    // follows it is a separate `codeFrame` property there)
    'missing-factory-export':
      '[vitest] No "{name}" export is defined on the "{raw}" mock. Did you forget to return it from "vi.mock"?\nIf you need to partially mock a module, you can use "importOriginal" helper inside:\n',
    // Vite's module runner raises it for the file that is not there (not in `.refs/vitest`): the
    // text is the recorded one, `mod-missing` and `mod-virtual` (vitest). `{id}` is root-relative.
    'unresolved-relative-mock': "Cannot find module '{id}'",
    // The loader's (B13c Gap 4): when the test file fails to load on that mock, the module runner
    // names the importer; an import from inside a test doesn't (`mod-virtual-static`, `mod-missing`).
    'unresolved-mock-import': '{message} imported from {importer}',
    // packages/mocker/src/registry.ts L298-L300 (`createHelpfulError`; the original is the cause)
    'factory-error':
      '[vitest] There was an error when mocking a module. If you are using "vi.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file. Read more: https://vitest.dev/api/vi.html#vi-mock',
  },
}

/** The `mock` policy a recording profile stands for. */
export const mockPolicyFor: Readonly<Record<FixtureProfile, MockPolicy>> = {
  jest: jestMockPolicy,
  vitest: vitestMockPolicy,
  'vitest-list': vitestMockPolicy,
}
