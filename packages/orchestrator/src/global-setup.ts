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
import { interopDefault, type ResolvedGlobalSetup, type ResolvedProject } from '@provino/config'
import type { CoordinatorLoader } from '@provino/loader'
import { callBehaviour, createBehaviourLoader } from '@provino/policy'
import type { GlobalSetupContext, ProvidedContext } from '@provino/types'
import { OrchestratorError } from './errors.ts'
import { ABORTED, isRecord, messageOf, raceAbort } from './util.ts'

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

/**
 * How a failing hook is reported on `stderr`, as Jest's CLI prints the error `runGlobalHook`
 * rewrites: the header (the reported error's class, then its message, which may run over several
 * lines), then the frames of what the hook threw, and no other line of its stack. The policy's
 * `globalSetup.failure` made that error: a stack with no frame of ours is its to keep.
 * @internal
 */
export function hookFailureReport(error: OrchestratorError): string {
  const { cause } = error
  if (!(cause instanceof Error)) return `${error.message}\n`
  const frames = (cause.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
  return `${[`${cause.name}: ${cause.message}`, ...frames].join('\n')}\n`
}

function isHook(value: unknown): value is Hook {
  return typeof value === 'function'
}

/** The function a module's `default` export gives, unwrapped as a compiled CommonJS file needs. */
function defaultFunction(namespace: unknown): Hook | undefined {
  if (!isRecord(namespace)) return undefined
  const value = interopDefault(namespace.default)
  return isHook(value) ? value : undefined
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
export type RunGlobalHooks = Pick<ResolvedGlobalSetup, 'setup' | 'teardown'>

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

/** A signal that aborts when any of `signals` that exist does; one that never does for none. */
function anyOf(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((signal) => signal !== undefined))
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
    onTestsRerun() {
      // Kept for the watch loop (T9.11): nothing re-runs yet, so there is nothing to call.
    },
    project: { name: project.name, root: project.rootDir },
  })

  /**
   * Runs `body` as `hook` of `path` would: what it throws (an import that fails, a module that
   * isn't a function, the hook itself) is reported as the policy's `globalSetup.failure` says.
   */
  async function guarded(
    hook: HookName,
    path: string,
    project: ResolvedProject,
    body: () => Promise<void>,
  ): Promise<void> {
    try {
      await body()
    } catch (cause) {
      const reported = await callBehaviour(
        createBehaviourLoader(),
        project.policy.orchestrator.globalSetup.failure,
        cause,
        { hook, path },
      )
      throw new OrchestratorError('ORCH_GLOBAL_SETUP_FAILED', reported.message, {
        cause: reported,
      })
    }
  }

  /**
   * A Jest hook: the module imported and its function called with `(globalConfig, projectConfig)`,
   * the reader's two configs for the project (the same objects for its setup and its teardown, as
   * Jest passes one `globalConfig` to every hook), `{}` each when it gave none.
   */
  function callJestHook(hook: HookName, path: string, project: ResolvedProject): Promise<void> {
    return guarded(hook, path, project, async () => {
      const fn = defaultFunction(await (await loaderOf(project)).import(path))
      if (fn === undefined) throw new TypeError(`${hook} file must export a function at ${path}`)
      const args = project.globalSetup?.args ?? { globalConfig: {}, projectConfig: {} }
      await fn(args.globalConfig, args.projectConfig)
    })
  }

  const { signal, forceSignal } = options
  const interrupt = anyOf(signal, forceSignal)
  const force = anyOf(forceSignal)

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
        const outcome = await raceAbort(step.run(), patient ? force : interrupt)
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
    if (project.policy.orchestrator.globalSetup.signature === 'global-and-project-config') {
      await callJestHook('globalSetup', path, project)
      return
    }
    await guarded('globalSetup', path, project, async () => {
      const namespace = await (await loaderOf(project)).import(path)
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
      const outcome = await raceAbort(setUp(path, project), interrupt)
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

  // A Jest teardown module is imported only when the teardown runs, as Jest does.
  const modules: TeardownStep[] = teardowns.map(({ path, project }) => ({
    path,
    run: () => callJestHook('globalTeardown', path, project),
  }))

  return {
    provided,
    async teardown() {
      try {
        // A run interrupted while setting up tears down what had set up (the functions setups
        // returned); a teardown module is a Jest hook, whose pairing with a setup is not ours to
        // guess (as when a setup throws), so none runs. The run itself ends with the signal's
        // reason (`run.ts`).
        await runTeardowns(ordered(interrupted ? returned : [...returned, ...modules]))
      } finally {
        await disposeLoaders()
      }
    },
  }
}
