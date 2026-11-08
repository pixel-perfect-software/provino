// The hoist corpus's flips (B13b): one or more per `HoistPolicy` key, each with an upstream case
// it must fail, and the keys no input can fail. `hoist-corpus.test.ts` runs every flip against the
// real hoisters; T1.7's `policy-truth.test.ts` takes a hoisting leaf as backed only when a flip
// here changes that leaf.
import { jestHoistPolicy } from '@provino/dialect-jest'
import type { HoistPolicy } from '@provino/types'
import { vitestHoistPolicy } from '../mock-corpus/profiles.ts'
import type { RunnerName } from './run-recorded.ts'

/** A policy key's flip and a case it must fail. */
export interface Flip {
  readonly key: keyof HoistPolicy
  readonly what: string
  readonly change: Partial<HoistPolicy>
  readonly caseName: string
}

function withoutObject(policy: HoistPolicy, kind: string, name?: string): Partial<HoistPolicy> {
  return {
    objects: policy.objects.filter(
      (matcher) =>
        matcher.kind !== kind || (name !== undefined && 'name' in matcher && matcher.name !== name),
    ),
  }
}

function withoutCall(policy: HoistPolicy, method: string): Partial<HoistPolicy> {
  return {
    hoistCalls: Object.fromEntries(
      Object.entries(policy.hoistCalls).filter(([name]) => name !== method),
    ),
  }
}

function withRule(policy: HoistPolicy, method: string, rule: 'any'): Partial<HoistPolicy> {
  return { hoistCalls: { ...policy.hoistCalls, [method]: rule } }
}

const REFERENCE_RULE = jestHoistPolicy.factoryReferences
if (REFERENCE_RULE === 'allow') throw new Error('Jest has a factory rule')

