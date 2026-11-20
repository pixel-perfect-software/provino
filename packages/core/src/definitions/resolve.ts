// Resolving the fixtures a function reads (T5.9), Vitest 5.0.5's `withFixtures` (`runner/fixture.ts`):
// the keys it destructures, plus every `auto` entry, with their dependencies first, each set on the
// context before the call. A `test` value is made once per attempt (its cleanup is one of the
// attempt's teardowns, so it runs after `afterEach` and before `onTestFinished`); a `file` or
// `worker` value once per scope instance, its cleanup when that scope ends. A function entry is
// `(context, use) => …`: the value is what it passes to `use`, and what follows `use` is its
// cleanup, run when its scope ends.
import type { SuiteNode } from '../internal/model.ts'
import { type DefinitionWords, definitionError, type ErrorSite } from './errors.ts'
import type { CleanupList, DefinitionSet, FixtureItem, Registrations, ScopeState } from './table.ts'
import { usedProps } from './used-props.ts'

/** The suite hooks that take file and worker fixtures only. */
export type SuiteHookKind = 'beforeAll' | 'afterAll' | 'aroundAll'

/** One attempt's test-scope state: what is set on its context, and the cleanups, last first. */
export interface AttemptFixtures {
  readonly made: Set<FixtureItem>
  readonly cleanups: CleanupList
}

/** Where a call's fixtures go. */
export interface Target {
  readonly set: DefinitionSet
  readonly suite: SuiteNode
  /** The object the function gets: the test context, or the file scope's values for a suite hook. */
  readonly context: Record<string, unknown>
  /** The attempt's test-scope state; absent for a suite hook. */
  readonly attempt: AttemptFixtures | undefined
  /** Which parameter of the function holds the fixtures. */
  readonly index: number
  readonly suiteHook?: SuiteHookKind
  /** Where a suite hook was registered, for its errors. */
  readonly site?: Error
}

/**
 * Sets on `target.context` every fixture `fn` needs. `undefined` when there is nothing to do,
 * so the call can go on synchronously; a parse error is thrown at once.
 */
export function prepare(
  fn: (...args: never[]) => unknown,
  target: Target,
): Promise<void> | undefined {
  const { set, suite } = target
  const registrations = set.get(suite)
  if (registrations.size === 0) return undefined
  const words = set.env
  const site: ErrorSite | undefined =
    target.site === undefined ? undefined : { error: target.site, mode: 'message-first' }
  // Read as Vitest's `withFixtures` reads it (`getUsedProps(fn)`): no suite-hook hint, no site.
  const props = usedProps(fn, words, { index: target.index })
  const used: FixtureItem[] = []
  for (const item of registrations.values()) {
    if (
      (item.auto && !(target.suiteHook !== undefined && item.scope === 'test')) ||
      props.has(item.key)
    ) {
      used.push(item)
    }
  }
  if (used.length === 0) return undefined
  const pending = order(used, registrations, words)
  if (pending.length === 0) return undefined
  if (target.suiteHook !== undefined) {
    const testScoped = pending.filter((item) => item.scope === 'test')
    if (testScoped.length > 0) {
      const keys = testScoped.map((item) => item.key)
      const alternative = {
        aroundAll: 'aroundEach',
        beforeAll: 'beforeEach',
        afterAll: 'afterEach',
      }[target.suiteHook]
      throw definitionError(
        words,
        {
          kind: 'dependency',
          code: 'test-scoped-in-suite-hook',
          key: keys[0] as string,
          message: `A ${target.suiteHook} hook cannot read test-scoped definitions (${keys.map((k) => `"${k}"`).join(', ')}): give them scope "file" or "worker", or use ${alternative}.`,
          params: {
            hook: target.suiteHook,
            keys: keys.map((k) => `"${k}"`).join(', '),
            alternative,
          },
        },
        site,
      )
    }
  }
  return resolveAll(pending, target)
}

async function resolveAll(pending: readonly FixtureItem[], target: Target): Promise<void> {
  const { context, attempt } = target
  for (const item of pending) {
    if (item.scope === 'test') {
      if (attempt === undefined) continue
      // Made already by an earlier hook of the attempt; the context may hold the parent's value.
      if (attempt.made.has(item)) continue
      attempt.made.add(item)
      try {
        context[item.key] = await testValue(item, context, attempt.cleanups, target.set)
      } catch (error) {
        attempt.made.delete(item)
        throw error
      }
      attempt.cleanups.push(() => attempt.made.delete(item))
    } else {
      context[item.key] = await scopeValue(item, target)
    }
  }
}

function testValue(
  item: FixtureItem,
  context: Record<string, unknown>,
  cleanups: CleanupList,
  set: DefinitionSet,
): unknown {
  if (typeof item.value !== 'function') return item.value
  return run(item, context, cleanups, set)
}

function scopeValue(item: FixtureItem, target: Target): unknown {
  const { set } = target
  const worker = set.workerScope()
  const file = set.fileScope(target.suite.file)
  const scope: ScopeState = item.scope === 'worker' ? worker : file
  if (typeof item.value !== 'function') {
    scope.values[item.key] = item.value
    return item.value
  }
  if (item.key in scope.values) return scope.values[item.key]
  const inFlight = scope.pending.get(item)
  if (inFlight !== undefined) return inFlight
  const context = item.scope === 'file' ? { ...worker.values, ...file.values } : worker.values
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
          definitionError(
            set.env,
            {
              kind: 'dependency',
              code: 'use-not-called',
              key: item.key,
              message: `"${item.key}" returned without calling use: call it on every path of the definition.`,
              params: {},
            },
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
          throw definitionError(words, {
            kind: 'dependency',
            code: 'cycle',
            key: item.key,
            message: `The definitions read each other in a cycle: ${cycle}.`,
            params: { cycle },
          })
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

/** Core's `DefinitionWords` when the runtime gives none: its own words. */
export const NO_WORDS: DefinitionWords = { format: undefined }

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
