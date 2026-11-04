// U1: the worker's runtime (B10). It assembles what the other packages built, in the order their
// docs prescribe, behind `startWorker`'s `WorkerRunner`:
//   start (once)   config → behaviour loader + project loader → expect (state source, registry,
//                  slot, table, `createExpect`) → core → environment `prepare` → the dialect's
//                  globals factory → registry snapshot (last, so a matcher the factory adds is part
//                  of the baseline a file's restore returns to)
//   runFile        back-pressure → file registry → environment `setup` → globals → expect state →
//                  core (setup files, then the test file, imported inside collection) → teardown
//   stop           core's worker teardowns → the worker environment → loader → the matcher slot →
//                  the worker's lifetime signal
// An environment's teardown may report globals it could not remove (D22): that is a `console`
// warning and, for a file, `leakedGlobals` on its outcome; it is never a failure.
// The environment and the globals come in by ref, never by import: this node knows no dialect and
// no environment package.
import { createRuntime, currentTest, type Runtime } from '@provino/core'
import {
  createExpect,
  createMatcherRegistry,
  createStateSource,
  ExpectError,
  installMatchersSlot,
  type RegistrySnapshot,
  type SlotHandle,
  type StateSource,
  snapshotRegistry,
} from '@provino/expect'
import { createProjectLoader } from '@provino/loader'
import { createBehaviourLoader } from '@provino/policy'
import type {
  EnvironmentInstance,
  EnvironmentScope,
  FileJob,
  FileRegistry,
  GlobalsHost,
  IsolationTier,
  Loader,
  Policy,
} from '@provino/types'
import { WorkerError } from '../errors.ts'
import { parseProjectConfig } from '../internal/runtime/config.ts'
import {
  type PreparedEnvironment,
  prepareEnvironment,
  setupEnvironment,
} from '../internal/runtime/environment.ts'
import { installGlobals } from '../internal/runtime/globals.ts'
import {
  fileLeakWarning,
  leakedGlobalsOf,
  leakWarningEvent,
  workerLeakWarning,
} from '../internal/runtime/leaks.ts'
import { assertionCountSink } from '../internal/runtime/sink.ts'
import type { FileContext, FileOutcome, WorkerContext, WorkerRunner } from '../start.ts'

/** Everything `start` built, and what `runFile` needs from it. */
interface Booted {
  readonly loader: Loader
  readonly runtime: Runtime
  readonly source: StateSource
  readonly snapshot: RegistrySnapshot
  readonly environment: PreparedEnvironment
  /** The dialect's globals, built once; `undefined` when none are injected. */
  readonly globals: Readonly<Record<string, unknown>> | undefined
  /** The file registry tier: `process` is the pool's business and runs as `registry`. */
  readonly tier: Exclude<IsolationTier, 'process'>
}

/**
 * The host the worker gives a dialect's globals factory: `GlobalsHost` with the real types of the
 * two objects it declares as `object`. A `GlobalsFactory` is bivariant in its host, so the compiler
 * does not stop this file passing the wrong `api` or `expect` through that type; building the host
 * as this type does, and a type test that this type is assignable to a dialect's own host
 * (`@provino/bench` checks the Jest dialect's), do.
 * @beta
 */
export interface RuntimeGlobalsHost extends GlobalsHost {
  /** Core's global API: `runtime.api`. */
  readonly api: Runtime['api']
  /** The worker's `expect`, from `createExpect`. */
  readonly expect: ReturnType<typeof createExpect>
}

/**
 * Runs every step, in order, whatever the earlier ones threw, and returns what they threw.
 */
async function runAll(steps: readonly (() => unknown)[]): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

