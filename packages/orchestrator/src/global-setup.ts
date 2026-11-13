// T9.15: global setup and teardown. The coordinator imports each module through the loader in
// coordinator mode (U5), so a TypeScript setup, or one a Jest transformer handles, loads as a test
// file would, and calls it as the policy's `globalSetup.signature` says: `(globalConfig,
// projectConfig)` (Jest), or `(context)` with a returned or exported teardown (Vitest).
//
// Setup runs once per distinct path, project by project in the config's order, and only for a
// project that has a file to run. A teardown runs after the run, in the order the policy says.
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
 * The hooks of `key` across `projects`, each distinct path once, in project order, with the first
 * project that names it (its config and transform are the ones the module is loaded with).
 */
function distinctHooks(
  projects: readonly ResolvedProject[],
  key: 'setup' | 'teardown',
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
  return hooks
}

/**
 * Runs the global setup of `projects`, which are the ones that have a file to run. Resolves with
 * `undefined` when none has a setup or a teardown. A hook that throws rejects with
 * `ORCH_GLOBAL_SETUP_FAILED` after the teardowns of what had set up already ran (a function a
 * setup returned; a teardown module is a Jest hook, whose pairing with a setup is not ours to
 * guess, and Jest runs none then).
 * @internal
 */
export async function runGlobalSetup(
  projects: readonly ResolvedProject[],
): Promise<GlobalSetupRun | undefined> {
  const setups = distinctHooks(projects, 'setup')
  const teardowns = distinctHooks(projects, 'teardown')
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

  async function runTeardowns(steps: readonly TeardownStep[]): Promise<void> {
    let first: unknown
    let failed = false
    for (const step of steps) {
      try {
        await step.run()
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

  try {
    for (const { path, project } of setups) {
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
          throw new TypeError(
            `globalSetup file must export a function, setup or teardown at ${path}`,
          )
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
