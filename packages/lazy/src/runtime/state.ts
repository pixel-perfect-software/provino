// What the runtime shares between its parts: the definition entry, the memo cell, the keys it puts
// in `slots` maps, and the engine record (the host, the policy and the synchronous evaluation stack).
import type {
  Definition,
  LazyHost,
  LazyPolicy,
  Scope,
  SourceLocation,
  SuiteHandle,
} from '@provino/types'
import type { OverrideContext } from '../types.ts'

// The slots keys. Private symbols: nothing outside this package can read or clash with them.
export const TABLE: unique symbol = Symbol('provino.lazy.table')
export const RESOLVED: unique symbol = Symbol('provino.lazy.resolved')
export const VIEW_CLASS: unique symbol = Symbol('provino.lazy.view')
export const FILE_STATE: unique symbol = Symbol('provino.lazy.file')
export const LOG: unique symbol = Symbol('provino.lazy.log')
export const FILE_CLEANUPS: unique symbol = Symbol('provino.lazy.file-cleanups')
export const WORKER_STATE: unique symbol = Symbol('provino.lazy.worker')

/** What a definition is called with: its dependencies and its context. */
export type DefineFn = (deps: object, ctx: OverrideContext<unknown, Scope>) => unknown

export type EntryKind = 'let' | 'eager' | 'override'

/**
 * One definition of one key in one suite, shaped as `@provino/types` `Definition` (B25's T5.9
 * moves the table into core; `define` is then `factory`, `site` is `location`, `eager` is `auto`
 * and `parentEntry` is `parent`). `scope`, `eager`, `parentEntry` and `memo` are settled on the
 * first read, once the whole file is collected.
 */
export class LazyEntry
  implements Omit<Definition, 'factory' | 'parent' | 'location' | 'auto' | 'scope'>
{
  readonly kind = 'lazy' as const
  readonly injected = false
  readonly staticDeps = null
  readonly key: string
  readonly kindOf: EntryKind
  /** The scope this entry declared; an override has none and takes its parent's. */
  readonly declared: Scope | undefined
  readonly define: DefineFn
  readonly timeout: number | undefined
  readonly suite: SuiteHandle
  readonly site: SourceLocation
  /** `file:line:column#key`: what a worker-scoped value is keyed by. */
  readonly id: string
  settled = false
  scope: Scope = 'test'
  /** Read through a hook that awaits it first (`eager`, and an override of an eager key). */
  eager = false
  parentEntry: LazyEntry | null = null
  memo: symbol = TABLE

  constructor(
    key: string,
    kindOf: EntryKind,
    declared: Scope | undefined,
    define: DefineFn,
    timeout: number | undefined,
    suite: SuiteHandle,
    site: SourceLocation,
    id: string,
  ) {
    this.key = key
    this.kindOf = kindOf
    this.declared = declared
    this.define = define
    this.timeout = timeout
    this.suite = suite
    this.site = site
    this.id = id
  }

  get override(): boolean {
    return this.kindOf === 'override'
  }
}

// The memo cell's states.
export const EVAL = 0
export const OK = 1
export const ERR = 2
export const EAGER_WAIT = 3

/** A memoized evaluation: a value (a promise for an async key), a thrown error, or in flight. */
export class Cell {
  state: number
  value: unknown
  /** An eager value being awaited. */
  wait: Promise<void> | undefined

  constructor(state: number) {
    this.state = state
    this.value = undefined
    this.wait = undefined
  }
}

/** One evaluation in progress: the entry, and the evaluation that asked for it (the chain). */
export class EvalFrame {
  readonly entry: LazyEntry
  readonly from: EvalFrame | null

  constructor(entry: LazyEntry, from: EvalFrame | null) {
    this.entry = entry
    this.from = from
  }
}

/** The runtime's shared record. */
export interface Engine {
  readonly host: LazyHost
  readonly policy: LazyPolicy
  /** The evaluations whose definition is running synchronously right now. */
  readonly stack: EvalFrame[]
}

export type SuiteTable = Map<string, LazyEntry>