export const FLIPS: Readonly<Record<RunnerName, readonly Flip[]>> = {
  jest: [
    {
      key: 'objects',
      what: 'no global',
      change: withoutObject(jestHoistPolicy, 'global'),
      caseName: 'argument: mock: one string',
    },
    {
      key: 'objects',
      what: 'no named import',
      change: withoutObject(jestHoistPolicy, 'import'),
      caseName: 'object: an aliased import',
    },
    {
      key: 'objects',
      what: 'no namespace member',
      change: withoutObject(jestHoistPolicy, 'namespace-member'),
      caseName: 'object: a namespace import',
    },
    {
      key: 'objects',
      what: 'any binding named jest',
      change: { objects: [{ kind: 'name', name: 'jest' }] },
      caseName: 'object: a local const named jest',
    },
    {
      key: 'hoistCalls',
      what: 'no mock',
      change: withoutCall(jestHoistPolicy, 'mock'),
      caseName: 'argument: mock: one string',
    },
    {
      key: 'hoistCalls',
      what: 'no unmock',
      change: withoutCall(jestHoistPolicy, 'unmock'),
      caseName: 'argument: unmock: a string',
    },
    {
      key: 'hoistCalls',
      what: 'no deepUnmock',
      change: withoutCall(jestHoistPolicy, 'deepUnmock'),
      caseName: 'argument: deepUnmock: a string',
    },
    {
      key: 'hoistCalls',
      what: 'no enableAutomock',
      change: withoutCall(jestHoistPolicy, 'enableAutomock'),
      caseName: 'argument: enableAutomock: no arguments',
    },
    {
      key: 'hoistCalls',
      what: 'no disableAutomock',
      change: withoutCall(jestHoistPolicy, 'disableAutomock'),
      caseName: 'argument: disableAutomock: no arguments',
    },
    {
      key: 'hoistCalls',
      what: 'doMock hoists',
      change: withRule(jestHoistPolicy, 'doMock', 'any'),
      caseName: 'argument: doMock never moves',
    },
    {
      key: 'hoistCalls',
      what: 'dontMock hoists',
      change: withRule(jestHoistPolicy, 'dontMock', 'any'),
      caseName: 'argument: dontMock never moves',
    },
    {
      key: 'hoistCalls',
      what: 'mock takes any argument',
      change: withRule(jestHoistPolicy, 'mock', 'any'),
      caseName: 'argument: mock: one identifier stays',
    },
    {
      key: 'hoistCalls',
      what: 'unmock takes any argument',
      change: withRule(jestHoistPolicy, 'unmock', 'any'),
      caseName: 'argument: unmock: an identifier stays',
    },
    {
      key: 'hoistCalls',
      what: 'enableAutomock takes any argument',
      change: withRule(jestHoistPolicy, 'enableAutomock', 'any'),
      caseName: 'argument: enableAutomock: an argument stays',
    },
    {
      key: 'hoistValues',
      what: 'hoisted is a value',
      change: { hoistValues: ['hoisted'] },
      caseName: 'argument: hoisted is not a Jest call',
    },
    {
      key: 'rewriteImportArg',
      what: 'mock rewrites import()',
      change: { rewriteImportArg: ['mock'] },
      caseName: 'argument: mock: a dynamic import stays',
    },
    {
      key: 'chainable',
      what: 'no chains',
      change: { chainable: false },
      caseName: 'chain: two mocks',
    },
    {
      key: 'placement',
      what: 'top level only',
      change: { placement: 'top-level-only' },
      caseName: 'block: a function body',
    },
    {
      key: 'factoryReferences',
      what: 'anything allowed',
      change: { factoryReferences: 'allow' },
      caseName: 'factory: an unknown global is out of scope',
    },
    {
      key: 'factoryReferences',
      what: 'no globals allowed',
      change: { factoryReferences: { ...REFERENCE_RULE, allowGlobals: new Set() } },
      caseName: 'factory: an allow-listed global',
    },
    {
      key: 'factoryReferences',
      what: 'no pattern allowed',
      change: { factoryReferences: { ...REFERENCE_RULE, allowPattern: /$^/ } },
      caseName: 'factory: a mock-prefixed name',
    },
    {
      key: 'factoryReferences',
      what: 'the pattern is case sensitive',
      change: { factoryReferences: { ...REFERENCE_RULE, allowPattern: /^(?:mock|(?:__)?cov)/ } },
      caseName: 'factory: a mock-prefixed name of any case',
    },
    {
      key: 'factoryReferences',
      what: 'coverage names not allowed',
      change: { factoryReferences: { ...REFERENCE_RULE, allowPattern: /^mock/i } },
      caseName: 'factory: a coverage variable',
    },
    {
      key: 'factoryReferences',
      what: 'the pattern ignores case',
      change: { factoryReferences: { ...REFERENCE_RULE, allowPattern: /^(?:mock|(?:__)?cov)/i } },
      caseName: 'factory: a capitalized Cov is not coverage',
    },
    {
      key: 'factoryReferences',
      what: 'no pure consts',
      change: { factoryReferences: { ...REFERENCE_RULE, hoistPureConsts: false } },
      caseName: 'const: a pure const a factory reads moves',
    },
    {
      key: 'runnerModules',
      what: 'no runner module',
      change: { runnerModules: [] },
      caseName: 'object: an aliased import',
    },
    {
      key: 'reExports',
      what: 'static',
      change: { reExports: 'static' },
      caseName: 're-export: imports and re-exports in order',
    },
    {
      key: 'rewrittenCalls',
      what: 'member',
      change: { rewrittenCalls: 'member' },
      caseName: 'this: a bare call through an import',
    },
  ],
  vitest: [
    {
      key: 'objects',
      what: 'no vi',
      change: withoutObject(vitestHoistPolicy, 'name', 'vi'),
      caseName: 'object: vi',
    },
    {
      key: 'objects',
      what: 'no vitest',
      change: withoutObject(vitestHoistPolicy, 'name', 'vitest'),
      caseName: 'object: vitest',
    },
    {
      key: 'objects',
      what: 'an alias from vitest counts',
      change: {
        objects: [
          ...vitestHoistPolicy.objects,
          { kind: 'import', module: 'vitest', exportName: 'vi' },
        ],
      },
      caseName: 'object: an alias of vi stays',
    },
    {
      key: 'hoistCalls',
      what: 'no mock',
      change: withoutCall(vitestHoistPolicy, 'mock'),
      caseName: 'object: vi',
    },
    {
      key: 'hoistCalls',
      what: 'no unmock',
      change: withoutCall(vitestHoistPolicy, 'unmock'),
      caseName: 'argument: unmock',
    },
    {
      key: 'hoistCalls',
      what: 'doMock hoists',
      change: withRule(vitestHoistPolicy, 'doMock', 'any'),
      caseName: 'argument: doMock stays',
    },
    {
      key: 'hoistValues',
      what: 'no hoisted',
      change: { hoistValues: [] },
      caseName: 'hoisted: a bare hoisted',
    },
    {
      key: 'rewriteImportArg',
      what: 'mock keeps import()',
      change: { rewriteImportArg: ['unmock', 'doMock', 'doUnmock'] },
      caseName: 'argument: an import argument',
    },
    {
      key: 'rewriteImportArg',
      what: 'unmock keeps import()',
      change: { rewriteImportArg: ['mock', 'doMock', 'doUnmock'] },
      caseName: 'argument: unmock with an import argument',
    },
    {
      key: 'rewriteImportArg',
      what: 'doMock keeps import()',
      change: { rewriteImportArg: ['mock', 'unmock', 'doUnmock'] },
      caseName: 'argument: doMock with an import argument stays',
    },
    {
      key: 'rewriteImportArg',
      what: 'doUnmock keeps import()',
      change: { rewriteImportArg: ['mock', 'unmock', 'doMock'] },
      caseName: 'argument: doUnmock with an import argument stays',
    },
    {
      key: 'placement',
      what: 'enclosing block',
      change: { placement: 'enclosing-block' },
      caseName: 'placement: a function',
    },
    {
      key: 'topLevelGuards',
      what: 'no guard',
      change: { topLevelGuards: [] },
      caseName: 'guard: a mock in a guard',
    },
    {
      key: 'runnerModules',
      what: 'no vitest',
      change: { runnerModules: ['vite-plus/test'] },
      caseName: 'object: vi imported from vitest',
    },
    {
      key: 'runnerModules',
      what: 'no vite-plus',
      change: { runnerModules: ['vitest'] },
      caseName: 'object: vi from vite-plus',
    },
    {
      key: 'reExports',
      what: 'in order',
      change: { reExports: 'in-order' },
      caseName: 're-export: a named re-export stays static',
    },
    {
      key: 'rewrittenCalls',
      what: 'detached',
      change: { rewrittenCalls: 'detached' },
      caseName: 'binding: a call through an import keeps the namespace',
    },
  ],
}

/** Keys with no flip, each with the reason no input could fail one. */
export const UNPROVABLE: Readonly<
  Record<RunnerName, Readonly<Partial<Record<keyof HoistPolicy, string>>>>
> = {
  jest: {
    id: 'names the policy for the cache key; the engine never reads it',
    messages: "the words, not the rules: codes are compared here, text in the transform's tests",
    topLevelGuards: 'only `top-level-only` placement reads it',
  },
  vitest: {
    id: 'names the policy for the cache key; the engine never reads it',
    messages: "the words, not the rules: codes are compared here, text in the transform's tests",
    chainable: 'only `enclosing-block` placement reads it, so its value changes nothing here',
    factoryReferences:
      'only a `path-factory-options` argument rule reads it, and Vitest has only `any`',
  },
}
