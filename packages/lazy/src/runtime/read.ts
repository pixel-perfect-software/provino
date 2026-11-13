// Reads: resolve a key from the test's innermost suite outward, find or make its memo cell, and run
// the definition on the first read. A memoized read of a test-scoped value is the host's frame
// lookup, two map reads on the resolved suite, one on the memo and a state check; it allocates nothing.
import type { LazyFrame, Scope, SourceLocation, SuiteHandle, TaskInfo } from '@provino/types'
import { LazyError } from '../errors.ts'
import type { EvaluatedLazy } from '../types.ts'
import { registerCleanup, scopeSignal } from './cleanup.ts'
import { formatSite } from './site.ts'
import {
  Cell,
  EAGER_WAIT,
  type Engine,
  ERR,
  EVAL,
  EvalFrame,
  type LazyEntry,
  LOG,
  OK,
  VIEW_CLASS,
} from './state.ts'
import { resolveEntry, visibleKeys } from './table.ts'

// Timers the definition's timeout uses are the real ones, captured when this module loads, so fake
// timers installed by a test never stall or fire a lazy timeout.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

const RANK: Record<Scope, number> = { worker: 0, file: 1, test: 2 }

/** An evaluated lazy value in a run's log. */
class Logged implements EvaluatedLazy {
  readonly key: string
  readonly site: SourceLocation
  readonly override: boolean
  readonly ms: number

  constructor(entry: LazyEntry, ms: number) {
    this.key = entry.key
    this.site = entry.site
    this.override = entry.override
    this.ms = ms
  }
}

// A view's state sits under module-private symbols, so no lazy key (`suite`, `engine`, `from`, …)
// can collide with it.
const V_ENGINE: unique symbol = Symbol('provino.lazy.view.engine')
const V_FRAME: unique symbol = Symbol('provino.lazy.view.frame')
const V_SUITE: unique symbol = Symbol('provino.lazy.view.suite')
const V_FROM: unique symbol = Symbol('provino.lazy.view.from')

/** What a definition's `deps` and `$.from(ctx)` give: getters over every key the suite can see. */
class View {
  readonly [V_ENGINE]: Engine
  readonly [V_FRAME]: LazyFrame
  readonly [V_SUITE]: SuiteHandle
  readonly [V_FROM]: EvalFrame | null

  constructor(engine: Engine, frame: LazyFrame, suite: SuiteHandle, from: EvalFrame | null) {
    this[V_ENGINE] = engine
    this[V_FRAME] = frame
    this[V_SUITE] = suite
    this[V_FROM] = from
  }
}

type ViewClass = new (
  engine: Engine,
  frame: LazyFrame,
  suite: SuiteHandle,
  from: EvalFrame | null,
) => View

function viewClassOf(suite: SuiteHandle): ViewClass {
  let cls = suite.slots.get(VIEW_CLASS) as ViewClass | undefined
  if (cls === undefined) {
    const made = class extends View {}
    for (const key of visibleKeys(suite)) {
      Object.defineProperty(made.prototype, key, {
        enumerable: true,
        get(this: View): unknown {
          return readFrom(this[V_ENGINE], this[V_FRAME], this[V_SUITE], key, this[V_FROM])
        },
      })
    }
    cls = made
    suite.slots.set(VIEW_CLASS, made)
  }
  return cls
}

/**
 * A view of the values for the test a frame belongs to, with no async context: what `$.from(ctx)`
 * returns.
 */
export function viewOf(engine: Engine, frame: LazyFrame): object {
  const Cls = viewClassOf(frame.suite)
  return new Cls(engine, frame, frame.suite, null)
}

function describeEntry(entry: LazyEntry): string {
  return `\`${entry.key}\` (${formatSite(entry.site)})`
}

function cycleError(chain: readonly LazyEntry[]): LazyError {
  return new LazyError('LAZY_CYCLE', `lazy cycle: ${chain.map(describeEntry).join(' -> ')}`, {
    sites: chain.map((entry) => entry.site),
  })
}

/** The cycle that reading `entry` closes, from the synchronous stack or the dependency chain. */
function cycleFrom(engine: Engine, entry: LazyEntry, from: EvalFrame | null): LazyError {
  const chain: LazyEntry[] = []
  if (from !== null) {
    for (let f: EvalFrame | null = from; f !== null; f = f.from) {
      chain.push(f.entry)
      if (f.entry === entry) break
    }
    chain.reverse()
  } else {
    const at = engine.stack.findIndex((frame) => frame.entry === entry)
    for (const frame of engine.stack.slice(Math.max(at, 0))) chain.push(frame.entry)
  }
  chain.push(entry)
  return cycleError(chain)
}

