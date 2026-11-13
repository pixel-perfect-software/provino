// T9.15: global setup and teardown. The coordinator imports each module through the loader in
// coordinator mode (U5), so a TypeScript setup, or one a Jest transformer handles, loads as a test
// file would, and calls it as the policy's `globalSetup.signature` says: `(globalConfig,
// projectConfig)` (Jest), or `(context)` with a returned or exported teardown (Vitest).
//
// Setup runs once per distinct path, project by project in the order Jest's sequenced list reaches
// them, then the run's own hooks (Jest's root `globalSetup`), and only for a project that has a
// file to run. A teardown runs after the run, in the order the policy says.
// `provide` collects the values workers get (`WorkerInit.provided`, read by `inject` once T11.16
// builds it); `onTestsRerun` is kept for the watch loop (T9.11).
import type { ResolvedProject } from '@provino/config'
import type { CoordinatorLoader } from '@provino/loader'
import type { GlobalSetupContext, ProvidedContext } from '@provino/types'
import { OrchestratorError } from './errors.ts'
import { messageOf } from './util.ts'

/** One step to run after the run: a teardown module to import and call, or a function a setup returned. */
interface TeardownStep {
  readonly path: string
  readonly run: () => Promise<void>
}

type HookName = 'globalSetup' | 'globalTeardown'

/** A hook's function: what a setup or teardown module exports. */
type Hook = (...args: readonly unknown[]) => unknown

/**
 * A run's global setup, once it has run.
 * @internal
 */
export interface GlobalSetupRun {
  /** What `provide` collected, for `WorkerInit.provided`. */
  readonly provided: Readonly<Partial<ProvidedContext>>
  /**
   * Runs every teardown, in the policy's order. Each runs even when an earlier one threw; the first
   * error is then thrown (Jest stops at the first). Disposes the loaders.
   */
  teardown(): Promise<void>
}

/** The text a failing hook raises: the policy's template with its three slots filled. */
function failure(
  template: string,
  hook: HookName,
  path: string,
  cause: unknown,
): OrchestratorError {
  const text = template.replace(/\{(hook|path|message)\}/g, (_slot, name: string) =>
    name === 'hook' ? hook : name === 'path' ? path : messageOf(cause),
  )
  return new OrchestratorError('ORCH_GLOBAL_SETUP_FAILED', text, { cause })
}

function isHook(value: unknown): value is Hook {
  return typeof value === 'function'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

/**
 * The function a module's exports give. A default export that is a function; one that is an
 * object with `__esModule` (a CommonJS file compiled from ES syntax, read under an `import`
 * interop that keeps `module.exports` whole) gives its own `default`.
 */
function defaultFunction(namespace: unknown): Hook | undefined {
  if (!isRecord(namespace)) return undefined
  const value = namespace.default
  if (isHook(value)) return value
  if (isRecord(value) && value.__esModule === true && isHook(value.default)) return value.default
  return undefined
}

function named(namespace: unknown, key: string): Hook | undefined {
  if (!isRecord(namespace)) return undefined
  const value = namespace[key]
  return isHook(value) ? value : undefined
}

/**
 * The hooks the run itself names, beside the projects' own: Jest's root `globalSetup` and
 * `globalTeardown`, which a config with `projects` keeps in its global config. Every path is
 * absolute.
 * @public
 */
export interface RunGlobalHooks {
  readonly setup: readonly string[]
  readonly teardown: readonly string[]
}

/**
 * The hooks of `key` across `projects`, each distinct path once, in project order, with the first
 * project that names it (its config and transform are the ones the module is loaded with), then
 * the run's own, each path not yet seen once, with the first project: Jest's `runGlobalHook` adds
 * `globalConfig[moduleName]` to the set of the projects' paths and, when no project names it,
 * calls it with the first test's config.
 */
function distinctHooks(
  projects: readonly ResolvedProject[],
  key: 'setup' | 'teardown',
  runHooks: RunGlobalHooks | undefined,
): { readonly path: string; readonly project: ResolvedProject }[] {
  const seen = new Set<string>()
  const hooks: { path: string; project: ResolvedProject }[] = []
  for (const project of projects) {
    for (const path of project.globalSetup?.[key] ?? []) {
      if (seen.has(path)) continue
      seen.add(path)
      hooks.push({ path, project })
    }
  }
  const [first] = projects
  if (first !== undefined) {
    for (const path of runHooks?.[key] ?? []) {
      if (seen.has(path)) continue
      seen.add(path)
      hooks.push({ path, project: first })
    }
  }
  return hooks
}

/** What `runGlobalSetup` takes besides the projects. */
export interface GlobalSetupOptions {
  /** The run's own hooks (Jest's root `globalSetup` and `globalTeardown`). */
  readonly hooks?: RunGlobalHooks | undefined
  /**
   * The run's `signal` (Ctrl+C, SIGTERM). A setup that is still running when it aborts is given
   * up on, not waited for: the run ends interrupted, and what had set up is torn down. A teardown
   * running when it aborts is given up on too, and the next one starts; one that begins after it
   * was already aborted (the run was interrupted) gets to run, unless `forceSignal` aborts.
   */
  readonly signal?: AbortSignal | undefined
  /** The second Ctrl+C: no hook is waited for any longer, a teardown that hangs included. */
  readonly forceSignal?: AbortSignal | undefined
}

/** What `unlessAborted` resolves with when a signal came first. */
const ABORTED: unique symbol = Symbol('aborted')

/**
 * `work`'s outcome, or `ABORTED` as soon as one of `signals` aborts (at once when one already
 * has). A hook that hangs can't be cancelled, so the work is left running; what it throws later is
 * nobody's to report.
 */
function unlessAborted<T>(
  work: Promise<T>,
  signals: readonly (AbortSignal | undefined)[],
): Promise<T | typeof ABORTED> {
  work.catch(() => undefined)
  const live = signals.filter((signal) => signal !== undefined)
  if (live.some((signal) => signal.aborted)) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      stop()
      resolve(ABORTED)
    }
    const stop = (): void => {
      for (const signal of live) signal.removeEventListener('abort', onAbort)
    }
    for (const signal of live) signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        stop()
        resolve(value)
      },
      (error: unknown) => {
        stop()
        reject(error)
      },
    )
  })
}

