// Runs one `mod-*` fixture's test file through `@provino/core` over the fake loader (B13b, T4.7),
// the way `mock-corpus/run-mock.ts` runs a mocking fixture. The fixture is copied to a temp
// directory with its `packages` installed, loaded by the fake loader (real resolver, real hoister,
// real module-mock registry) and removed afterwards, also on failure.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRuntime } from '@provino/core'
import { createMockRegistry, createStubs } from '@provino/mock'
import { createBehaviourLoader } from '@provino/policy'
import type {
  CorePolicy,
  HoistPolicy,
  MockPolicy,
  ModulePolicy,
  RuntimeEvent,
} from '@provino/types'
import type { Fixture } from '../fixture.ts'
import { installGlobals } from '../internal/globals.ts'
import '../internal/observe-setup.ts'
import { unusedJestHost } from '../mock-corpus/run-mock.ts'
import { copyFixture, installPackages } from '../record.ts'
import { type CoreRun, summarizeRun } from '../runtime-corpus/run-core.ts'
import { createFacades } from './facades.ts'
import { FakeLoader } from './fake-loader.ts'

/** Everything a profile contributes. */
export interface ModProfile {
  readonly facade: 'jest' | 'vi'
  readonly core: CorePolicy
  readonly mock: MockPolicy
  readonly module: ModulePolicy
  readonly hoist: HoistPolicy
  /** Whether a transform error reads `<file>: <message>` (Babel's, so Jest's). */
  readonly prefixTransformErrors?: boolean
}

/** A broken engine for the non-vacuity checks; see `FakeLoaderOptions.sabotage`. */
export interface RunModOptions {
  readonly sabotage?: 'inert' | 'wrong-values'
}

/** What a run reports, plus the work directory its messages name (gone by the time it returns). */
export interface ModRun extends CoreRun {
  readonly root: string
}

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
  const stubs = createStubs(mocks, process.env, globalThis)
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
  const runtime = await createRuntime({
    policy: profile.core,
    behaviours: createBehaviourLoader(),
    sink: { emit: (event) => events.push(event) },
    importFile: async (file) => {
      runtime.api.beforeEach(() => {
        mocks.beforeEach(cleanup, profile.mock.between)
      })
      await loader.loadTestFile(file)
      return {}
    },
    rootDir: root,
    ci: true,
  })
  const jestHost = unusedJestHost(runtime.api, mocks, profile.mock, 'the mod corpus')
  const loader: FakeLoader = new FakeLoader({
    root,
    ...(jest?.roots === undefined ? {} : { roots: jest.roots.map((dir) => path.join(root, dir)) }),
    hoist: profile.hoist,
    policy: modulePolicy,
    mockPolicy: profile.mock,
    mocks,
    ...(options.sabotage === undefined ? {} : { sabotage: options.sabotage }),
    ...(profile.prefixTransformErrors === true ? { prefixTransformErrors: true } : {}),
    facades: (from, ops) =>
      createFacades(
        {
          facade: profile.facade,
          policy: modulePolicy,
          mockPolicy: profile.mock,
          mocks,
          jestHost,
          stubs,
          inert: options.sabotage === 'inert',
        },
        from,
        ops,
      ),
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
    await runtime.runFile(path.join(root, testFile))
  } finally {
    try {
      loader.registry.dispose()
      mocks.dispose()
    } finally {
      restore()
      await runtime.dispose()
    }
  }
  return summarizeRun(events, lines)
}
