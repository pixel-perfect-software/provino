// The collector (T5.3): `describe`/`test`/hook registration into a mutable tree, describe bodies
// run immediately or deferred, async bodies thrown or awaited, and late or nested registration.
// `finalize.ts` turns the tree into clone-safe `TaskNode`s after focus and filters.
import type { CorePolicy, FormatEachTitle, JsonValue, RunMode } from '@provino/types'
import { currentStore, newStore, runInStore } from '../current/current-test.ts'
import { CoreError } from '../errors.ts'
import { resolveTimeout } from '../executor/deadline.ts'
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
import { isThenable } from '../internal/thenable.ts'
import { type EachRow, eachRows } from './each.ts'
import {
  CALLER_FRAMES,
  captureSite,
  type Site,
  type StackMarker,
  TEST_FILE_FRAMES,
} from './location.ts'
import { isOpen, newSuiteNode } from './nodes.ts'
import { type RetryOption, retryOf } from './retry.ts'

/**
 * The options tests and describes both take as their second argument (Vitest's options object).
 * @public
 */
export interface CommonOptions {
  readonly timeout?: number
  readonly retry?: RetryOption
  readonly repeats?: number
  readonly concurrent?: boolean
  readonly skip?: boolean
  readonly only?: boolean
  readonly todo?: boolean
  readonly tags?: string | readonly string[]
  readonly meta?: Readonly<Record<string, JsonValue>>
}

/**
 * Options a test takes as its second argument.
 * @public
 */
export interface TestOptions extends CommonOptions {
  readonly fails?: boolean
}

/**
 * Options a describe takes as its second argument; its tests and nested describes inherit them,
 * `only`, `skip` and `todo` included.
 * @public
 */
export interface SuiteOptions extends CommonOptions {
  readonly shuffle?: boolean
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
  /**
   * A registration after collection, for the runtime to report. `chargedTo` is the file that
   * failed for it (`collect.lateRegistration: 'fail-file'`), which already has the error in its
   * `errors`: the file whose suite the registration was made in, else the file running now.
   * It may run inside a user's timer, so it must not throw.
   */
  readonly onLateRegistration: (error: CoreError, chargedTo: FileState | undefined) => void
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

  /** The suite registrations go to, if collection is open. Never a suite of a collected file. */
  collecting(): SuiteNode | undefined {
    const suite = this.#scope(currentStore())
    return isOpen(suite?.file) ? suite : undefined
  }

