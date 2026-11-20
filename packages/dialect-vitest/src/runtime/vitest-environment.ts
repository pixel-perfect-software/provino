// T8.6: Vitest environments under the Vitest dialect. A project's or a docblock's `environment`
// becomes an `EnvironmentRef` (`vitestEnvironmentRef`, and `vitestEnvironmentFor`, the dialect's
// `environmentResolver`): `node` is `@provino/env-node`; `jsdom` is `@provino/env-jsdom` over the
// project's own `jsdom` (D177, speed); `happy-dom` and `edge-runtime` are Vitest 5.0.5's built-in
// setups, vendored (`vendor/vitest-env/`), over the project's own library (compat; the faster
// option, a Provino happy-dom environment prepared once per worker, is not built); any other name is
// a `vitest-environment-<name>` package or a path, run through `vitestEnvironment`, the adapter for
// Vitest's `{ name, viteEnvironment, setup }` object. Realm `worker` only: `setupVM` needs T2.8.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type JsdomEnvironmentOptions, jsdomEnvironment } from '@provino/env-jsdom'
import { leakReport, populateGlobal, snapshotProperties, WINDOW_KEYS } from '@provino/env-shared'
import { createResolver } from '@provino/resolver'
import type {
  Environment,
  EnvironmentInstance,
  EnvironmentRef,
  EnvironmentResolver,
  EnvironmentSetupContext,
  EnvironmentTeardownReport,
  GlobalReadWatch,
  JsonValue,
} from '@provino/types'
import { environmentOptionsKey } from '../internal/environment-options-key.ts'
import { VitestDialectError } from './errors.ts'
import { edgeRuntimeEnvironment } from './vendor/vitest-env/edge-runtime.ts'
import { happyDomEnvironment } from './vendor/vitest-env/happy-dom.ts'
import type { SetupDeps } from './vendor/vitest-env/types.ts'

type JsonObject = { readonly [key: string]: JsonValue }

/** What `setup` returns: its `teardown(global)`, as Vitest's environments return it. @public */
export interface VitestEnvironmentReturn {
  teardown(global: typeof globalThis): unknown
}

/**
 * A Vitest environment object (`vitest/environments`' `Environment`), the members Provino runs.
 * @public
 */
export interface VitestEnvironmentLike {
  readonly name: string
  readonly viteEnvironment?: string
  readonly transformMode?: string
  /** Realm `context` (T2.8): refused. */
  readonly setupVM?: unknown
  setup?(
    global: typeof globalThis,
    options: Record<string, unknown>,
  ): VitestEnvironmentReturn | Promise<VitestEnvironmentReturn>
}

/**
 * What `vitestEnvironment` is given (JSON, so it crosses to a worker).
 * @public
 */
