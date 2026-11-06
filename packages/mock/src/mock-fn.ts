// The mock function (T4.3). Creation has a budget of 1 µs, so it does as little as it can:
//
// - Methods live on one frozen prototype per `MockPolicy` (the module's only hidden state, a cache
//   of immutable objects), as enumerable accessors. A mock's own keys are `mock` and an enumerable
//   symbol. A method is bound to its mock on first read, so nothing per method exists at creation,
//   and `beforeEach(fn.mockClear)` and `const { mockReturnValue } = fn` still work.
// - State and configuration live in one `MockSlot`. Under a policy where `.mock` is an accessor,
//   the arrays don't exist until something reads or calls.
// - Creation touches no dirty set. A mock joins one on its first call, its first configuration
//   change, or (under `clearReplacesStateObject`) its first read of `.mock`, the only ways
//   `clearAll` or `resetAll` could be observed on it. The one thing that leaves is a never-used
//   `fn(impl)` under `resetTo: 'empty'`, whose implementation `resetAll` must still drop: it
//   compares `registry.resets` on first use instead.
import type { MockPolicy } from '@provino/types'
import { MockTypeError } from './errors.ts'
import { argsEqual } from './internal/args-equal.ts'
import { fill, messageFor } from './internal/messages.ts'
import type { DirtyMock, MockRegistry } from './registry.ts'
import type {
  CreateMockOptions,
  Mock,
  MockResult,
  MockSettledResult,
  MockTarget,
  UnknownFunction,
} from './types.ts'

/**
 * Marks a mock made by this engine. Every mock also has `_isMockFunction: true`, for the ecosystem
 * and for `isMockFunction`.
 * @public
 */
export const MOCK_BRAND: unique symbol = Symbol.for('@provino/mock.brand')

/**
 * The key of a mock's slot: own, enumerable, and never read by anything outside this file. A symbol
 * rather than a `#private` field, because a `Proxy` around a mock must keep working.
 */
const SLOT: unique symbol = Symbol('@provino/mock.slot')

type Impl = (this: unknown, ...args: unknown[]) => unknown
type Newable = abstract new (...args: never[]) => unknown
type BoundMethods = Record<PropertyKey, unknown>

interface RawState {
  calls: unknown[][]
  contexts: unknown[]
  instances: unknown[]
  invocationCallOrder: number[]
  settledResults?: Array<MockSettledResult<unknown>>
  results: Array<MockResult<unknown>>
  lastCall?: unknown[] | undefined
}

interface SlotHolder {
  [SLOT]: MockSlot
}

/** What a mock looks like to this file: a function with a slot. */
type MockFn = Impl & SlotHolder

/** A policy's answers, read once, plus the frozen prototype and the function maker. */
interface Layout {
  readonly proto: object
  /** The function makers by arity (0 to 9), with this policy's own name. */
  readonly makers: readonly Maker[]
  /** `.mock` is an accessor. Otherwise a non-writable data property holding one state object. */
  readonly accessor: PropertyDescriptor | null
  readonly construct: boolean
  readonly settled: boolean
  readonly lastCallOnRead: boolean
  readonly chain: boolean
  readonly ownNameFromOriginal: boolean
}

function noop(): void {}

// Captured at module load, so `jest.spyOn(Function.prototype, 'bind')` isn't inflated by a mock
// binding a method on first read.
const reflectApply = Reflect.apply
const functionBind: (this: Impl, thisArg: unknown) => Impl = Function.prototype.bind

/**
 * `lastCall` as an own enumerable getter, under `lastCallKey: 'always'`. One shared descriptor, as
 * a `get` in the object literal costs about 330 ns more per mock (`local`).
 */
const LAST_CALL_GETTER: PropertyDescriptor = Object.freeze({
  configurable: true,
  enumerable: true,
  get(this: RawState): unknown[] | undefined {
    return this.calls.at(-1)
  },
})

function freshState(policy: MockPolicy): RawState {
  const state: RawState = policy.settledResults
    ? {
        calls: [],
        contexts: [],
        instances: [],
        invocationCallOrder: [],
        settledResults: [],
        results: [],
      }
    : { calls: [], contexts: [], instances: [], invocationCallOrder: [], results: [] }
  if (policy.lastCallKey === 'always') Object.defineProperty(state, 'lastCall', LAST_CALL_GETTER)
  return state
}

