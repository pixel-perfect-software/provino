import {
  type BehaviourLoader,
  callBehaviour,
  defineDialect,
  diffPolicy,
  moduleRef,
  neutralPolicy,
  type PolicyDifference,
  resolvePolicy,
  serializePolicy,
} from '@provino/policy'
import type { Dialect, ModuleRef, Policy, SerializedPolicy, SnapshotKey } from '@provino/types'
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