export interface VitestEnvironmentOptions {
  readonly [key: string]: JsonValue
  /** The name the project or the docblock gave. */
  readonly name: string
  /** Where the project's own libraries resolve from. */
  readonly rootDir: string
  /** A built-in setup (`happy-dom`, `edge-runtime`), else `module`. */
  readonly builtin?: 'happy-dom' | 'edge-runtime'
  /** The environment package's entry or the path, absolute. */
  readonly module?: string
  /** What `setup(global, options)` gets: Vitest's whole `environmentOptions` object. */
  readonly environmentOptions: JsonObject
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rootRequire(rootDir: string): NodeJS.Require {
  return createRequire(join(rootDir, '__provino_environment__.js'))
}

/** The project's own copy of a library, else `undefined`. */
function resolveFromRoot(rootDir: string, name: string): string | undefined {
  try {
    return rootRequire(rootDir).resolve(name)
  } catch {
    return undefined
  }
}

/**
 * Where an environment package resolves from the root as an `import` does (`import` and `node`
 * conditions), as Vitest 5.0.5's `loadNativeEnvironment` resolves it with `import.meta.resolve`
 * (`integrations/env/loader.ts` L68): an ES-module-only package is found, and a dual one gives its
 * ES module build. Node's `require` conditions would miss the first and load the second's CommonJS
 * build, whose namespace has the environment one level down.
 */
function resolveEnvironmentPackage(rootDir: string, name: string): string | undefined {
  const resolver = createResolver({
    root: rootDir,
    mappers: [],
    extensions: ['.js', '.mjs', '.cjs', '.json'],
  })
  const found = resolver.resolve(name, {
    importer: join(rootDir, '__provino_environment__.js'),
    kind: 'import',
    conditions: ['node'],
  })
  return found.type === 'file' ? found.path : undefined
}

/** Imports the project's own copy of an environment's library. */
function projectLoader(rootDir: string): SetupDeps['load'] {
  return async (name) => {
    const found = resolveFromRoot(rootDir, name)
    if (found === undefined) {
      throw new VitestDialectError(
        'VITEST_ENVIRONMENT_NOT_INSTALLED',
        `The ${name} environment needs the '${name}' package: install it as a dev dependency of the project.`,
      )
    }
    return import(pathToFileURL(found).href)
  }
}

function builtinSetup(name: 'happy-dom' | 'edge-runtime', rootDir: string): VitestEnvironmentLike {
  const deps: SetupDeps = {
    populateGlobal: (global, win, options) =>
      populateGlobal(global as object, win as object, {
        ...(options?.bindFunctions === undefined ? {} : { bindFunctions: options.bindFunctions }),
        ...(options?.additionalKeys === undefined
          ? {}
          : { additionalKeys: options.additionalKeys }),
      }),
    KEYS: WINDOW_KEYS,
    load: projectLoader(rootDir),
  }
  const made = name === 'happy-dom' ? happyDomEnvironment(deps) : edgeRuntimeEnvironment(deps)
  return made as VitestEnvironmentLike
}

/**
 * Checks a loaded environment module as Vitest 5.0.5's `resolveEnvironmentFromModule` does
 * (`packages/vitest/src/integrations/env/loader.ts` L82-L111), with its texts and its warning.
 */
function environmentOf(name: string, packageId: string, namespace: unknown): VitestEnvironmentLike {
  const pkg = isRecord(namespace) ? namespace : undefined
  const environment = pkg?.default
  if (!isRecord(environment)) {
    // loader.ts L88-L91
    throw new TypeError(
      `Environment "${name}" is not a valid environment. ` +
        `Path "${packageId}" should export default object with a "setup" or/and "setupVM" method.`,
    )
  }
  const mode = environment.transformMode
  if (mode != null && mode !== 'web' && mode !== 'ssr') {
    // loader.ts L98-L101
    throw new TypeError(
      `Environment "${name}" is not a valid environment. ` +
        `Path "${packageId}" should export default object with a "transformMode" method equal to "ssr" or "web", received "${String(mode)}".`,
    )
  }
  if (mode != null) {
    // loader.ts L104-L106
    console.warn(
      `The Vitest environment ${String(environment.name)} defines the "transformMode". This options was deprecated in Vitest 4 and will be removed in the next major version. Please, use "viteEnvironment" instead.`,
    )
  }
  return environment as unknown as VitestEnvironmentLike
}

function optionsOf(value: unknown): VitestEnvironmentOptions {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.rootDir !== 'string' ||
    !isRecord(value.environmentOptions) ||
    (value.builtin === undefined && typeof value.module !== 'string')
  ) {
    throw new TypeError(
      'The Vitest environment adapter needs { name, rootDir, environmentOptions } and a builtin or a module as options.',
    )
  }
  return value as VitestEnvironmentOptions
}

async function setUpVitest(
  environment: VitestEnvironmentLike,
  options: Record<string, unknown>,
): Promise<EnvironmentInstance> {
  if (typeof environment.setup !== 'function') {
    throw new VitestDialectError(
      'VITEST_ENVIRONMENT_SETUP_VM',
      `The Vitest environment "${environment.name}" has no "setup", only "setupVM", which needs the realm isolation tier (T2.8, not built).`,
    )
  }
  // The worker's global is shared by every file, so it is put back as `nodeEnvironment` does
  // (D71), whatever the environment's own teardown leaves (Vitest gives each file a fresh worker).
  const snapshot = snapshotProperties(globalThis)
  let returned: VitestEnvironmentReturn & { readonly populated?: unknown }
  try {
    const value: unknown = await environment.setup(globalThis, options)
    if (!isRecord(value) || typeof value.teardown !== 'function') {
      throw new VitestDialectError(
        'VITEST_ENVIRONMENT_BAD_SETUP',
        `The Vitest environment "${environment.name}" setup must return an object with a "teardown" method.`,
      )
    }
    returned = value as unknown as VitestEnvironmentReturn & { readonly populated?: unknown }
  } catch (error) {
    snapshot.restore()
    throw error
  }
  const reads = returned.populated as GlobalReadWatch | undefined
  return {
    global: globalThis,
    ...(reads === undefined ? {} : { globalReads: reads }),
    async teardown(): Promise<EnvironmentTeardownReport | undefined> {
      let failure: { readonly error: unknown } | undefined
      try {
        await returned.teardown(globalThis)
      } catch (error) {
        failure = { error }
      }
      // Whatever the environment threw, the global goes back for the next file.
      const leaked = snapshot.restore()
      if (failure !== undefined) throw failure.error
      return leakReport(leaked)
    },
  }
}