interface WhenBranch {
  readonly matchers: readonly unknown[]
  readonly subMock: MockFn
}

/** `whenCalledWith`'s routing, jest-mock's `_makeWhenDispatcherImpl` (index.ts L612-L662). */
interface WhenState {
  readonly dispatcher: Impl
  readonly branches: WhenBranch[]
  /** What the dispatcher took over from: the implementation it falls through to. */
  fallback: Impl | null
}

class MockSlot implements DirtyMock {
  readonly policy: MockPolicy
  readonly registry: MockRegistry
  readonly layout: Layout
  fn: MockFn | null = null
  /** Falsy once the state object is replaced by `fn.mock = undefined`, as jest-mock's check is. */
  state: RawState | null = null
  /**
   * The persistent implementation. `undefined` is "none", as in jest-mock; a `null` the user set is
   * kept apart from it, which `whenCalledWith`'s dispatcher can tell (`mockImpl !== undefined`).
   */
  impl: Impl | null | undefined = undefined
  /** The `mockImplementationOnce` queue; an entry can be a falsy value the caller passed. */
  onces: Array<Impl | null | undefined> | null = null
  /** What a call runs with no implementation: a spied function or `options.fallback`. */
  fallback: Impl | null = null
  /** What it was built from: what `mockReset` returns to, and what `mockRestore` runs. */
  options: CreateMockOptions<MockTarget> | null = null
  name: string | null = null
  when: WhenState | null = null
  chained = false
  stateDirty = false
  configDirty = false
  ref: WeakRef<DirtyMock> | null = null
  /** The methods read so far, each bound to this mock. */
  bound: BoundMethods | null = null
  resets: number
  /** Bumped by every `resetMock`, so a restore queued before a reset can tell it is stale. */
  epoch = 0

  constructor(policy: MockPolicy, registry: MockRegistry, layout: Layout) {
    this.policy = policy
    this.registry = registry
    this.layout = layout
    this.resets = registry.resets
  }

  /** A `resetAll` this mock wasn't in a dirty set for. See the top of the file. */
  catchUpOnResets(): void {
    if (this.resets === this.registry.resets) return
    this.resets = this.registry.resets
    if (this.policy.resetTo === 'empty') {
      this.impl = undefined
      this.fallback = (this.options?.fallback as Impl | undefined) ?? null
    }
  }

  enterStateDirty(): void {
    this.catchUpOnResets()
    this.registry.markStateDirty(this)
  }

  touchConfig(): void {
    if (this.configDirty) return
    this.catchUpOnResets()
    this.registry.markConfigDirty(this)
  }

  /** `fn.mock`, read. */
  readState(): RawState {
    if (!this.stateDirty && this.policy.clearReplacesStateObject) this.enterStateDirty()
    return this.currentState()
  }

  currentState(): RawState {
    let state = this.state
    // Falsy, not only null: jest-mock's `_ensureMockState` recovers from `fn.mock = undefined`.
    if (!state) {
      state = freshState(this.policy)
      this.state = state
    }
    // jest-mock's `_ensureMockState` (index.ts L681): the key appears on a read after a call.
    if (this.layout.lastCallOnRead && state.calls.length > 0) state.lastCall = state.calls.at(-1)
    return state
  }

  clearState(): void {
    if (this.policy.clearReplacesStateObject) {
      this.state = null
      return
    }
    const state = this.state
    if (!state) return
    state.calls = []
    state.contexts = []
    state.instances = []
    state.invocationCallOrder = []
    state.results = []
    if (this.layout.settled) state.settledResults = []
  }

  resetMock(): void {
    this.resets = this.registry.resets
    this.epoch++
    this.clearState()
    const when = this.when
    if (when !== null) {
      for (const branch of when.branches) branch.subMock[SLOT].resetMock()
      this.when = null
    }
    this.onces = null
    this.name = null
    if (this.policy.resetTo === 'empty') {
      this.impl = undefined
      this.fallback = (this.options?.fallback as Impl | undefined) ?? null
    } else {
      this.impl = this.options?.impl as Impl | undefined
    }
    if (this.layout.chain) this.syncPrototype(this.impl ?? this.fallback)
  }