function eagerPending(entry: LazyEntry): LazyError {
  return new LazyError(
    'LAZY_EAGER_PENDING',
    `\`${entry.key}\` (${formatSite(entry.site)}) is eager and has not been evaluated yet: its hook runs at the place it is declared, so read it in a hook declared after that, or in the test.`,
    { site: entry.site },
  )
}

/** Checks that `reader` (the evaluation asking) may read `entry`: scope, and for a chain, cycles. */
function checkReader(engine: Engine, entry: LazyEntry, reader: EvalFrame, chained: boolean): void {
  if (chained) {
    for (let f: EvalFrame | null = reader; f !== null; f = f.from) {
      if (f.entry === entry) throw cycleFrom(engine, entry, reader)
    }
  }
  if (RANK[reader.entry.scope] < RANK[entry.scope]) {
    throw new LazyError(
      'LAZY_SCOPE',
      `\`${reader.entry.key}\` (${formatSite(reader.entry.site)}) has scope '${reader.entry.scope}' and cannot read \`${entry.key}\` (${formatSite(entry.site)}), which has the narrower scope '${entry.scope}'. Give \`${entry.key}\` scope '${reader.entry.scope}' or wider, or read it in a test.`,
      { sites: [reader.entry.site, entry.site] },
    )
  }
}

/** The map a value is memoized in. */
function memoOf(engine: Engine, entry: LazyEntry, frame: LazyFrame): Map<symbol, unknown> {
  if (entry.scope === 'worker') return engine.host.workerSlots
  if (entry.scope === 'file') return frame.file.slots
  if (frame.kind === 'test') return frame.run.slots
  if (engine.policy.readInBeforeAll === 'error') {
    throw new LazyError(
      'LAZY_SCOPE',
      `\`${entry.key}\` (${formatSite(entry.site)}) is test-scoped and cannot be read in ${frame.hook}. Read it in beforeEach, or declare it with { scope: 'file' }.`,
      { site: entry.site },
    )
  }
  return frame.suite.slots
}