/**
 * Runs the global setup of `projects`, which are the ones that have a file to run, in the order
 * Jest's sequencer reaches them (the first project's config decides a path several share, and
 * the run's own hooks). Resolves with `undefined` when none has a setup or a teardown. A hook
 * that throws rejects with `ORCH_GLOBAL_SETUP_FAILED` after the teardowns of what had set up
 * already ran (a function a setup returned; a teardown module is a Jest hook, whose pairing with
 * a setup is not ours to guess, and Jest runs none then).
 * @internal
 */
export async function runGlobalSetup(
  projects: readonly ResolvedProject[],
  options: GlobalSetupOptions = {},
): Promise<GlobalSetupRun | undefined> {
  const setups = distinctHooks(projects, 'setup', options.hooks)
  const teardowns = distinctHooks(projects, 'teardown', options.hooks)
  if (setups.length === 0 && teardowns.length === 0) return undefined

  const provided: Partial<Record<keyof ProvidedContext, unknown>> = {}
  const rerun: (() => void | Promise<void>)[] = []
  /** The teardowns of what a setup returned or exported, in the order those setups ran. */
  const returned: TeardownStep[] = []
  const loaders = new Map<ResolvedProject, Promise<CoordinatorLoader>>()

  function loaderOf(project: ResolvedProject): Promise<CoordinatorLoader> {
    let loader = loaders.get(project)
    if (loader === undefined) {
      // The loader and the transform behind it load when the first hook does: a run with no
      // global setup never pays for them.
      loader = import('@provino/loader').then(({ createCoordinatorLoader }) =>
        createCoordinatorLoader(project.rootDir, project.config.loader, project.policy.module),
      )
      loaders.set(project, loader)
    }
    return loader
  }

  async function disposeLoaders(): Promise<void> {
    const pending = [...loaders.values()]
    loaders.clear()
    for (const loader of await Promise.allSettled(pending)) {
      if (loader.status === 'fulfilled') loader.value.dispose()
    }
  }

  async function importHook(
    hook: HookName,
    path: string,
    project: ResolvedProject,
  ): Promise<unknown> {
    try {
      return await (await loaderOf(project)).import(path)
    } catch (cause) {
      throw failure(project.policy.orchestrator.globalSetup.failureMessage, hook, path, cause)
    }
  }

  const contextOf = (project: ResolvedProject): GlobalSetupContext => ({
    provide(key, value) {
      try {
        structuredClone(value)
      } catch (cause) {
        throw new TypeError(
          `provide(${JSON.stringify(key)}): the value can't cross to a worker (${messageOf(cause)})`,
          { cause },
        )
      }
      provided[key] = value
    },
    onTestsRerun(callback) {
      rerun.push(callback)
    },
    project: { name: project.name, root: project.rootDir },
  })

  /** Runs `body` as `hook` of `path` would: what it throws becomes the policy's error. */
  async function guarded(
    hook: HookName,
    path: string,
    project: ResolvedProject,
    body: () => Promise<void>,
  ): Promise<void> {
    try {
      await body()
    } catch (cause) {
      if (cause instanceof OrchestratorError) throw cause
      throw failure(project.policy.orchestrator.globalSetup.failureMessage, hook, path, cause)
    }
  }

  const { signal, forceSignal } = options

  /**
   * Runs the steps, each even when an earlier one threw (the first error is then thrown). A step
   * that is still running when the run's signal aborts is given up on and the next one starts
   * (the signal means "stop waiting"); one that begins after the run was already interrupted is
   * given its time, and only the force signal cuts a hanging one short, and the rest.
   */
  async function runTeardowns(steps: readonly TeardownStep[]): Promise<void> {
    let first: unknown
    let failed = false
    let patient = signal?.aborted === true
    for (const step of steps) {
      if (forceSignal?.aborted === true) break
      try {
        const outcome = await unlessAborted(
          step.run(),
          patient ? [forceSignal] : [signal, forceSignal],
        )
        if (outcome === ABORTED) patient = true
      } catch (error) {
        if (!failed) first = error
        failed = true
      }
    }
    if (failed) throw first
  }

  /** What a setup left to tear down, in the order the policy wants. */
  const ordered = (steps: readonly TeardownStep[]): readonly TeardownStep[] => {
    const [first] = projects
    return first?.policy.orchestrator.globalSetup.teardownOrder === 'reverse'
      ? steps.toReversed()
      : steps
  }

  /** One setup: the module imported, and called as the policy's signature says. */
  async function setUp(path: string, project: ResolvedProject): Promise<void> {
    const { signature } = project.policy.orchestrator.globalSetup
    const namespace = await importHook('globalSetup', path, project)
    await guarded('globalSetup', path, project, async () => {
      if (signature === 'global-and-project-config') {
        const fn = defaultFunction(namespace)
        if (fn === undefined) {
          throw new TypeError(`globalSetup file must export a function at ${path}`)
        }
        const args = project.globalSetup?.args
        await fn(args?.globalConfig ?? {}, args?.projectConfig ?? {})
        return
      }
      const fn = defaultFunction(namespace) ?? named(namespace, 'setup')
      const exported = named(namespace, 'teardown')
      if (fn === undefined && exported === undefined) {
        throw new TypeError(`globalSetup file must export a function, setup or teardown at ${path}`)
      }
      const result: unknown = fn === undefined ? undefined : await fn(contextOf(project))
      const teardown = typeof result === 'function' ? result : exported
      if (teardown !== undefined) {
        returned.push({
          path,
          run: () =>
            guarded('globalTeardown', path, project, async () => {
              await teardown()
            }),
        })
      }
    })
  }

  /** A signal came while setting up: no more setups, and no teardown module (see below). */
  let interrupted = false
  try {
    for (const { path, project } of setups) {
      // Each setup is waited for only until a signal comes (a hook that hangs can't be cancelled).
      const outcome = await unlessAborted(setUp(path, project), [signal, forceSignal])
      if (outcome === ABORTED) {
        interrupted = true
        break
      }
    }
  } catch (error) {
    // What had set up is torn down; the setup's own error is the one to report.
    try {
      await runTeardowns(ordered(returned))
    } catch {
      // The setup's error stands.
    }
    await disposeLoaders()
    throw error
  }

  // A run interrupted while setting up tears down what had set up (the functions setups returned);
  // a teardown module is a Jest hook, whose pairing with a setup is not ours to guess (as when a
  // setup throws), so none runs. The run itself ends with the signal's reason (`run.ts`).
  if (interrupted) {
    return {
      provided,
      async teardown() {
        try {
          await runTeardowns(ordered(returned))
        } finally {
          await disposeLoaders()
        }
      },
    }
  }

  // A Jest teardown module is imported only when the teardown runs, as Jest does.
  const modules: TeardownStep[] = teardowns.map(({ path, project }) => ({
    path,
    run: () =>
      guarded('globalTeardown', path, project, async () => {
        const namespace = await importHook('globalTeardown', path, project)
        const fn = defaultFunction(namespace)
        if (fn === undefined) {
          throw new TypeError(`globalTeardown file must export a function at ${path}`)
        }
        const args = project.globalSetup?.args
        await fn(args?.globalConfig ?? {}, args?.projectConfig ?? {})
      }),
  }))

  return {
    provided,
    async teardown() {
      try {
        await runTeardowns(ordered([...returned, ...modules]))
      } finally {
        await disposeLoaders()
      }
    },
  }
}
