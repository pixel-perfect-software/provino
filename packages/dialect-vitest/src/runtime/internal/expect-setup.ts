// For `expect-table.test.ts` and `lazy-chai.ts` (not a test file): the Vitest table built and run through `@provino/expect` as the
// worker builds it, with no test running (every assertion counts into the file's state).
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
  type StateSource,
} from '@provino/expect'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { CurrentTest, ExpectStatic, ExpectTable } from '@provino/types'
import { vitestPolicy } from '../../dialect.ts'

/** The Vitest dialect's `expect`, its table and the state it counts into. */
export interface VitestExpect {
  readonly expect: ExpectStatic
  readonly table: ExpectTable
  readonly source: StateSource
}

/** Installs the slot, loads the table by the policy's ref and builds `expect` over it. */
export async function setUpVitestExpect(): Promise<VitestExpect> {
  const policy = resolvePolicy(vitestPolicy).expect
  if (policy.matcherTable === null) throw new Error('the Vitest policy has no matcher table')
  const source = createStateSource({ get: () => undefined } as unknown as CurrentTest, {
    nameSeparator: ' > ',
    expand: policy.expand,
    outsideTestCounts: policy.outsideTestCounts,
  })
  const registry = createMatcherRegistry()
  installMatchersSlot(source, registry)
  const table = (await createBehaviourLoader().load(policy.matcherTable))()
  return { expect: createExpect({ policy, table, source, registry }), table, source }
}
