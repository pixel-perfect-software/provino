// For `expect-table.test.ts`: the table built and assertions run in a fresh process, printing
// whether Chai is loaded after passing assertions and after a failure (D170).
import { importFromVitest } from '../../internal/from-vitest.ts'
import { chaiLoaded } from '../expect/chai.ts'
import { setUpVitestExpect } from './expect-setup.ts'

const { fn } = (await importFromVitest('@vitest/spy')) as { fn: () => () => void }

const { expect } = await setUpVitestExpect()
const afterBuild = chaiLoaded()
expect(1).toBe(1)
expect({ a: [1] }).toEqual({ a: [1] })
expect({ a: 1, b: 2 }).toMatchObject({ a: 1 })
expect('x').toBeTruthy()
expect(2).not.toBe(3)
expect(1).toEqual(expect.any(Number))
const afterPassing = chaiLoaded()
// A passing `toHaveBeenCalled` words its failure before it asserts: no placeholder, so no Chai.
const spy = fn()
spy()
expect(spy).toHaveBeenCalled()
const afterCalled = chaiLoaded()
try {
  expect(1).toBe(2)
} catch {}
process.stdout.write(
  JSON.stringify({ afterBuild, afterPassing, afterCalled, afterFailure: chaiLoaded() }),
)
