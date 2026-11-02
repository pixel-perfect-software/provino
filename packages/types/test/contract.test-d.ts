// Track 1 §Type tests, the cases that need only @provino/types. The defineConfig cases (literal
// kept without `as const`) move to T1.4, and `DialectName = 'jest'` moves to B14 (T1.8), since
// they need @provino/config or a real dialect package. A local `acme` dialect stands in here.
import type {
  Behaviour,
  CorePolicy,
  DataOnly,
  Dialect,
  DialectName,
  FormatEachTitle,
  ModuleRef,
  Policy,
  PolicyOverrides,
  ProjectConfig,
  ProvinoConfigInput,
  SerializedPolicy,
  SnapshotKey,
  SnapshotPolicy,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

interface AcmeOptions {
  readonly strict?: boolean
}

declare module '@provino/types' {
  interface DialectRegistry {
    acme: AcmeOptions
  }
}

declare const policy: Policy
/** Stands in for a core function: it takes the `core` slice, never the whole policy. */
declare function runTest(policy: CorePolicy, task: object, fn: () => void): void

// Registered dialects become names, and their options become config keys.
expectTypeOf<DialectName>().toEqualTypeOf<'acme'>()
expectTypeOf<ProjectConfig['acme']>().toEqualTypeOf<AcmeOptions | undefined>()
expectTypeOf(runTest).parameter(0).toEqualTypeOf<CorePolicy>()

// Behaviour keys serialize only as ModuleRefs: closures are stripped from the type.
expectTypeOf<DataOnly<SnapshotPolicy>['key']>().toEqualTypeOf<ModuleRef<SnapshotKey>>()
expectTypeOf<SerializedPolicy['core']['formatEachTitle']>().toEqualTypeOf<
  ModuleRef<FormatEachTitle>
>()
expectTypeOf<SerializedPolicy['core']['orderHooks']>().toEqualTypeOf<ModuleRef<
  NonNullable<CorePolicy['orderHooks']> extends Behaviour<infer F> ? F : never
> | null>()
// Data keys pass through unchanged.
expectTypeOf<SerializedPolicy['core']['nameSeparator']>().toEqualTypeOf<string>()
expectTypeOf<SerializedPolicy['module']['unmockedPathPatterns']>().toEqualTypeOf<
  readonly RegExp[]
>()

// @ts-expect-error closure in a SerializedPolicy
const s1: SerializedPolicy['snapshot']['key'] = (n: string, c: number) => n + c
// @ts-expect-error whole policy passed to core
runTest(policy, {}, () => {})
// @ts-expect-error readonly slice
policy.core.nameSeparator = '/'
// @ts-expect-error readonly nested key
policy.core.hookOrder.afterAll = 'reverse'

// Config: unknown dialects, option typos and explicit undefined are rejected.
const ok: ProvinoConfigInput = { dialect: 'acme', acme: { strict: true }, projects: ['a'] }
// @ts-expect-error unknown dialect
const c1: ProjectConfig = { dialect: 'mocha' }
// @ts-expect-error typo in dialect option
const c2: ProjectConfig = { acme: { strickt: true } }
// @ts-expect-error explicit undefined (exactOptionalPropertyTypes)
const c3: ProjectConfig = { globals: undefined }
// @ts-expect-error not an isolation tier
const c4: ProjectConfig = { isolation: 'vm' }

// Overrides: any key may be left out, unknown slices and wrong values are rejected.
const o1: PolicyOverrides = { core: { hookOrder: { afterAll: 'reverse' } } }
// @ts-expect-error unknown slice
const o2: PolicyOverrides = { reporter: {} }
// @ts-expect-error not a HookOrder
const o3: PolicyOverrides = { core: { hookOrder: { afterAll: 'stack' } } }
// @ts-expect-error wrong behaviour signature
const o4: PolicyOverrides = { snapshot: { key: (n: number) => n } }
// @ts-expect-error explicit undefined in a layer (exactOptionalPropertyTypes)
const o5: PolicyOverrides = { core: { nameSeparator: undefined } }
// Arrays replace whole, so a layer gives the full array.
const o6: PolicyOverrides = { mock: { between: { order: ['restore', 'clear'] } } }

// A dialect with typed options is a Dialect, so dialect lists can mix option types.
declare const acme: Dialect<'acme', AcmeOptions>
const dialects: readonly Dialect[] = [acme]

export { c1, c2, c3, c4, dialects, o1, o2, o3, o4, o5, o6, ok, s1 }
