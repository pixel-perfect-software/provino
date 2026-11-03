// The collector (T5.3): `describe`/`test`/hook registration into a mutable tree, describe bodies
// run immediately or deferred, async bodies thrown or awaited, and late or nested registration.
// `finalize.ts` turns the tree into clone-safe `TaskNode`s after focus and filters.
import type { CorePolicy, FormatEachTitle, JsonValue, RunMode } from '@provino/types'
import { currentStore, runInStore } from '../current/current-test.ts'
import { CoreError } from '../errors.ts'
import type {
  DeclaredHookKind,
  FileState,
  HookNode,
  InheritedOptions,
  Store,
  SuiteNode,
  TestNode,
  UserFn,
} from '../internal/model.ts'
import { eachRows } from './each.ts'
import { captureSite } from './location.ts'
import { newSuiteNode } from './nodes.ts'

/**
 * Options a test takes as its second argument (Vitest's options object).
 * @public
 */
export interface TestOptions {
  readonly timeout?: number
  readonly retry?: number
  readonly repeats?: number
  readonly concurrent?: boolean
  readonly skip?: boolean
  readonly only?: boolean
  readonly todo?: boolean
  readonly fails?: boolean
  readonly tags?: string | readonly string[]
  readonly meta?: Readonly<Record<string, JsonValue>>
}

/**
 * Options a describe takes as its second argument; its tests inherit them.
 * @public
 */
export interface SuiteOptions {
  readonly timeout?: number
  readonly retry?: number
  readonly repeats?: number
  readonly concurrent?: boolean
  readonly skip?: boolean
  readonly only?: boolean
  readonly todo?: boolean
  readonly shuffle?: boolean
  readonly tags?: string | readonly string[]
  readonly meta?: Readonly<Record<string, JsonValue>>
}

/** Modifiers set by chaining (`test.only.concurrent`). */
export interface Flags {
  readonly only?: boolean
  readonly skip?: boolean
  readonly todo?: boolean
  readonly concurrent?: boolean
  readonly fails?: boolean
  readonly shuffle?: boolean
  /** `skipIf(true)`/`runIf(false)`: skipped, reason `condition`. */
  readonly conditionSkip?: boolean
}

/** What the collector needs from the runtime. */
export interface CollectorConfig {
  readonly policy: CorePolicy
  readonly formatEachTitle: FormatEachTitle
  readonly locations: boolean
  /** A registration after collection; the runtime reports it (`collect.lateRegistration`). */
  readonly onLateRegistration: (file: FileState, error: CoreError) => void
}

/** The registration target behind the global API. One per runtime; one file at a time. */
export class Collector {
  readonly #config: CollectorConfig
  /** The file collecting or running now. */
  #file: FileState | undefined
  /** The suite whose body runs synchronously now (the file root while its module loads). */
  #pointer: SuiteNode | undefined
  /** Async describe bodies still settling (`asyncDescribe: 'await'` with immediate bodies). */
  readonly #pending: Array<Promise<unknown>> = []

  constructor(config: CollectorConfig) {
    this.#config = config
  }

  /** The file collecting or running now. */
  get file(): FileState | undefined {
    return this.#file
  }

  /** The suite registrations go to, if collection is open. */
  collecting(): SuiteNode | undefined {
    const store = currentStore()
    if (store?.collecting !== undefined) return store.collecting
    if (store?.attempt !== undefined || store?.hook !== undefined) return undefined
    return this.#pointer
  }