/** Throws the one error as it is, several as an `AggregateError`, and nothing for none. */
function rethrow(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

/**
 * Waits until the packer has room for another file's events, so a worker never runs ahead of a
 * slow coordinator by more than one file. `false` when `signal` aborted first (or already had):
 * a cancelled file never starts.
 */
async function writableUnlessAborted(
  sink: { writable(): Promise<void> },
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const onAbort = (): void => resolve(false)
  signal.addEventListener('abort', onAbort, { once: true })
  void sink.writable().then(() => resolve(true))
  try {
    return await promise
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Creates the real runner behind `startWorker`: the worker runtime, one per worker. It reads the
 * project from `init.config`; a missing or malformed piece fails `start` with a coded
 * `WorkerError`, which `startWorker` charges to every file.
 * @public
 */
export function createRuntimeRunner(): WorkerRunner {
  // The pieces of the worker that exist so far. `start` fills them in as it goes, so `stop` can
  // undo a worker whose `start` threw half-way.
  let slot: SlotHandle | undefined
  let loader: Loader | undefined
  let runtime: Runtime | undefined
  /** The environment instance of a worker-scoped environment (isolation `none`). */
  let workerEnvironment: EnvironmentInstance | undefined
  /**
   * The lifetime of the worker: what a worker-scoped environment's `signal` is. It outlives the
   * first file, whose own signal belongs to that file's run, and `stop` aborts it.
   */
  const workerLifetime = new AbortController()
  let booted: Booted | undefined
  /** The registry of the file running now, for `importFile` and the globals' `registry()`. */
  let current: FileRegistry | undefined

  const activeRegistry = (): FileRegistry => {
    if (current === undefined) {
      throw new WorkerError('ORCH_NO_ACTIVE_FILE', 'No test file is running in this worker')
    }
    return current
  }

  async function boot(context: WorkerContext): Promise<Booted> {
    const config = parseProjectConfig(context.init.config)
    // A SerializedPolicy is a Policy whose behaviour keys are all refs: nothing to deserialize.
    const policy: Policy = config.policy
    const behaviours = createBehaviourLoader()
    const projectLoader = await createProjectLoader(config.rootDir, config.loader, policy.module)
    loader = projectLoader

    // Expect, in the order its docs give: the slot exists before any matcher module loads, and
    // `createExpect` registers the table's matchers. The registry snapshot comes last (below).
    const source = createStateSource(currentTest, {
      nameSeparator: policy.core.nameSeparator,
      expand: policy.expect.expand,
    })
    const registry = createMatcherRegistry()
    slot = installMatchersSlot(source, registry)
    if (policy.expect.matcherTable === null) {
      throw new ExpectError(
        'EXPECT_NO_MATCHER_TABLE',
        'ExpectPolicy.matcherTable is null: the neutral matcher table is not built yet',
      )
    }
    const table = (await behaviours.load(policy.expect.matcherTable))()
    const expect = createExpect({ policy: policy.expect, table, source, registry })

    // `process` is the pool's business (a new process per file) and runs as `registry`.
    const tier = context.init.isolation === 'process' ? 'registry' : context.init.isolation

    // Setup files run inside core's collection, so the hooks they register belong to the file.
    const importFile = async (path: string): Promise<unknown> => {
      const files = activeRegistry()
      // Under `none` one registry serves every file of the worker, so a module it already
      // evaluated is cached: the setup files and the test file itself (queued twice, or imported
      // by an earlier file) are dropped and evaluated again, while their dependencies stay shared.
      // Every other tier gives the file a new registry, where there is nothing to drop.
      const shared = tier === 'none'
      for (const setup of [...config.setupFiles, ...config.setupFilesAfterEnv]) {
        if (shared) files.invalidate(setup)
        await files.import(setup)
      }
      if (shared) files.invalidate(path)
      return await files.import(path)
    }
    const coreRuntime = await createRuntime({
      policy: policy.core,
      behaviours,
      sink: assertionCountSink(source, context.sink),
      importFile,
      rootDir: config.rootDir,
      projectName: config.name,
      ci: config.ci,
    })
    runtime = coreRuntime

    const environment = await prepareEnvironment(config.environment)

    let globals: Readonly<Record<string, unknown>> | undefined
    if (policy.core.injectGlobals && config.globals !== null) {
      const factory = await behaviours.load(config.globals)
      const host: RuntimeGlobalsHost = { api: coreRuntime.api, expect, registry: activeRegistry }
      const built: unknown = factory(host)
      if (typeof built !== 'object' || built === null) {
        throw new WorkerError(
          'ORCH_BAD_GLOBALS',
          `The globals factory ${config.globals.module}#${config.globals.export} did not return an object`,
        )
      }
      globals = built as Readonly<Record<string, unknown>>
    }
    // After the factory: it may extend `expect` (or add to it), and what it adds belongs to the
    // baseline that each file's restore returns to, not to something the first file leaked.
    const snapshot = snapshotRegistry(registry, expect)
    return {
      loader: projectLoader,
      runtime: coreRuntime,
      source,
      snapshot,
      environment,
      globals,
      tier,
    }
  }

  /**
   * The environment instance for a file: a new one for scope `file` (given the file's `signal`),
   * and for scope `worker` the one made for the first file (given the worker's lifetime signal,
   * because it outlives that file; its `testPath` stays the first file's, the only file it was set
   * up for).
   */
  async function setUpEnvironment(
    worker: Booted,
    scope: EnvironmentScope,
    context: FileContext,
  ): Promise<EnvironmentInstance> {
    if (scope === 'worker' && workerEnvironment !== undefined) return workerEnvironment
    const instance = await setupEnvironment(worker.environment, {
      scope,
      testPath: context.job.file,
      pragmas: {},
      console: context.console,
      signal: scope === 'worker' ? workerLifetime.signal : context.signal,
    })
    if (scope === 'worker') workerEnvironment = instance
    return instance
  }

  /** The filters this file's job carries; `exactOptionalPropertyTypes` forbids passing `undefined`. */
  function filtersOf(job: FileJob) {
    return {
      ...(job.testNamePattern === undefined ? {} : { testNamePattern: job.testNamePattern }),
      ...(job.testIds === undefined ? {} : { testIds: job.testIds }),
    }
  }

  return {
    async start(context): Promise<void> {
      booted = await boot(context)
    },

    async runFile(context): Promise<FileOutcome> {
      if (booted === undefined) {
        throw new WorkerError('ORCH_NOT_STARTED', 'The worker runtime has not started')
      }
      const worker = booted
      const { job } = context
      if (!(await writableUnlessAborted(context.sink, context.signal))) return {}

      // Throws for the tier `realm` (the loader's LOADER_NOT_IMPLEMENTED), with nothing set up yet.
      const registry = worker.loader.createFileRegistry(job.file, { tier: worker.tier })
      current = registry
      // With `none` nothing is isolated, so the environment lives as long as the worker.
      const scope: EnvironmentScope = worker.tier === 'none' ? 'worker' : 'file'
      let instance: EnvironmentInstance | undefined
      const errors: unknown[] = []
      try {
        instance = await setUpEnvironment(worker, scope, context)
        if (worker.globals !== undefined) installGlobals(instance.global, worker.globals)
        worker.source.startFile(job.file)
        await worker.runtime.runFile(job.file, filtersOf(job))
      } catch (error) {
        errors.push(error)
      }

      // Teardown, always, in this order. A step that throws doesn't stop the next ones.
      let leaked: readonly string[] = []
      errors.push(
        ...(await runAll([
          // File scope only: with `none` the environment, the custom matchers and the globals
          // persist for the next file, as with Vitest's `isolate: false`. The environment reports
          // a global it couldn't remove instead of throwing (D22).
          async () => {
            if (scope !== 'file' || instance === undefined) return
            leaked = leakedGlobalsOf(await instance.teardown(), worker.environment.environment.name)
          },
          () => scope === 'file' && worker.snapshot.restore(),
          () => registry.dispose(),
        ])),
      )
      current = undefined
      // A warning, before the file finishes: through the same sink as the file's own events, so it
      // arrives after them and before `fileDone`. It has no task: the file's tasks have ended.
      if (leaked.length > 0) context.sink.emit(leakWarningEvent(fileLeakWarning(job.file, leaked)))
      rethrow(errors, `Tearing down ${job.file} failed`)
      return leaked.length > 0 ? { leakedGlobals: leaked } : {}
    },

    async stop(context): Promise<void> {
      const parts = { runtime, workerEnvironment, loader, slot, environment: booted?.environment }
      booted = runtime = workerEnvironment = loader = slot = undefined
      let leaked: readonly string[] = []
      const errors = await runAll([
        () => parts.runtime?.dispose(),
        async () => {
          if (parts.workerEnvironment === undefined) return
          const name = parts.environment?.environment.name ?? 'worker'
          leaked = leakedGlobalsOf(await parts.workerEnvironment.teardown(), name)
        },
        () => parts.loader?.[Symbol.dispose](),
        () => parts.slot?.uninstall(),
        // Last: the worker environment's teardown ran with its signal still live.
        () => workerLifetime.abort(),
      ])
      // The worker-scoped environment (isolation `none`) reports once, here, before `stopped`.
      if (leaked.length > 0) context.sink.emit(leakWarningEvent(workerLeakWarning(leaked)))
      rethrow(errors, 'Stopping the worker runtime failed')
    },
  }
}
