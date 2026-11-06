// The Jest dialect's mock-hoisting policy (T3.4, T1.8's Jest half): the rules of
// `babel-plugin-jest-hoist` 30.5.0 as typed values for the one neutral engine in
// `@provino/transform`. Every value is checked against the real plugin by the harness's hoist
// corpus; "hoist corpus agrees" is a claim `hoist-corpus.test.ts` makes true. B14 verifies each
// `unverified` entry against a recorded fixture (non-negotiable 2).
import { defineHoistPolicy } from '@provino/policy'
import type { HoistPolicy } from '@provino/types'

/**
 * The names a factory may read: the plugin's `ALLOWED_IDENTIFIERS` set, which adds every own name
 * of `globalThis` to a fixed list when the plugin loads. That second half depends on the Node
 * running the transform, so it is pinned here as data instead of computed: these are the names on
 * Node 24.22.1 (`Object.getOwnPropertyNames(globalThis)` plus the plugin's own list, deduplicated
 * and sorted as the plugin sorts them). A different Node would add or drop a few; the corpus runs
 * the real plugin on the same Node, so a drift that matters shows there.
 */
const ALLOWED_IDENTIFIERS = [
  'AbortController',
  'AbortSignal',
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'AsyncDisposableStack',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Blob',
  'Boolean',
  'BroadcastChannel',
  'Buffer',
  'ByteLengthQueuingStrategy',
  'CloseEvent',
  'CompressionStream',
  'CountQueuingStrategy',
  'Crypto',
  'CryptoKey',
  'CustomEvent',
  'DOMException',
  'DataView',
  'Date',
  'DecompressionStream',
  'DisposableStack',
  'Error',
  'EvalError',
  'Event',
  'EventTarget',
  'File',
  'FinalizationRegistry',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'FormData',
  'Function',
  'Generator',
  'GeneratorFunction',
  'Headers',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'InternalError',
  'Intl',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'MessageChannel',
  'MessageEvent',
  'MessagePort',
  'NaN',
  'Navigator',
  'Number',
  'Object',
  'Performance',
  'PerformanceEntry',
  'PerformanceMark',
  'PerformanceMeasure',
  'PerformanceObserver',
  'PerformanceObserverEntryList',
  'PerformanceResourceTiming',
  'Promise',
  'Proxy',
  'RangeError',
  'ReadableByteStreamController',
  'ReadableStream',
  'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest',
  'ReadableStreamDefaultController',
  'ReadableStreamDefaultReader',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'SharedArrayBuffer',
  'String',
  'SubtleCrypto',
  'SuppressedError',
  'Symbol',
  'SyntaxError',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoder',
  'TextEncoderStream',
  'TransformStream',
  'TransformStreamDefaultController',
  'TypeError',
  'URIError',
  'URL',
  'URLPattern',
  'URLSearchParams',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'WebAssembly',
  'WebSocket',
  'WritableStream',
  'WritableStreamDefaultController',
  'WritableStreamDefaultWriter',
  '__dirname',
  '__filename',
  'arguments',
  'atob',
  'btoa',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'eval',
  'expect',
  'exports',
  'fetch',
  'global',
  'globalThis',
  'isFinite',
  'isNaN',
  'jest',
  'module',
  'navigator',
  'parseFloat',
  'parseInt',
  'performance',
  'process',
  'queueMicrotask',
  'require',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'structuredClone',
  'undefined',
  'unescape',
] as const

/**
 * Jest 30.5's mock-hoisting policy.
 * @public
 */
export const jestHoistPolicy: HoistPolicy<
  'mock' | 'unmock' | 'deepUnmock' | 'enableAutomock' | 'disableAutomock',
  never
> = defineHoistPolicy({
  id: 'jest-30.5',
  // unverified: track-03 L612 (hoist corpus agrees). index.ts `isJestObject`: the unshadowed
  // global, `import { jest } from '@jest/globals'` under any alias, and `G.jest` for a namespace
  // import of `@jest/globals`.
  objects: [
    { kind: 'global', name: 'jest' },
    { kind: 'import', module: '@jest/globals', exportName: 'jest' },
    { kind: 'namespace-member', module: '@jest/globals', exportName: 'jest' },
  ],
  // unverified: track-03 L612 (hoist corpus agrees). index.ts `FUNCTIONS`; `doMock` and
  // `dontMock` are not listed, so they never hoist.
  hoistCalls: {
    mock: 'path-factory-options',
    unmock: 'one-string',
    deepUnmock: 'one-string',
    enableAutomock: 'no-args',
    disableAutomock: 'no-args',
  },
  // unverified: track-03 L612 (hoist corpus agrees). Jest has no hoisted values.
  hoistValues: [],
  // unverified: track-03 L612 (hoist corpus agrees). Jest does not read `import()` arguments.
  rewriteImportArg: [],
  // unverified: track-03 L612 (hoist corpus agrees). `jest.mock(a).mock(b)` hoists as one.
  chainable: true,
  // unverified: track-03 L612 (hoist corpus agrees). Each call goes to the top of its own block.
  placement: 'enclosing-block',
  topLevelGuards: [],
  // unverified: track-03 L612 (hoist corpus agrees). index.ts `FUNCTIONS.mock`: a global on the
  // allow list, a name matching `/^mock/i`, or Istanbul's `/^(?:__)?cov/` (case sensitive, so the
  // two are spelled out in one pattern rather than given a flag), or a pure `const` hoisted along.
  factoryReferences: {
    allowGlobals: new Set<string>(ALLOWED_IDENTIFIERS),
    allowPattern: /^(?:[mM][oO][cC][kK]|(?:__)?cov)/,
    hoistPureConsts: true,
  },
  // unverified: track-03 L612 (hoist corpus agrees). `JEST_GLOBALS_MODULE_NAME`.
  runnerModules: ['@jest/globals'],
  // unverified: track-03 L612 (hoist corpus agrees; Babel's CJS step keeps source order)
  reExports: 'in-order',
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
    // The plugin has no errors for these three: it hoists within blocks, allows nested calls, and
    // never looks at exports. Under `enclosing-block` placement the engine cannot report them.
    HOIST_NOT_TOP_LEVEL: 'Jest hoists within the enclosing block; {call} has no top-level rule.',
    HOIST_NESTED: 'Jest allows {call} inside another hoisted call.',
    HOIST_EXPORTED: 'Jest does not restrict exporting the result of {call}.',
  },
})
