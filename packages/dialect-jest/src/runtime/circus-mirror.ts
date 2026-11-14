// T8.5's rest (B23d): a custom environment's `handleTestEvent`. jest-circus keeps its own tree
// (describe blocks, tests, hooks) and a state object, applies each event to them in
// `eventHandler.ts` (and the adapter's `jestAdapterInit.ts`), and only then calls the environment's
// handler, so a handler sees the objects already updated. This is that mirror: the runtime's
// neutral lifecycle events (`LifecycleEvent`) in, circus's events and objects out. The objects are
// Provino's own copies with circus's fields (name, parent, children, mode, errors, status,
// duration, invocations, startedAt, retryReasons; the state's fields): a handler that reads them
// sees the values circus would hold, but not circus's identical objects.
import type { LifecycleEvent, LifecycleRef } from '@provino/types'

/** The part of Jest's `globalConfig` the mirror's state reads (JSON, from the environment's options). */
export interface CircusConfig {
  readonly testLocationInResults?: boolean
  readonly maxConcurrency?: number
  readonly expand?: boolean
  readonly seed?: number
  readonly randomize?: boolean
  readonly testTimeout?: number
}

type BlockMode = 'skip' | 'only' | undefined
type HookType = 'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll'

interface Hook {
  asyncError: Error
  fn: unknown
  type: HookType
  parent: DescribeBlock
  seenDone: boolean
  timeout: number | undefined
}

interface DescribeBlock {
  type: 'describeBlock'
  children: Array<DescribeBlock | TestEntry>
  hooks: Hook[]
  mode: BlockMode
  name: string
  parent: DescribeBlock | undefined
  tests: TestEntry[]
}

interface TestEntry {
  type: 'test'
  asyncError: Error
  errors: unknown[]
  retryReasons: unknown[]
  fn: unknown
  invocations: number
  mode: 'skip' | 'only' | 'todo' | undefined
  concurrent: boolean
  name: string
  numPassingAsserts: number
  parent: DescribeBlock
  startedAt: number | null
  duration: number | null
  seenDone: boolean
  status: 'skip' | 'done' | 'todo' | null
  timeout: number | undefined
  failing: boolean
  unhandledRejectionErrorByPromise: Map<Promise<unknown>, unknown>
}

/** jest-circus's `State`. */
interface CircusState {
  currentDescribeBlock: DescribeBlock
  currentlyRunningTest: TestEntry | null
  describeRetryOptions: WeakMap<DescribeBlock, unknown>
  expand: boolean | undefined
  hasFocusedTests: boolean
  hasStarted: boolean
  includeTestLocationInResult: boolean
  maxConcurrency: number
  parentProcess: NodeJS.Process | null
  processErrorGeneration: number
  randomize: boolean | undefined
  rootDescribeBlock: DescribeBlock
  seed: number
  testNamePattern: RegExp | null
  testTimeout: number
  unhandledErrors: unknown[]
  unhandledRejectionErrorByPromise: Map<Promise<unknown>, unknown>
  unhandledRejectionErrorByPromiseByHook: WeakMap<Hook, Map<Promise<unknown>, unknown>>
  unhandledRejectionErrorByPromiseTarget: WeakMap<Promise<unknown>, Map<Promise<unknown>, unknown>>
}

/** A circus event, as the handler receives it. */
type CircusEvent = { readonly name: string } & Readonly<Record<string, unknown>>

/** What an environment's `handleTestEvent(event, state)` is, as the mirror calls it. */
export type HandleTestEvent = (event: never, state: never) => void | Promise<void>

const ROOT_NAME = 'ROOT_DESCRIBE_BLOCK'
const TEST_TIMEOUT_DEFAULT = 5000

function makeDescribe(name: string, parent?: DescribeBlock, mode?: BlockMode): DescribeBlock {
  // Not set explicitly: inherited from the parent (circus's `makeDescribe`).
  const own = parent !== undefined && mode === undefined ? parent.mode : mode
  return { type: 'describeBlock', children: [], hooks: [], mode: own, name, parent, tests: [] }
}