/**
 * Runs a Vitest environment (a built-in setup, a `vitest-environment-<name>` package or a path):
 * `prepare` loads it once per worker; `setup` calls its `setup(globalThis, environmentOptions)`
 * once per file and puts the worker's global back after its `teardown`.
 * @public
 */
export const vitestEnvironment: Environment<'vitest-environment', VitestEnvironmentOptions> = {
  name: 'vitest-environment',
  realms: ['worker'],
  async prepare(options) {
    const { name, rootDir, builtin, module } = optionsOf(options)
    if (builtin !== undefined) return builtinSetup(builtin, rootDir)
    const path = module as string
    return environmentOf(name, path, await import(pathToFileURL(path).href))
  },
  setup(context, prepared) {
    const options = optionsOf(context.options)
    return setUpVitest(prepared as VitestEnvironmentLike, options.environmentOptions)
  },
}

/**
 * An `Environment` over a Vitest environment object you already hold (`{ name, viteEnvironment,
 * setup }`); `options` is what its `setup` gets. Realm `worker` only.
 * @public
 */
export function fromVitestEnvironment(
  environment: VitestEnvironmentLike,
  options: Record<string, unknown> = {},
): Environment<'vitest-environment', JsonObject> {
  return {
    name: 'vitest-environment',
    realms: ['worker'],
    setup: () => setUpVitest(environment, options),
  }
}

/** What `vitestJsdomEnvironment` is given: Vitest's `environmentOptions.jsdom` and the project's root. */
type JsdomAdapterOptions = JsonObject & { readonly rootDir?: string }

/**
 * Vitest's `environmentOptions.jsdom` as env-jsdom's options (compat): Vitest 5.0.5's
 * `integrations/env/jsdom.ts` reads `html`, `userAgent`, `url` and `pretendToBeVisual` (env-jsdom's
 * own keys), `contentType`, `includeNodeLocations`, `runScripts`, `resources`, `console` and
 * `cookieJar`, and spreads the rest into the `JSDOM` constructor, so everything but env-jsdom's
 * keys goes into its `jsdom` bag, which goes last. `cookieJar: true` is a `CookieJar` of the
 * project's jsdom (jsdom makes a fresh one of its own without it, so a missing class is the same
 * jar). `console` is no constructor option: Vitest forwards the virtual console to the console
 * with it and jsdom's default does so without it, as env-jsdom always does.
 */
function jsdomOptionsOf(options: JsdomAdapterOptions, prepared: unknown): JsdomEnvironmentOptions {
  const {
    rootDir: _rootDir,
    html,
    url,
    userAgent,
    pretendToBeVisual,
    customExportConditions,
    console: _console,
    cookieJar,
    ...rest
  } = options
  const CookieJar =
    isRecord(prepared) && typeof prepared.CookieJar === 'function'
      ? (prepared.CookieJar as new () => object)
      : undefined
  return {
    ...(typeof html === 'string' ? { html } : {}),
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
    ...(typeof pretendToBeVisual === 'boolean' ? { pretendToBeVisual } : {}),
    ...(Array.isArray(customExportConditions)
      ? { customExportConditions: customExportConditions.filter((c) => typeof c === 'string') }
      : {}),
    jsdom: { ...rest, ...(cookieJar && CookieJar ? { cookieJar: new CookieJar() } : {}) },
  }
}

/**
 * `@provino/env-jsdom` over the project's own `jsdom` (D177): `prepare` imports the copy the
 * project's root resolves, else env-jsdom's own peer.
 * @public
 */
export const vitestJsdomEnvironment: Environment<'jsdom', JsdomAdapterOptions> = {
  name: 'jsdom',
  realms: ['worker'],
  async prepare(options) {
    const rootDir = typeof options.rootDir === 'string' ? options.rootDir : undefined
    const found = rootDir === undefined ? undefined : resolveFromRoot(rootDir, 'jsdom')
    if (found === undefined) return jsdomEnvironment.prepare?.({})
    const jsdom = (await import(pathToFileURL(found).href)) as Record<string, unknown>
    return {
      JSDOM: jsdom.JSDOM,
      VirtualConsole: jsdom.VirtualConsole,
      CookieJar: jsdom.CookieJar,
      ...(typeof jsdom.ResourceLoader === 'function'
        ? { ResourceLoader: jsdom.ResourceLoader }
        : {}),
    }
  },
  setup(context, prepared) {
    return jsdomEnvironment.setup(
      {
        ...context,
        options: jsdomOptionsOf(context.options, prepared),
      } as EnvironmentSetupContext<never>,
      prepared,
    )
  },
}