  setImpl(impl: Impl | null | undefined): void {
    this.touchConfig()
    const when = this.when
    if (when !== null && this.impl === when.dispatcher) when.fallback = impl ?? null
    else this.impl = impl
    if (this.layout.chain) this.syncPrototype(this.nextImpl())
  }

  addOnce(impl: Impl | null | undefined): void {
    this.touchConfig()
    if (this.onces === null) this.onces = [impl]
    else this.onces.push(impl)
    if (this.layout.chain) this.syncPrototype(this.nextImpl())
  }

  /** What the next call runs, without consuming it. */
  nextImpl(): Impl | null | undefined {
    return this.onces?.[0] ?? this.impl ?? this.fallback
  }

  /**
   * Keeps `fn.prototype`'s parent on the prototype of what the next construction runs, so instances
   * inherit its methods (`classMockPrototype: 'chain-to-impl'`, @vitest/spy's
   * `reparentMockPrototype`). An implementation with no prototype, such as an arrow, leaves
   * `fn.prototype` unallocated.
   */
  syncPrototype(next: Impl | null | undefined): void {
    const parent = (next?.prototype as object | null | undefined) ?? null
    if (parent === null && !this.chained) return
    const own = (this.fn as MockFn).prototype as object | null | undefined
    if (own === null || own === undefined) return
    const target = parent ?? Object.prototype
    if (own !== target && Object.getPrototypeOf(own) !== target) {
      Object.setPrototypeOf(own, target)
    }
    this.chained = parent !== null
  }

  /** One call of the mock. */
  invoke(self: unknown, args: unknown[], newTarget: unknown): unknown {
    if (!this.stateDirty) this.enterStateDirty()
    const state = this.currentState()
    const layout = this.layout
    const constructing = newTarget !== undefined && layout.construct
    // A construction's `this` is only known once it returns.
    const context = constructing ? undefined : self
    state.calls.push(args)
    const instanceIndex = state.instances.push(context) - 1
    const contextIndex = state.contexts.push(context) - 1
    const result: MockResult<unknown> = { type: 'incomplete', value: undefined }
    state.results.push(result)
    let settled: MockSettledResult<unknown> | null = null
    if (layout.settled) {
      settled = { type: 'incomplete', value: undefined }
      state.settledResults?.push(settled)
    }
    state.invocationCallOrder.push(this.registry.nextInvocationOrder())

    // jest-mock's order (index.ts L805-L820). A queued entry that is `undefined` falls back to the
    // persistent implementation on a plain call, and runs nothing under `new`; any other falsy
    // entry runs nothing.
    const onces = this.onces
    let impl: Impl | null | undefined
    if (onces !== null && onces.length > 0) {
      const queued = onces.shift()
      if (queued) impl = queued
      else if (newTarget !== undefined) impl = null
      else impl = (queued === undefined ? this.impl : null) || this.fallback
    } else {
      impl = this.impl || this.fallback
    }

    let value: unknown
    try {
      if (constructing) {
        if (layout.chain) this.syncPrototype(impl)
        value = Reflect.construct(impl || noop, args, newTarget as Newable)
        // As @vitest/spy does (`state.contexts[contextIndex - 1] = returnValue`, after the
        // construction returns): written into whatever arrays are current then. A `mockClear`
        // during the construction leaves the instance at index 0 of the new arrays, with `calls`
        // empty. A throw writes nothing.
        state.contexts[contextIndex] = value
        state.instances[instanceIndex] = value
      } else if (impl) {
        value = impl.apply(self, args)
      }
    } catch (error) {
      // Mutated, not pushed: a `mockClear` during the call must not get this result back.
      const thrown = result as { type: string; value: unknown }
      thrown.type = 'throw'
      thrown.value = error
      if (settled !== null) {
        const rejected = settled as { type: string; value: unknown }
        rejected.type = 'rejected'
        rejected.value = error
      }
      if (constructing) this.warnIfNotConstructor(error)
      throw error
    }
    const returned = result as { type: string; value: unknown }
    returned.type = 'return'
    returned.value = value
    if (settled !== null) settle(settled, value)
    return value
  }