function createState(config: CircusConfig): CircusState {
  const root = makeDescribe(ROOT_NAME)
  return {
    currentDescribeBlock: root,
    currentlyRunningTest: null,
    describeRetryOptions: new WeakMap(),
    expand: config.expand,
    hasFocusedTests: false,
    hasStarted: false,
    includeTestLocationInResult: false,
    maxConcurrency: config.maxConcurrency ?? 5,
    parentProcess: null,
    processErrorGeneration: 0,
    randomize: config.randomize,
    rootDescribeBlock: root,
    seed: config.seed ?? 0,
    testNamePattern: null,
    testTimeout: config.testTimeout ?? TEST_TIMEOUT_DEFAULT,
    unhandledErrors: [],
    unhandledRejectionErrorByPromise: new Map(),
    unhandledRejectionErrorByPromiseByHook: new WeakMap(),
    unhandledRejectionErrorByPromiseTarget: new WeakMap(),
  }
}

/** Every test below a block, as circus's `addErrorToEachTestUnderDescribe` walks them. */
function testsUnder(block: DescribeBlock): TestEntry[] {
  const found: TestEntry[] = []
  for (const child of block.children) {
    if (child.type === 'test') found.push(child)
    else found.push(...testsUnder(child))
  }
  return found
}

function isHookType(kind: string): kind is HookType {
  return (
    kind === 'beforeAll' || kind === 'beforeEach' || kind === 'afterEach' || kind === 'afterAll'
  )
}

/**
 * The listener for a file's lifecycle events that feeds `handleTestEvent`. One per environment
 * instance; `file-setup` starts a new state, so a worker-scoped environment serves many files.
 */
