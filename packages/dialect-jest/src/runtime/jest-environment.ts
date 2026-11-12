// T8.5: the adapter that runs a Jest environment class (`jest-environment-jsdom`,
// `jest-fixed-jsdom`, `@edge-runtime/jest-environment`, a project's own) as a Provino
// `Environment`. Decision D44: under the Jest dialect the project's own package is what runs, so
// the DOM is exactly the one Jest 30 would give. The class is constructed as jest-runtime does
// (`new Class({ globalConfig, projectConfig }, { console, docblockPragmas, testPath })`), set up,
// and its `global` populated onto the worker's own global (isolation `registry`; the realm
// `context` tier waits for T2.8). `teardown` puts the worker's global back.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { populateGlobal, snapshotProperties } from '@provino/env-shared'
import type {
  Environment,
  EnvironmentConditions,
  EnvironmentInstance,
  EnvironmentRequest,
  EnvironmentResolver,
  EnvironmentSetupContext,
  EnvironmentTeardownReport,
  JsonValue,
  Pragmas,
} from '@provino/types'
import { projectJestRequireResolve } from '../jest-require.ts'

/**
 * What the adapter is given (JSON, so it crosses to a worker): where the class is and the parts of
 * Jest's `projectConfig` an environment class reads.
 * @public
 */
export interface JestEnvironmentOptions {
  readonly [key: string]: JsonValue
  /** The environment package's entry, absolute (the project's own copy). */
  readonly module: string
  /** What Jest's `projectConfig` holds that an environment reads. */
  readonly projectConfig: { readonly [key: string]: JsonValue }
}

/** The surface of a Jest environment class instance the adapter uses. */
interface JestEnvironmentLike {
  readonly global: object
  setup(): Promise<void>
  teardown(): Promise<void>
  exportConditions?(): readonly string[]
}

/** A Jest environment class, as jest-runtime constructs it. @public */
export type JestEnvironmentClass = new (
  config: { readonly globalConfig: object; readonly projectConfig: object },
  context: {
    readonly console: Console
    readonly docblockPragmas: Pragmas
    readonly testPath: string
  },
) => JestEnvironmentLike

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads the class out of a loaded module as Jest's `interopRequireDefault` and `getTestEnvironment` do. */
function classOf(namespace: unknown, path: string): JestEnvironmentClass {
  let candidate: unknown = isRecord(namespace) ? namespace.default : namespace
  if (isRecord(candidate) && candidate.__esModule === true) {
    candidate = candidate.default ?? candidate.TestEnvironment
  }
  if (typeof candidate !== 'function' && isRecord(namespace)) candidate = namespace.TestEnvironment
  if (typeof candidate !== 'function') {
    throw new TypeError(
      `Test environment ${path} must export a class (as its default export, or as TestEnvironment).`,
    )
  }
  return candidate as JestEnvironmentClass
}

function optionsOf(value: unknown): JestEnvironmentOptions {
  if (
    !isRecord(value) ||
    typeof value.module !== 'string' ||
    !isRecord(value.projectConfig) ||
    Array.isArray(value.projectConfig)
  ) {
    throw new TypeError('The Jest environment adapter needs { module, projectConfig } as options.')
  }
  return value as JestEnvironmentOptions
}

async function setUpJest(
  context: EnvironmentSetupContext<{ readonly [key: string]: JsonValue }>,
  EnvironmentClass: JestEnvironmentClass,
  projectConfig: object,
): Promise<EnvironmentInstance> {
  // Jest's fresh vm context per file makes a restore unnecessary there; the worker's own global is
  // shared by every file, so it is put back as `nodeEnvironment` does (D71): descriptor-exact, with
  // the closure-backed accessors (`process`, `performance`) wrapped so an assignment is undone too.
  const snapshot = snapshotProperties(globalThis)
  const environment = new EnvironmentClass(
    { globalConfig: {}, projectConfig },
    { console: context.console, docblockPragmas: context.pragmas, testPath: context.testPath },
  )
  let populated: ReturnType<typeof populateGlobal> | undefined
  try {
    await environment.setup()
    // Only a window stands in for the global: a Node or edge environment's code must not see one.
    const isWindow = 'document' in environment.global
    populated = populateGlobal(globalThis, environment.global, { selfReferences: isWindow })
  } catch (error) {
    // Jest tears the environment down even when its setup threw: its window, timers and
    // half-defined accessors must not outlive the failed file.
    populated?.restore()
    try {
      await environment.teardown()
    } catch {
      // The setup's error is the one the file fails with.
    }
    snapshot.restore()
    throw error
  }
  const installed = populated
  return {
    global: globalThis,
    async teardown(): Promise<EnvironmentTeardownReport | undefined> {
      let failure: { readonly error: unknown } | undefined
      try {
        await environment.teardown()
      } catch (error) {
        failure = { error }
      }
      // Whatever the class threw, the global goes back: the next file's baseline would otherwise
      // hold this one's accessors. Anything the class or the test left that differs from the
      // snapshot is put right too; a key that can't be is a warning (D22).
      installed.restore()
      const leaked = snapshot.restore().map(String)
      if (failure !== undefined) throw failure.error
      return leaked.length === 0 ? undefined : { leakedGlobals: leaked }
    },
  }
}

/**
 * Runs the Jest environment class a project names (by path, in `options`): `prepare` imports the
 * class once per worker; `setup` builds one instance per file.
 * @public
 */