  /**
   * Collects one file: loads it through `load` with the file root open, runs deferred bodies,
   * and waits for async ones. Throws what the file's top level or a body threw, once every async
   * body has settled.
   */
  async collect(file: FileState, load: () => Promise<unknown>): Promise<void> {
    this.#file = file
    this.#pending.length = 0
    try {
      await this.#load(file, load)
      if (this.#config.policy.collect.describeBody === 'deferred') {
        await this.#runDeferred(file.root)
      }
      while (this.#pending.length > 0) await this.#pending.shift()
    } catch (error) {
      // Let every body of the failed file finish here, so none runs on into the next file.
      while (this.#pending.length > 0) await Promise.allSettled(this.#pending.splice(0))
      throw error
    }
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
    const parent = this.#target('test')
    if (parent === undefined) return
    const { policy } = this.#config
    const fn = spec.fn
    const inherited = parent.options
    const declared = this.#declare(spec.flags, spec.options, inherited, fn)
    if (declared === 'todo' && fn !== undefined && policy.collect.todoWithFn === 'throw') {
      throw new CoreError('CORE_TODO_WITH_FN', 'Todo must be called with only a description.')
    }
    if (fn !== undefined && typeof fn !== 'function') {
      throw new CoreError(
        'CORE_INVALID_ARGUMENT',
        `A test function must be a function, got ${typeof fn}`,
      )
    }
    const timeout = resolveTimeout(
      policy.timeouts,
      spec.timeout ?? spec.options.timeout ?? inherited.timeout,
    )
    const test: TestNode = {
      type: 'test',
      name: spec.name,
      parent,
      // A `.failing` test reports its definition's frames if it passes (jest-circus's `asyncError`).
      site: this.#site(spec.entry, spec.flags.fails === true || spec.options.fails === true),
      declared,
      mode: declared ?? 'run',
      skipReason:
        spec.flags.conditionSkip === true
          ? 'condition'
          : declared === 'skip'
            ? 'modifier'
            : undefined,
      id: '' as TestNode['id'],
      each: spec.each !== undefined,
      fn: fn as UserFn | undefined,
      arity: typeof fn === 'function' ? fn.length : 0,
      rowArgs: spec.each?.args,
      passContext: spec.each?.passContext ?? true,
      concurrent: spec.flags.concurrent ?? spec.options.concurrent ?? inherited.concurrent ?? false,
      expectFail: spec.flags.fails === true || spec.options.fails === true,
      timeoutMs: timeout,
      retry: retryOf(spec.options.retry, inherited.retry, policy.retry),
      repeats: spec.options.repeats ?? inherited.repeats ?? 0,
      tags: mergeTags(inherited.tags, spec.options.tags),
      meta: { ...inherited.meta, ...spec.options.meta },
      fullName: [],
      dupIndex: 0,
      task: undefined,
    }
    parent.children.push(test)
  }

  /** Registers one test per row of a `.each`/`.for` table, or the test an invalid table fails. */
  addTestTable(spec: TestSpec, table: EachTable): void {
    const rows = this.#rows(table, spec.name, spec.fn)
    if (rows instanceof CoreError) {
      this.addTest({ ...spec, fn: failWith(rows) })
      return
    }
    const passContext = table.mode === 'for'
    for (const row of rows) {
      this.addTest({ ...spec, name: row.title, each: { args: row.args, passContext } })
    }
  }

  /** Registers a describe block and runs (or defers) its body. */
  addSuite(spec: SuiteSpec): void {
    const parent = this.#target('describe')
    if (parent === undefined) return
    if (spec.flags.shuffle === true || spec.options.shuffle === true) {
      throw new CoreError('CORE_NOT_IMPLEMENTED', '`describe.shuffle` arrives with T5.13')
    }
    const inherited = parent.options
    const declared = this.#declare(spec.flags, spec.options, inherited, spec.body)
    if (spec.body !== undefined && typeof spec.body !== 'function') {
      throw new CoreError(
        'CORE_INVALID_ARGUMENT',
        `A describe body must be a function, got ${typeof spec.body}`,
      )
    }
    const options = inheritOptions(
      inherited,
      spec.options,
      spec.flags.concurrent,
      this.#config.policy.retry,
    )
    const suite = newSuiteNode({
      type: 'suite',
      name: spec.name,
      parent,
      file: parent.file,
      site: this.#site(spec.entry),
      declared,
      conditionSkip: spec.flags.conditionSkip === true,
      each: spec.each !== undefined,
      options,
      // A describe inside a concurrent one is concurrent too, unless it says otherwise (Vitest), so
      // the executor groups it with its concurrent siblings.
      concurrent: options.concurrent,
      body: spec.body as UserFn | undefined,
      bodyArgs: spec.each?.args ?? [],
    })
    parent.children.push(suite)
    if (this.#config.policy.collect.describeBody === 'immediate') {
      const settled = this.#runBody(suite)
      if (settled !== undefined) this.#track(settled)
    }
  }

  /** Registers one describe per row of a `.each`/`.for` table, or the test an invalid table fails. */
  addSuiteTable(spec: SuiteSpec, table: EachTable): void {
    const rows = this.#rows(table, spec.name, spec.body)
    if (rows instanceof CoreError) {
      const { name, options, flags, entry } = spec
      this.addTest({ name, fn: failWith(rows), options, flags, timeout: undefined, entry })
      return
    }
    for (const row of rows) this.addSuite({ ...spec, name: row.title, each: { args: row.args } })
  }

  /** Registers a hook on the current suite. */
  addHook(kind: DeclaredHookKind, fn: unknown, timeout: unknown, entry: StackMarker): void {
    if (typeof fn !== 'function') {
      throw new CoreError('CORE_INVALID_ARGUMENT', `"${kind}" expects a function, got ${typeof fn}`)
    }
    const owner = this.#target(kind)
    if (owner === undefined) return
    const hooks = owner.hooks[kind]
    const hook: HookNode = {
      kind,
      fn: fn as UserFn,
      arity: (fn as UserFn).length,
      ordinal: hooks.length,
      owner,
      timeoutMs: resolveTimeout(
        this.#config.policy.timeouts,
        typeof timeout === 'number' ? timeout : undefined,
      ),
      site: this.#site(entry),
      location: null,
    }
    hooks.push(hook)
  }

  /** Adds a hook at the end of a suite's list, for `LazyHost.addHook` (eager lazy values). */
  appendHook(owner: SuiteNode, kind: 'beforeEach' | 'beforeAll', fn: () => unknown): void {
    const hooks = owner.hooks[kind]
    hooks.push({
      kind,
      fn,
      arity: fn.length,
      ordinal: hooks.length,
      owner,
      timeoutMs: undefined,
      site: null,
      location: null,
    })
  }

  /** The suite the running code registers into, whether or not its file is still collecting. */
  #scope(store: Store | undefined): SuiteNode | undefined {
    if (store?.collecting !== undefined) return store.collecting
    if (store?.attempt !== undefined || store?.hook !== undefined) return undefined
    return this.#pointer
  }

  async #load(file: FileState, load: () => Promise<unknown>): Promise<void> {
    this.#pointer = file.root
    try {
      await runInStore(collectStore(file.root), load)
    } finally {
      this.#pointer = undefined
    }
  }

