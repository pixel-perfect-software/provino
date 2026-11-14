// Track 1 §Type tests, the cases that need only @provino/types. The defineConfig cases (literal
// kept without `as const`) move to T1.4, and `DialectName = 'jest'` moves to B14 (T1.8), since
// they need @provino/config or a real dialect package. A local `acme` dialect stands in here.
import type {
  Behaviour,
  Contribution,
  CorePolicy,
  DataOnly,
  Dialect,
  DialectName,
  FormatEachTitle,
  Matcher,
  ModuleRef,
  Policy,
  PolicyOverrides,
  ProjectConfig,
  ProvinoConfigInput,
  ProvinoPlugin,
  SerializedPolicy,
  ShuffleFactory,
  SnapshotKey,
  SnapshotPolicy,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

interface AcmeOptions {
  readonly strict?: boolean
}

interface MswOptions {
  readonly onUnhandled?: 'warn' | 'error'
}

declare module '@provino/types' {
  interface DialectRegistry {
    acme: AcmeOptions
    // Named like a config key, so it gets no options key (ReservedConfigKey).
    include: { readonly shadowed: true }
  }
  interface PluginRegistry {
    msw: MswOptions
    // Named like a dialect, so the dialect's options win.
    acme: { readonly fromPlugin: true }
  }
}

declare const policy: Policy
/** Stands in for a core function: it takes the `core` slice, never the whole policy. */
declare function runTest(policy: CorePolicy, task: object, fn: () => void): void

// Registered dialects become names, and their options become config keys.
expectTypeOf<DialectName>().toEqualTypeOf<'acme' | 'include'>()
expectTypeOf<ProjectConfig['acme']>().toEqualTypeOf<AcmeOptions | undefined>()
// A dialect named like a config key doesn't take over that key.
expectTypeOf<ProjectConfig['include']>().toEqualTypeOf<readonly string[] | undefined>()
// Registered plugins' options become config keys too.
expectTypeOf<ProjectConfig['msw']>().toEqualTypeOf<MswOptions | undefined>()
expectTypeOf(runTest).parameter(0).toEqualTypeOf<CorePolicy>()

// Behaviour keys serialize only as ModuleRefs: closures are stripped from the type.
expectTypeOf<DataOnly<SnapshotPolicy>['key']>().toEqualTypeOf<ModuleRef<SnapshotKey>>()
expectTypeOf<SerializedPolicy['core']['formatEachTitle']>().toEqualTypeOf<
  ModuleRef<FormatEachTitle>
>()
// A randomized run's shuffle: built from the seed, it reorders an array in place; `null` cannot shuffle.
expectTypeOf<CorePolicy['shuffle']>().toEqualTypeOf<Behaviour<ShuffleFactory> | null>()
expectTypeOf<ShuffleFactory>().toEqualTypeOf<(seed: number) => <T>(items: T[]) => T[]>()
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
// @ts-expect-error readonly slice reference
policy.core = {} as CorePolicy
// @ts-expect-error a ref to a function with the wrong signature
const wrongRef: Behaviour<SnapshotKey> = {} as ModuleRef<(n: number) => number>

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
// Records replace whole too, and an entry can't be explicitly undefined.
const o7: PolicyOverrides = {
  orchestrator: { isolationDefault: { byEnvironment: { edge: 'process' } } },
}
// @ts-expect-error explicit undefined in a record (exactOptionalPropertyTypes)
const o8: PolicyOverrides = { mock: { messages: { MOCK_X: undefined } } }

// A contribution's process is fixed by its kind, even in a mixed list.
const ok1: Contribution<'pool'> = { kind: 'pool', runsIn: 'coordinator', module: 'm', options: {} }
// @ts-expect-error a pool runs in the coordinator
const bad1: Contribution<'pool'> = { kind: 'pool', runsIn: 'worker', module: 'm', options: {} }
// @ts-expect-error an environment runs in the worker (default Contribution, as plugins write it)
const bad2: Contribution = { kind: 'environment', runsIn: 'coordinator', module: 'm', options: {} }
const plugin: ProvinoPlugin = {
  name: 'p',
  contributions: [
    { kind: 'environment', runsIn: 'worker', module: 'e', options: {} },
    { kind: 'reporter', runsIn: 'coordinator', module: 'r', options: { verbose: true } },
  ],
}

// Matchers may type their parameters.
const toBeWithin: Matcher = (received: number, floor: number, ceiling: number) => ({
  pass: received >= floor && received <= ceiling,
  message: () => `expected ${received} within ${floor}..${ceiling}`,
})

// A dialect with typed options is a Dialect, so dialect lists can mix option types.
declare const acme: Dialect<'acme', AcmeOptions>
const dialects: readonly Dialect[] = [acme]

export {
  bad1,
  bad2,
  c1,
  c2,
  c3,
  c4,
  dialects,
  o1,
  o2,
  o3,
  o4,
  o5,
  o6,
  o7,
  o8,
  ok,
  ok1,
  plugin,
  s1,
  toBeWithin,
  wrongRef,
}