export const jestEnvironment: Environment<'jest-environment', JestEnvironmentOptions> = {
  name: 'jest-environment',
  realms: ['worker'],
  async prepare(options) {
    const { module } = optionsOf(options)
    return classOf(await import(pathToFileURL(module).href), module)
  },
  setup(context, prepared) {
    const options = optionsOf(context.options)
    return setUpJest(context, prepared as JestEnvironmentClass, options.projectConfig)
  },
}

/**
 * An `Environment` over a Jest environment class you already hold (T8.5): for code that builds an
 * environment itself rather than naming a package. `projectConfig` is what the class reads.
 * @public
 */
export function fromJestEnvironment(
  EnvironmentClass: JestEnvironmentClass,
  projectConfig: object = {},
): Environment<'jest-environment', { readonly [key: string]: JsonValue }> {
  return {
    name: 'jest-environment',
    realms: ['worker'],
    setup: (context) => setUpJest(context, EnvironmentClass, projectConfig),
  }
}

/** `customExportConditions` from `testEnvironmentOptions`, as the classes read it (an array of strings). */
function customConditions(options: EnvironmentRequest['options']): readonly string[] | undefined {
  const config = options?.projectConfig
  const own = isRecord(config) ? config.testEnvironmentOptions : undefined
  const custom = isRecord(own) ? own.customExportConditions : undefined
  return Array.isArray(custom) && custom.every((item) => typeof item === 'string')
    ? (custom as readonly string[])
    : undefined
}

/**
 * The resolver export conditions of a Jest environment (`orchestrator.environmentConditions`),
 * which jest-runtime reads from the class's `exportConditions()`: the option
 * `customExportConditions` when the project gives it (`['']` for react-hook-form's, which names no
 * condition), else the default of the package Jest ships: `['browser']` for the jsdom family,
 * `['node', 'node-addons']` for `jest-environment-node`, `['edge', 'edge-light']` for the edge
 * runtime. A class this doesn't know has none, as jest-runtime's `?.() ?? []`; `node` is always
 * added (see below).
 * @public
 */
export const jestEnvironmentConditions: EnvironmentConditions = (env) => {
  const own = environmentOwnConditions(env)
  // jest-resolve resolves `exports` through resolve.exports, which adds `node` itself (recorded:
  // `env/conditions-custom`, where `['']` still picks the `node` variant).
  return own.includes('node') ? own : [...own, 'node']
}

function environmentOwnConditions(env: EnvironmentRequest): readonly string[] {
  const custom = customConditions(env.options)
  if (custom !== undefined) return custom
  const where = env.name
  if (where === 'node' || /jest-environment-node/.test(where)) return ['node', 'node-addons']
  if (/jsdom/.test(where)) return ['browser']
  if (/@edge-runtime[\\/]jest-environment/.test(where)) return ['edge', 'edge-light']
  return env.conditions ?? []
}

function tryResolve(from: NodeRequire, name: string): string | undefined {
  try {
    return from.resolve(name)
  } catch {
    return undefined
  }
}

/** Jest's `resolveWithPrefix` message for an environment that can't be found. */
function notFound(name: string): Error {
  return new Error(
    `Test environment ${name} cannot be found. Make sure the testEnvironment configuration option points to an existing node module.`,
  )
}

/**
 * The environment a test file's docblock names (`@jest-environment`), resolved as jest-runner's
 * `resolveTestEnvironment` does it for a project: from the project's root, `jsdom` and `node` as
 * their `jest-environment-*` packages, a name as a path or package, then with the
 * `jest-environment-` prefix. The options pragma is merged over the project's
 * `testEnvironmentOptions`. Every environment runs through the adapter (D44).
 * @public
 */
export const jestEnvironmentFor: EnvironmentResolver = (request) => {
  const alias =
    request.name === 'jsdom'
      ? 'jest-environment-jsdom'
      : request.name === 'node'
        ? 'jest-environment-node'
        : request.name
  const candidates = [alias, `jest-environment-${request.name}`]
  // From the project's root first. `jest-environment-node` and `-jsdom` belong to Jest's own
  // install, which pnpm doesn't hoist, so then from jest-config's place, as its `requireResolve` does.
  const fromRoot = createRequire(join(request.rootDir, '__provino_environment__.js'))
  const fromJest = projectJestRequireResolve(request.rootDir)
  let found: string | undefined
  for (const resolveFrom of [(name: string) => tryResolve(fromRoot, name), fromJest]) {
    for (const candidate of candidates) {
      found = resolveFrom(candidate)
      if (found !== undefined) break
    }
    if (found !== undefined) break
  }
  if (found === undefined) throw notFound(request.name)
  const base = request.base.options
  const baseConfig = isRecord(base.projectConfig) ? base.projectConfig : {}
  const baseOptions = isRecord(baseConfig.testEnvironmentOptions)
    ? baseConfig.testEnvironmentOptions
    : {}
  const docblock = isRecord(request.options) ? request.options : {}
  return {
    module: import.meta.resolve('@provino/dialect-jest/runtime'),
    export: 'jestEnvironment',
    options: {
      module: found,
      projectConfig: {
        rootDir: request.rootDir,
        cwd: request.rootDir,
        ...baseConfig,
        testEnvironment: found,
        testEnvironmentOptions: { ...baseOptions, ...docblock } as JsonValue,
      } as JsonValue,
    },
  }
}
