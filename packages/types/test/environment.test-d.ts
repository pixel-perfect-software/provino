// Track 8 §Types → "Type tests that gate CI" (T8.1): environments and coverage.
import type {
  ContributionContracts,
  CoverageOptions,
  DefineEnvironment,
  EnvironmentHelper,
  EnvironmentInstance,
  EnvironmentTeardownReport,
  RawCoverage,
  LifecycleEvent,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const defineEnvironment: DefineEnvironment
declare const environment: EnvironmentHelper

const custom = defineEnvironment<'my-env', { port: number }>({
  name: 'my-env',
  realms: ['context'],
  setup(ctx) {
    expectTypeOf(ctx.options.port).toEqualTypeOf<number>()
    return { global: globalThis, teardown() {} }
  },
})
expectTypeOf(custom.name).toEqualTypeOf<'my-env'>()
const inferred = defineEnvironment({
  name: 'auto',
  realms: ['worker'],
  setup: () => ({ global: globalThis, teardown() {} }),
})
expectTypeOf(inferred.name).toEqualTypeOf<'auto'>()
// Any environment, whatever its options, is a valid `environment` contribution.
const contributed: ContributionContracts['environment'] = custom

// Built-in names get checked options; custom ones take anything.
environment({ name: 'jsdom', options: { url: 'http://x/' } })
environment({ name: './my-env.ts', options: { anything: 1 } })
// @ts-expect-error jsdom has no `width`
environment({ name: 'jsdom', options: { width: 3 } })
// @ts-expect-error happy-dom has no `html`
environment({ name: 'happy-dom', options: { html: '<p>' } })
// @ts-expect-error exactOptionalPropertyTypes: context cannot be explicitly undefined
const inst: EnvironmentInstance = { global: globalThis, context: undefined, teardown() {} }

// A teardown returns nothing for a clean teardown, or a report of the globals it could not restore
// (decision D22), synchronously or not.
expectTypeOf<EnvironmentTeardownReport['leakedGlobals']>().toEqualTypeOf<readonly string[]>()
type Teardown = EnvironmentInstance['teardown']
expectTypeOf<() => void>().toExtend<Teardown>()
expectTypeOf<() => Promise<void>>().toExtend<Teardown>()
expectTypeOf<() => EnvironmentTeardownReport>().toExtend<Teardown>()
expectTypeOf<() => EnvironmentTeardownReport | undefined>().toExtend<Teardown>()
expectTypeOf<() => Promise<EnvironmentTeardownReport>>().toExtend<Teardown>()
expectTypeOf<() => Promise<EnvironmentTeardownReport | undefined>>().toExtend<Teardown>()
expectTypeOf<() => string>().not.toExtend<Teardown>()
expectTypeOf<() => Promise<string>>().not.toExtend<Teardown>()
expectTypeOf<() => { readonly leakedGlobals: readonly symbol[] }>().not.toExtend<Teardown>()
const reporting: EnvironmentInstance = {
  global: globalThis,
  teardown: () => ({ leakedGlobals: ['__stuck', 'Symbol(stuck)'] }),
}
const reportingLater: EnvironmentInstance = {
  global: globalThis,
  async teardown() {
    return { leakedGlobals: [] }
  },
}
const maybeReporting: EnvironmentInstance = {
  global: globalThis,
  teardown: () => (Math.random() > 0.5 ? { leakedGlobals: ['__stuck'] } : undefined),
}
// @ts-expect-error a teardown returns a report or nothing, not another shape
const wrongShape: EnvironmentInstance = { global: globalThis, teardown: () => ({ leaked: ['x'] }) }
const symbolKeys: EnvironmentInstance = {
  global: globalThis,
  // @ts-expect-error the keys are strings: a symbol key is reported as String(symbol)
  teardown: () => ({ leakedGlobals: [Symbol('stuck')] }),
}
const wrongShapeLater: EnvironmentInstance = {
  global: globalThis,
  // @ts-expect-error the same rule when the teardown is async
  async teardown() {
    return { leakedGlobals: 'stuck' }
  },
}
const report: EnvironmentTeardownReport = { leakedGlobals: ['x'] }
// @ts-expect-error the report's list is read-only
report.leakedGlobals.push('y')

// Jest's handleTestEvent sees the lifecycle events.
expectTypeOf<
  Parameters<NonNullable<EnvironmentInstance['onTestEvent']>>[0]
>().toEqualTypeOf<LifecycleEvent>()

const cov: CoverageOptions = {
  thresholds: {
    branches: 80,
    statements: -10,
    autoUpdate: (n) => Math.floor(n),
    groups: { 'src/api/**': { lines: 100, perFile: true } },
  },
}
declare const raw: RawCoverage
if (raw.kind === 'v8') expectTypeOf(raw.scripts).items.toHaveProperty('url')
// @ts-expect-error not a coverage metric
const badThresholds: CoverageOptions = { thresholds: { lines: 90, paths: 80 } }

export {
  badThresholds,
  contributed,
  cov,
  inst,
  maybeReporting,
  report,
  reporting,
  reportingLater,
  symbolKeys,
  wrongShape,
  wrongShapeLater,
}
