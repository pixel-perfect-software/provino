// U1: the worker's runtime (B10). It assembles what the other packages built, in the order their
// docs prescribe, behind `startWorker`'s `WorkerRunner`:
//   start (once)   config → behaviour loader + project loader → expect (state source, registry,
//                  slot, table, `createExpect`) → core → environment `prepare` → the dialect's
//                  globals factory → registry snapshot (last, so a matcher the factory adds is part
//                  of the baseline a file's restore returns to)
//   runFile        back-pressure → mock registry (new per file; one per worker under `none`) →
//                  file registry, with the file's module-mock registry and the per-module
//                  bindings → environment `setup` → globals → expect state → core (setup files,
//                  then the test file, imported inside collection) → teardown, which disposes the
//                  module-mock registry and then the mock registry first, while the environment is
//                  still alive, so a spy on a global is restored before the next file sees it
//   stop           the worker's mock registry (isolation `none`) → core's worker teardowns → the
//                  worker environment → loader → the matcher slot → the worker's lifetime signal
// An environment's teardown may report globals it could not remove (D22): that is a `console`
// warning and, for a file, `leakedGlobals` on its outcome; it is never a failure.
// The environment and the globals come in by ref, never by import: this node knows no dialect and
// no environment package.
import { AsyncLocalStorage } from 'node:async_hooks'
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
import {
  createMockRegistry,
  createModuleMockRegistry,
  createRootMockIndex,
  type MockRegistry,
  type RootMockIndex,
} from '@provino/mock'
import { createBehaviourLoader } from '@provino/policy'
import {
  openFileSnapshots,
  type SnapshotLifecycle,
  type SnapshotState,
} from '@provino/snapshot/runtime'
import type {
  EnvironmentInstance,
  EnvironmentScope,
  EventSink,
  FileJob,
  FileRegistry,
  GlobalsHost,
  IsolationTier,
  Loader,
  ModuleMockRegistry,
  ModuleMocksFactory,
  ModuleScopeValues,
  Policy,
  ResolveSnapshotPath,
  RuntimeEvent,
  SnapshotFileReport,
  SnapshotKey,
  SnapshotPlugin,
  SnapshotPrinter,
} from '@provino/types'
import { WorkerError } from '../errors.ts'
import { parseProjectConfig } from '../internal/runtime/config.ts'
import {
  type PreparedEnvironment,
  prepareEnvironment,
  setupEnvironment,
} from '../internal/runtime/environment.ts'
import { installGlobals, splitGlobals } from '../internal/runtime/globals.ts'
import { fileLeakEvent, leakedGlobalsOf, workerLeakEvent } from '../internal/runtime/leaks.ts'
import { assertionCountSink } from '../internal/runtime/sink.ts'
import type { FileContext, FileOutcome, WorkerContext, WorkerRunner } from '../start.ts'

/**
 * The pieces of the worker. `boot` fills them in as it goes, so `stop` can undo a worker whose
 * `start` threw half-way; a worker is started once `isBooted` says every one it builds is there.
 */
interface Booted {
  /** The matcher slot expect installed. */
  slot: SlotHandle
  loader: Loader
  runtime: Runtime
  source: StateSource
  snapshot: RegistrySnapshot
  /** The environment, loaded and prepared. */
  environment: PreparedEnvironment
  /**
   * The dialect's globals, built once and split by `core.globalsBeforeSetupFiles`: `before` is
   * installed before the file's `setupFiles`, `after` once they ran. `undefined` when none are
   * injected.
   */
  globals:
    | {
        readonly before: Readonly<Record<string, unknown>>
        readonly after: Readonly<Record<string, unknown>>
      }
    | undefined
  /** The file registry tier: `process` is the pool's business and runs as `registry`. */
  tier: Exclude<IsolationTier, 'process'>
  /**
   * How long an environment instance lives: `worker` for isolation `none` (nothing is isolated, so
   * the environment, the globals and the registry last as long as the worker), `file` otherwise.
   */
  scope: EnvironmentScope
  /** The instance of a worker-scoped environment, set up for the first file; `stop` tears it down. */
  workerEnvironment: { readonly instance: EnvironmentInstance; readonly name: string } | undefined
  /** The mock registry of a worker-scoped run (isolation `none`); `stop` disposes it. */
  workerMocks: MockRegistry | undefined
  /** What each file's module-mock registry is built from (B13c). */
  modules: ModuleMocking
  /** The dialect's per-module bindings, built once from its factory; `undefined` for none. */
  moduleScope: ModuleScopeValues | undefined
  /** What every file's snapshot state is built from: the policy's behaviours, loaded once. */
  snapshots: SnapshotBehaviours
}

