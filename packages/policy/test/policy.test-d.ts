import {
  type BehaviourLoader,
  callBehaviour,
  createBehaviourLoader,
  defineDialect,
  diffPolicy,
  formatPolicyDiff,
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