  warnIfNotConstructor(error: unknown): void {
    const text = this.policy.messages['new-not-a-constructor']
    if (text === undefined) return
    if (error instanceof TypeError && error.message.includes('is not a constructor')) {
      console.warn(fill(text, { name: this.mockName() }))
    }
  }

  mockName(): string {
    if (this.name) return this.name
    if (this.options?.spy === true && this.policy.spyNameFromMethod) {
      return (this.fn as MockFn).name || this.policy.defaultName
    }
    return this.policy.defaultName
  }

  implementation(): Impl | undefined {
    this.catchUpOnResets()
    if (this.policy.getImplPrefersOnce) {
      const once = this.onces?.[0]
      if (once != null) return once
    }
    const when = this.when
    if (when !== null && this.impl === when.dispatcher) return when.fallback ?? undefined
    return this.impl ?? undefined
  }

  /** The implementations `withImplementation` swaps out, as a function that puts them back. */
  swapImpl(impl: Impl): () => void {
    this.touchConfig()
    const { impl: previous, onces: previousOnces } = this
    const when = this.when
    const previousFallback = when?.fallback ?? null
    const epoch = this.epoch
    this.impl = impl
    this.onces = null
    if (this.layout.chain) this.syncPrototype(impl)
    return () => {
      // A reset since the swap took the old configuration away, as jest-mock's restore into a
      // detached config does (index.ts L944-L964): the mock stays reset.
      if (this.epoch !== epoch) return
      this.touchConfig()
      this.impl = previous
      this.onces = previousOnces
      if (when !== null) when.fallback = previousFallback
      if (this.layout.chain) this.syncPrototype(this.nextImpl())
    }
  }

  /**
   * A method, bound to this mock, made on first read. `bind` keeps the method's `length`, which a
   * `beforeEach` reads to decide whether it takes `done`, and its result. It prefixes the `name`
   * with `bound `: renaming costs a `defineProperty` per method, for a name nothing has been seen
   * to read.
   */
  boundMethod(key: PropertyKey, method: Impl): unknown {
    let bound = this.bound
    if (bound === null) {
      bound = Object.create(null) as BoundMethods
      this.bound = bound
    }
    let closure = bound[key]
    if (closure === undefined) {
      // Not `method.bind(...)`: reading `bind` off the method would go through a spied
      // `Function.prototype.bind`. These are captured at module load.
      closure = reflectApply(functionBind, method, [this.fn])
      bound[key] = closure
    }
    return closure
  }

  whenState(): WhenState {
    if (this.when !== null) return this.when
    const when: WhenState = { dispatcher: makeDispatcher(this), branches: [], fallback: null }
    this.when = when
    return when
  }
}

function settle(settled: MockSettledResult<unknown>, value: unknown): void {
  const target = settled as { type: string; value: unknown }
  if (value instanceof Promise) {
    value.then(
      (fulfilled: unknown) => {
        target.type = 'fulfilled'
        target.value = fulfilled
      },
      (rejected: unknown) => {
        target.type = 'rejected'
        target.value = rejected
      },
    )
    return
  }
  target.type = 'fulfilled'
  target.value = value
}

/** The order of jest-mock's dispatcher (index.ts L616-L625). Targets always run through `apply`. */
function makeDispatcher(slot: MockSlot): Impl {
  return function whenCalledWithDispatcherImpl(this: unknown, ...args: unknown[]): unknown {
    const when = slot.when
    if (when === null) return undefined
    const matching = when.branches.filter((branch) => argsEqual(branch.matchers, args))
    const queued = matching.find((branch) => (branch.subMock[SLOT].onces?.length ?? 0) > 0)
    if (queued !== undefined) return queued.subMock.apply(this, args)
    for (let index = matching.length - 1; index >= 0; index--) {
      const branch = matching[index]
      // jest-mock's `mockImpl !== undefined`: a `null` implementation is a branch, `undefined` isn't.
      if (branch !== undefined && branch.subMock[SLOT].impl !== undefined) {
        return branch.subMock.apply(this, args)
      }
    }
    const fallThrough = when.fallback ?? slot.fallback
    return fallThrough === null ? undefined : fallThrough.apply(this, args)
  }
}

