// The definition table's fixture half (T5.9): what `test.extend` and `test.override` register.
// A `DefinitionSet` is one test API's registrations (each `extend` makes a new one, so two
// extended tests never see each other's keys), with the overrides a describe block made of it.
// The rules are Vitest 5.0.5's (`runner/fixture.ts` `TestFixtures`): an entry is a value, a
// function `(context, use) => …`, or `[value, { scope, auto, injected }]`; a key registered again
// keeps its scope and `auto` (a different one is an error) and reads the earlier entry as its
// parent; only `test` scope is allowed inside a describe; a dependency must exist and be no
// narrower than its dependent. Lazy variables keep their own entries per suite (`suiteTable`).
import type { Scope } from '@provino/types'
import type { FileState, SuiteNode } from '../internal/model.ts'
import { type DefinitionWords, definitionError, oneOf } from './errors.ts'
import { propsFrom, usedProps } from './used-props.ts'

/** One fixture: its value or function, its options, the keys it reads and the entry it overrides. */
export interface FixtureItem {
  readonly key: string
  readonly kind: 'fixture'
  readonly value: unknown
  readonly scope: Scope
  readonly auto: boolean
  readonly injected: boolean
  /** The keys a function entry destructures; empty for a value. */
  readonly deps: ReadonlySet<string>
  readonly parent: FixtureItem | undefined
  /** Where a function entry was registered, for an error about it later. */
  readonly site: Error | undefined
}

export type Registrations = ReadonlyMap<string, FixtureItem>

/** What every set of one runtime shares. */
export interface DefinitionEnv extends DefinitionWords {
  /** A value for an `injected` fixture (Vitest's `provide`); `undefined` keeps its default. */
  readonly injectValue: ((key: string) => unknown) | undefined
  /** Registers a cleanup for when the worker stops. */
  readonly addWorkerTeardown: (fn: () => unknown) => void
}

/** The memo and cleanups of one scope instance (a file, or the worker) of one set. */
export interface ScopeState {
  readonly values: Record<string, unknown>
  readonly cleanups: CleanupList
  readonly pending: Map<FixtureItem, Promise<unknown>>
}

const SCOPES: readonly Scope[] = ['test', 'file', 'worker']
const OPTION_KEYS: readonly string[] = ['auto', 'injected', 'scope']

/** Keys the test context has of its own: a function may read them without a fixture. */
export const CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'task',
  'signal',
  'onTestFailed',
  'onTestFinished',
  'skip',
  'annotate',
  'bench',
])

/** Whether `value` looks like fixture options: an object with `auto`, `injected` or `scope`. */
export function isFixtureOptions(value: unknown): value is FixtureOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    // Own enumerable keys only (Vitest's `Object.keys(obj).some(...)`): a class instance whose
    // prototype has a `scope` getter is a value.
    Object.keys(value).some((key) => OPTION_KEYS.includes(key))
  )
}

/**
 * A fixture's options.
 * @public
 */
export interface FixtureOptions {
  readonly scope?: Scope
  readonly auto?: boolean
  readonly injected?: boolean
}

/** One test API's registrations and the overrides made of them. */
export class DefinitionSet {
  readonly #env: DefinitionEnv
  #registrations: Registrations
  readonly #overrides = new WeakMap<SuiteNode, Registrations>()
  readonly #files = new WeakMap<FileState, ScopeState>()
  #worker: ScopeState | undefined

  constructor(env: DefinitionEnv, registrations: Registrations = new Map()) {
    this.#env = env
    this.#registrations = registrations
  }

  get env(): DefinitionEnv {
    return this.#env
  }