const RUNTIME = import.meta.resolve('@provino/dialect-vitest/runtime')

/** Vitest's `isBuiltinEnvironment` names. */
const BUILTINS = new Set(['node', 'jsdom', 'happy-dom', 'edge-runtime'])

/** Vitest's `Environment "<name>" cannot be found`-shaped error for a package that isn't there. */
function notFound(name: string, rootDir: string): Error {
  return new VitestDialectError(
    'VITEST_ENVIRONMENT_NOT_FOUND',
    `Cannot find package 'vitest-environment-${name}' imported from ${rootDir}: the environment "${name}" is neither built in nor installed.`,
  )
}

/**
 * The `EnvironmentRef` of a Vitest environment name, as Vitest 5.0.5's `loadEnvironment` finds it:
 * a built-in name, then a path (`.` or `/` first, against the root), then the package
 * `vitest-environment-<name>` from the root. `environmentOptions` is the whole object Vitest hands
 * `setup`; the built-ins read their own key of it (`jsdom`, `happyDOM`).
 * @public
 */
export function vitestEnvironmentRef(
  name: string,
  environmentOptions: JsonObject,
  rootDir: string,
): EnvironmentRef {
  if (name === 'node') {
    return {
      module: import.meta.resolve('@provino/env-node'),
      export: 'nodeEnvironment',
      options: {},
    }
  }
  if (name === 'jsdom') {
    const own = environmentOptions.jsdom
    return {
      module: RUNTIME,
      export: 'vitestJsdomEnvironment',
      options: { ...(isRecord(own) ? (own as JsonObject) : {}), rootDir },
    }
  }
  const base = { name, rootDir, environmentOptions }
  if (BUILTINS.has(name)) {
    return {
      module: RUNTIME,
      export: 'vitestEnvironment',
      options: { ...base, builtin: name as 'happy-dom' | 'edge-runtime' },
    }
  }
  const module =
    name[0] === '.' || name[0] === '/'
      ? resolve(rootDir, name)
      : resolveEnvironmentPackage(rootDir, `vitest-environment-${name}`)
  if (module === undefined) throw notFound(name, rootDir)
  return { module: RUNTIME, export: 'vitestEnvironment', options: { ...base, module } }
}

/**
 * The environment a file's `@vitest-environment` or `@jest-environment` docblock names (the
 * dialect's `environmentResolver`). The `-options` docblock **replaces** the project's options
 * for the file, as Vitest 5.0.5's `getSpecificationDocblock` does (`{ [envKey]: options }`,
 * `utils/test-helpers.ts` L47-L54); without one the file gets the project's options when it
 * names the project's own environment, else none (a limit: the worker holds only the project
 * environment's own options, not the whole `environmentOptions`).
 * @public
 */
export const vitestEnvironmentFor: EnvironmentResolver = (request) => {
  const docblock = isRecord(request.options) ? (request.options as JsonObject) : undefined
  const environmentOptions: JsonObject =
    docblock !== undefined
      ? { [environmentOptionsKey(request.name)]: docblock }
      : sameEnvironment(request.base, request.name)
        ? baseOptions(request.base, request.name)
        : {}
  return vitestEnvironmentRef(request.name, environmentOptions, request.rootDir)
}

/** Whether the project's own environment ref is the one `name` gives. */
function sameEnvironment(base: EnvironmentRef, name: string): boolean {
  const options = base.options
  if (name === 'node') return base.export === 'nodeEnvironment'
  if (name === 'jsdom')
    return base.export === 'vitestJsdomEnvironment' || base.export === 'jsdomEnvironment'
  return options.name === name
}

/** The project's options as the whole `environmentOptions` object an environment reads. */
function baseOptions(base: EnvironmentRef, name: string): JsonObject {
  const options = base.options
  if (isRecord(options.environmentOptions)) return options.environmentOptions as JsonObject
  const { rootDir: _rootDir, ...own } = options
  return { [environmentOptionsKey(name)]: own }
}
