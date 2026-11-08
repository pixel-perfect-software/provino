// The Jest dialect's mock-hoisting policy (T3.4, T1.8's Jest half): the rules of
// `babel-plugin-jest-hoist` 30.5.0 as typed values for the one neutral engine in
// `@provino/transform`. Every value is checked against the real plugin by the harness's hoist
// corpus; "hoist corpus agrees" is a claim `hoist-corpus.test.ts` makes true, and T1.7's
// `policy-truth/claims/module.ts` in the harness lists the evidence per key.
import { defineHoistPolicy } from '@provino/policy'
import type { HoistPolicy } from '@provino/types'

/**
 * The names a factory may read: the plugin's `ALLOWED_IDENTIFIERS` (index.ts L36-L96), its fixed list
 * plus every own name of `globalThis`, worked out when the module loads and sorted, as the plugin
 * does. So the list follows the Node running the transform, as real Jest's does.
 */
const ALLOWED_IDENTIFIERS: readonly string[] = [
  ...new Set([
    'Array',
    'ArrayBuffer',
    'Boolean',
    'BigInt',
    'DataView',
    'Date',
    'Error',
    'EvalError',
    'Float32Array',
    'Float64Array',
    'Function',
    'Generator',
    'GeneratorFunction',
    'Infinity',
    'Int16Array',
    'Int32Array',
    'Int8Array',
    'InternalError',
    'Intl',
    'JSON',
    'Map',
    'Math',
    'NaN',
    'Number',
    'Object',
    'Promise',
    'Proxy',
    'RangeError',
    'ReferenceError',
    'Reflect',
    'RegExp',
    'Set',
    'String',
    'Symbol',
    'SyntaxError',
    'TypeError',
    'URIError',
    'Uint16Array',
    'Uint32Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'WeakMap',
    'WeakSet',
    'arguments',
    'console',
    'expect',
    'isNaN',
    'jest',
    'parseFloat',
    'parseInt',
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    'undefined',
    ...Object.getOwnPropertyNames(globalThis),
  ]),
].toSorted()

/**
 * Jest 30.5's mock-hoisting policy.
 * @public
 */
export const jestHoistPolicy: HoistPolicy<
  'mock' | 'unmock' | 'deepUnmock' | 'enableAutomock' | 'disableAutomock',
  never
> = defineHoistPolicy({
  id: 'jest-30.5',
  // research: track-03 L612 (hoist corpus agrees). index.ts `isJestObject`: the unshadowed
  // global, `import { jest } from '@jest/globals'` under any alias, and `G.jest` for a namespace
  // import of `@jest/globals`.
  objects: [
    { kind: 'global', name: 'jest' },
    { kind: 'import', module: '@jest/globals', exportName: 'jest' },
    { kind: 'namespace-member', module: '@jest/globals', exportName: 'jest' },
  ],
  // research: track-03 L612 (hoist corpus agrees). index.ts `FUNCTIONS`; `doMock` and
  // `dontMock` are not listed, so they never hoist.
  hoistCalls: {
    mock: 'path-factory-options',
    unmock: 'one-string',
    deepUnmock: 'one-string',
    enableAutomock: 'no-args',
    disableAutomock: 'no-args',
  },
  // research: track-03 L612 (hoist corpus agrees). Jest has no hoisted values.
  hoistValues: [],
  // research: track-03 L612 (hoist corpus agrees). Jest does not read `import()` arguments.
  rewriteImportArg: [],
  // research: track-03 L612 (hoist corpus agrees). `jest.mock(a).mock(b)` hoists as one.
  chainable: true,
  // research: track-03 L612 (hoist corpus agrees). Each call goes to the top of its own block.
  placement: 'enclosing-block',
  topLevelGuards: [],
  // research: track-03 L612 (hoist corpus agrees). index.ts `FUNCTIONS.mock`: a global on the
  // allow list, a name matching `/^mock/i`, or Istanbul's `/^(?:__)?cov/` (case sensitive, so the
  // two are spelled out in one pattern rather than given a flag), or a pure `const` hoisted along.
  factoryReferences: {
    allowGlobals: new Set<string>(ALLOWED_IDENTIFIERS),
    allowPattern: /^(?:[mM][oO][cC][kK]|(?:__)?cov)/,
    hoistPureConsts: true,
  },
  // research: track-03 L612 (hoist corpus agrees). `JEST_GLOBALS_MODULE_NAME`.
  runnerModules: ['@jest/globals'],
  // research: track-03 L612 (hoist corpus agrees; Babel's CJS step keeps source order)
  reExports: 'in-order',
  // research: mod-import-this (the golden agrees: a bare call and a tag through a named import
  // see `this` as `undefined`, Babel's `(0, _a.f)()`)
  rewrittenCalls: 'detached',
  // Copied exactly from babel-plugin-jest-hoist 30.5.0, `src/index.ts`. The plugin writes
  // `jest.mock` in its text whatever the receiver was called, so `{call}` is not used.
  messages: {
    // index.ts L186-L196: the `buildCodeFrameError` text (a ReferenceError there).
    HOIST_FACTORY_OUT_OF_SCOPE:
      'The module factory of `jest.mock()` is not allowed to ' +
      'reference any out-of-scope variables.\n' +
      'Invalid variable access: {name}\n' +
      `Allowed objects: ${ALLOWED_IDENTIFIERS.join(', ')}.\n` +
      'Note: This is a precaution to guard against uninitialized mock ' +
      'variables. If it is ensured that the mock is required lazily, ' +
      'variable names prefixed with `mock` (case insensitive) are permitted.\n',
    // index.ts L125-L128: the `buildCodeFrameError` text (a TypeError there).
    HOIST_FACTORY_NOT_FUNCTION: 'The second argument of `jest.mock` must be an inline function.\n',
    // The plugin has no errors for these: it hoists within blocks, allows nested calls, and never
    // looks at exports. Under `enclosing-block` placement the engine cannot report them.
    HOIST_NOT_TOP_LEVEL: 'Jest hoists within the enclosing block; {call} has no top-level rule.',
    HOIST_NESTED: 'Jest allows {call} inside another hoisted call.',
    HOIST_EXPORTED: 'Jest does not restrict exporting the result of {call}.',
    HOIST_EXPORTED_VALUE: 'Jest has no hoisted values; {call} is not one.',
  },
})
