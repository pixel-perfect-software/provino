// The public API of @provino/env-node.
import {
  NodeEnvironmentError,
  type NodeEnvironmentErrorCode,
  nodeEnvironment,
} from '@provino/env-node'
import type { Environment, EnvironmentInstance, EnvironmentRealm } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(nodeEnvironment).toEqualTypeOf<Environment<'node'>>()
expectTypeOf(nodeEnvironment.name).toEqualTypeOf<'node'>()
expectTypeOf(nodeEnvironment.realms).toEqualTypeOf<readonly EnvironmentRealm[]>()
expectTypeOf<NodeEnvironmentError['code']>().toEqualTypeOf<NodeEnvironmentErrorCode>()
// A global it cannot restore is reported by `teardown` (D22), so the only error is the realm one.
expectTypeOf<NodeEnvironmentErrorCode>().toEqualTypeOf<'ENV_NODE_REALM_UNSUPPORTED'>()
expectTypeOf<NodeEnvironmentError>().not.toHaveProperty('failures')
// The instance its `setup` returns tears down with the contract's report, or nothing.
expectTypeOf<ReturnType<typeof nodeEnvironment.setup>>().toEqualTypeOf<
  EnvironmentInstance | Promise<EnvironmentInstance>
>()

declare function useJsdom(environment: Environment<'jsdom'>): void

// @ts-expect-error the node environment is not the jsdom one
useJsdom(nodeEnvironment)
// @ts-expect-error not a code
new NodeEnvironmentError('ENV_NODE_NOPE', 'message')
// @ts-expect-error a restore failure is reported by teardown, not thrown (D22)
new NodeEnvironmentError('ENV_NODE_RESTORE_FAILED', 'message')
// @ts-expect-error the name is read-only
nodeEnvironment.name = 'node'