  /** A new set with `fixtures` added: what `test.extend` returns. */
  extend(fixtures: Readonly<Record<string, unknown>>, collecting: SuiteNode): DefinitionSet {
    const registrations = this.#parse(fixtures, collecting.type === 'file', this.#registrations)
    return new DefinitionSet(this.#env, registrations)
  }

  /** Overrides keys for `collecting` and the blocks inside it (the whole file at the top level). */
  override(fixtures: Readonly<Record<string, unknown>>, collecting: SuiteNode): void {
    const topLevel = collecting.type === 'file'
    const registrations = this.#parse(fixtures, topLevel, this.get(collecting))
    if (topLevel) this.#registrations = registrations
    else this.#overrides.set(collecting, registrations)
  }

  /** The registrations a test or hook of `suite` sees: the closest override, else the set's own. */
  get(suite: SuiteNode): Registrations {
    for (let s: SuiteNode | null = suite; s !== null; s = s.parent) {
      const found = this.#overrides.get(s)
      if (found !== undefined) return found
    }
    return this.#registrations
  }

  /** The file scope's state for `file`, made on first use; its cleanups run when the file ends. */
  fileScope(file: FileState): ScopeState {
    let state = this.#files.get(file)
    if (state === undefined) {
      const made = newScope()
      state = made
      this.#files.set(file, made)
      file.handle.teardowns.push(() => made.cleanups.drain())
    }
    return state
  }

  /** The worker scope's state, made on first use; its cleanups run when the worker stops. */
  workerScope(): ScopeState {
    if (this.#worker === undefined) {
      const made = newScope()
      this.#worker = made
      this.#env.addWorkerTeardown(() => made.cleanups.drain())
    }
    return this.#worker
  }

  #parse(
    fixtures: Readonly<Record<string, unknown>>,
    topLevel: boolean,
    base: Registrations,
  ): Registrations {
    const env = this.#env
    const errors: Error[] = []
    const fail = (key: string, code: string, message: string, params: Record<string, string>) =>
      errors.push(definitionError(env, { kind: 'dependency', code, key, message, params }))
    const registrations = new Map(base)
    for (const [key, entry] of Object.entries(fixtures)) {
      let given: FixtureOptions | undefined
      let value: unknown = entry
      if (Array.isArray(entry) && entry.length >= 2 && isFixtureOptions(entry[1])) {
        given = entry[1]
        value = entry[0]
      }
      const parent = registrations.get(key)
      let scope: Scope
      let auto: boolean
      let injected: boolean
      if (given !== undefined) {
        scope = given.scope ?? 'test'
        auto = given.auto ?? false
        injected = given.injected ?? false
        if (parent !== undefined && parent.scope !== scope) {
          fail(
            key,
            'scope-conflict',
            `"${key}" is already defined with scope "${parent.scope}", not "${scope}".`,
            { scope },
          )
        }
        if (parent !== undefined && parent.auto !== auto) {
          fail(key, 'auto-conflict', `"${key}" is already defined with auto: ${parent.auto}.`, {
            auto: String(auto),
          })
        }
      } else if (parent !== undefined) {
        ;({ scope, auto, injected } = parent)
      } else {
        scope = 'test'
        auto = false
        injected = false
      }
      if (given !== undefined && injected) {
        // `??`: a provided `null` keeps the default too, as Vitest's `injectValue?.(name) ?? fn[0]`.
        value = env.injectValue?.(key) ?? value
      }
      if (!SCOPES.includes(scope)) {
        fail(key, 'unknown-scope', `"${key}" has an unknown scope "${String(scope)}".`, {
          scope: String(scope),
        })
      }
      if (!topLevel && scope !== 'test') {
        const inherited = given?.scope === undefined && parent !== undefined
        fail(
          key,
          'scope-in-describe',
          `"${key}" has scope "${scope}"${inherited ? ' (from the definition it overrides)' : ''}, which is only allowed at the top level of a file, not inside a describe.`,
          { scope, inherited: inherited ? 'true' : 'false' },
        )
      }
      const isFunction = typeof value === 'function'
      const deps = isFunction ? usedProps(value as Fn, env) : new Set<string>()
      registrations.set(key, {
        key,
        kind: 'fixture',
        value,
        scope,
        auto,
        injected,
        deps,
        parent,
        site: isFunction ? new Error('STACK_TRACE_ERROR') : undefined,
      })
    }
    for (const item of registrations.values()) {
      for (const dep of item.deps) {
        if (CONTEXT_KEYS.has(dep)) continue
        const target = registrations.get(dep)
        if (target === undefined) {
          fail(
            item.key,
            'unknown-dependency',
            `"${item.key}" reads "${dep}", which is not defined.`,
            { dependency: dep },
          )
          continue
        }
        if (dep === item.key && item.parent === undefined) {
          fail(
            item.key,
            'self-without-parent',
            `"${item.key}" reads itself, but there is no earlier definition of it to read.`,
            {},
          )
          continue
        }
        if (SCOPES.indexOf(item.scope) > SCOPES.indexOf(target.scope)) {
          fail(
            item.key,
            'narrower-dependency',
            `"${item.key}" has scope "${item.scope}" and cannot read "${target.key}", whose scope "${target.scope}" is narrower.`,
            { scope: item.scope, dependency: target.key, dependencyScope: target.scope },
          )
        }
      }
    }
    if (errors.length > 0) throw oneOf(env, errors, Object.keys(fixtures)[0] ?? '')
    return registrations
  }
}

