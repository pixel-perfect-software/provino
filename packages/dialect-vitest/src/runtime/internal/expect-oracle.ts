// The real `@vitest/expect` 5.0.5 over `expect-cases.ts`, for `expect-table.test.ts`. It runs in a
// child process of its own: loading `@vitest/expect` defines the matcher slot on `globalThis`,
// which the table's own engine owns in the test's process. `@vitest/expect`, `@vitest/utils` and
// Chai are reached from `vitest`, a devDependency, so nothing is added. Prints one JSON line.
import { importFromVitest } from '../../internal/from-vitest.ts'
import { type Asymmetric, expectCases, runCase, type Side } from './expect-cases.ts'

/** What this reads of Chai and of `chai.expect`. */
interface ChaiLike {
  use(plugin: unknown): void
  readonly Assertion: { readonly prototype: object }
  readonly expect: ((actual: unknown) => unknown) & {
    readonly not: Asymmetric
    extend(expect: unknown, matchers: unknown): void
  } & Asymmetric
}

const upstream = await importFromVitest('@vitest/expect')
const { processError } = (await importFromVitest('@vitest/utils/error')) as {
  processError: (error: unknown) => { diff?: string }
}
const chai = upstream.chai as ChaiLike
const before = new Set(Object.getOwnPropertyNames(chai.Assertion.prototype))
chai.use(upstream.JestExtend)
chai.use(upstream.JestChaiExpect)
const jestStyle = Object.getOwnPropertyNames(chai.Assertion.prototype).filter((n) => !before.has(n))
const beforeChaiStyle = new Set(Object.getOwnPropertyNames(chai.Assertion.prototype))
chai.use(upstream.ChaiStyleAssertions)
// sinon-chai's names: methods (`calledWith`) and properties (`called`).
const chaiStyle = Object.getOwnPropertyNames(chai.Assertion.prototype).filter(
  (n) => !beforeChaiStyle.has(n),
)
const isGetter = (n: string): boolean =>
  typeof Object.getOwnPropertyDescriptor(chai.Assertion.prototype, n)?.get === 'function'
const chaiStyleMethods = chaiStyle.filter((n) => !isGetter(n))
const expectBefore = new Set(Object.keys(chai.expect))
chai.use(upstream.JestAsymmetricMatchers)
chai.expect.extend(chai.expect, upstream.customMatchers)
// `expect.extend` gives each custom matcher an asymmetric form too, as Vitest's own `expect` has.
// Chai's `addMethod` leaves its `__flags` on `chai.expect` once one of them has run.
const asymmetric = Object.keys(chai.expect).filter(
  (n) => !expectBefore.has(n) && n !== 'not' && n !== '__flags',
)

const asymmetricNot = Object.keys(chai.expect.not)
const side: Side = {
  expect: chai.expect as Side['expect'],
  extend: (matchers) => chai.expect.extend(chai.expect, matchers),
}
const results = []
for (const c of expectCases(chai.expect as Asymmetric, chai.expect.not as Asymmetric)) {
  try {
    await runCase(side, c)
    results.push({ pass: true })
  } catch (error) {
    const { name, message, cause } = error as Error
    results.push({
      pass: false,
      name,
      message,
      diff: processError(error).diff ?? null,
      cause: cause === undefined ? null : String(cause),
    })
  }
}

process.stdout.write(
  JSON.stringify({
    jestStyle,
    chaiStyleMethods,
    asymmetric,
    asymmetricNot,
    customMatchers: Object.keys(upstream.customMatchers as object),
    results,
  }),
)
