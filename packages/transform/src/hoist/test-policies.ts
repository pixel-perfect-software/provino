// Small inline policies for the engine's own tests: one rule at a time, in the shape of the two
// policies the research describes (Track 3 F4). They are not the dialects' values (those live in
// the dialect packages and are checked against the real hoisters by the harness's hoist corpus).
import type { HoistPolicy } from '@provino/types'

const MESSAGES = {
  HOIST_FACTORY_OUT_OF_SCOPE: 'out of scope: {name} in {call}',
  HOIST_NOT_TOP_LEVEL: '{call} is not at the top level',
  HOIST_NESTED: '{call} is inside another hoisted call',
  HOIST_EXPORTED: 'cannot export the result of {call}',
  HOIST_FACTORY_NOT_FUNCTION: 'the factory of {call} must be an inline function',
} as const

/** Enclosing-block placement, an argument rule per call, a factory allow list, pure consts. */
export const blockPolicy: HoistPolicy = {
  id: 'test-block',
  objects: [
    { kind: 'global', name: 'jest' },
    { kind: 'import', module: '@jest/globals', exportName: 'jest' },
    { kind: 'namespace-member', module: '@jest/globals', exportName: 'jest' },
  ],
  hoistCalls: {
    mock: 'path-factory-options',
    unmock: 'one-string',
    deepUnmock: 'one-string',
    enableAutomock: 'no-args',
    disableAutomock: 'no-args',
  },
  hoistValues: [],
  rewriteImportArg: [],
  chainable: true,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: {
    allowGlobals: new Set([
      'Array',
      'jest',
      'Object',
      'Promise',
      'Math',
      'JSON',
      'console',
      'expect',
      'require',
      'undefined',
    ]),
    allowPattern: /^(?:[mM][oO][cC][kK]|(?:__)?cov)/,
    hoistPureConsts: true,
  },
  runnerModules: ['@jest/globals'],
  reExports: 'in-order',
  messages: MESSAGES,
}

/** Top-level-only placement, `hoisted` values, `import()` arguments, a guard. */
export const topLevelPolicy: HoistPolicy = {
  id: 'test-top-level',
  objects: [
    { kind: 'name', name: 'vi' },
    { kind: 'name', name: 'vitest' },
  ],
  hoistCalls: { mock: 'any', unmock: 'any' },
  hoistValues: ['hoisted'],
  rewriteImportArg: ['mock', 'unmock', 'doMock', 'doUnmock'],
  chainable: false,
  placement: 'top-level-only',
  topLevelGuards: ['import.meta.vitest'],
  factoryReferences: 'allow',
  runnerModules: ['vitest'],
  reExports: 'static',
  messages: MESSAGES,
}
