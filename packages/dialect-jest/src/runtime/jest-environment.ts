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
import { populateGlobal } from '@provino/env-shared'
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
  /** Bind the window's functions to it (happy-dom needs it; jsdom prefers it off). */
  readonly bindFunctions?: boolean
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

/**
 * Symbols a package a Jest environment loads defines on the global once per process and never
 * removes (graceful-fs's queue, undici's dispatchers). They are not a test's leak, and the next
 * file's baseline holds them.
 */
function isProcessSingleton(key: string | symbol): boolean {
  return typeof key === 'symbol' && /^(graceful-fs\.queue|undici\.)/.test(key.description ?? '')
}

/** Whether two property descriptors describe the same property, as a restore needs to know. */
function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return (
    a.configurable === b.configurable &&
    a.enumerable === b.enumerable &&
    a.writable === b.writable &&
    Object.is(a.value, b.value) &&
    a.get === b.get &&
    a.set === b.set
  )
}

/**
 * Puts the worker's global back to `baseline` (every own key's descriptor, read before the
 * environment was built): a key the file or the class added is deleted, one that is gone or that
 * a test replaced (`fetch`, `setTimeout`, `Date`, ...) is defined again. Jest's fresh vm context
 * per file makes this unnecessary there; the worker's own global is shared by every file. A key
 * that can't be put back is returned, for the warning (D22). The same comparison `@provino/env-node`
 * makes on its restore, kept here because this package has no edge to it.
 */
function restoreBaseline(baseline: ReadonlyMap<string | symbol, PropertyDescriptor>): string[] {
  const failed: string[] = []
  for (const key of Reflect.ownKeys(globalThis)) {
    if (baseline.has(key)) continue
    try {
      if (!Reflect.deleteProperty(globalThis, key) && !isProcessSingleton(key)) {
        failed.push(String(key))
      }
    } catch {
      if (!isProcessSingleton(key)) failed.push(String(key))
    }
  }
  for (const [key, descriptor] of baseline) {
    const now = Object.getOwnPropertyDescriptor(globalThis, key)
    if (now !== undefined && sameDescriptor(now, descriptor)) continue
    try {
      Object.defineProperty(globalThis, key, descriptor)
    } catch {
      failed.push(String(key))
    }
  }
  return failed
}

async function setUpJest(
  context: EnvironmentSetupContext<{ readonly [key: string]: JsonValue }>,
  EnvironmentClass: JestEnvironmentClass,
  projectConfig: object,
  bindFunctions: boolean,
): Promise<EnvironmentInstance> {
  // Read every descriptor first: V8 backs some Node globals (undici's) with lazy properties whose
  // first read adds non-configurable symbols, which would otherwise look like a leak (env-node).
  for (const key of Reflect.ownKeys(globalThis)) Object.getOwnPropertyDescriptor(globalThis, key)
  const baseline = new Map<string | symbol, PropertyDescriptor>()
  for (const key of Reflect.ownKeys(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    if (descriptor !== undefined) baseline.set(key, descriptor)
  }
  const environment = new EnvironmentClass(
    { globalConfig: {}, projectConfig },
    { console: context.console, docblockPragmas: context.pragmas, testPath: context.testPath },
  )
  let populated: ReturnType<typeof populateGlobal> | undefined
  try {
    await environment.setup()
    // Only a window stands in for the global: a Node or edge environment's code must not see one.
    const isWindow = 'document' in environment.global
    populated = populateGlobal(globalThis, environment.global, {
      bindFunctions,
      selfReferences: isWindow,
    })
  } catch (error) {
    // Jest tears the environment down even when its setup threw: its window, timers and
    // half-defined accessors must not outlive the failed file.
    populated?.restore()
    try {
      await environment.teardown()
    } catch {
      // The setup's error is the one the file fails with.
    }
    restoreBaseline(baseline)
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
      // baseline is put right too; a key that can't be is a warning (D22).
      installed.restore()
      const leaked = restoreBaseline(baseline)
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
    return setUpJest(
      context,
      prepared as JestEnvironmentClass,
      options.projectConfig,
      options.bindFunctions === true,
    )
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
    setup: (context) => setUpJest(context, EnvironmentClass, projectConfig, false),
  }
}

/** `customExportConditions` from `testEnvironmentOptions`, as the classes read it (an array of strings). */
function customConditions(options: EnvironmentRequest['options']): readonly string[] | undefined {
  const config = options?.projectConfig
  const own =
    isRecord(config) && isRecord(config.testEnvironmentOptions)
      ? config.testEnvironmentOptions
      : options
  const custom = own?.customExportConditions
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

/**
 * A `require.resolve` from where Jest's own packages live: the project's `jest`, then `jest-cli`,
 * then `jest-config` (each found from the one before, which works under pnpm). `undefined` when
 * the project has no Jest.
 */
function jestRequire(from: NodeRequire): (name: string) => string | undefined {
  return (name) => {
    try {
      const jest = createRequire(from.resolve('jest/package.json'))
      const cli = createRequire(jest.resolve('jest-cli/package.json'))
      const config = createRequire(cli.resolve('jest-config/package.json'))
      return config.resolve(name)
    } catch {
      return undefined
    }
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
  const from = createRequire(join(request.rootDir, '__provino_environment__.js'))
  const fromJest = jestRequire(from)
  const alias =
    request.name === 'jsdom'
      ? 'jest-environment-jsdom'
      : request.name === 'node'
        ? 'jest-environment-node'
        : request.name
  let found: string | undefined
  for (const candidate of [alias, `jest-environment-${request.name}`]) {
    try {
      found = from.resolve(candidate)
      break
    } catch {
      // try the next one
    }
  }
  // `jest-environment-node` and `-jsdom` belong to Jest's own install, which pnpm doesn't hoist:
  // look from jest-config's place, as jest-config's `requireResolve` does.
  for (const candidate of found === undefined ? [alias, `jest-environment-${request.name}`] : []) {
    found ??= fromJest(candidate)
  }
  if (found === undefined) throw notFound(request.name)
  const base = request.base.options
  const baseConfig = isRecord(base.projectConfig) ? base.projectConfig : {}
  // A built-in environment's options are the `testEnvironmentOptions` themselves.
  const baseOptions = isRecord(baseConfig.testEnvironmentOptions)
    ? baseConfig.testEnvironmentOptions
    : isRecord(base.projectConfig)
      ? {}
      : base
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
