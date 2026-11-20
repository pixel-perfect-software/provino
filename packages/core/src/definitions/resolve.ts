// Resolving the fixtures a function reads (T5.9), Vitest 5.0.5's `withFixtures` (`runner/fixture.ts`):
// the keys it destructures, plus every `auto` entry, with their dependencies first, each set on the
// context before the call. A `test` value is made once per attempt (its cleanup is one of the
// attempt's teardowns, so it runs after `afterEach` and before `onTestFinished`); a `file` or
// `worker` value once per scope instance, its cleanup when that scope ends. A function entry is
// `(context, use) => …`: the value is what it passes to `use`, and what follows `use` is its
// cleanup, run when its scope ends.
import type { AnyFunction } from '@provino/types'
import type { AttemptState, SuiteHookKind, SuiteNode } from '../internal/model.ts'
import { type DefinitionWords, definitionError, dependencyError, type ErrorSite } from './errors.ts'
import {
  CleanupList,
  type DefinitionSet,
  type FixtureItem,
  type Registrations,
  type ScopeState,
} from './table.ts'
import { usedProps } from './used-props.ts'

/** One attempt's test-scope state: what is set on its context, and the cleanups, last first. */
export interface AttemptFixtures {
  readonly made: Set<FixtureItem>
  readonly cleanups: CleanupList
}

/** Where a call's fixtures go. */
export interface Target {
  readonly set: DefinitionSet
  /** What the function sees: `set.get(suite)`, looked up once by the caller. */
  readonly registrations: Registrations
  readonly suite: SuiteNode
  /** The object the function gets: the test context, or the file scope's values for a suite hook. */
  readonly context: Record<string, unknown>
  /** The attempt whose test-scope fixtures these are; absent for a suite hook. */
  readonly attempt: AttemptState | undefined
  /** Which parameter of the function holds the fixtures. */
  readonly index: number
  readonly suiteHook?: SuiteHookKind
  /** Where a suite hook was registered, for its errors. */
  readonly site?: ErrorSite['error']
}

const NOTHING: readonly FixtureItem[] = []

/**
 * Each function's resolution plan, by the registrations it read them from and whether a suite hook
 * reads them (a suite hook makes no unnamed `test` entry). Only a plan that was built is kept: a
 * function whose reading throws is read again, and throws again, at its next call.
 */
const plans = new WeakMap<
  Registrations,
  WeakMap<AnyFunction, Map<string, readonly FixtureItem[]>>
>()

/**
 * Sets on `target.context` every fixture `fn` needs. `undefined` when there is nothing to do,
 * so the call can go on synchronously; a parse error is thrown at once.
 */
export function prepare(fn: AnyFunction, target: Target): Promise<void> | undefined {
  const pending = planOf(fn, target)
  return pending.length === 0 ? undefined : resolveAll(pending, target)
}

function planOf(fn: AnyFunction, target: Target): readonly FixtureItem[] {
  const { registrations } = target
  const kind = target.suiteHook ?? 'each'
  let byFn = plans.get(registrations)
  const known = byFn?.get(fn)?.get(kind)
  if (known !== undefined) return known
  const plan = buildPlan(fn, target)
  if (byFn === undefined) {
    byFn = new WeakMap()
    plans.set(registrations, byFn)
  }
  let byKind = byFn.get(fn)
  if (byKind === undefined) {
    byKind = new Map()
    byFn.set(fn, byKind)
  }
  byKind.set(kind, plan)
  return plan
}

function buildPlan(fn: AnyFunction, target: Target): readonly FixtureItem[] {
  const { registrations, suiteHook } = target
  const words = target.set.env
  // Read as Vitest's `withFixtures` reads it (`getUsedProps(fn)`): no suite-hook hint, no site.
  const props = usedProps(fn, words, { index: target.index })
  const used = [...registrations.values()].filter(
    (item) =>
      (item.auto && !(suiteHook !== undefined && item.scope === 'test')) || props.has(item.key),
  )
  if (used.length === 0) return NOTHING
  const pending = order(used, registrations, words)
  if (suiteHook !== undefined) {
    const testScoped = pending.filter((item) => item.scope === 'test')
    if (testScoped.length > 0) {
      const keys = testScoped.map((item) => `"${item.key}"`).join(', ')
      const alternative = {
        aroundAll: 'aroundEach',
        beforeAll: 'beforeEach',
        afterAll: 'afterEach',
      }[suiteHook]
      throw dependencyError(
        words,
        'test-scoped-in-suite-hook',
        testScoped[0]?.key ?? '',
        `A ${suiteHook} hook cannot read test-scoped definitions (${keys}): give them scope "file" or "worker", or use ${alternative}.`,
        { hook: suiteHook, keys, alternative },
        target.site === undefined ? undefined : { error: target.site, mode: 'message-first' },
      )
    }
  }
  return pending
}

async function resolveAll(pending: readonly FixtureItem[], target: Target): Promise<void> {
  const { context, attempt } = target
  for (const item of pending) {
    if (item.scope === 'test') {
      if (attempt === undefined) continue
      const fixtures = attemptFixtures(attempt)
      // Made already by an earlier hook of the attempt; the context may hold the parent's value.
      if (fixtures.made.has(item)) continue
      fixtures.made.add(item)
      try {
        context[item.key] =
          typeof item.value === 'function'
            ? await run(item, context, fixtures.cleanups, target.set)
            : item.value
      } catch (error) {
        fixtures.made.delete(item)
        throw error
      }
      fixtures.cleanups.push(() => fixtures.made.delete(item))
    } else {
      context[item.key] = await scopeValue(item, target)
    }
  }
}