  /**
   * Where a registration goes: the collecting suite, or `undefined` after a late registration
   * was charged (`collect.lateRegistration`) and reported. Throws for a registration inside a
   * running test.
   */
  #target(what: string): SuiteNode | undefined {
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
    const suite = this.#scope(store)
    if (suite !== undefined && isOpen(suite.file)) return suite
    // An async describe continuation or a timer in a describe body belongs to its suite's file,
    // which may not be the file running now. Never thrown: this may run in a user's timer.
    const file = suite?.file ?? this.#file
    const error = new CoreError(
      'CORE_LATE_REGISTRATION',
      file === undefined
        ? `"${what}" was called outside a test file's collection`
        : `Cannot add "${what}" after tests have started running. Tests and hooks must be defined during collection.`,
    )
    const chargedTo =
      this.#config.policy.collect.lateRegistration === 'fail-file' ? file : undefined
    chargedTo?.errors.push(error)
    this.#config.onLateRegistration(error, chargedTo)
    return undefined
  }

  /**
   * A registration's declared mode. Under `missingTestFn: 'todo'` only a registration that
   * declares no mode becomes a todo: `.skip` stays skipped, and `.only` keeps its focus (and fails
   * when it runs, having no function).
   */
  #declare(
    flags: Flags,
    own: ModeOptions,
    inherited: ModeOptions,
    fn: unknown,
  ): RunMode | undefined {
    const declared = declaredMode(flags, own, inherited)
    if (fn !== undefined || declared === 'todo') return declared
    if (this.#config.policy.missingTestFn === 'throw') {
      throw new CoreError(
        'CORE_MISSING_TEST_FN',
        'Missing second argument. It must be a callback function.',
      )
    }
    return declared ?? 'todo'
  }

  /** A registration's callsite, with the frames `locationFrame` needs. */
  #site(entry: StackMarker, deep = false): Site | null {
    const frames =
      deep || this.#config.policy.locationFrame === 'test-file' ? TEST_FILE_FRAMES : CALLER_FRAMES
    return captureSite(entry, this.#config.locations, frames)
  }

  /**
   * A table's registrations, titled by the policy's `formatEachTitle`. Under
   * `collect.eachTableError: 'failing-test'` an invalid table, or a missing function, gives the
   * error its one failing test reports instead (jest-each); `'lenient'` reads what it can, and a
   * missing function is left to `missingTestFn` (Vitest).
   */
  #rows(table: EachTable, name: string, fn: unknown): EachRegistration[] | CoreError {
    const strict = this.#config.policy.collect.eachTableError === 'failing-test'
    if (strict && fn === undefined) {
      return new CoreError('CORE_INVALID_EACH_TABLE', '`.each` was called without a test function')
    }
    const rows = strict ? strictRows(table) : eachRows(table.cases, table.values, false)
    if (rows instanceof CoreError) return rows
    return rows.map((row, index) => ({
      // `.for` titles a row that is `null` or `undefined` as an empty one, where `.each` has `[null]`.
      title: this.#config.formatEachTitle(
        name,
        table.mode === 'for' && row.item == null ? [] : row.row,
        index,
        row.kind,
      ),
      args: table.mode === 'for' ? [row.item] : row.args,
    }))
  }

  /**
   * Keeps an async body for `collect` to await. It is handled at once, so a rejection while
   * another body is awaited, or after the file has already failed, is never unhandled.
   */
  #track(body: Promise<unknown>): void {
    void body.catch(() => undefined)
    this.#pending.push(body)
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

