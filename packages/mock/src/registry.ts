// The per-file mock registry: the invocation counter, the dirty sets behind an O(dirty)
// `clearAll`/`resetAll`, the restorers, and the stubs.
import type { MockCleanupStep, MockPolicy } from '@provino/types'

/**
 * What the registry needs of a mock: its two dirty flags, and the two operations a walk runs. The
 * registry holds these only through `WeakRef`s, so a mock no test can reach can be collected.
 * @internal
 */
export interface DirtyMock {
  stateDirty: boolean
  configDirty: boolean
  ref: WeakRef<DirtyMock> | null
  /** The `mockClear` operation. */
  clearState(): void
  /** The `mockReset` operation. */
  resetMock(): void
}

/**
 * A restorer the registry runs on `restoreAll`. A replaced property's restorer also says what it
 * replaced, so a second `replaceProperty` on the same key finds it.
 * @internal
 */
export interface Restorer {
  (): void
  object?: object
  property?: PropertyKey
  replaced?: unknown
}

/**
 * The unstub operations a `Stubs` value registers, so the between-test steps can reach it.
 * @internal
 */
export interface StubSteps {
  unstubAllEnvs(): unknown
  unstubAllGlobals(): unknown
}

/**
 * Per-test cleanup flags by their neutral names; a missing flag takes the policy's value.
 * @public
 */
export type MockCleanupConfig = {
  readonly [K in MockCleanupStep]?: boolean | undefined
}

/**
 * One test file's mock state. Mocks, spies and stubs built with it share its invocation counter
 * and are what its `*All` operations reach.
 * @public
 */
export interface MockRegistry {
  /** The next call's place in `mock.invocationCallOrder`. The first is 1. */
  nextInvocationOrder(): number
  /** `mockClear` on every mock with state to clear. */
  clearAll(): void
  /** `mockReset` on every mock with state or configuration to reset. */
  resetAll(): void
  /** Runs every restorer once and forgets them: spies and replaced properties, not stubs. */
  restoreAll(): void
  /** The cleanup before a test: the steps of `between.order` that `cfg` or `between` turn on. */
  beforeEach(cfg: MockCleanupConfig, between: MockPolicy['between']): void
  /** File teardown: `restoreAll`, both unstubs, and every reference dropped. */
  dispose(): void
  /**
   * How many `resetAll`s have run. A mock that has never been touched isn't in a dirty set, so it
   * compares this on first use and applies the reset then.
   * @internal
   */
  readonly resets: number
  /** @internal */
  markStateDirty(mock: DirtyMock): void
  /** @internal */
  markConfigDirty(mock: DirtyMock): void
  /** @internal */
  addRestorer(restorer: Restorer): void
  /** @internal */
  deleteRestorer(restorer: Restorer): void
  /** @internal */
  findRestorer(object: object, property: PropertyKey): Restorer | undefined
  /** @internal */
  addStubs(stubs: StubSteps): void
  /** How many mocks each dirty set holds, including any that have been collected. @internal */
  dirtyCounts(): { readonly state: number; readonly config: number }
}

class Registry implements MockRegistry {
  resets = 0
  private order = 1
  private readonly dirtyStates = new Set<WeakRef<DirtyMock>>()
  private readonly dirtyConfigs = new Set<WeakRef<DirtyMock>>()
  private readonly restorers = new Set<Restorer>()
  private readonly stubs = new Set<StubSteps>()

  nextInvocationOrder(): number {
    return this.order++
  }

  markStateDirty(mock: DirtyMock): void {
    mock.stateDirty = true
    this.dirtyStates.add(refOf(mock))
  }

  markConfigDirty(mock: DirtyMock): void {
    mock.configDirty = true
    this.dirtyConfigs.add(refOf(mock))
  }

  clearAll(): void {
    for (const ref of this.dirtyStates) {
      const mock = ref.deref()
      if (mock === undefined) continue
      mock.stateDirty = false
      mock.clearState()
    }
    this.dirtyStates.clear()
  }

  resetAll(): void {
    this.resets++
    for (const dirty of [this.dirtyStates, this.dirtyConfigs]) {
      for (const ref of dirty) {
        const mock = ref.deref()
        // A mock in both sets was reset on the first pass, which took both its flags down.
        if (mock === undefined || (!mock.stateDirty && !mock.configDirty)) continue
        mock.stateDirty = false
        mock.configDirty = false
        mock.resetMock()
      }
      dirty.clear()
    }
  }

  restoreAll(): void {
    const restorers = [...this.restorers]
    this.restorers.clear()
    runAll(restorers)
  }

  beforeEach(cfg: MockCleanupConfig, between: MockPolicy['between']): void {
    for (const step of between.order) {
      if (!(cfg[step] ?? between[step])) continue
      switch (step) {
        case 'clear':
          this.clearAll()
          break
        case 'reset':
          this.resetAll()
          break
        case 'restore':
          this.restoreAll()
          break
        case 'unstubEnvs':
          for (const stubs of this.stubs) stubs.unstubAllEnvs()
          break
        case 'unstubGlobals':
          for (const stubs of this.stubs) stubs.unstubAllGlobals()
          break
      }
    }
  }

  dispose(): void {
    const steps: Array<() => void> = [...this.restorers]
    for (const stubs of this.stubs) {
      steps.push(
        () => stubs.unstubAllEnvs(),
        () => stubs.unstubAllGlobals(),
      )
    }
    this.restorers.clear()
    this.stubs.clear()
    this.dirtyStates.clear()
    this.dirtyConfigs.clear()
    runAll(steps)
  }

  addRestorer(restorer: Restorer): void {
    this.restorers.add(restorer)
  }

  deleteRestorer(restorer: Restorer): void {
    this.restorers.delete(restorer)
  }

  findRestorer(object: object, property: PropertyKey): Restorer | undefined {
    for (const restorer of this.restorers) {
      if (restorer.object === object && restorer.property === property) return restorer
    }
    return undefined
  }

  addStubs(stubs: StubSteps): void {
    this.stubs.add(stubs)
  }

  dirtyCounts(): { readonly state: number; readonly config: number } {
    return { state: this.dirtyStates.size, config: this.dirtyConfigs.size }
  }
}

function refOf(mock: DirtyMock): WeakRef<DirtyMock> {
  if (mock.ref === null) mock.ref = new WeakRef(mock)
  return mock.ref
}

/** Runs every step even when one throws, so one bad restorer can't leak the rest; then rethrows. */
function runAll(steps: ReadonlyArray<() => void>): void {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Several mock restorers threw')
}

/**
 * A new registry, one per test file. The first invocation order it hands out is 1.
 * @public
 */
export function createMockRegistry(): MockRegistry {
  return new Registry()
}