function slotOf(fn: unknown): MockSlot {
  const slot = (fn as Partial<SlotHolder> | null | undefined)?.[SLOT]
  if (slot === undefined) {
    throw new MockTypeError(
      'MOCK_DETACHED_METHOD',
      'A mock method was called without its mock. Call it as `mock.method()`, or wrap it in a function.',
    )
  }
  return slot
}

/** A value shorthand's implementation; `name` is what a policy that refuses `new` says it was. */
function shorthand(slot: MockSlot, name: string, produce: () => unknown): Impl {
  if (!slot.policy.valueShorthandsThrowOnNew) return () => produce()
  const policy = slot.policy
  return function valueShorthand(): unknown {
    if (new.target !== undefined) {
      throw new MockTypeError('MOCK_NEW_SHORTHAND', messageFor(policy, 'new-shorthand', { name }))
    }
    return produce()
  }
}

function throwing(value: unknown): Impl {
  // A `function`, not an arrow, so `new` on it throws this value too.
  return function throwValue(): never {
    throw value
  }
}

/**
 * The shared methods, unbound. Each finds its slot through `this`, which `boundMethod` fixes to the
 * mock. Only the prototype itself hands out one of these, and calling that throws
 * `MOCK_DETACHED_METHOD` rather than acting on nothing.
 */
const METHODS = {
  getMockImplementation(this: unknown): Impl | undefined {
    return slotOf(this).implementation()
  },
  getMockName(this: unknown): string {
    return slotOf(this).mockName()
  },
  mockName<S>(this: S, name: string): S {
    const slot = slotOf(this)
    if (name) {
      slot.touchConfig()
      slot.name = name
    }
    return this
  },
  mockClear<S>(this: S): S {
    slotOf(this).clearState()
    return this
  },
  mockReset<S>(this: S): S {
    slotOf(this).resetMock()
    return this
  },
  mockRestore(this: unknown): void {
    const slot = slotOf(this)
    slot.resetMock()
    slot.options?.restore?.()
  },
  mockImplementation<S>(this: S, impl: Impl): S {
    slotOf(this).setImpl(impl)
    return this
  },
  mockImplementationOnce<S>(this: S, impl: Impl): S {
    slotOf(this).addOnce(impl)
    return this
  },
  withImplementation(this: unknown, impl: Impl, callback: () => unknown): unknown {
    const slot = slotOf(this)
    const restore = slot.swapImpl(impl)
    const returnsMock = slot.policy.withImplementationReturnsMock
    const answer = returnsMock ? this : undefined
    const returned = callback()
    if (isThenable(returned)) {
      return returned.then(() => {
        restore()
        return answer
      })
    }
    restore()
    return answer
  },
  mockReturnThis<S>(this: S): S {
    slotOf(this).setImpl(function returnThis(this: unknown): unknown {
      return this
    })
    return this
  },
  mockReturnValue<S>(this: S, value: unknown): S {
    const slot = slotOf(this)
    slot.setImpl(shorthand(slot, 'mockReturnValue', () => value))
    return this
  },
  mockReturnValueOnce<S>(this: S, value: unknown): S {
    const slot = slotOf(this)
    slot.addOnce(shorthand(slot, 'mockReturnValueOnce', () => value))
    return this
  },
  mockResolvedValue<S>(this: S, value: unknown): S {
    const slot = slotOf(this)
    slot.setImpl(shorthand(slot, 'mockResolvedValue', () => Promise.resolve(value)))
    return this
  },
  mockResolvedValueOnce<S>(this: S, value: unknown): S {
    const slot = slotOf(this)
    slot.addOnce(shorthand(slot, 'mockResolvedValueOnce', () => Promise.resolve(value)))
    return this
  },
  mockRejectedValue<S>(this: S, value: unknown): S {
    const slot = slotOf(this)
    slot.setImpl(shorthand(slot, 'mockRejectedValue', () => Promise.reject(value)))
    return this
  },
  mockRejectedValueOnce<S>(this: S, value: unknown): S {
    const slot = slotOf(this)
    slot.addOnce(shorthand(slot, 'mockRejectedValueOnce', () => Promise.reject(value)))
    return this
  },
  mockThrow<S>(this: S, value: unknown): S {
    slotOf(this).setImpl(throwing(value))
    return this
  },
  mockThrowOnce<S>(this: S, value: unknown): S {
    slotOf(this).addOnce(throwing(value))
    return this
  },
  whenCalledWith(this: unknown, ...matchers: unknown[]): unknown {
    const slot = slotOf(this)
    slot.touchConfig()
    const when = slot.whenState()
    if (slot.impl !== when.dispatcher) {
      when.fallback = slot.impl ?? null
      slot.impl = when.dispatcher
    }
    const subMock = createMockFn(slot.policy, slot.registry)
    when.branches.push({ matchers, subMock: subMock as unknown as MockFn })
    return subMock
  },
  [Symbol.dispose](this: unknown): void {
    const slot = slotOf(this)
    slot.resetMock()
    slot.options?.restore?.()
  },
}