  /**
   * Collects one file: loads it through `load` with the file root open, runs deferred bodies,
   * and waits for async ones. Throws what the file's top level or a body threw.
   */
  async collect(file: FileState, load: () => Promise<unknown>): Promise<void> {
    if (this.#file !== undefined && !this.#file.collected) {
      throw new CoreError('CORE_BUSY', `"${this.#file.path}" is still collecting`)
    }
    this.#file = file
    this.#pending.length = 0
    this.#pointer = file.root
    try {
      await runInStore(collectStore(file.root), load)
    } finally {
      this.#pointer = undefined
    }
    if (this.#config.policy.collect.describeBody === 'deferred') await this.#runDeferred(file.root)
    while (this.#pending.length > 0) await this.#pending.shift()
  }

  /** Marks the file collected: later registrations are late. */
  close(file: FileState): void {
    file.collected = true
  }

  /** Clears the active file once it has run. */
  release(file: FileState): void {
    if (this.#file === file) this.#file = undefined
  }

  /** Registers a test (or one `.each`/`.for` row's test). */
  addTest(spec: TestSpec): void {
    const parent = this.#target('test', spec.entry)
    if (parent === undefined) return
    const { policy } = this.#config
    const fn = spec.fn
    let declared = declaredMode(spec.flags, spec.options)
    if (fn === undefined && declared !== 'todo') {
      if (policy.missingTestFn === 'throw') {
        throw new CoreError(
          'CORE_MISSING_TEST_FN',
          'Missing second argument. It must be a callback function.',
        )
      }
      declared = 'todo'
    }
    if (declared === 'todo' && fn !== undefined && policy.collect.todoWithFn === 'throw') {
      throw new CoreError('CORE_TODO_WITH_FN', 'Todo must be called with only a description.')
    }
    if (fn !== undefined && typeof fn !== 'function') {
      throw new CoreError(
        'CORE_INVALID_ARGUMENT',
        `A test function must be a function, got ${typeof fn}`,
      )
    }
    const inherited = parent.options
    const site = captureSite(spec.entry, this.#config.locations)
    const test: TestNode = {
      type: 'test',
      name: spec.name,
      parent,
      site,
      declared,
      mode: declared ?? 'run',
      skipReason: spec.flags.conditionSkip === true ? 'condition' : undefined,
      id: '' as TestNode['id'],
      each: spec.each !== undefined,
      fn: fn as UserFn | undefined,
      rowArgs: spec.each?.args,
      passContext: spec.each?.passContext ?? true,
      concurrent: spec.flags.concurrent ?? spec.options.concurrent ?? inherited.concurrent ?? false,
      expectFail: spec.flags.fails === true || spec.options.fails === true,
      timeoutMs: spec.timeout ?? spec.options.timeout ?? inherited.timeout ?? policy.timeouts.test,
      retry: spec.options.retry ?? inherited.retry ?? 0,
      repeats: spec.options.repeats ?? inherited.repeats ?? 0,
      tags: mergeTags(inherited.tags, spec.options.tags),
      meta: { ...inherited.meta, ...spec.options.meta },
      fullName: [],
      dupIndex: 0,
    }
    parent.children.push(test)
  }

  /** Registers a describe block and runs (or defers) its body. */
  addSuite(spec: SuiteSpec): void {
    const parent = this.#target('describe', spec.entry)
    if (parent === undefined) return
    if (spec.flags.shuffle === true || spec.options.shuffle === true) {
      throw new CoreError('CORE_NOT_IMPLEMENTED', '`describe.shuffle` arrives with T5.13')
    }
    let declared = declaredMode(spec.flags, spec.options)
    if (spec.body === undefined && declared !== 'todo') {
      if (this.#config.policy.missingTestFn === 'throw') {
        throw new CoreError(
          'CORE_MISSING_TEST_FN',
          'Missing second argument. It must be a callback function.',
        )
      }
      declared = 'todo'
    }
    if (spec.body !== undefined && typeof spec.body !== 'function') {
      throw new CoreError(
        'CORE_INVALID_ARGUMENT',
        `A describe body must be a function, got ${typeof spec.body}`,
      )
    }
    const inherited = parent.options
    // `describe.concurrent` is `describe(name, { concurrent: true }, …)`: its tests inherit it.
    const concurrent = spec.flags.concurrent ?? spec.options.concurrent
    const options: InheritedOptions = {
      ...pick(inherited, concurrent === undefined ? spec.options : { ...spec.options, concurrent }),
      tags: mergeTags(inherited.tags, spec.options.tags),
      meta: { ...inherited.meta, ...spec.options.meta },
    }
    const suite = newSuiteNode({
      type: 'suite',
      name: spec.name,
      parent,
      file: parent.file,
      site: captureSite(spec.entry, this.#config.locations),
      declared,
      conditionSkip: spec.flags.conditionSkip === true,
      each: spec.each !== undefined,
      options,
      concurrent,
      body: spec.body as UserFn | undefined,
      bodyArgs: spec.each?.args ?? [],
    })
    parent.children.push(suite)
    if (this.#config.policy.collect.describeBody === 'immediate') {
      const settled = this.#runBody(suite)
      if (settled !== undefined) this.#pending.push(settled)
    }
  }

  /** Registers a hook on the current suite. */
  addHook(kind: DeclaredHookKind, fn: unknown, timeout: unknown, entry: AnyFunction): void {
    if (typeof fn !== 'function') {
      throw new CoreError('CORE_INVALID_ARGUMENT', `"${kind}" expects a function, got ${typeof fn}`)
    }
    const owner = this.#target(kind, entry)
    if (owner === undefined) return
    const hooks = owner.hooks[kind]
    const hook: HookNode = {
      kind,
      fn: fn as UserFn,
      ordinal: hooks.length,
      owner,
      timeoutMs: typeof timeout === 'number' ? timeout : undefined,
      site: captureSite(entry, this.#config.locations),
    }
    hooks.push(hook)
  }

  /** Adds a hook at the end of a suite's list, for `LazyHost.addHook` (eager lazy values). */
  appendHook(owner: SuiteNode, kind: 'beforeEach' | 'beforeAll', fn: () => unknown): void {
    const hooks = owner.hooks[kind]
    hooks.push({ kind, fn, ordinal: hooks.length, owner, timeoutMs: undefined, site: null })
  }

  /**
   * Where a registration goes: the collecting suite, or `undefined` after a late registration
   * was reported. Throws for a registration inside a running test.
   */
  #target(what: string, _entry: AnyFunction): SuiteNode | undefined {
    const store = currentStore()
    if (store?.attempt !== undefined) {
      const error = new CoreError(
        'CORE_NESTED_REGISTRATION',
        `"${what}" cannot be called inside a running test ("${store.attempt.test.name}")`,
      )
      if (this.#config.policy.collect.nestedInTest === 'throw') throw error
      store.attempt.errors.push(error)
      return undefined
    }
    const suite = this.collecting()
    if (suite !== undefined && !suite.file.collected) return suite
    const file = this.#file
    if (file === undefined) {
      throw new CoreError(
        'CORE_LATE_REGISTRATION',
        `"${what}" was called outside a test file's collection`,
      )
    }
    this.#config.onLateRegistration(
      file,
      new CoreError(
        'CORE_LATE_REGISTRATION',
        `Cannot add "${what}" after tests have started running. Tests and hooks must be defined during collection.`,
      ),
    )
    return undefined
  }

  /** Runs a body; returns its promise when the policy awaits async bodies. */
  #runBody(suite: SuiteNode): Promise<unknown> | undefined {
    const body = suite.body
    suite.body = undefined
    if (body === undefined) return undefined
    const result = runInStore(collectStore(suite), () =>
      Reflect.apply(body, undefined, suite.bodyArgs),
    )
    if (isThenable(result)) {
      if (this.#config.policy.asyncDescribe === 'throw') {
        // Settle it quietly: the error below is what the user sees.
        void Promise.resolve(result).catch(() => undefined)
        throw new CoreError(
          'CORE_ASYNC_DESCRIBE',
          'Returning a Promise from "describe" is not supported. Tests must be defined synchronously.',
        )
      }
      return Promise.resolve(result)
    }
    if (result !== undefined && this.#config.policy.collect.describeReturnValue === 'error') {
      throw new CoreError(
        'CORE_DESCRIBE_RETURN_VALUE',
        'A "describe" callback must not return a value.',
      )
    }
    return undefined
  }

  /** Deferred bodies: parents before children, depth first in declaration order (Vitest). */
  async #runDeferred(suite: SuiteNode): Promise<void> {
    for (const child of [...suite.children]) {
      if (child.type === 'test') continue
      const settled = this.#runBody(child)
      if (settled !== undefined) await settled
      await this.#runDeferred(child)
    }
  }
}

/** A function the API passes as the stack-capture marker. */
// biome-ignore lint/complexity/noBannedTypes: any function can mark where the user's frames start
export type AnyFunction = Function

/** One test registration. */
export interface TestSpec {
  readonly name: string
  readonly fn: unknown
  readonly options: TestOptions
  readonly flags: Flags
  /** A timeout given as the third argument. */
  readonly timeout: number | undefined
  readonly entry: AnyFunction
  readonly each?: { readonly args: readonly unknown[]; readonly passContext: boolean }
}

/** One describe registration. */
export interface SuiteSpec {
  readonly name: string
  readonly body: unknown
  readonly options: SuiteOptions
  readonly flags: Flags
  readonly entry: AnyFunction
  readonly each?: { readonly args: readonly unknown[] }
}

function collectStore(suite: SuiteNode): Store {
  return {
    frame: undefined,
    lazy: undefined,
    collecting: suite,
    attempt: undefined,
    hook: undefined,
  }
}

function declaredMode(flags: Flags, options: TestOptions | SuiteOptions): RunMode | undefined {
  if (flags.only === true || options.only === true) return 'only'
  if (flags.skip === true || flags.conditionSkip === true || options.skip === true) return 'skip'
  if (flags.todo === true || options.todo === true) return 'todo'
  return undefined
}

function pick(
  inherited: InheritedOptions,
  options: SuiteOptions,
): Omit<InheritedOptions, 'tags' | 'meta'> {
  const timeout = options.timeout ?? inherited.timeout
  const retry = options.retry ?? inherited.retry
  const repeats = options.repeats ?? inherited.repeats
  const concurrent = options.concurrent ?? inherited.concurrent
  return {
    ...(timeout === undefined ? {} : { timeout }),
    ...(retry === undefined ? {} : { retry }),
    ...(repeats === undefined ? {} : { repeats }),
    ...(concurrent === undefined ? {} : { concurrent }),
  }
}

function mergeTags(
  inherited: readonly string[],
  own: string | readonly string[] | undefined,
): readonly string[] {
  if (own === undefined) return inherited
  const list = typeof own === 'string' ? [own] : own
  return [...new Set([...inherited, ...list])]
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** A registration's name: a function or class gives its name, anything else its string. */
export function formatName(name: unknown): string {
  if (typeof name === 'function') return name.name
  return String(name)
}

/**
 * Expands `.each`/`.for` into one registration per row, with titles from the policy's
 * `formatEachTitle`.
 */
export function expandRows(
  formatEachTitle: FormatEachTitle,
  cases: unknown,
  values: readonly unknown[],
  name: string,
  mode: 'each' | 'for',
): Array<{ readonly title: string; readonly args: readonly unknown[] }> {
  return eachRows(cases, values).map((row, index) => ({
    title: formatEachTitle(name, row.row, index),
    args: mode === 'for' ? [row.item] : row.args,
  }))
}

export { isThenable }
