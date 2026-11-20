// Runs one `mod-*` fixture's test file through `@provino/core` over the real loader (T2.5 + T4.8,
// B13c), the way `mock-corpus/run-mock.ts` runs a mocking fixture. The fixture is copied to a temp
// directory with its `packages` installed and loaded by `@provino/loader` (the real resolver, the
// real pipeline with the profile's hoist policy, every edge through the real module-mock registry),
// then removed, also on failure.
//
// The Jest profile's modules get the shipped per-module `jest` (`jestModuleScope`), the Vitest
// profile's the shipped per-module `vi` (`vitestModuleScope`, B25f). The non-vacuity checks' broken engines wrap the injected module-mock registry,
// so nothing broken ships.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRuntime } from '@provino/core'
import { type JestGlobalsHost, jestModuleScope } from '@provino/dialect-jest/runtime'
import { vitestModuleScope } from '@provino/dialect-vitest/runtime'
import { createLoader } from '@provino/loader'
import { createMockRegistry, createModuleMockRegistry } from '@provino/mock'
import { createBehaviourLoader } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import type {
  CorePolicy,
  FileRegistry,
  HoistPolicy,
  MockDecision,
  MockPolicy,
  ModuleMockRegistry,
  ModulePolicy,
  ModuleScopeValues,
  RuntimeEvent,
} from '@provino/types'
import type { Fixture } from '../fixture.ts'
import { installGlobals } from '../internal/globals.ts'
import '../internal/observe-setup.ts'
import { unusedJestHost } from '../internal/unused-jest-host.ts'
import { copyFixture, installPackages } from '../record.ts'
import { type CoreRun, summarizeRun } from '../runtime-corpus/run-core.ts'

/** Everything a profile contributes. */
export interface ModProfile {
  readonly facade: 'jest' | 'vi'
  readonly core: CorePolicy
  readonly mock: MockPolicy
  readonly module: ModulePolicy
  readonly hoist: HoistPolicy
}

/**
 * A broken engine for the non-vacuity checks. `inert`: no import edge is mocked (root
 * `__mocks__` files included) and registrations go nowhere. `wrong-values`: the registry decides
 * and runs its factories as usual, but every mocked edge is served an empty module.
 */
export type Sabotage = 'inert' | 'wrong-values'

export interface RunModOptions {
  readonly sabotage?: Sabotage
}