/**
 * One method as a prototype accessor. Enumerable, so `for...in` over a mock lists it. A read never
 * throws; a write makes an own data property on the mock, as assigning over jest-mock's own
 * properties does, which also is what a frozen prototype's data property would have refused.
 */
function methodAccessor(key: PropertyKey, method: Impl): PropertyDescriptor {
  return {
    enumerable: true,
    get(this: unknown): unknown {
      const slot = (this as Partial<SlotHolder> | null | undefined)?.[SLOT]
      return slot === undefined ? method : slot.boundMethod(key, method)
    },
    set(this: object, value: unknown): void {
      Object.defineProperty(this, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    },
  }
}

/**
 * `_isMockFunction` and `MOCK_BRAND`: `true` only where there is a slot. `Function.prototype.bind`
 * gives a bound function the mock's prototype, so a plain `true` there would make a bound mock look
 * like one, with no slot to back it. `Object.create(mock)` children and `util.promisify` copies
 * have the slot (an inherited or copied symbol key), so they still answer `true`. A write defines
 * an own data property, as the method accessors' does.
 */
function flagAccessor(key: PropertyKey): PropertyDescriptor {
  return {
    enumerable: true,
    get(this: unknown): true | undefined {
      return (this as Partial<SlotHolder> | null | undefined)?.[SLOT] !== undefined
        ? true
        : undefined
    },
    set(this: object, value: unknown): void {
      Object.defineProperty(this, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    },
  }
}

function prototypeDescriptors(): PropertyDescriptorMap {
  const descriptors: PropertyDescriptorMap & Record<symbol, PropertyDescriptor> = {
    _isMockFunction: flagAccessor('_isMockFunction'),
    [MOCK_BRAND]: flagAccessor(MOCK_BRAND),
  }
  for (const key of Reflect.ownKeys(METHODS)) {
    const method = (METHODS as unknown as Record<PropertyKey, Impl>)[key] as Impl
    ;(descriptors as Record<PropertyKey, PropertyDescriptor>)[key] = methodAccessor(key, method)
  }
  return descriptors
}

const PROTOTYPE_DESCRIPTORS: PropertyDescriptorMap = prototypeDescriptors()

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as Partial<PromiseLike<unknown>>).then === 'function'
  )
}

/** Copies `arguments` with an indexed loop: no global or prototype lookup on the call path. */
function copyArguments(source: IArguments): unknown[] {
  const copy: unknown[] = []
  for (let index = 0; index < source.length; index++) copy[index] = source[index]
  return copy
}

type Maker = (slot: MockSlot) => Impl

/**
 * The function makers by arity, 0 to 9, for each own name. `Object.defineProperty(fn, 'length')` costs
 * more than the rest of creation, so as jest-mock's `matchArity` does (index.ts L352-L465), the
 * arity is in the source, written out rather than compiled: nothing here generates code from a
 * string, which a host can forbid. Each maker is a plain closure over the slot.
 */
