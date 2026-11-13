// U1: the worker's runtime (B10). It assembles what the other packages built, in the order their
// docs prescribe, behind `startWorker`'s `WorkerRunner`:
//   start (once)   config → behaviour loader + project loader → expect (state source, registry,
//                  slot, table, `createExpect`) → core → lazy runtime (the slot) → environment `prepare` → the dialect's
//                  globals factory → registry snapshot (last, so a matcher the factory adds is part
//                  of the baseline a file's restore returns to)
//   runFile        back-pressure → mock registry (new per file; one per worker under `none`) →
//                  file registry, with the file's module-mock registry and the per-module
//                  bindings → environment `setup` → globals → expect state → core (setup files,
//                  then the test file, imported inside collection) → teardown, which disposes the
//                  module-mock registry and then the mock registry first, while the environment is
//                  still alive, so a spy on a global is restored before the next file sees it
//   stop           the process error listeners → the worker's mock registry (isolation `none`) →
//                  core's worker teardowns → the worker environment → loader → the matcher slot →
//                  the worker's lifetime signal
// The fake clock (T4.9) is per file, on the environment's global; the mock cleanup between tests
// (T4.10) is core's `onBeforeTryTask`; uncaught exceptions and rejections reach core through
// `captureProcessErrors` (T5.11).
// An environment's teardown may report globals it could not remove (D22): that is a `console`
// warning and, for a file, `leakedGlobals` on its outcome; it is never a failure.
// The environment and the globals come in by ref, never by import: this node knows no dialect and
// no environment package.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRuntime, currentTest, type Runtime } from '@provino/core'
import {
  createEndOfTest,
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
import { createLazyRuntime, installLazyRuntime } from '@provino/lazy'
import { createProjectLoader, installSourceMappedStacks } from '@provino/loader'
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
import { createFakeClock, type FakeClock, type FakeTimersConfig } from '@provino/timers'
import type {
  EnvironmentInstance,
  EnvironmentRef,
  EnvironmentResolver,
  EnvironmentScope,
  EventSink,
  FileJob,
  FileRegistry,
  GlobalsHost,
  IsolationTier,
  JsonValue,
  Loader,
  ModuleMockRegistry,
  ModuleMocksFactory,
  ModuleScopeValues,
  Policy,
  Pragmas,
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
import { lazyReportSink } from '../internal/runtime/lazy-sink.ts'
import { fileLeakEvent, leakedGlobalsOf, workerLeakEvent } from '../internal/runtime/leaks.ts'
import { pragmaValue, readPragmas } from '../internal/runtime/pragmas.ts'
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
  /** The project's `globals` values (Jest), copied onto each file's global before anything runs. */
  globalValues: Readonly<Record<string, JsonValue>> | undefined
  /** The project's fake-timer defaults (Jest's `fakeTimers`), what every clock install is layered over. */
  fakeTimers: Readonly<Record<string, JsonValue>> | undefined
  /**
   * The dialect's resolver for a file's environment pragma, with the project's own environment
   * ref it builds on, its root and the environments prepared so far: one per kind per worker,
   * made the first time a file names it (R4). `requested` is the same by what a docblock asked
   * for (name and options), so a second file with the same pragma neither resolves nor hashes the
   * ref again.
   */
  pragmaEnvironments:
    | {
        readonly resolve: EnvironmentResolver
        readonly base: EnvironmentRef
        readonly rootDir: string
        readonly prepared: Map<string, PreparedEnvironment>
        readonly requested: Map<string, PreparedEnvironment>
      }
    | undefined
  /** The file registry tier: `process` is the pool's business and runs as `registry`. */
  tier: Exclude<IsolationTier, 'process'>
  /**
   * How long an environment instance lives: `worker` for isolation `none` (nothing is isolated, so
   * the environment, the globals and the registry last as long as the worker), `file` otherwise.
   */
  scope: EnvironmentScope
  /**
   * The instance of a worker-scoped environment and the kind it was prepared from. It is kept for
   * as long as the files that follow want the same kind, and torn down when one wants another (a
   * docblock); `stop` tears the last one down.
   */
  workerEnvironment:
    | {
        readonly instance: EnvironmentInstance
        readonly name: string
        readonly prepared: PreparedEnvironment
      }
    | undefined
  /** The mock registry of a worker-scoped run (isolation `none`); `stop` disposes it. */
  workerMocks: MockRegistry | undefined
  /** What each file's module-mock registry is built from (B13c). */
  modules: ModuleMocking
  /** The dialect's per-module bindings, built once from its factory; `undefined` for none. */
  moduleScope: ModuleScopeValues | undefined
  /** Removes the process listeners core charges errors from (`captureProcessErrors`). */
  stopProcessErrors: (() => void) | undefined
  /** Takes the lazy runtime out of its slot (`installLazyRuntime`). */
  uninstallLazy: (() => void) | undefined
  /** Puts back the `Error.prepareStackTrace` the worker found (`installSourceMappedStacks`). */
  unmapStacks: (() => void) | undefined
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
  /** The fake clock of the file running now, on the environment's global. */
  timers(): FakeClock
}

/** What a file's code finds through the host: its own registries, whoever runs when it asks. */
interface FileScope {
  readonly registry: FileRegistry
  readonly mocks: MockRegistry
  /** The file's module-mock registry: one per file in every tier (B13c Gap 9). */
  readonly moduleMocks: ModuleMockRegistry
  /** Installs the globals that wait for `setupFiles` (`core.globalsBeforeSetupFiles`). */
  readonly installLateGlobals: () => void
  /** The file's fake clock, made once its environment exists. */
  clock: FakeClock | undefined
  /** True once the file's teardown has run: its environment is gone. */
  tornDown: boolean
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
  const activeClock = (): FakeClock => {
    const { clock } = activeScope()
    if (clock === undefined) {
      throw new WorkerError('ORCH_NO_ACTIVE_FILE', "The file's environment is not set up yet")
    }
    return clock
  }

  async function boot(context: WorkerContext): Promise<void> {
    const config = parseProjectConfig(context.init.config)
    // A SerializedPolicy is a Policy whose behaviour keys are all refs: nothing to deserialize.
    const policy: Policy = config.policy
    const behaviours = createBehaviourLoader()
    parts.loader = await createProjectLoader(config.rootDir, config.loader, policy.module)
    // A frame in a module the loader ran is reported where it is in the file as written.
    parts.unmapStacks = installSourceMappedStacks(parts.loader)

    // `process` is the pool's business (a new process per file) and runs as `registry`.
    const tier = context.init.isolation === 'process' ? 'registry' : context.init.isolation
    // With `none` nothing is isolated, so the environment lives as long as the worker.
    const scope: EnvironmentScope = tier === 'none' ? 'worker' : 'file'
    parts.tier = tier
    parts.scope = scope
    parts.globalValues = config.globalValues
    parts.fakeTimers = config.fakeTimers

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
    // `expect.poll` moves the file's fake clock by the interval after each wait, as Vitest does
    // (T7.8). With no file running, or no clock installed, there is none to move.
    const advanceFakeClock = (ms: number): Promise<void> | undefined => {
      const clock = (fileScope.getStore() ?? fallback)?.clock
      return clock?.isInstalled() ? clock.advanceByAsync(ms) : undefined
    }
    const expect = createExpect({
      policy: policy.expect,
      table,
      source,
      registry,
      // This package reads only its own slice, so the worker hands over the core leaf (T7.8).
      unawaited: policy.core.unawaitedAsyncAssertion,
      pollTimers: { advance: advanceFakeClock },
    })

    // Setup files run inside core's collection, so the hooks they register belong to the file.
    const importFile = async (path: string): Promise<unknown> => {
      const files = activeRegistry()
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
      // `fakeTimers.enableGlobally` installs the clock here, as jestAdapter does after
      // `runTest` ran `setupFiles`: a setup file sees real timers, `setupFilesAfterEnv` fake ones.
      if (policy.timers.enableGlobally) activeScope().clock?.install()
      // The project's snapshot serializers, when the test framework starts: after `setupFiles` and
      // the globals, before `setupFilesAfterEnv`. Jest tries them ahead of its own and in the order
      // listed, so they are added in reverse (jestAdapterInit.ts L134-L136).
      const snapshotState = openSnapshots?.state
      if (snapshotState !== undefined) {
        for (const serializer of [...policy.snapshot.serializers].reverse()) {
          snapshotState.addSerializer(pluginOf(await files.import(serializer)))
        }
      }
      for (const setup of config.setupFilesAfterEnv) {
        if (shared) files.invalidate(setup)
        await files.import(setup)
      }
      if (shared) files.invalidate(path)
      return await files.import(path)
    }
    const lazyReport = lazyReportSink(
      observingSink(assertionCountSink(source, context.sink), (event) =>
        openSnapshots?.lifecycle.observe(event),
      ),
    )
    const coreRuntime = await createRuntime({
      policy: policy.core,
      behaviours,
      sink: lazyReport.sink,
      importFile,
      rootDir: config.rootDir,
      projectName: config.name,
      ci: config.ci,
    })
    parts.runtime = coreRuntime
    // Cleanup between tests (T4.10): where `registry.beforeEach` sits in a test's order is core's
    // call (before its first `beforeEach`, in its own async context). `activeMocks` is read when it
    // runs, because every file has its own registry. The project's own flags layer over the
    // policy's `mock.between` through the policy, so there is nothing else to pass.
    coreRuntime.onBeforeTryTask(() => {
      activeMocks().beforeEach({}, policy.mock.between)
    })
    // What `expect` owes a test when its attempt ends (T7.8): soft failures, `expect.assertions`,
    // `hasAssertions`, `requireAssertions` and async assertions nobody awaited. It runs after the
    // last `afterEach` and the teardowns, in the attempt's own async context. Core adds one error
    // per thrown value, so several are thrown together.
    const endOfTest = createEndOfTest({
      source,
      messages: table.messages,
      policy: policy.expect,
      hasAssertionsWhenFailed: policy.core.errors.hasAssertionsWhenFailed,
    })
    coreRuntime.onAfterTryTask(({ test, attempt, repeat, failed, fail }) => {
      // One error each, as the runners report them (two soft failures are two errors).
      for (const error of endOfTest({ test, attempt, repeat, failed })) fail(error)
    })
    // Uncaught exceptions and rejections with no handler are charged by `errors.lateErrors` (T5.11).
    parts.stopProcessErrors = coreRuntime.captureProcessErrors()
    // Lazy variables: `import { lazy } from 'provino'` reaches this runtime through its slot. It is
    // neutral, so every dialect gets it, and it goes in before the environment is prepared.
    const lazyRuntime = createLazyRuntime({
      host: coreRuntime.lazyHost,
      policy: policy.lazy,
      describe: coreRuntime.api.describe,
    })
    parts.uninstallLazy = installLazyRuntime(lazyRuntime)
    // A failed attempt hands its lazy values to the failure report (T6.10); a passing one does
    // nothing, so a test that passes pays for none of it.
    coreRuntime.onAfterTryTask(({ test, failed }) => {
      if (!failed) return
      const frame = coreRuntime.lazyHost.current()
      if (frame?.kind !== 'test') return
      const lazies = lazyRuntime.evaluatedLazies(frame.run)
      if (lazies.length > 0) lazyReport.record(test.id, lazies)
    })

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
    if (config.environmentResolver !== undefined) {
      parts.pragmaEnvironments = {
        resolve: await behaviours.load(config.environmentResolver),
        base: config.environment,
        rootDir: config.rootDir,
        prepared: new Map(),
        requested: new Map(),
      }
    }

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
      timers: activeClock,
      timersPolicy: policy.timers,
      seed: config.seed,
      environmentTornDown: () => (fileScope.getStore() ?? fallback)?.tornDown ?? true,
      setDefaultTimeout: (ms) => coreRuntime.setDefaultTimeout(ms),
      setDefaultRetry: (retry) => coreRuntime.setDefaultRetry(retry),
    }
    // The scope also serves the imports (`@jest/globals`); the bindings a module's wrapper declares
    // are `config.loader.moduleScope`, which is empty when `injectGlobals` is off.
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
   * and for scope `worker` the worker's one while the files want the same kind of environment
   * (given the worker's lifetime signal, because it outlives the file it was made for; its
   * `testPath` stays that file's). A file whose docblock names another kind tears the current one
   * down first, so the global is restored before the next populates it: each environment is on the
   * global only while its own files run.
   */
  async function setUpEnvironment(
    worker: Booted,
    context: FileContext,
  ): Promise<{ readonly instance: EnvironmentInstance; readonly name: string }> {
    const { scope } = worker
    const pragmas = readPragmas(context.job.file)
    // A pragma picks the environment for this file.
    const environment = await environmentFor(worker, pragmas, context.job.file)
    const current = worker.workerEnvironment
    if (current !== undefined) {
      if (current.prepared === environment) return current
      // Another kind: this one goes (the global is restored) before the next is set up. A global it
      // could not remove is the worker's to report, as at `stop`.
      worker.workerEnvironment = undefined
      const leaked = leakedGlobalsOf(await current.instance.teardown(), current.name)
      if (leaked.length > 0) context.sink.emit(workerLeakEvent(leaked))
    }
    const instance = await setupEnvironment(environment, {
      scope,
      testPath: context.job.file,
      pragmas,
      console: context.console,
      signal: scope === 'worker' ? workerLifetime.signal : context.signal,
      // A copy of `process` for the file, or the worker's own (`orchestrator.processObject`).
      processObject: worker.modules.policy.orchestrator.processObject,
    })
    const set = { instance, name: environment.environment.name, prepared: environment }
    if (scope === 'worker') worker.workerEnvironment = set
    return set
  }

  /**
   * The prepared environment for a file: the project's own, or the one its docblock names, resolved
   * by the dialect and prepared once per kind (the same ref and options is the same kind).
   */
  async function environmentFor(
    worker: Booted,
    pragmas: Pragmas,
    file: string,
  ): Promise<PreparedEnvironment> {
    const names = worker.modules.policy.orchestrator.environmentPragmas
    const name = names
      .map((pragma) => pragmaValue(pragmas, pragma))
      .find((value) => value !== undefined)
    if (name === undefined || name === '') return worker.environment
    const optionsText = names
      .map((pragma) => pragmaValue(pragmas, `${pragma}-options`))
      .find((value) => value !== undefined)
    const known = worker.pragmaEnvironments
    if (known === undefined) {
      throw new WorkerError(
        'ORCH_BAD_ENVIRONMENT',
        `${file} asks for the environment "${name}" in its docblock, but this project's dialect can't resolve one`,
      )
    }
    const requestKey = `${name}\0${optionsText ?? ''}`
    const requested = known.requested.get(requestKey)
    if (requested !== undefined) return requested
    let options: JsonValue = null
    if (optionsText !== undefined) {
      try {
        options = JSON.parse(optionsText) as JsonValue
      } catch (cause) {
        throw new WorkerError(
          'ORCH_BAD_ENVIRONMENT',
          `${file}: the @${names[0]}-options docblock must be JSON (${optionsText})`,
          { cause },
        )
      }
    }
    const ref = await known.resolve({
      name,
      options,
      rootDir: known.rootDir,
      testPath: file,
      base: known.base,
    })
    const key = JSON.stringify([ref.module, ref.export, ref.options])
    let prepared = known.prepared.get(key)
    if (prepared === undefined) {
      prepared = await prepareEnvironment(ref)
      known.prepared.set(key, prepared)
    }
    known.requested.set(requestKey, prepared)
    return prepared
  }

  /** The filters this file's job carries; `exactOptionalPropertyTypes` forbids passing `undefined`. */
  function filtersOf(job: FileJob) {
    return {
      ...(job.testNamePattern === undefined ? {} : { testNamePattern: job.testNamePattern }),
      ...(job.testIds === undefined ? {} : { testIds: job.testIds }),
      // Whatever the job carries is forwarded: core fails the file for a value that is not `true`.
      ...(job.collectOnly === undefined ? {} : { collectOnly: job.collectOnly }),
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
        clock: undefined,
        tornDown: false,
      }
      fallback = thisFile
      let environmentName = worker.environment.environment.name
      const errors: unknown[] = []
      let snapshotReport: SnapshotFileReport | null = null
      try {
        const set = await setUpEnvironment(worker, context)
        instance = set.instance
        environmentName = set.name
        // The fake clock of this file, on the environment's global (the registry tier keeps one
        // global per file): each callback it schedules runs as the test that scheduled it.
        thisFile.clock = createFakeClock(instance.global, worker.modules.policy.timers, {
          bind: currentTest.bind,
          // jest-runtime layers every install over the project's `fakeTimers`, `enableGlobally`'s too.
          defaults: worker.fakeTimers as FakeTimersConfig | undefined,
        })
        // The rest go on after `setupFiles` (`importFile`). Under `none` the environment, and so
        // the late globals of the file before, persist: a later file's `setupFiles` sees them.
        // Deliberate: Jest has no `none` to match, and the tier keeps everything (runtime.test.ts
        // pins it).
        // Jest's `globals` config: copied for each file and defined before anything else (the
        // environment constructor's `installCommonGlobals`), so `setupFiles` see them.
        if (worker.globalValues !== undefined) {
          installGlobals(instance.global, structuredClone(worker.globalValues))
        }
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
        // A collect-only file ran no test: `finish` would save the file and report every stored
        // snapshot as unchecked.
        if (job.collectOnly !== true) snapshotReport = snapshots.lifecycle.finish()
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
      // What the file loaded, read before the registry's disposal empties it (U5: the `deps` event).
      const deps = registry.loadedModules()
      let leaked: readonly string[] = []
      const teardownEnvironment = async (): Promise<void> => {
        // The environment reports a global it couldn't remove instead of throwing (D22).
        if (instance === undefined) return
        leaked = leakedGlobalsOf(await instance.teardown(), environmentName)
      }
      const restoreMatchers = () => worker.snapshot.restore()
      const disposeRegistry = () => registry.dispose()
      const disposeMocks = () => mocks.dispose()
      // The module-mock registry before the mock registry: its mocks are in `mocks`. One per file
      // in every tier, so it goes under `none` too (B13c Gap 9).
      const disposeModuleMocks = () => thisFile.moduleMocks.dispose()
      // The real timers go back first: a callback the mock teardown or the environment fires must
      // not meet a fake clock of a file that is over.
      const disposeClock = () => thisFile.clock?.dispose()
      errors.push(
        ...(await runAll(
          worker.scope === 'file'
            ? [
                disposeClock,
                disposeModuleMocks,
                disposeMocks,
                teardownEnvironment,
                restoreMatchers,
                disposeRegistry,
              ]
            : [disposeClock, disposeModuleMocks, disposeRegistry],
        )),
      )
      thisFile.tornDown = true
      fallback = undefined
      // A warning, before the file finishes: through the same sink as the file's own events, so it
      // arrives after them and before `fileDone`. It has no task: the file's tasks have ended.
      if (leaked.length > 0) context.sink.emit(fileLeakEvent(job.file, leaked))
      rethrow(errors, `Tearing down ${job.file} failed`)
      return {
        deps,
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
        () => torn.stopProcessErrors?.(),
        // While the worker environment is alive (isolation `none`).
        () => torn.workerMocks?.dispose(),
        () => torn.runtime?.dispose(),
        async () => {
          if (torn.workerEnvironment === undefined) return
          const { instance, name } = torn.workerEnvironment
          leaked = leakedGlobalsOf(await instance.teardown(), name)
        },
        () => torn.loader?.[Symbol.dispose](),
        () => torn.unmapStacks?.(),
        () => torn.uninstallLazy?.(),
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