/** What a run reports, plus the work directory its messages name (gone by the time it returns). */
export interface ModRun extends CoreRun {
  readonly root: string
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']
/** The extensions a fixture's manual mock has. */
const MOCK_EXTENSIONS = ['.ts']
const NOT_MOCKED: MockDecision = { mocked: false }

/**
 * Runs `testFile` (relative to the fixture) under `profile`. `cleanup` is the fixture's
 * `mockCleanup`. Returns what core reported; `trace` holds the `observe` lines in order.
 */
export async function runModFile(
  fixture: Fixture,
  testFile: string,
  profile: ModProfile,
  options: RunModOptions = {},
): Promise<ModRun> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'provino-mod-')))
  try {
    await copyFixture(fixture, root)
    await installPackages(fixture, root)
    return { ...(await runIn(fixture, root, testFile, profile, options)), root }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The module-mock registry the loader is given, broken as `sabotage` says. */
function sabotaged(
  registry: ModuleMockRegistry,
  sabotage: Sabotage | undefined,
): ModuleMockRegistry {
  if (sabotage === undefined) return registry
  const inert = sabotage === 'inert'
  return {
    register: (specifier, spec, options) => {
      if (!inert) registry.register(specifier, spec, options)
    },
    decide: (id, importer, kind, specifier) =>
      inert ? NOT_MOCKED : registry.decide(id, importer, kind, specifier),
    decideUnresolved: (specifier, importer) =>
      inert ? NOT_MOCKED : registry.decideUnresolved(specifier, importer),
    active: () => !inert && registry.active(),
    generation: () => registry.generation(),
    materialize: (id) => {
      const served = registry.materialize(id)
      return inert ? served : {}
    },
    mockFor: (specifier, from) => registry.mockFor(specifier, from),
    createMockFromModule: (specifier, from) => registry.createMockFromModule(specifier, from),
    onResetModules: () => registry.onResetModules(),
    onGenerateMock: (callback) => registry.onGenerateMock(callback),
    setAutomock: (enabled) => {
      if (!inert) registry.setAutomock(enabled)
    },
    enterIsolation: (caller, other) => registry.enterIsolation(caller, other),
    exitIsolation: () => registry.exitIsolation(),
    dispose: () => registry.dispose(),
  }
}

async function runIn(
  fixture: Fixture,
  root: string,
  testFile: string,
  profile: ModProfile,
  options: RunModOptions,
): Promise<CoreRun> {
  const lines: string[] = []
  const events: RuntimeEvent[] = []
  const mocks = createMockRegistry()
  const cleanup = fixture.manifest.mockCleanup ?? {}
  // The fixture's `jestConfig` is Jest's, so it reaches the Jest profile only: Jest's `roots` are
  // where `__mocks__` is looked for, and `unmockedModulePathPatterns` the policy's patterns.
  const jest = profile.facade === 'jest' ? fixture.manifest.jestConfig : undefined
  const modulePolicy: ModulePolicy =
    jest?.unmockedModulePathPatterns === undefined
      ? profile.module
      : {
          ...profile.module,
          unmockedPathPatterns: jest.unmockedModulePathPatterns.map((source) => new RegExp(source)),
        }
  const roots = jest?.roots === undefined ? [root] : jest.roots.map((dir) => path.join(root, dir))
  const loader = createLoader({
    root,
    engine: 'runner',
    resolver: createResolver({ root, mappers: [], extensions: EXTENSIONS, tsconfig: false }),
    transformer: createPipeline({
      root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: profile.hoist,
      cache: false,
    }),
    policy: modulePolicy,
    conditions: [],
    moduleScope: { names: [profile.facade] },
  })

  let files: FileRegistry | undefined
  let moduleMocks: ModuleMockRegistry | undefined
  const currentFiles = (): FileRegistry => {
    if (files === undefined) throw new Error('no file registry yet')
    return files
  }
  const currentModuleMocks = (): ModuleMockRegistry => {
    if (moduleMocks === undefined) throw new Error('no module-mock registry yet')
    return moduleMocks
  }

  const runtime = await createRuntime({
    policy: profile.core,
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    importFile: async (file) => {
      runtime.api.beforeEach(() => {
        mocks.beforeEach(cleanup, profile.mock.between)
      })
      await currentFiles().import(file)
      return {}
    },
    rootDir: root,
    ci: true,
  })
  const host: JestGlobalsHost = {
    ...unusedJestHost(runtime.api, mocks, profile.mock, 'the mod corpus'),
    registry: currentFiles,
    moduleMocks: currentModuleMocks,
  }
  const moduleScope: ModuleScopeValues =
    profile.facade === 'jest' ? jestModuleScope(host) : vitestModuleScope(host)
  const testPath = path.join(root, testFile)
  files = loader.createFileRegistry(testPath, {
    tier: 'registry',
    moduleMocks: (context) => {
      moduleMocks = sabotaged(
        createModuleMockRegistry({
          policy: modulePolicy,
          mockPolicy: profile.mock,
          mocks,
          resolver: context.resolver,
          roots,
          extensions: MOCK_EXTENSIONS,
          conditions: context.conditions,
          loadActual: context.loadActual,
        }),
        options.sabotage,
      )
      return moduleMocks
    },
    moduleScope,
  })

  // The fixtures keep counters on `globalThis`; a real run starts a process per profile, so what a
  // run added is removed afterwards.
  const before = new Set(Reflect.ownKeys(globalThis))
  const restoreInstalled = installGlobals({
    trace: (step: string): void => {
      lines.push(step)
    },
    ...runtime.api,
  })
  const restore = (): void => {
    restoreInstalled()
    for (const key of Reflect.ownKeys(globalThis)) {
      if (!before.has(key)) Reflect.deleteProperty(globalThis, key)
    }
  }
  try {
    await runtime.runFile(testPath)
  } finally {
    try {
      files.dispose()
      mocks.dispose()
    } finally {
      restore()
      loader[Symbol.dispose]()
      await runtime.dispose()
    }
  }
  return summarizeRun(events, lines)
}