// biome-ignore-start lint/complexity/noArguments: a rest parameter would allocate before the copy and change `length`
const MOCK_CONSTRUCTOR_MAKERS: readonly Maker[] = [
  (slot) =>
    function mockConstructor(this: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(this: unknown, _0: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(this: unknown, _0: unknown, _1: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(this: unknown, _0: unknown, _1: unknown, _2: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(this: unknown, _0: unknown, _1: unknown, _2: unknown, _3: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
      _5: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
      _5: unknown,
      _6: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
      _5: unknown,
      _6: unknown,
      _7: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function mockConstructor(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
      _5: unknown,
      _6: unknown,
      _7: unknown,
      _8: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
]

const MOCK_MAKERS: readonly Maker[] = [
  (slot) =>
    function Mock(this: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(this: unknown, _0: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(this: unknown, _0: unknown, _1: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(this: unknown, _0: unknown, _1: unknown, _2: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(this: unknown, _0: unknown, _1: unknown, _2: unknown, _3: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(this: unknown, _0: unknown, _1: unknown, _2: unknown, _3: unknown, _4: unknown) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
      _5: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
      _5: unknown,
      _6: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
      _5: unknown,
      _6: unknown,
      _7: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
  (slot) =>
    function Mock(
      this: unknown,
      _0: unknown,
      _1: unknown,
      _2: unknown,
      _3: unknown,
      _4: unknown,
      _5: unknown,
      _6: unknown,
      _7: unknown,
      _8: unknown,
    ) {
      return slot.invoke(this, copyArguments(arguments), new.target)
    },
]

// biome-ignore-end lint/complexity/noArguments: see above

const MAX_COMPILED_ARITY = 9

function readMock(this: SlotHolder): RawState {
  return this[SLOT].readState()
}

function writeMock(this: SlotHolder, value: RawState): void {
  const slot = this[SLOT]
  slot.state = value
  if (!slot.stateDirty) slot.enterStateDirty()
}

function buildLayout(policy: MockPolicy): Layout {
  const proto = Object.freeze(Object.create(Function.prototype, PROTOTYPE_DESCRIPTORS) as object)
  let accessor: PropertyDescriptor | null = null
  if (policy.clearReplacesStateObject || policy.mockPropertyWritable) {
    accessor = { configurable: false, enumerable: true, get: readMock }
    if (policy.mockPropertyWritable) accessor.set = writeMock
    Object.freeze(accessor)
  }
  return {
    proto,
    makers: policy.functionName === 'mockConstructor' ? MOCK_CONSTRUCTOR_MAKERS : MOCK_MAKERS,
    accessor,
    construct: policy.newCall === 'construct',
    settled: policy.settledResults,
    lastCallOnRead: policy.lastCallKey === 'after-first-call',
    chain: policy.classMockPrototype === 'chain-to-impl',
    ownNameFromOriginal: policy.functionName === 'impl-or-Mock',
  }
}

// The only module-level state: a cache from a policy to its frozen prototype and answers. Nothing
// in it depends on a test file, and a policy that goes away takes its entry with it.
const LAYOUTS = new WeakMap<MockPolicy, Layout>()

function layoutOf(policy: MockPolicy): Layout {
  let layout = LAYOUTS.get(policy)
  if (layout === undefined) {
    layout = buildLayout(policy)
    LAYOUTS.set(policy, layout)
  }
  return layout
}

const STATIC_PROPERTIES_SKIPPED: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  'length',
  'name',
  'prototype',
  Symbol.for('nodejs.util.promisify.custom'),
])

/** `copyStaticProps`: @vitest/spy's `copyOriginalStaticProperties`, skipping what the mock has. */
function copyStatics(mock: MockFn, source: object): void {
  let from: object | null = source
  while (from !== null && from !== Object.prototype && from !== Function.prototype) {
    const keys = Reflect.ownKeys(from)
    // A plain arrow has `length` and `name`, a plain strict function those and `prototype`. Those
    // are the usual cases, and neither needs a lookup per key.
    if (keys.length > 3 || (keys.length === 3 && keys[2] !== 'prototype')) {
      for (const key of keys) {
        if (STATIC_PROPERTIES_SKIPPED.has(key) || key in mock) continue
        const descriptor = Object.getOwnPropertyDescriptor(from, key)
        if (descriptor !== undefined) Object.defineProperty(mock, key, descriptor)
      }
    }
    from = Object.getPrototypeOf(from) as object | null
  }
}

/** The parts of the options only a spy or an automock member has. */
function applyRareOptions(
  slot: MockSlot,
  mock: MockFn,
  options: CreateMockOptions<MockTarget>,
): void {
  const original = options.original as Impl | undefined
  if (options.fallback !== undefined) slot.fallback = options.fallback as Impl
  if (original !== undefined) {
    if (slot.policy.spyReportsBridgeImpl) {
      // Under this policy a spy's implementation is a bridge, not the original itself, and is a
      // configuration change like any other: it is what `resetAll` takes away. As in jest-mock's
      // `spyOn`, it is the only route to the original, so clearing the implementation (even with
      // `mockImplementation(undefined)`) drops the call-through; no fallback holds the original.
      slot.setImpl(function spyBridge(this: unknown, ...args: unknown[]): unknown {
        return original.apply(this, args)
      })
    } else {
      slot.fallback = original
    }
  }
  const ownName = options.name ?? (slot.layout.ownNameFromOriginal ? original?.name : undefined)
  if (ownName) Object.defineProperty(mock, 'name', { value: ownName, configurable: true })
}

/** The own length a mock is made with, unless `options.length` says otherwise. */
function lengthFor(options: CreateMockOptions<MockTarget>, layout: Layout): number {
  if (options.length !== undefined) return options.length
  const source = options.impl ?? (layout.ownNameFromOriginal ? options.original : undefined)
  return source?.length ?? 0
}

function makeFunction(layout: Layout, slot: MockSlot, length: number): MockFn {
  const arity = length >= 0 && length <= MAX_COMPILED_ARITY ? length : 0
  const fn = (layout.makers[arity] as Maker)(slot) as MockFn
  if (arity !== length) Object.defineProperty(fn, 'length', { value: length, configurable: true })
  return fn
}

/**
 * Builds a mock function: `fn()`, `fn(impl)`, and through its options every other builder (spies,
 * automock members, factories). Takes one policy slice, and the file's registry.
 * @public
 */
export function createMockFn<T extends MockTarget = UnknownFunction>(
  policy: MockPolicy,
  registry: MockRegistry,
  options?: CreateMockOptions<T>,
): Mock<T> {
  if (
    options !== undefined &&
    policy.fnOfMockReturnsSame &&
    (options.impl as Partial<SlotHolder> | undefined)?.[SLOT] !== undefined
  ) {
    return options.impl as unknown as Mock<T>
  }
  const layout = layoutOf(policy)
  const slot = new MockSlot(policy, registry, layout)
  const opts = options as CreateMockOptions<MockTarget> | undefined
  const fn = makeFunction(layout, slot, opts === undefined ? 0 : lengthFor(opts, layout))
  slot.fn = fn
  Object.setPrototypeOf(fn, layout.proto)
  // A plain assignment, because `defineProperty` costs several times as much. It makes the slot an
  // enumerable symbol key, which `Object.keys` doesn't list; jest-mock's own `Symbol.dispose` is too.
  fn[SLOT] = slot
  if (layout.accessor !== null) {
    Object.defineProperty(fn, 'mock', layout.accessor)
  } else {
    const state = freshState(policy)
    slot.state = state
    Object.defineProperty(fn, 'mock', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: state,
    })
  }
  if (opts !== undefined) {
    slot.options = opts
    if (opts.impl !== undefined) slot.impl = opts.impl as Impl
    if (opts.spy === true || opts.fallback !== undefined || opts.name !== undefined) {
      applyRareOptions(slot, fn, opts)
    }
    if (layout.chain) slot.syncPrototype(slot.nextImpl())
    if (policy.copyStaticProps) {
      const source = opts.original ?? opts.impl
      if (source !== undefined) copyStatics(fn, source)
    }
  }
  return fn as unknown as Mock<T>
}

/**
 * Whether a value is a mock function. Under `isMockAcceptsObjects` any value with
 * `_isMockFunction: true` is; otherwise only a function is.
 * @public
 */
export function isMockFunction(policy: MockPolicy, value: unknown): value is Mock<UnknownFunction> {
  if (value === null || value === undefined) return false
  if (!policy.isMockAcceptsObjects && typeof value !== 'function') return false
  return (value as { _isMockFunction?: unknown })._isMockFunction === true
}