/** The snapshot slice's behaviours, loaded by ref when the worker starts (B17b). */
interface SnapshotBehaviours {
  readonly key: SnapshotKey
  /** `null`: the policy names no printer. */
  readonly printer: SnapshotPrinter | null
  /** `null`: the default layout beside the test file. */
  readonly resolvePath: ResolveSnapshotPath | null
}

/** What every file's module-mock registry shares: the policy slices, the roots and the root mocks. */
interface ModuleMocking {
  readonly policy: Policy
  readonly roots: readonly string[]
  readonly extensions: readonly string[]
  /** The root `__mocks__` trees, listed once per worker (B13c Gap 8). */
  readonly rootMocks: RootMockIndex
}

/** The pieces `boot` builds. `globals`, `moduleScope` and `workerEnvironment` may stay `undefined`. */
const BUILT = [
  'slot',
  'loader',
  'runtime',
  'source',
  'snapshot',
  'environment',
  'tier',
  'scope',
  'modules',
  'snapshots',
] as const satisfies readonly (keyof Booted)[]

function isBooted(parts: Partial<Booted>): parts is Booted {
  return BUILT.every((key) => parts[key] !== undefined)
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
  /** The mock registry of the file running now (the worker's, under isolation `none`). */
  mocks(): MockRegistry
}

/** What a file's code finds through the host: its own registries, whoever runs when it asks. */
interface FileScope {
  readonly registry: FileRegistry
  readonly mocks: MockRegistry
  /** The file's module-mock registry: one per file in every tier (B13c Gap 9). */
  readonly moduleMocks: ModuleMockRegistry
  /** Installs the globals that wait for `setupFiles` (`core.globalsBeforeSetupFiles`). */
  readonly installLateGlobals: () => void
}

/**
 * The registries of the file whose code is running, carried along its async work. `jest` is one
 * object on a shared global, so a callback a file leaves behind (a timer, a promise) would
 * otherwise find the registries of whichever file runs when it fires. Entered around
 * `runtime.runFile`.
 *
 * Built when the module loads, never per runner (core's rule for its own store, `currentTest`);
 * sequential inline runners share it, which is fine because `run` scopes the store. The cost of a
 * second active store: about 8 ns per await on Node 24 and about 20 ns on Node 22's `async_hooks`
 * path (`local`, measured 2026-11-06; 44 to 52 ns and 182 to 202 ns per await in all). It is
 * accepted because the alternative is threading an opaque context through core's three `newStore`
 * sites for a rare edge.
 */
const fileScope = new AsyncLocalStorage<FileScope>()

/** The snapshot state and lifecycle of the file running now: what the event stream is told. */
interface OpenSnapshots {
  readonly state: SnapshotState
  readonly lifecycle: SnapshotLifecycle
}

/** A file that checked, wrote and left no snapshot has nothing to tell the coordinator. */
function isEmptyReport(report: SnapshotFileReport): boolean {
  return (
    report.file === null &&
    !report.fileDeleted &&
    report.added + report.matched + report.unmatched + report.updated + report.unchecked === 0
  )
}

/** Hands every event to `observe` first, then on. */
function observingSink(next: EventSink, observe: (event: RuntimeEvent) => void): EventSink {
  return {
    emit(event: RuntimeEvent): void {
      observe(event)
      next.emit(event)
    },
  }
}

