// The public API of @provino/env-node.
import {
  NodeEnvironmentError,
  type NodeEnvironmentErrorCode,
  nodeEnvironment,
  type RestoreFailure,
} from '@provino/env-node'
import type { Environment, EnvironmentRealm } from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(nodeEnvironment).toEqualTypeOf<Environment<'node'>>()
expectTypeOf(nodeEnvironment.name).toEqualTypeOf<'node'>()
expectTypeOf(nodeEnvironment.realms).toEqualTypeOf<readonly EnvironmentRealm[]>()
expectTypeOf<NodeEnvironmentError['code']>().toEqualTypeOf<NodeEnvironmentErrorCode>()
expectTypeOf<NodeEnvironmentErrorCode>().toEqualTypeOf<
  'ENV_NODE_RESTORE_FAILED' | 'ENV_NODE_REALM_UNSUPPORTED'
>()
expectTypeOf<NodeEnvironmentError['failures']>().toEqualTypeOf<readonly RestoreFailure[]>()
expectTypeOf<RestoreFailure['key']>().toEqualTypeOf<string | symbol>()
expectTypeOf<RestoreFailure['action']>().toEqualTypeOf<'delete' | 'redefine'>()

declare function useJsdom(environment: Environment<'jsdom'>): void
declare function report(failure: RestoreFailure): void

// @ts-expect-error the node environment is not the jsdom one
useJsdom(nodeEnvironment)
// @ts-expect-error not a code
new NodeEnvironmentError('ENV_NODE_NOPE', 'message')
// @ts-expect-error the name is read-only
nodeEnvironment.name = 'node'
// @ts-expect-error a failure's action is delete or redefine
report({ key: 'x', action: 'skip' })