/** One test registration. */
export interface TestSpec {
  readonly name: string
  readonly fn: unknown
  readonly options: TestOptions
  readonly flags: Flags
  /** A timeout given as the third argument. */
  readonly timeout: number | undefined
  readonly entry: StackMarker
  readonly each?: { readonly args: readonly unknown[]; readonly passContext: boolean }
}

/** One describe registration. */
export interface SuiteSpec {
  readonly name: string
  readonly body: unknown
  readonly options: SuiteOptions
  readonly flags: Flags
  readonly entry: StackMarker
  readonly each?: { readonly args: readonly unknown[] }
}

/** A `.each`/`.for` call: the table, the values a tagged template interpolates, and which call. */
export interface EachTable {
  readonly cases: unknown
  readonly values: readonly unknown[]
  readonly mode: 'each' | 'for'
}

/** One row's registration: its title and the arguments it passes. */
interface EachRegistration {
  readonly title: string
  readonly args: readonly unknown[]
}

/** The options that set a mode. */
interface ModeOptions {
  readonly only?: boolean | undefined
  readonly skip?: boolean | undefined
  readonly todo?: boolean | undefined
}

function collectStore(suite: SuiteNode): Store {
  return newStore({ collecting: suite })
}

/**
 * Chained flags first, then the options (a registration's own over its suite's, as Vitest's
 * `assignDefined` merges them); `only` wins over `skip`, which wins over `todo`.
 */
function declaredMode(flags: Flags, own: ModeOptions, inherited: ModeOptions): RunMode | undefined {
  if (flags.only === true || (own.only ?? inherited.only) === true) return 'only'
  if (
    flags.skip === true ||
    flags.conditionSkip === true ||
    (own.skip ?? inherited.skip) === true
  ) {
    return 'skip'
  }
  if (flags.todo === true || (own.todo ?? inherited.todo) === true) return 'todo'
  return undefined
}

/** A registration's mode options merged over its suite's, as Vitest's `assignDefined` merges them. */
function modeOptions(inherited: InheritedOptions, own: ModeOptions): ModeOptions {
  return {
    only: own.only ?? inherited.only,
    skip: own.skip ?? inherited.skip,
    todo: own.todo ?? inherited.todo,
  }
}

/**
 * What a describe passes down: its options over its parent's, and a chained `.concurrent`, which
 * is `{ concurrent: true }` (Vitest).
 */
function inheritOptions(
  inherited: InheritedOptions,
  own: SuiteOptions,
  chainedConcurrent: boolean | undefined,
  retryPolicy: CorePolicy['retry'],
): InheritedOptions {
  return {
    ...modeOptions(inherited, own),
    timeout: own.timeout ?? inherited.timeout,
    // Read here, so a wrong `retry` fails the describe, not each of its tests.
    retry: retryOf(own.retry, inherited.retry, retryPolicy),
    repeats: own.repeats ?? inherited.repeats,
    concurrent: chainedConcurrent ?? own.concurrent ?? inherited.concurrent,
    tags: mergeTags(inherited.tags, own.tags),
    meta: { ...inherited.meta, ...own.meta },
  }
}

/** A strict read of a table, with what makes it invalid returned as the error its test fails. */
function strictRows(table: EachTable): EachRow[] | CoreError {
  try {
    return eachRows(table.cases, table.values, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new CoreError('CORE_INVALID_EACH_TABLE', message, { cause: error })
  }
}

/** The body of the test an invalid table registers. */
function failWith(error: CoreError): () => never {
  return () => {
    throw error
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

/** A registration's name: a function or class gives its name, anything else its string. */
export function formatName(name: unknown): string {
  if (typeof name === 'function') return name.name
  return String(name)
}