function taskOf(frame: LazyFrame): TaskInfo {
  if (frame.kind === 'test') return frame.run.ctx.task
  // A test-scoped value read in a suite hook (`readInBeforeAll: 'allow'`) has no test: its task
  // describes the suite.
  return {
    name: frame.suite.name,
    fullName: frame.suite.name,
    file: frame.file.name,
    retry: 0,
    repeat: 0,
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Rejects with `LAZY_TIMEOUT` and aborts the definition's signal when `pending` outlasts `ms`. */
function withTimeout(
  pending: PromiseLike<unknown>,
  entry: LazyEntry,
  ms: number,
  controller: AbortController,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => {
      const error = new LazyError(
        'LAZY_TIMEOUT',
        `\`${entry.key}\` (${formatSite(entry.site)}) did not settle within ${ms} ms.`,
        { site: entry.site },
      )
      controller.abort(error)
      reject(error)
    }, ms)
    pending.then(
      (value) => {
        realClearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        realClearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** How one evaluation ended. */
interface Outcome {
  readonly ok: boolean
  readonly value: unknown
}

/**
 * Runs `entry`'s definition: its `deps` view, its context (`onCleanup`, `signal`, `parent`), the
 * synchronous stack, the timeout and the run's log. Nothing is memoized here.
 */
function run(engine: Engine, entry: LazyEntry, frame: LazyFrame, from: EvalFrame | null): Outcome {
  const evalFrame = new EvalFrame(entry, from)
  const resolveFrom = entry.scope === 'test' ? frame.suite : entry.suite
  const Cls = viewClassOf(resolveFrom)
  const deps = new Cls(engine, frame, resolveFrom, evalFrame)
  const scope = scopeSignal(engine, entry, frame)
  let controller: AbortController | undefined
  let signal = scope
  if (entry.timeout !== undefined) {
    controller = new AbortController()
    signal = AbortSignal.any([scope, controller.signal])
  }
  let parentValue: { readonly value: unknown } | undefined
  const ctx = {
    key: entry.key,
    scope: entry.scope,
    task: entry.scope === 'test' ? taskOf(frame) : undefined,
    signal,
    onCleanup(fn: () => unknown): void {
      registerCleanup(engine, entry, frame, fn)
    },
    parent(): unknown {
      if (parentValue === undefined) {
        const parent = entry.parentEntry
        if (parent === null) {
          throw new LazyError(
            'LAZY_UNDEFINED',
            `\`${entry.key}\` (${formatSite(entry.site)}) has no outer definition, so it has no parent().`,
            { site: entry.site },
          )
        }
        const outcome = run(engine, parent, frame, evalFrame)
        let value = outcome.value
        if (entry.eager) {
          value = outcome.ok ? Promise.resolve(value) : Promise.reject(value)
        } else if (!outcome.ok) {
          throw value
        }
        parentValue = { value }
      }
      return parentValue.value
    },
  }
  const start = performance.now()
  let outcome: Outcome
  engine.stack.push(evalFrame)
  try {
    let value = entry.define(deps, ctx)
    if (controller !== undefined && entry.timeout !== undefined && isThenable(value)) {
      value = withTimeout(value, entry, entry.timeout, controller)
    }
    outcome = { ok: true, value }
  } catch (error) {
    outcome = { ok: false, value: error }
  } finally {
    engine.stack.pop()
  }
  if (frame.kind === 'test') {
    let log = frame.run.slots.get(LOG) as Logged[] | undefined
    if (log === undefined) {
      log = []
      frame.run.slots.set(LOG, log)
    }
    log.push(new Logged(entry, performance.now() - start))
  }
  return outcome
}

/** Reads `key` for the test (or hook) a frame belongs to, resolving from `suite` outward. */
export function readFrom(
  engine: Engine,
  frame: LazyFrame,
  suite: SuiteHandle,
  key: string,
  from: EvalFrame | null,
): unknown {
  const entry = resolveEntry(suite, key)
  const top = engine.stack.length === 0 ? null : (engine.stack[engine.stack.length - 1] ?? null)
  if (from !== null) checkReader(engine, entry, from, true)
  else if (top !== null) checkReader(engine, entry, top, false)
  const memo = memoOf(engine, entry, frame)
  const cell = memo.get(entry.memo) as Cell | undefined
  if (cell !== undefined) {
    if (cell.state === OK) return cell.value
    if (cell.state === ERR) throw cell.value
    if (cell.state === EAGER_WAIT) throw eagerPending(entry)
    throw cycleFrom(engine, entry, from)
  }
  if (entry.eager) throw eagerPending(entry)
  if (entry.scope === 'test' && frame.kind === 'test' && frame.run.state === 'cleanup') {
    throw new LazyError(
      'LAZY_IN_CLEANUP',
      `\`${entry.key}\` (${formatSite(entry.site)}) was first read while the test was cleaning up. Read it in the test or a hook before then.`,
      { site: entry.site },
    )
  }
  const fresh = new Cell(EVAL)
  memo.set(entry.memo, fresh)
  const outcome = run(engine, entry, frame, from)
  fresh.state = outcome.ok ? OK : ERR
  fresh.value = outcome.value
  if (!outcome.ok) throw outcome.value
  return outcome.value
}

/**
 * The first read of an eager value, in its hook: runs the definition, then awaits it and replaces
 * the memo with the settled value. Reads before it settles throw `LAZY_EAGER_PENDING`.
 */
export async function evaluateEager(
  engine: Engine,
  entry: LazyEntry,
  frame: LazyFrame,
): Promise<void> {
  const memo = memoOf(engine, entry, frame)
  const existing = memo.get(entry.memo) as Cell | undefined
  if (existing !== undefined) {
    if (existing.wait !== undefined) await existing.wait
    if (existing.state === ERR) throw existing.value
    return
  }
  const cell = new Cell(EVAL)
  memo.set(entry.memo, cell)
  const outcome = run(engine, entry, frame, null)
  if (!outcome.ok) {
    cell.state = ERR
    cell.value = outcome.value
    throw outcome.value
  }
  cell.state = EAGER_WAIT
  cell.wait = Promise.resolve(outcome.value).then(
    (value) => {
      cell.state = OK
      cell.value = value
    },
    (error: unknown) => {
      cell.state = ERR
      cell.value = error
    },
  )
  await cell.wait
  if (cell.state === ERR) throw cell.value
}

/** What a key currently holds for a frame, with nothing evaluated: for `util.inspect`. */
export function peek(
  engine: Engine,
  frame: LazyFrame,
  key: string,
): { readonly evaluated: boolean; readonly value: unknown } {
  try {
    const entry = resolveEntry(frame.suite, key)
    let memo: Map<symbol, unknown> | undefined
    if (entry.scope === 'worker') memo = engine.host.workerSlots
    else if (entry.scope === 'file') memo = frame.file.slots
    else memo = frame.kind === 'test' ? frame.run.slots : undefined
    const cell = memo?.get(entry.memo) as Cell | undefined
    if (cell !== undefined && cell.state === OK) return { evaluated: true, value: cell.value }
  } catch {
    // An undefined key is shown as not evaluated.
  }
  return { evaluated: false, value: undefined }
}

/** The values a run evaluated, in the order they finished. */
export function logOf(slots: Map<symbol, unknown>): readonly EvaluatedLazy[] {
  return (slots.get(LOG) as Logged[] | undefined) ?? []
}