/** The attempt's test-scope fixtures, made on the first one read: one teardown, after `afterEach`. */
function attemptFixtures(attempt: AttemptState): AttemptFixtures {
  let fixtures = attempt.fixtures
  if (fixtures === undefined) {
    const made: AttemptFixtures = { made: new Set(), cleanups: new CleanupList() }
    fixtures = made
    attempt.fixtures = made
    attempt.run.addTeardown(() => made.cleanups.drain())
  }
  return fixtures
}

function scopeValue(item: FixtureItem, target: Target): unknown {
  const { set } = target
  // The item's own scope first; the worker's values are read only to build a file value.
  const scope: ScopeState =
    item.scope === 'worker' ? set.workerScope() : set.fileScope(target.suite.file)
  if (typeof item.value !== 'function') {
    scope.values[item.key] = item.value
    return item.value
  }
  if (item.key in scope.values) return scope.values[item.key]
  const inFlight = scope.pending.get(item)
  if (inFlight !== undefined) return inFlight
  const context =
    item.scope === 'file' ? { ...set.workerScope().values, ...scope.values } : scope.values
  const promise = run(item, context, scope.cleanups, set)
    .then((value) => {
      scope.values[item.key] = value
      return value
    })
    .finally(() => scope.pending.delete(item))
  scope.pending.set(item, promise)
  return promise
}

/**
 * Calls a `(context, use)` entry and resolves with what it passes to `use`, as Vitest 5.0.5's
 * `resolveFixtureFunction` does (`runner/fixture.ts` L541-L582): `.then` is called on what the
 * entry returns, so one that returns no promise fails with the `TypeError` Vitest's does, and a
 * synchronous throw (before or after `use`) fails what asked for the value. Its cleanup awaits that
 * same chain, so after such a failure the cleanup fails too, as Vitest's does.
 */
async function run(
  item: FixtureItem,
  context: unknown,
  cleanups: CleanupList,
  set: DefinitionSet,
): Promise<unknown> {
  // Vitest calls `.then` on the raw return: the type says what the entry should return.
  const fn = item.value as (
    context: unknown,
    use: (value: unknown) => Promise<void>,
  ) => Promise<unknown>
  const value = Promise.withResolvers<unknown>()
  let used = false
  const fixtureReturn: Promise<void> = fn(context, async (given: unknown) => {
    used = true
    value.resolve(given)
    // The fixture's tail waits here until its scope ends.
    const { promise, resolve: release } = Promise.withResolvers<void>()
    cleanups.push(async () => {
      release()
      await fixtureReturn
    })
    await promise
  })
    .then(() => {
      if (!used) {
        value.reject(
          dependencyError(
            set.env,
            'use-not-called',
            item.key,
            `"${item.key}" returned without calling use: call it on every path of the definition.`,
            {},
            item.site === undefined ? undefined : { error: item.site, mode: 'message-first' },
          ),
        )
      }
    })
    .catch((error: unknown) => {
      // A failed setup fails what asked for it; a failure after `use` is the cleanup's.
      if (!used) {
        value.reject(error)
        return
      }
      throw error
    })
  return value.promise
}

/**
 * `used` and what they read, dependencies first (Vitest's `resolveDeps`): a key that reads itself
 * reads its parent; any other cycle is an error.
 */
function order(
  used: readonly FixtureItem[],
  registrations: Registrations,
  words: DefinitionWords,
): FixtureItem[] {
  const pending: FixtureItem[] = []
  const visit = (items: readonly FixtureItem[], chain: Set<FixtureItem>): void => {
    for (const start of items) {
      let item = start
      if (pending.includes(item)) continue
      // Only a value is placed at once: a function with no dependencies still enters the chain,
      // so a later key that reads its parent finds it there (Vitest's `resolveDeps`).
      if (typeof item.value !== 'function') {
        pending.push(item)
        continue
      }
      if (chain.has(item)) {
        if (item.parent === undefined) {
          const names = [...chain].reverse().map((entry) => entry.key)
          const cycle = `${item.key} <- ${names.join(' <- ')}`
          throw dependencyError(
            words,
            'cycle',
            item.key,
            `The definitions read each other in a cycle: ${cycle}.`,
            { cycle },
          )
        }
        item = item.parent
      }
      chain.add(item)
      const own = item
      visit(
        [...own.deps]
          .map((key) => (key === own.key ? own.parent : registrations.get(key)))
          .filter((dep): dep is FixtureItem => dep !== undefined),
        chain,
      )
      pending.push(item)
      chain.clear()
    }
  }
  visit(used, new Set())
  return pending
}

/**
 * A plain suite hook that names fixtures: it has no context to read them from (Vitest's
 * `FixtureAccessError`, `validateSuiteHook`).
 */
export function suiteHookAccess(
  words: DefinitionWords,
  hook: SuiteHookKind,
  props: ReadonlySet<string>,
  site?: ErrorSite,
): Error {
  const keys = [...props].join('", "')
  return definitionError(
    words,
    {
      kind: 'access',
      code: 'suite-hook-no-context',
      key: [...props][0] ?? '',
      message: `The ${hook} hook reads "${keys}", but a plain ${hook} has no definitions to read: register it as test.${hook}() on the test that defines them.`,
      params: { hook, keys },
    },
    site,
  )
}