/** The plugin a serializer module exports: its default export when that is an object, else the module. */
function pluginOf(exported: unknown): SnapshotPlugin {
  const fallback = exported as SnapshotPlugin
  if (typeof exported !== 'object' || exported === null) return fallback
  const inner: unknown = Reflect.get(exported, 'default')
  return typeof inner === 'object' && inner !== null ? (inner as SnapshotPlugin) : fallback
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
  /** What `boot` has built so far; `stop` takes it all and leaves it empty. */
  let parts: Partial<Booted> = {}
  /**
   * The lifetime of the worker: what a worker-scoped environment's `signal` is. It outlives the
   * first file, whose own signal belongs to that file's run, and `stop` aborts it.
   */
  const workerLifetime = new AbortController()
  /**
   * The registries of the file running now (the same object `fileScope` holds; the mocks are the
   * worker's under `none`). The fallback for code that lost its async context, such as a callback
   * from a native addon, and for `importFile`, the globals' setup and the teardown, which run
   * outside `fileScope.run`. Do not delete it in favour of throwing on an empty store: such a
   * callback must still find the current file, or a green suite goes red.
   */
  let fallback: FileScope | undefined
  /** The snapshots of the file running now; the runtime's events pass through its lifecycle. */
  let openSnapshots: OpenSnapshots | undefined

  const activeScope = (): FileScope => {
    const found = fileScope.getStore() ?? fallback
    if (found === undefined) {
      throw new WorkerError('ORCH_NO_ACTIVE_FILE', 'No test file is running in this worker')
    }
    return found
  }
  const activeMocks = (): MockRegistry => activeScope().mocks
  const activeRegistry = (): FileRegistry => activeScope().registry
  const activeModuleMocks = (): ModuleMockRegistry => activeScope().moduleMocks

  async function boot(context: WorkerContext): Promise<void> {
    const config = parseProjectConfig(context.init.config)
    // A SerializedPolicy is a Policy whose behaviour keys are all refs: nothing to deserialize.
    const policy: Policy = config.policy
    const behaviours = createBehaviourLoader()
    parts.loader = await createProjectLoader(config.rootDir, config.loader, policy.module)

    // `process` is the pool's business (a new process per file) and runs as `registry`.
    const tier = context.init.isolation === 'process' ? 'registry' : context.init.isolation
    // With `none` nothing is isolated, so the environment lives as long as the worker.
    const scope: EnvironmentScope = tier === 'none' ? 'worker' : 'file'
    parts.tier = tier
    parts.scope = scope

    // Expect, in the order its docs give: the slot exists before any matcher module loads, and
    // `createExpect` registers the table's matchers. The registry snapshot comes last (below).
    const source = createStateSource(currentTest, {
      nameSeparator: policy.core.nameSeparator,
      expand: policy.expect.expand,
    })
    parts.source = source
    const registry = createMatcherRegistry()
    parts.slot = installMatchersSlot(source, registry)
    if (policy.expect.matcherTable === null) {
      throw new ExpectError(
        'EXPECT_NO_MATCHER_TABLE',
        'ExpectPolicy.matcherTable is null: the neutral matcher table is not built yet',
      )
    }
    const table = (await behaviours.load(policy.expect.matcherTable))()
    const expect = createExpect({ policy: policy.expect, table, source, registry })

    // Setup files run inside core's collection, so the hooks they register belong to the file.
    const importFile = async (path: string): Promise<unknown> => {
      const files = activeRegistry()
      // The project's snapshot serializers, before any setup file: Jest tries them ahead of its own
      // and in the order listed, so they are added in reverse (jestAdapterInit.ts L134-L136).
      const snapshotState = openSnapshots?.state
      if (snapshotState !== undefined) {
        for (const serializer of [...policy.snapshot.serializers].reverse()) {
          snapshotState.addSerializer(pluginOf(await files.import(serializer)))
        }
      }
      // Under `none` one registry serves every file of the worker, so a module it already
      // evaluated is cached: the setup files and the test file itself (queued twice, or imported
      // by an earlier file) are dropped and evaluated again, while their dependencies stay shared.
      // Every other tier gives the file a new registry, where there is nothing to drop.
      const shared = scope === 'worker'
      for (const setup of config.setupFiles) {
        if (shared) files.invalidate(setup)
        await files.import(setup)
      }
      // The globals a dialect installs only after `setupFiles` (Jest's `describe`, `expect`, ...).
      activeScope().installLateGlobals()
      for (const setup of config.setupFilesAfterEnv) {
        if (shared) files.invalidate(setup)
        await files.import(setup)
      }
      if (shared) files.invalidate(path)
      return await files.import(path)
    }
    const coreRuntime = await createRuntime({
      policy: policy.core,
      behaviours,
      sink: observingSink(assertionCountSink(source, context.sink), (event) =>
        openSnapshots?.lifecycle.observe(event),
      ),
      importFile,
      rootDir: config.rootDir,
      projectName: config.name,
      ci: config.ci,
    })
    parts.runtime = coreRuntime

    // The snapshot slice's behaviours, once: every file's state is built from them.
    const { snapshot } = policy
    const printerFactory =
      snapshot.printer === null ? null : await behaviours.load(snapshot.printer)
    parts.snapshots = {
      key: await behaviours.load(snapshot.key),
      printer: printerFactory === null ? null : printerFactory(),
      resolvePath:
        snapshot.resolvePath === null ? null : await behaviours.load(snapshot.resolvePath),
    }

    parts.environment = await prepareEnvironment(config.environment)

    // Jest's `roots` default to the root; a project's own `roots` arrive with B14c.
    const roots = [config.rootDir]
    parts.modules = {
      policy,
      roots,
      extensions: config.loader.extensions,
      rootMocks: createRootMockIndex({ roots, extensions: config.loader.extensions }),
    }

    const host: RuntimeGlobalsHost = {
      api: coreRuntime.api,
      expect,
      registry: activeRegistry,
      mocks: activeMocks,
      moduleMocks: activeModuleMocks,
      mockPolicy: policy.mock,
    }
    // A module's own bindings (Jest's `jest`) exist whether or not globals are injected.
    if (config.moduleScope !== null) {
      const scopeFactory = await behaviours.load(config.moduleScope)
      const values: unknown = scopeFactory(host)
      if (typeof values !== 'function') {
        throw new WorkerError(
          'ORCH_BAD_GLOBALS',
          `The module-scope factory ${config.moduleScope.module}#${config.moduleScope.export} did not return a function`,
        )
      }
      parts.moduleScope = values as ModuleScopeValues
    }

    if (policy.core.injectGlobals && config.globals !== null) {
      const factory = await behaviours.load(config.globals)
      const built: unknown = factory(host)
      if (typeof built !== 'object' || built === null) {
        throw new WorkerError(
          'ORCH_BAD_GLOBALS',
          `The globals factory ${config.globals.module}#${config.globals.export} did not return an object`,
        )
      }
      parts.globals = splitGlobals(
        built as Readonly<Record<string, unknown>>,
        policy.core.globalsBeforeSetupFiles,
      )
    }
    // After the factory: it may extend `expect` (or add to it), and what it adds belongs to the
    // baseline that each file's restore returns to, not to something the first file leaked.
    parts.snapshot = snapshotRegistry(registry, expect)
  }

  /**
   * The environment instance for a file: a new one for scope `file` (given the file's `signal`),
   * and for scope `worker` the one made for the first file (given the worker's lifetime signal,
   * because it outlives that file; its `testPath` stays the first file's, the only file it was set
   * up for).
   */
  async function setUpEnvironment(
    worker: Booted,
    context: FileContext,
  ): Promise<EnvironmentInstance> {
    const { scope, environment } = worker
    if (worker.workerEnvironment !== undefined) return worker.workerEnvironment.instance
    const instance = await setupEnvironment(environment, {
      scope,
      testPath: context.job.file,
      pragmas: {},
      console: context.console,
      signal: scope === 'worker' ? workerLifetime.signal : context.signal,
    })
    if (scope === 'worker') {
      worker.workerEnvironment = { instance, name: environment.environment.name }
    }
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
      await boot(context)
    },

    async runFile(context): Promise<FileOutcome> {
      if (!isBooted(parts)) {
        throw new WorkerError('ORCH_NOT_STARTED', 'The worker runtime has not started')
      }
      const worker = parts
      const { job } = context
      if (!(await writableUnlessAborted(context.sink, context.signal))) return {}

      // The worker owns the mock registry, not core: a new one per file, or (isolation `none`, where
      // everything is kept) the worker's own, made for the first file and disposed in `stop`.
      const mocks = worker.workerMocks ?? createMockRegistry()
      // The file's module-mock registry, built by the loader's call with the loader's own
      // `loadActual` and resolver; it needs the mock slice and `mocks`, which the loader never reads.
      const built: { moduleMocks?: ModuleMockRegistry } = {}
      const buildModuleMocks: ModuleMocksFactory = (loaderContext) => {
        const { policy, roots, extensions, rootMocks } = worker.modules
        built.moduleMocks = createModuleMockRegistry({
          policy: policy.module,
          mockPolicy: policy.mock,
          mocks,
          resolver: loaderContext.resolver,
          roots,
          extensions,
          conditions: loaderContext.conditions,
          loadActual: loaderContext.loadActual,
          rootMocks,
        })
        return built.moduleMocks
      }
      // Throws for the tier `realm` (the loader's LOADER_NOT_IMPLEMENTED), with nothing set up yet.
      const registry = worker.loader.createFileRegistry(job.file, {
        tier: worker.tier,
        moduleMocks: buildModuleMocks,
        ...(worker.moduleScope === undefined ? {} : { moduleScope: worker.moduleScope }),
      })
      const { moduleMocks } = built
      if (moduleMocks === undefined) {
        registry.dispose()
        throw new WorkerError('ORCH_NOT_STARTED', 'The loader built no module-mock registry')
      }
      if (worker.scope === 'worker') worker.workerMocks = mocks
      let instance: EnvironmentInstance | undefined
      const { globals } = worker
      const thisFile: FileScope = {
        registry,
        mocks,
        moduleMocks,
        installLateGlobals: () => {
          if (globals !== undefined && instance !== undefined) {
            installGlobals(instance.global, globals.after)
          }
        },
      }
      fallback = thisFile
      const errors: unknown[] = []
      let snapshotReport: SnapshotFileReport | null = null
      try {
        instance = await setUpEnvironment(worker, context)
        // The rest go on after `setupFiles` (`importFile`). Under `none` the environment, and so
        // the late globals of the file before, persist: a later file's `setupFiles` sees them.
        // Deliberate: Jest has no `none` to match, and the tier keeps everything (runtime.test.ts
        // pins it).
        if (globals !== undefined) installGlobals(instance.global, globals.before)
        worker.source.startFile(job.file)
        // The file's snapshots: the state is where the matchers find it (Jest's
        // `setState({ snapshotState, testPath })`), and the lifecycle follows the file's events.
        const snapshots = openFileSnapshots({
          testPath: job.file,
          update: job.updateSnapshots,
          expand: worker.modules.policy.expect.expand,
          policy: worker.modules.policy.snapshot,
          ...worker.snapshots,
        })
        openSnapshots = snapshots
        Object.assign(worker.source.file(), { snapshotState: snapshots.state })
        // The coordinator's id for the file (D23), so every event carries the id it expects.
        await fileScope.run(thisFile, () =>
          worker.runtime.runFile(job.file, { fileId: job.fileId, ...filtersOf(job) }),
        )
        snapshotReport = snapshots.lifecycle.finish()
      } catch (error) {
        errors.push(error)
      } finally {
        openSnapshots = undefined
      }

      // Teardown, always, in this order. A step that throws doesn't stop the next ones. The mock
      // registry goes first, while the environment is alive: a spy on a global (`Math.random`) is
      // put back before the environment's own check of the global, and before the next file. With
      // `none` the environment, the custom matchers, the globals and the mocks persist for the
      // next file, as with Vitest's `isolate: false`: only the file registry goes.
      let leaked: readonly string[] = []
      const teardownEnvironment = async (): Promise<void> => {
        // The environment reports a global it couldn't remove instead of throwing (D22).
        if (instance === undefined) return
        leaked = leakedGlobalsOf(await instance.teardown(), worker.environment.environment.name)
      }
      const restoreMatchers = () => worker.snapshot.restore()
      const disposeRegistry = () => registry.dispose()
      const disposeMocks = () => mocks.dispose()
      // The module-mock registry before the mock registry: its mocks are in `mocks`. One per file
      // in every tier, so it goes under `none` too (B13c Gap 9).
      const disposeModuleMocks = () => thisFile.moduleMocks.dispose()
      errors.push(
        ...(await runAll(
          worker.scope === 'file'
            ? [
                disposeModuleMocks,
                disposeMocks,
                teardownEnvironment,
                restoreMatchers,
                disposeRegistry,
              ]
            : [disposeModuleMocks, disposeRegistry],
        )),
      )
      fallback = undefined
      // A warning, before the file finishes: through the same sink as the file's own events, so it
      // arrives after them and before `fileDone`. It has no task: the file's tasks have ended.
      if (leaked.length > 0) context.sink.emit(fileLeakEvent(job.file, leaked))
      rethrow(errors, `Tearing down ${job.file} failed`)
      return {
        ...(leaked.length > 0 ? { leakedGlobals: leaked } : {}),
        ...(snapshotReport === null || isEmptyReport(snapshotReport)
          ? {}
          : { snapshot: snapshotReport }),
      }
    },

    async stop(context): Promise<void> {
      const torn = parts
      parts = {}
      // Under `none` the worker's registry is disposed below; nothing may reach it afterwards.
      fallback = undefined
      let leaked: readonly string[] = []
      const errors = await runAll([
        // First, while the worker environment is alive (isolation `none`).
        () => torn.workerMocks?.dispose(),
        () => torn.runtime?.dispose(),
        async () => {
          if (torn.workerEnvironment === undefined) return
          const { instance, name } = torn.workerEnvironment
          leaked = leakedGlobalsOf(await instance.teardown(), name)
        },
        () => torn.loader?.[Symbol.dispose](),
        () => torn.slot?.uninstall(),
        // Last: the worker environment's teardown ran with its signal still live.
        () => workerLifetime.abort(),
      ])
      // The worker-scoped environment (isolation `none`) reports once, here, before `stopped`.
      if (leaked.length > 0) context.sink.emit(workerLeakEvent(leaked))
      rethrow(errors, 'Stopping the worker runtime failed')
    },
  }
}