export function createCircusMirror(
  handleTestEvent: HandleTestEvent,
  config: CircusConfig,
): (event: LifecycleEvent) => void | Promise<void> {
  let state = createState(config)
  let nodes = new Map<LifecycleRef, DescribeBlock | TestEntry>()
  /** The hooks the file registered, by block and kind, in registration order (the runtime's ordinals index these). */
  let declared = new Map<DescribeBlock, Map<HookType, Hook[]>>()
  /** The beforeEach hook the Jest adapter adds at the root, which no test file declares. */
  let adapterHook: Hook | undefined

  const call = (event: CircusEvent): void | Promise<void> =>
    (handleTestEvent as (event: CircusEvent, state: CircusState) => void | Promise<void>)(
      event,
      state,
    )

  const block = (ref: LifecycleRef): DescribeBlock => {
    const found = nodes.get(ref)
    if (found === undefined || found.type !== 'describeBlock') {
      throw new TypeError(`the lifecycle names a suite that was never defined: ${ref.name}`)
    }
    return found
  }
  const test = (ref: LifecycleRef): TestEntry => {
    const found = nodes.get(ref)
    if (found === undefined || found.type !== 'test') {
      throw new TypeError(`the lifecycle names a test that was never defined: ${ref.name}`)
    }
    return found
  }
  const hookOf = (owner: DescribeBlock, kind: HookType, ordinal: number): Hook | undefined =>
    declared.get(owner)?.get(kind)?.[ordinal]

  function addHook(owner: DescribeBlock, type: HookType, fn: unknown, timeout: number | undefined) {
    const hook: Hook = {
      asyncError: new Error(),
      fn,
      parent: owner,
      seenDone: false,
      timeout,
      type,
    }
    owner.hooks.push(hook)
    return hook
  }

  function clearErrors(owner: DescribeBlock, keep: boolean): void {
    for (const entry of testsUnder(owner)) {
      if (keep) entry.retryReasons.push(...entry.errors)
      entry.errors = []
    }
  }

  async function setup(root: DescribeBlock, testNamePattern: string | undefined): Promise<void> {
    state.parentProcess = process
    if (testNamePattern !== undefined) state.testNamePattern = new RegExp(testNamePattern, 'i')
    await call({
      name: 'setup',
      parentProcess: process,
      runtimeGlobals: {},
      ...(testNamePattern === undefined ? {} : { testNamePattern }),
    })
    if (config.testLocationInResults === true) {
      state.includeTestLocationInResult = true
      await call({ name: 'include_test_location_in_result' })
    }
    // jest-circus's adapter registers a `beforeEach` on the root before the setup files load.
    const hook = addHook(root, 'beforeEach', () => undefined, undefined)
    adapterHook = hook
    void call({
      name: 'add_hook',
      hookType: 'beforeEach',
      fn: hook.fn,
      timeout: undefined,
      asyncError: hook.asyncError,
    })
  }

  function hookEnd(event: Extract<LifecycleEvent, { type: 'hook-end' }>): void | Promise<void> {
    if (!isHookType(event.kind)) return undefined
    const owner = block(event.owner)
    const hook = hookOf(owner, event.kind, event.ordinal)
    if (hook === undefined) return undefined
    const entry = event.test === undefined ? undefined : test(event.test)
    const describeBlock =
      event.kind === 'beforeAll' || event.kind === 'afterAll' ? owner : undefined
    if (!event.failed) return call({ name: 'hook_success', describeBlock, hook, test: entry })
    // circus's `hook_failure`: a `beforeAll` fails every test below, an `afterAll` the file, an each-hook its test.
    const failure = [event.error, hook.asyncError]
    if (event.kind === 'beforeAll') {
      for (const below of testsUnder(owner)) below.errors.push(failure)
    } else if (event.kind === 'afterAll') {
      state.unhandledErrors.push(failure)
    } else {
      entry?.errors.push(failure)
    }
    return call({
      name: 'hook_failure',
      error: event.error,
      describeBlock,
      hook,
      test: entry,
    })
  }

  return (event) => {
    switch (event.type) {
      case 'file-setup': {
        state = createState(config)
        nodes = new Map([[event.root, state.rootDescribeBlock]])
        declared = new Map()
        adapterHook = undefined
        return setup(state.rootDescribeBlock, event.testNamePattern)
      }
      case 'file-teardown':
        return call({ name: 'teardown' })
      case 'define-suite-start': {
        const parent = block(event.parent)
        const made = makeDescribe(
          event.ref.name,
          parent,
          event.mode === 'todo' ? undefined : event.mode,
        )
        parent.children.push(made)
        state.currentDescribeBlock = made
        nodes.set(event.ref, made)
        return call({
          name: 'start_describe_definition',
          blockName: made.name,
          mode: event.mode,
          asyncError: new Error(),
        })
      }
      case 'define-suite-end': {
        const current = state.currentDescribeBlock
        // circus passes the block's mode down to the tests that declare none, unless a
        // `describe.only` already has a direct `test.only`; and notes focus.
        const passes = !(
          current.mode === 'only' &&
          current.children.some((child) => child.type === 'test' && child.mode === 'only')
        )
        if (passes) {
          for (const child of current.children) {
            if (child.type === 'test' && child.mode === undefined) child.mode = current.mode
          }
        }
        if (
          !state.hasFocusedTests &&
          current.mode !== 'skip' &&
          current.children.some((child) => child.type === 'test' && child.mode === 'only')
        ) {
          state.hasFocusedTests = true
        }
        if (current.parent !== undefined) state.currentDescribeBlock = current.parent
        return call({
          name: 'finish_describe_definition',
          blockName: current.name,
          mode: event.mode,
        })
      }
      case 'define-hook': {
        if (!isHookType(event.kind)) return undefined
        const owner = block(event.owner)
        const hook = addHook(owner, event.kind, event.fn, event.timeoutMs)
        const kinds = declared.get(owner) ?? new Map<HookType, Hook[]>()
        declared.set(owner, kinds)
        const list = kinds.get(event.kind) ?? []
        list.push(hook)
        kinds.set(event.kind, list)
        return call({
          name: 'add_hook',
          hookType: event.kind,
          fn: event.fn,
          timeout: event.timeoutMs,
          asyncError: hook.asyncError,
        })
      }
      case 'define-test': {
        const parent = block(event.parent)
        // `test.todo` has no function in Provino's tree; circus's has an empty one.
        const fn = event.fn ?? (() => undefined)
        const made: TestEntry = {
          type: 'test',
          asyncError: new Error(),
          concurrent: event.concurrent,
          duration: null,
          errors: [],
          failing: event.failing,
          fn,
          invocations: 0,
          mode: event.mode,
          name: event.ref.name,
          numPassingAsserts: 0,
          parent,
          retryReasons: [],
          seenDone: false,
          startedAt: null,
          status: null,
          timeout: event.timeoutMs,
          unhandledRejectionErrorByPromise: new Map(),
        }
        if (parent.mode !== 'skip' && made.mode === 'only') state.hasFocusedTests = true
        parent.children.push(made)
        parent.tests.push(made)
        nodes.set(event.ref, made)
        return call({
          name: 'add_test',
          testName: made.name,
          fn,
          mode: event.mode,
          concurrent: event.concurrent,
          timeout: event.timeoutMs,
          failing: event.failing,
          asyncError: made.asyncError,
        })
      }
      case 'run-start':
        state.hasStarted = true
        state.testTimeout = event.timeoutMs
        return call({ name: 'run_start' })
      case 'run-end':
        return call({ name: 'run_finish' })
      case 'suite-start':
        return call({ name: 'run_describe_start', describeBlock: block(event.ref) })
      case 'suite-end':
        return call({ name: 'run_describe_finish', describeBlock: block(event.ref) })
      case 'suite-retry': {
        const owner = block(event.ref)
        clearErrors(owner, event.keepEarlierErrors)
        return call({ name: 'describe_retry', describeBlock: owner })
      }
      case 'concurrent-start':
      case 'concurrent-end':
        return call({
          name:
            event.type === 'concurrent-start' ? 'concurrent_tests_start' : 'concurrent_tests_end',
          describeBlock: block(event.ref),
          tests: event.tests.map(test),
        })
      case 'test-start': {
        const entry = test(event.ref)
        state.currentlyRunningTest = entry
        entry.startedAt = Date.now()
        entry.invocations += 1
        return call({ name: 'test_start', test: entry })
      }
      case 'test-started': {
        const entry = test(event.ref)
        const started = call({ name: 'test_started', test: entry })
        const hook = adapterHook
        // The adapter's own beforeEach comes first, as the first of the root's hooks (circus stops
        // the chain once the test has an error).
        if (hook === undefined || entry.errors.length > 0) return started
        return (async () => {
          await started
          await call({ name: 'hook_start', hook })
          await call({ name: 'hook_success', describeBlock: undefined, hook, test: entry })
        })()
      }
      case 'test-skip': {
        const entry = test(event.ref)
        entry.status = 'skip'
        state.currentlyRunningTest = null
        return call({ name: 'test_skip', test: entry })
      }
      case 'test-todo': {
        const entry = test(event.ref)
        entry.status = 'todo'
        state.currentlyRunningTest = null
        return call({ name: 'test_todo', test: entry })
      }
      case 'fn-start': {
        const entry = test(event.ref)
        entry.seenDone = false
        return call({ name: 'test_fn_start', test: entry })
      }
      case 'fn-end': {
        const entry = test(event.ref)
        if (!event.failed) return call({ name: 'test_fn_success', test: entry })
        entry.errors.push([event.error, entry.asyncError])
        return call({ name: 'test_fn_failure', error: event.error, test: entry })
      }
      case 'test-done': {
        const entry = test(event.ref)
        // Errors the runtime added after the body (assertion counts, teardowns) are plain entries.
        for (const error of event.errors) {
          const known = entry.errors.some(
            (have) => have === error || (Array.isArray(have) && have[0] === error),
          )
          if (!known) entry.errors.push(error)
        }
        entry.duration = entry.startedAt === null ? null : Date.now() - entry.startedAt
        entry.status = 'done'
        state.currentlyRunningTest = null
        return call({ name: 'test_done', test: entry })
      }
      case 'test-retry': {
        const entry = test(event.ref)
        if (event.keepEarlierErrors) entry.retryReasons.push(...entry.errors)
        entry.errors = []
        return call({ name: 'test_retry', test: entry })
      }
      case 'hook-start': {
        if (!isHookType(event.kind)) return undefined
        const hook = hookOf(block(event.owner), event.kind, event.ordinal)
        if (hook === undefined) return undefined
        hook.seenDone = false
        return call({ name: 'hook_start', hook })
      }
      case 'hook-end':
        return hookEnd(event)
    }
  }
}