type Fn = (...args: never[]) => unknown

function newScope(): ScopeState {
  return {
    values: Object.create(null) as Record<string, unknown>,
    cleanups: new CleanupList(),
    pending: new Map(),
  }
}

/**
 * One scope's cleanups, run last first when it ends. Once it has ended, a cleanup added (by a
 * fixture whose setup outlived its test's deadline) runs at once instead of waiting for a drain
 * that already happened; what it throws then is an unhandled rejection the runtime charges.
 */
export class CleanupList {
  readonly #fns: Array<() => unknown> = []
  #ended = false

  push(fn: () => unknown): void {
    if (this.#ended) {
      void (async () => fn())()
      return
    }
    this.#fns.push(fn)
  }

  /** Ends the scope: runs every cleanup, last first, each awaited. */
  async drain(): Promise<void> {
    this.#ended = true
    while (this.#fns.length > 0) {
      const cleanup = this.#fns.pop() as () => unknown
      await cleanup()
    }
  }
}

/**
 * A builder entry (`test.extend(key, fn)`, `(key, options, fn)` or `(key, options)`) as an
 * object entry: a function returning the value becomes a `(context, use)` fixture, with
 * `onCleanup` (once) run after `use` returns. Vitest 5.0.5's `parseBuilderFixtures` (`suite.ts`).
 */
export function builderEntry(
  words: DefinitionWords,
  keyOrFixtures: unknown,
  optionsOrValue: unknown,
  maybeValue: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof keyOrFixtures !== 'string') {
    return (keyOrFixtures ?? {}) as Readonly<Record<string, unknown>>
  }
  const key = keyOrFixtures
  let options: FixtureOptions | undefined
  let value: unknown
  if (maybeValue !== undefined) {
    options = optionsOrValue as FixtureOptions
    value = maybeValue
  } else if (isFixtureOptions(optionsOrValue)) {
    options = optionsOrValue
    value = {}
  } else {
    value = optionsOrValue
  }
  if (typeof value === 'function') {
    const build = value as (
      context: unknown,
      tools: { onCleanup(fn: () => unknown): void },
    ) => unknown
    const fixture = async (context: unknown, use: (value: unknown) => Promise<void>) => {
      let cleanup: (() => unknown) | undefined
      const onCleanup = (fn: () => unknown): void => {
        if (cleanup !== undefined) {
          throw definitionError(words, {
            kind: 'dependency',
            code: 'cleanup-twice',
            key,
            message: `onCleanup can be called once per definition ("${key}"): define another one for a second cleanup.`,
            params: {},
          })
        }
        cleanup = fn
      }
      const built = await build(context, { onCleanup })
      await use(built)
      if (cleanup !== undefined) await cleanup()
    }
    propsFrom(fixture, { index: 0, original: build })
    value = fixture
  }
  return { [key]: options === undefined ? value : [value, options] }
}
