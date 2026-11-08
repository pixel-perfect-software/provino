import {
  type BehaviourLoader,
  callBehaviour,
  createBehaviourLoader,
  defineDialect,
  defineHoistPolicy,
  diffPolicy,
  forEachModuleRef,
  formatPolicyDiff,
  isImportableLocation,
  isModuleRef,
  moduleRef,
  neutralPolicy,
  type PolicyDifference,
  PolicyError,
  type PolicyErrorCode,
  resolvePolicy,
  serializePolicy,
} from '@provino/policy'
import { environmentConditions, formatEachTitle, snapshotKey } from '@provino/policy/behaviours'
import type {
  Dialect,
  EnvironmentConditions,
  FormatEachTitle,
  HoistArgRule,
  HoistPolicy,
  ModuleRef,
  Policy,
  SerializedPolicy,
  SnapshotKey,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

interface AcmeOptions {
  readonly strict: boolean
}

// The name stays a literal, with no `as const`.
const plain = defineDialect({
  name: 'acme',
  version: '1.0',
  policy: { core: { nameSeparator: '/' } },
})
expectTypeOf(plain).toEqualTypeOf<Dialect<'acme', undefined>>()

// isolatedDeclarations: an exported dialect is annotated.
export const withOptions: Dialect<'acme', AcmeOptions> = defineDialect({
  name: 'acme',
  version: '1.0',
  policy: (options: AcmeOptions) => ({
    core: { allowOnly: options.strict ? 'not-in-ci' : 'always' },
  }),
})

defineDialect({
  name: 'acme',
  version: '1.0',
  // @ts-expect-error unknown slice
  policy: { reporter: {} },
})
defineDialect({
  name: 'acme',
  version: '1.0',
  // @ts-expect-error not a HookOrder
  policy: { core: { hookOrder: { afterAll: 'stack' } } },
})
defineDialect({
  name: 'acme',
  version: '1.0',
  // @ts-expect-error wrong behaviour signature
  policy: { snapshot: { key: (n: number) => n } },
})
// @ts-expect-error a dialect needs a version
defineDialect({ name: 'acme', policy: {} })

expectTypeOf(neutralPolicy).toEqualTypeOf<Policy>()
expectTypeOf(resolvePolicy()).toEqualTypeOf<Policy>()
expectTypeOf(serializePolicy).returns.toEqualTypeOf<SerializedPolicy>()
expectTypeOf(diffPolicy).returns.toEqualTypeOf<readonly PolicyDifference[]>()
// @ts-expect-error a layer is overrides, not a whole policy with a typo
resolvePolicy({ core: { nameSeperator: '/' } })

expectTypeOf(moduleRef<SnapshotKey>('m', 'e')).toEqualTypeOf<ModuleRef<SnapshotKey>>()

declare const loader: BehaviourLoader
declare const key: ModuleRef<SnapshotKey>
// The call is typed by the ref's function: arguments and result.
expectTypeOf(callBehaviour(loader, key, 'name', 1)).toEqualTypeOf<Promise<string>>()
expectTypeOf(callBehaviour(loader, async () => 1)).toEqualTypeOf<Promise<number>>()
// @ts-expect-error wrong argument type
callBehaviour(loader, key, 'name', '1')
// @ts-expect-error missing argument
callBehaviour(loader, key, 'name')

// formatPolicyDiff takes diffPolicy rows and two column labels.
expectTypeOf(formatPolicyDiff).parameter(0).toEqualTypeOf<readonly PolicyDifference[]>()
expectTypeOf(formatPolicyDiff).returns.toEqualTypeOf<string>()
formatPolicyDiff([], ['jest', 'vitest'])
// @ts-expect-error labels are a pair
formatPolicyDiff([], ['only one'])

// isModuleRef narrows.
declare const unknownValue: unknown
if (isModuleRef(unknownValue)) expectTypeOf(unknownValue).toEqualTypeOf<ModuleRef>()

// isImportableLocation takes a string and answers a boolean.
expectTypeOf(isImportableLocation).toEqualTypeOf<(location: string) => boolean>()
// @ts-expect-error a location is a string
isImportableLocation(1)

// forEachModuleRef hands the visitor a ModuleRef by default, and the guard's type when given one.
forEachModuleRef(unknownValue, 'policy', (ref, path) => {
  expectTypeOf(ref).toEqualTypeOf<ModuleRef>()
  expectTypeOf(path).toEqualTypeOf<string>()
})
forEachModuleRef<{ readonly module: unknown }>(
  unknownValue,
  'policy',
  (ref) => {
    expectTypeOf(ref).toEqualTypeOf<{ readonly module: unknown }>()
  },
  (value): value is { readonly module: unknown } => typeof value === 'object',
)
// @ts-expect-error the path is required
forEachModuleRef(unknownValue, () => {})
// @ts-expect-error the visitor's path is a string
forEachModuleRef(unknownValue, 'policy', (_ref, path: number) => path)

// createBehaviourLoader takes an optional importer that returns a module namespace.
expectTypeOf(createBehaviourLoader).returns.toEqualTypeOf<BehaviourLoader>()
createBehaviourLoader({ importModule: async () => ({ f: () => 1 }) })
// @ts-expect-error the importer must return a promise of a namespace
createBehaviourLoader({ importModule: () => 1 })

// PolicyError carries a typed code and an optional path.
declare const err: PolicyError
expectTypeOf(err.code).toEqualTypeOf<PolicyErrorCode>()
expectTypeOf(err.path).toEqualTypeOf<string | undefined>()
// @ts-expect-error not a PolicyErrorCode
new PolicyError('POLICY_TYPO', 'x')

// The behaviours subpath exports the neutral behaviour keys' implementations.
expectTypeOf(formatEachTitle).toEqualTypeOf<FormatEachTitle>()
expectTypeOf(snapshotKey).toEqualTypeOf<SnapshotKey>()
expectTypeOf(environmentConditions).toEqualTypeOf<EnvironmentConditions>()

// defineHoistPolicy (Track 3 L563) keeps the literal names of hoisted calls and values.
const messages = {
  HOIST_FACTORY_OUT_OF_SCOPE: '',
  HOIST_NOT_TOP_LEVEL: '',
  HOIST_NESTED: '',
  HOIST_EXPORTED: '',
  HOIST_EXPORTED_VALUE: '',
  HOIST_FACTORY_NOT_FUNCTION: '',
} as const
const hoist = defineHoistPolicy({
  id: 'x',
  objects: [{ kind: 'name', name: 'vi' }],
  hoistCalls: { mock: 'any', unmock: 'one-string' },
  hoistValues: ['hoisted'],
  rewriteImportArg: ['mock'],
  chainable: false,
  placement: 'top-level-only',
  topLevelGuards: ['import.meta.vitest'],
  factoryReferences: 'allow',
  runnerModules: ['vitest'],
  reExports: 'static',
  rewrittenCalls: 'member',
  messages,
})
expectTypeOf(hoist.hoistCalls).toEqualTypeOf<{
  readonly mock: HoistArgRule
  readonly unmock: HoistArgRule
}>()
expectTypeOf(hoist.hoistValues).toEqualTypeOf<readonly 'hoisted'[]>()
expectTypeOf(hoist).toExtend<HoistPolicy>()
defineHoistPolicy({
  id: 'x',
  objects: [],
  hoistCalls: { mock: 'any' },
  hoistValues: [],
  rewriteImportArg: [],
  chainable: false,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
  reExports: 'in-order',
  rewrittenCalls: 'detached',
  messages,
})
defineHoistPolicy({
  id: 'x',
  objects: [],
  // @ts-expect-error not an argument rule
  hoistCalls: { mock: 'sometimes' },
  hoistValues: [],
  rewriteImportArg: [],
  chainable: false,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
  reExports: 'in-order',
  rewrittenCalls: 'detached',
  messages,
})
defineHoistPolicy({
  id: 'x',
  objects: [],
  hoistCalls: {},
  hoistValues: [],
  rewriteImportArg: [],
  chainable: false,
  // @ts-expect-error not a placement
  placement: 'anywhere',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
  reExports: 'in-order',
  rewrittenCalls: 'detached',
  messages,
})
defineHoistPolicy({
  id: 'x',
  objects: [],
  hoistCalls: {},
  hoistValues: [],
  rewriteImportArg: [],
  chainable: false,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
  reExports: 'in-order',
  rewrittenCalls: 'detached',
  // @ts-expect-error every HOIST_* code needs a message
  messages: { HOIST_NESTED: '' },
})
defineHoistPolicy({
  id: 'x',
  objects: [],
  hoistCalls: {},
  hoistValues: [],
  rewriteImportArg: [],
  chainable: false,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
  reExports: 'in-order',
  // @ts-expect-error not a way to call through a rewritten import
  rewrittenCalls: 'bound',
  messages,
})
