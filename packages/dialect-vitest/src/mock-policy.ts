// The Vitest dialect's `mock` and `module` slices (T4.2, T1.8), moved here from the harness's mock
// corpus, where B13a and B13b recorded them. The evidence for each value is listed in
// `@provino/harness`'s `src/policy-truth/claims/` (T1.7): the `fixtures/mocking/` goldens through
// the mock and mod corpora, each value flipped and seen to fail. The messages are `@vitest/spy` and
// `@vitest/mocker` 5.0.5's text, copied from `.refs/vitest` (v5.0.5).
import type { MockPolicy, ModulePolicy } from '@provino/types'

/**
 * Vitest 5.0's `mock` slice.
 * @public
 */
export const vitestMockPolicy: MockPolicy = {
  resetTo: 'original-impl',
  defaultName: 'vi.fn()',
  // `order` is Vitest's own order of the cleanup steps (`vitest/src/runtime/runners/test.ts`);
  // no case can tell one order from another, so the claim says so.
  between: {
    order: ['restore', 'reset', 'clear', 'unstubEnvs', 'unstubGlobals'],
    clear: true,
    reset: false,
    restore: false,
    unstubEnvs: false,
    unstubGlobals: false,
  },
  classMockPrototype: 'chain-to-impl',
  spyNameFromMethod: true,
  functionName: 'impl-or-Mock',
  newCall: 'construct',
  valueShorthandsThrowOnNew: true,
  fnOfMockReturnsSame: true,
  copyStaticProps: true,
  settledResults: true,
  lastCallKey: 'always',
  clearReplacesStateObject: false,
  mockPropertyWritable: false,
  withImplementationReturnsMock: true,
  getImplPrefersOnce: true,
  spyReportsBridgeImpl: false,
  isMockAcceptsObjects: false,
  spyInstall: 'define',
  // `@vitest/spy` 5.0.5's dist text.
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
 * Vitest 5.0's `module` slice. The texts are copied from `.refs/vitest` (v5.0.5); the two with
 * `{raw}` carry the specifier as written.
 * @public
 */
export const vitestModulePolicy: ModulePolicy = {
  factoryShape: 'namespace',
  rootMocksAutoApply: false,
  automock: false,
  actual: 'async-import',
  resetModulesBetween: false,
  injectCjsGlobals: true,
  // Node's namespaces, not Babel's: Track 2 L452 said `babel`, the `mod-*` goldens say `node`.
  interopDefault: 'node',
  resetModulesClearsMocks: false,
  awaitFactory: true,
  missingFactoryExport: 'throw',
  requireVirtualFlag: false,
  virtualRelative: false,
  // `mod-reregister` and `mod-reset-modules`: the value is on the registered mock.
  mockValueOwner: 'registration',
  // Recorded, Vitest 5.0.5: `mod-conditions` (an `import`-only package mocks, a `require`-only one is not exported).
  mockResolveKind: 'import',
  // Not recorded yet (T11.16): an edge resolves as it is written.
  edgeResolveKind: 'as-written',
  // Not recorded yet (T11.16): no edge adds the `module-sync` condition.
  moduleSyncCondition: 'never',
  // Recorded, Vitest 5.0.5: `mod-shared-dep` and `mod-shared-dep-root` (a mock reaches only a direct import).
  mocksReachShared: false,
  // Recorded, Vitest 5.0.5: `module/vitest-externals-two-files` (with `isolate` on, its default,
  // each file has its own worker, so an externalized package that registers a hook as it loads
  // does so again in every file: D127). Compat; the faster option is one evaluation per worker.
  reevaluateHookingExternals: true,
  // Recorded, Vitest 5.0.5: `module/vitest-externals-two-files` (a package that writes the global
  // as it loads has written it again in the second file: D151). Compat, as above.
  reevaluatePatchingExternals: true,
  // Not recorded yet (T11.16): a frame keeps the name V8 gave it.
  stackFrameNames: 'engine',
  // Not recorded yet (T11.16): an externalized dependency loads through Node's loader as it is.
  nativeLoadPatches: 'apply',
  automockShape: 'deep',
  unmockedPathPatterns: [],
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
  // Vitest has no name mapper: a miss is a not-found.
  mapperMiss: null,
}
