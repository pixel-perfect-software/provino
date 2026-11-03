// Track 8 §Types → "Type tests that gate CI" (T8.1): environments and coverage.
import type {
  ContributionContracts,
  CoverageOptions,
  DefineEnvironment,
  EnvironmentHelper,
  EnvironmentInstance,
  RawCoverage,
  RuntimeEvent,
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

// Jest's handleTestEvent sees the runtime's own events.
expectTypeOf<
  Parameters<NonNullable<EnvironmentInstance['onTestEvent']>>[0]
>().toEqualTypeOf<RuntimeEvent>()

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

export { badThresholds, contributed, cov, inst }
