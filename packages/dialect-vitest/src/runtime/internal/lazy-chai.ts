// For `expect-table.test.ts`: the table built and assertions run in a fresh process, printing
// whether Chai is loaded after passing assertions and after a failure (D170).
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  installMatchersSlot,
} from '@provino/expect'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import type { CurrentTest } from '@provino/types'
import { vitestPolicy } from '../../dialect.ts'
import { chaiLoaded } from '../expect/chai.ts'

const policy = resolvePolicy(vitestPolicy).expect
if (policy.matcherTable === null) throw new Error('no matcher table')
const source = createStateSource({ get: () => undefined } as unknown as CurrentTest, {
  nameSeparator: ' > ',
  expand: false,
  outsideTestCounts: 'drop',
})
const registry = createMatcherRegistry()
installMatchersSlot(source, registry)
const table = (await createBehaviourLoader().load(policy.matcherTable))()
const expect = createExpect({ policy, table, source, registry })
const afterBuild = chaiLoaded()
expect(1).toBe(1)
expect({ a: [1] }).toEqual({ a: [1] })
expect({ a: 1, b: 2 }).toMatchObject({ a: 1 })
expect('x').toBeTruthy()
expect(2).not.toBe(3)
expect(1).toEqual(expect.any(Number))
const afterPassing = chaiLoaded()
try {
  expect(1).toBe(2)
} catch {}
process.stdout.write(JSON.stringify({ afterBuild, afterPassing, afterFailure: chaiLoaded() }))
