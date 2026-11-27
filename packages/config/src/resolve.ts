import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  callBehaviour,
  createBehaviourLoader,
  nativeSnapshotPolicy,
  resolvePolicy,
  serializePolicy,
} from '@provino/policy'
import type {
  ConfigResolve,
  ConfigTimeouts,
  Dialect,
  EnvironmentRef,
  IsolationTier,
  JsonValue,
  ModuleRef,
  NativeRuntimeRefs,
  NeutralAlias,
  NeutralDiscovery,
  NeutralProject,
  NeutralResolution,
  Policy,
  PolicyOverrides,
  ProvinoConfigInput,
  SerializedCoverageConfig,
  SerializedLoaderConfig,
  SerializedModuleMapper,
  SerializedProjectConfig,
  SerializedTransformConfig,
  TransformClaims,
} from '@provino/types'
import { ConfigError } from './errors.ts'
import { dialectPolicy, dialectsFor, loadOnce, selectDialect } from './internal/dialect.ts'
import { describe, isStringArray, messageOf, parseInput } from './internal/input.ts'
import { assertNativeRefs, assertWorkerConfig } from './internal/refs.ts'
import { resolveSetupFiles } from './internal/setup-files.ts'
import { resolveTransformClaims, resolveTransforms } from './internal/transform.ts'

/**
 * What `resolveProject` needs besides the config itself. The dialects and environments come from
 * the caller (`provino`), so this package names no dialect and no environment package.
 * @public
 */
export interface ResolveProjectOptions {
  /** The config file's absolute path: `root` and the default `rootDir` are relative to its directory. */
  readonly configPath: string
  /** The dialects a project may name or have detected. A config's own `dialects` replaces them. */
  readonly dialects: readonly Dialect[]
  /**
   * More dialects, loaded only when a config needs one `dialects` lacks (B27e): it names a
   * `dialect` that isn't there, or has a key no project reads (a dialect's options key). A config
   * that needs none never calls it, so the caller can keep a dialect's code unloaded until a
   * project names it (`provino` passes its built-ins here). What it gives joins `dialects` for
   * that config's names (a name already there keeps the `dialects` entry), but never for
   * detection: a dialect with `detect` that only this gives is used only when named.
   * `resolveProjects` calls it at most once. A throw, a rejection or a result that isn't an array
   * is `CONFIG_LOAD_FAILED`, the same error for each project that needed it.
   */
  readonly loadDialects?: () => Promise<readonly Dialect[]>
  /** Each environment by name, as an absolute ref the worker can import. */
  readonly environments: Readonly<
    Record<string, { readonly module: string; readonly export: string }>
  >
  /** Whether this is a CI run (`allowOnly: 'not-in-ci'`). */
  readonly ci: boolean
  /**
   * The native runtime (D186): the matcher table, served modules and globals a project with no
   * dialect gets, as absolute refs from the caller (`provino`). Ignored when a dialect is selected;
   * absent, a project with no dialect has none (the neutral `matcherTable: null`).
   */
  readonly native?: NativeRuntimeRefs
}

/**
 * A project's worker config before the run gives it a seed: a Jest or Vitest config reader brings
 * its own, a `provino.config.*` project none, and one run shares a single seed across its projects.
 * @public
 */
export type UnseededProjectConfig = Omit<SerializedProjectConfig, 'seed'> & {
  readonly seed?: number
}

/**
 * A project's global setup and teardown (T9.15): modules the coordinator imports and calls, as the
 * policy's `globalSetup.signature` says. Every path is absolute.
 * @public
 */
export interface ResolvedGlobalSetup {
  /** The setup modules, in the order they run. */
  readonly setup: readonly string[]
  /** The teardown modules. */
  readonly teardown: readonly string[]
  /**
   * What the function is called with under the `global-and-project-config` signature (Jest's two
   * configs, as the reader built them: they stay in the coordinator, so they are not JSON); absent
   * for a project whose dialect passes none.
   */
  readonly args?: NeutralProject['globalSetupArgs']
}

/**
 * A project, resolved: the choices config and policy made, and the config its workers get.
 * @public
 */
export interface ResolvedProject {
  /** `''` when config gives none. */
  readonly name: string
  /** The project root, an absolute path. */
  readonly rootDir: string
  /** The selected dialect, or `null` for the neutral one. */
  readonly dialect: Dialect | null
  /** The dialect's policy with the project's own keys layered on (`include`, `exclude`, `globals`). */
  readonly policy: Policy
  /** The globs that find test files, relative to `rootDir`. */
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  /**
   * A dialect reader's discovery rules (roots, patterns on absolute paths, extensions), or `null`
   * for a `provino.config.*` project, which finds tests by `include` and `exclude`. Carried for
   * discovery to read (B14c); today's discovery uses `include` and `exclude`.
   */
  readonly discovery: NeutralDiscovery | null
  /** The environment's name: `WorkerKey.environment`. */
  readonly environment: string
  readonly isolation: IsolationTier
  /** What each worker is started with, but for the run's seed (`withSeed`). */
  readonly config: UnseededProjectConfig
  /** The cache directory the project's config sets itself (D70), or absent for the default. */
  readonly cacheDirectory?: string
  /** Global setup and teardown the coordinator runs for this project (T9.15); absent for none. */
  readonly globalSetup?: ResolvedGlobalSetup
  /**
   * What affected-test selection reads of the project itself (T9.12, T9.16): its own dependency
   * extractor (Jest's `dependencyExtractor`); absent when it names none.
   */
  readonly affected?: { readonly extractor: ModuleRef }
}

/**
 * The extensions a specifier without one is tried with, in order: Jest's `moduleFileExtensions`
 * without `.node`. A neutral default of ours.
 */
const LOADER_EXTENSIONS: readonly string[] = [
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.json',
]

/** `rootDir` must be a directory that exists, whether or not a dialect detects. */
async function assertDirectory(rootDir: string): Promise<void> {
  let isDirectory = false
  try {
    isDirectory = (await stat(rootDir)).isDirectory()
  } catch {
    // Missing or unreadable: reported below.
  }
  if (!isDirectory) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `config key "root" must be an existing directory ("${rootDir}" is not)`,
    )
  }
}

/**
 * Awaits two independent promises together. If both fail, `first`'s error is thrown, as it would
 * be had `first` been awaited alone before `second` started; `second`'s is never left unhandled.
 */
async function inParallel<First, Second>(
  first: Promise<First>,
  second: Promise<Second>,
): Promise<[First, Second]> {
  const [a, b] = await Promise.allSettled([first, second])
  if (a.status === 'rejected') throw a.reason
  if (b.status === 'rejected') throw b.reason
  return [a.value, b.value]
}

/** A record's own entry for a name from config (`constructor` is not an entry). */
function entry<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** The project's own keys, as the policy layer that goes over the dialect's. */
function projectLayer(
  include: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
  globals: boolean | undefined,
  timeouts: ConfigTimeouts | undefined,
): PolicyOverrides {
  const orchestrator = {
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
  }
  const core = {
    ...(globals === undefined ? {} : { injectGlobals: globals }),
    ...(timeouts === undefined || Object.keys(timeouts).length === 0 ? {} : { timeouts }),
  }
  return {
    ...(Object.keys(orchestrator).length === 0 ? {} : { orchestrator }),
    ...(Object.keys(core).length === 0 ? {} : { core }),
  }
}

/** A string as a regular expression's source that matches only it. */
function escapeText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `resolve.aliases` as the loader's name-mapping rules, in the order given, with tsconfig `paths`'
 * wildcard: one `*` anywhere in the key is what the specifier has there, and the one `*` in the
 * target (which the key then needs) is that text (`'@/*': './src/*'` maps `@/a/b` to
 * `<root>/src/a/b`). A key without `*` matches only itself. The targets are absolute, against the
 * project root. More than one `*`, or one in the target alone, is `CONFIG_INVALID`.
 */
function aliasesOf(
  aliases: Readonly<Record<string, string>> | undefined,
  rootDir: string,
): readonly NeutralAlias[] {
  return Object.entries(aliases ?? {}).map(([from, to]) => {
    const fromParts = from.split('*')
    const toParts = to.split('*')
    if (
      fromParts.length > 2 ||
      toParts.length > 2 ||
      (toParts.length === 2 && fromParts.length === 1)
    ) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `config key "resolve.aliases" has ${JSON.stringify(from)}: ${JSON.stringify(to)}; a key and its target take one "*" each, or the key alone`,
      )
    }
    const [before = '', after = ''] = fromParts
    const pattern =
      fromParts.length === 1
        ? `^${escapeText(from)}$`
        : `^${escapeText(before)}(.*)${escapeText(after)}$`
    // The wildcard goes through `resolve` as a character no path holds, then becomes the capture.
    const target = resolve(rootDir, to.replace('*', '\0')).replace('\0', () => '$1')
    return { pattern, targets: [target] }
  })
}

/** `resolve.tsconfig` as `SerializedLoaderConfig.tsconfig`: a path is made absolute against the root. */
function tsconfigOf(
  tsconfig: ConfigResolve['tsconfig'],
  rootDir: string,
): SerializedLoaderConfig['tsconfig'] {
  if (tsconfig === undefined || tsconfig === 'auto' || tsconfig === false) return tsconfig ?? 'auto'
  return resolve(rootDir, tsconfig)
}

/**
 * The resolver export conditions for the environment: the policy's `environmentConditions`
 * behaviour, loaded and called here in the coordinator. It only knows the environment's name,
 * not the `conditions` its `Environment` declares (that object lives in the worker).
 */
async function loaderConditions(
  policy: Policy,
  environment: string,
  options: EnvironmentRef['options'],
): Promise<readonly string[]> {
  const behaviour = policy.orchestrator.environmentConditions
  let conditions: unknown
  try {
    conditions = await callBehaviour(createBehaviourLoader(), behaviour, {
      name: environment,
      options,
    })
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_LOAD_FAILED',
      `can't get the resolver conditions for the "${environment}" environment from the policy's orchestrator.environmentConditions`,
      { cause },
    )
  }
  if (!isStringArray(conditions)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the policy's orchestrator.environmentConditions must return an array of strings (got ${describe(conditions)})`,
    )
  }
  return conditions
}

/**
 * Resolves one project's config: its root, dialect, policy, globs, environment and isolation, and
 * the `SerializedProjectConfig` its workers start with. Every failure is a `ConfigError`.
 *
 * - The dialect is the one `dialect` names, else the best `detect` score (a tie is an error),
 *   else none: the neutral policy, no globals.
 * - The config's `include`, `exclude` and `globals` are layered over the dialect's policy, so the
 *   policy a worker gets agrees with them.
 * - The environment is the config's, else the policy's `envDefault`; it must be in `environments`.
 * - Isolation is the config's, else the policy's default for that environment.
 * - The neutral `setupFiles` become the worker's `setupFilesAfterEnv`, as Vitest's `setupFiles`
 *   do, resolved against `rootDir`.
 * @public
 */
export async function resolveProject(
  input: ProvinoConfigInput,
  options: ResolveProjectOptions,
): Promise<ResolvedProject> {
  return resolveProjectInput(input, options, true)
}

/**
 * `resolveProject`, for a config that is the whole run's (`topLevel`) or one project of a
 * `projects` list, which takes no key that belongs to the whole run.
 * @internal
 */
export async function resolveProjectInput(
  input: ProvinoConfigInput,
  options: ResolveProjectOptions,
  topLevel: boolean,
): Promise<ResolvedProject> {
  if (!isAbsolute(options.configPath)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the config path must be absolute (got "${options.configPath}")`,
    )
  }
  const dialects = await dialectsFor(
    input,
    options.dialects,
    loadOnce(options.loadDialects),
    topLevel,
  )
  const parsed = parseInput(input, dialects, topLevel)
  if (parsed.projects !== undefined && parsed.projects.length > 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'config key "projects" holds several projects: resolve it with resolveProjects',
    )
  }
  const rootDir = resolve(dirname(options.configPath), parsed.root ?? '.')
  // The root check and `detect`'s read of the root are independent; a bad root is reported first.
  const [, dialect] = await inParallel(
    assertDirectory(rootDir),
    selectDialect(
      parsed.dialect,
      parsed.dialects ?? dialects,
      rootDir,
      // Detection reads the eager dialects only: one only `loadDialects` gave is named, never guessed.
      parsed.dialects ?? options.dialects,
    ),
  )
  const dialectLayer =
    dialect === null
      ? undefined
      : await dialectPolicy(
          dialect,
          Object.hasOwn(input, dialect.name) ? Reflect.get(input, dialect.name) : undefined,
        )
  return finishProject(
    {
      name: parsed.name ?? '',
      rootDir,
      dialect,
      layers: [
        dialectLayer,
        projectLayer(parsed.include, parsed.exclude, parsed.globals, parsed.timeouts),
      ],
      environment: parsed.environment,
      environmentOptions: parsed.environmentOptions ?? {},
      isolation: parsed.isolation,
      setupFiles: [],
      setupFilesAfterEnv: parsed.setupFiles ?? [],
      setupFilesAfterEnvKey: 'setupFiles',
      discovery: null,
      aliases: aliasesOf(parsed.resolve?.aliases, rootDir),
      extraConditions: parsed.resolve?.conditions ?? [],
      tsconfig: tsconfigOf(parsed.resolve?.tsconfig, rootDir),
      define: parsed.define,
    },
    options,
  )
}

/**
 * What `resolveNeutralProject` needs besides the project: the dialect its reader belongs to (the
 * caller has it already), the environments, and whether this is a CI run.
 * @public
 */
export interface ResolveNeutralProjectOptions {
  /** The dialect whose config reader produced the project, or `null` for neutral. */
  readonly dialect: Dialect | null
  /** Each environment by name, as an absolute ref the worker can import. */
  readonly environments: ResolveProjectOptions['environments']
  readonly ci: boolean
  /** The native runtime, as `ResolveProjectOptions.native`: used only when `dialect` is `null`. */
  readonly native?: NativeRuntimeRefs
}

/**
 * Resolves a project a dialect's config reader produced (`ConfigReader.toNeutral`): the dialect's
 * policy with the project's own layered over it, its environment and isolation, and the
 * `SerializedProjectConfig` its workers start with. The same steps as `resolveProject` after
 * reading a `provino.config.*`. Its `setupFiles` stay the worker's `setupFiles` (run before the
 * framework) and its `setupFilesAfterEnv` the worker's; each must be an absolute path to a file.
 * Every failure is a `ConfigError`.
 * @public
 */
export async function resolveNeutralProject(
  neutral: NeutralProject,
  options: ResolveNeutralProjectOptions,
): Promise<ResolvedProject> {
  if (!isAbsolute(neutral.rootDir)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the project's rootDir must be absolute (got "${neutral.rootDir}")`,
    )
  }
  await assertDirectory(neutral.rootDir)
  const dialectLayer =
    options.dialect === null ? undefined : await dialectPolicy(options.dialect, undefined)
  for (const [key, paths] of [
    ['setupFiles', neutral.setupFiles],
    ['setupFilesAfterEnv', neutral.setupFilesAfterEnv],
    ['globalSetup', neutral.globalSetup],
    ['globalTeardown', neutral.globalTeardown],
  ] as const) {
    const relative = paths.find((path) => !isAbsolute(path))
    if (relative !== undefined) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `the project's ${key} must hold absolute paths (got "${relative}")`,
      )
    }
  }
  return finishProject(
    {
      name: neutral.name,
      rootDir: neutral.rootDir,
      dialect: options.dialect,
      layers: [dialectLayer, neutral.policy],
      environment: neutral.environment.name,
      environmentOptions: neutral.environment.options,
      environmentResolverOptions: neutral.environment.resolverOptions,
      isolation: undefined,
      setupFiles: neutral.setupFiles,
      setupFilesAfterEnv: neutral.setupFilesAfterEnv,
      setupFilesAfterEnvKey: 'setupFilesAfterEnv',
      discovery: neutral.discovery,
      transform: resolveTransforms(neutral),
      transformClaims: resolveTransformClaims(neutral),
      cacheDirectory: neutral.cacheDirectory,
      globalSetup: globalSetupOf(neutral),
      affected: affectedOf(neutral),
      aliases: neutral.aliases,
      mappers: neutral.mappers,
      globalValues: neutral.globalValues,
      fakeTimers: neutral.fakeTimers,
      snapshotResolver: neutral.snapshotResolver,
      seed: neutral.seed,
      randomize: neutral.randomize,
      resolution: neutral.resolution,
      coverage: neutral.coverage,
    },
    {
      environments: options.environments,
      ci: options.ci,
      ...(options.native === undefined ? {} : { native: options.native }),
    },
  )
}

/**
 * The project's own affected-selection settings: its dependency extractor, or `undefined` when it
 * names none. `watchPathIgnorePatterns` stays on the neutral project (`watch`) for the watch
 * driver to carry (B23c Phase 8).
 */
function affectedOf(neutral: NeutralProject): ResolvedProject['affected'] {
  const extractor = neutral.affected?.extractor
  return extractor === undefined ? undefined : { extractor }
}

/**
 * The project's global hooks, or `undefined` when it has none and no args either: a project with
 * no hook of its own keeps the args when the run has one (Jest's root `globalSetup`), since that
 * hook is called with the config of the first project.
 */
function globalSetupOf(neutral: NeutralProject): ResolvedGlobalSetup | undefined {
  if (
    neutral.globalSetup.length === 0 &&
    neutral.globalTeardown.length === 0 &&
    neutral.globalSetupArgs === undefined
  ) {
    return undefined
  }
  return {
    setup: neutral.globalSetup,
    teardown: neutral.globalTeardown,
    ...(neutral.globalSetupArgs === undefined ? {} : { args: neutral.globalSetupArgs }),
  }
}

/** A project after its input is read: what `finishProject` builds the rest from. */
interface ProjectInput {
  readonly name: string
  readonly rootDir: string
  readonly dialect: Dialect | null
  /** The policy layers, lowest first (the dialect's, then the project's). */
  readonly layers: readonly (PolicyOverrides | undefined)[]
  readonly environment: string | undefined
  readonly environmentOptions: EnvironmentRef['options']
  /** The project's `EnvironmentRef.resolverOptions`, when its reader gives any. */
  readonly environmentResolverOptions?: EnvironmentRef['options'] | undefined
  readonly isolation: IsolationTier | undefined
  /** Worker `setupFiles` (absolute, or relative to `rootDir`). */
  readonly setupFiles: readonly string[]
  /** Worker `setupFilesAfterEnv` (absolute, relative to `rootDir`, or a `file:` URL). */
  readonly setupFilesAfterEnv: readonly string[]
  /** The config key `setupFilesAfterEnv` came from, for messages. */
  readonly setupFilesAfterEnvKey: string
  readonly discovery: NeutralDiscovery | null
  /** User transformers (T3.8); a neutral project's only, `undefined` for none. */
  readonly transform?: SerializedTransformConfig | undefined
  /** The files the transforms take, stand-ins included; a neutral project's only. */
  readonly transformClaims?: TransformClaims | undefined
  /** The cache directory the config sets itself (D70); a neutral project's only. */
  readonly cacheDirectory?: string | undefined
  /** Global setup and teardown (T9.15); a neutral project's only. */
  readonly globalSetup?: ResolvedGlobalSetup | undefined
  /** The project's own affected-selection settings (T9.16); a neutral project's only. */
  readonly affected?: ResolvedProject['affected'] | undefined
  /**
   * Name-mapping rules and resolver keys (T3.3); none for a `provino.config.*` project. So such a
   * project has no `esmExtensions` either: under a dialect whose `module.edgeResolveKind` is
   * `importer-format` (`dialect: 'jest'`), a `.ts` or `.tsx` file always resolves its edges as
   * CommonJS-run, even under `--experimental-vm-modules`, where `.mjs` and a `"type": "module"`
   * package's `.js` resolve as ES modules (Jest's `extensionsToTreatAsEsm` has no Provino key).
   */
  readonly aliases?: readonly NeutralAlias[] | undefined
  readonly mappers?: readonly SerializedModuleMapper[] | undefined
  readonly resolution?: NeutralResolution | undefined
  readonly globalValues?: Readonly<Record<string, JsonValue>> | undefined
  readonly fakeTimers?: Readonly<Record<string, JsonValue>> | undefined
  readonly seed?: number | undefined
  /** The project's own snapshot resolver module, absolute (Jest's `snapshotResolver`). */
  readonly snapshotResolver?: string | undefined
  /** Which files count toward coverage (B23b); a neutral project's only, `undefined` for off. */
  readonly coverage?: SerializedCoverageConfig | undefined
  readonly randomize?: true | undefined
  /** Export conditions `resolve.conditions` adds after the environment's (a `provino.config.*` project's only). */
  readonly extraConditions?: readonly string[] | undefined
  /** `loader.tsconfig`; `'auto'` when absent. */
  readonly tsconfig?: SerializedLoaderConfig['tsconfig'] | undefined
  /** `define`, as source text (a `provino.config.*` project's only). */
  readonly define?: SerializedLoaderConfig['define'] | undefined
}

/** `record`, or `undefined` when it has no keys: an empty one is no setting. */
function nonEmpty<T extends object>(record: T | undefined): T | undefined {
  return record === undefined || Object.keys(record).length === 0 ? undefined : record
}

/** The resolver keys of the loader config: only the ones the project gave (T3.3). */
function resolverKeys(input: ProjectInput): Partial<SerializedLoaderConfig> {
  const { aliases, resolution } = input
  return {
    ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
    ...(input.mappers === undefined || input.mappers.length === 0
      ? {}
      : { mappers: input.mappers }),
    ...(resolution?.moduleDirectories === undefined
      ? {}
      : { moduleDirectories: resolution.moduleDirectories }),
    ...(resolution?.modulePaths === undefined || resolution.modulePaths.length === 0
      ? {}
      : { modulePaths: resolution.modulePaths }),
    ...(resolution?.esmExtensions === undefined || resolution.esmExtensions.length === 0
      ? {}
      : { esmExtensions: resolution.esmExtensions }),
    ...(resolution?.resolver === undefined
      ? {}
      : { resolver: { module: resolution.resolver, export: 'default' } }),
    ...(resolution?.skipNodeResolution === true ? { skipNodeResolution: true } : {}),
  }
}

/**
 * The native runtime's policy layer: its matcher table over the neutral `null`, and with a snapshot
 * printer the snapshot slice that writes Jest's `.snap` format (`nativeSnapshotPolicy`, B28).
 */
function nativeLayer(native: NativeRuntimeRefs | undefined): PolicyOverrides | undefined {
  if (native === undefined) return undefined
  return {
    expect: { matcherTable: native.matcherTable },
    ...(native.snapshot === undefined ? {} : { snapshot: nativeSnapshotPolicy(native.snapshot) }),
  }
}

/** The steps every project shares once its input is read: policy, environment, the worker config. */
async function finishProject(
  input: ProjectInput,
  options: Pick<ResolveProjectOptions, 'environments' | 'ci' | 'native'>,
): Promise<ResolvedProject> {
  const { dialect, rootDir } = input
  // The native runtime stands in for a dialect's table, scope and globals only when there is none.
  const native = dialect === null ? options.native : undefined
  if (native !== undefined) assertNativeRefs(native)
  let policy: Policy
  try {
    policy = resolvePolicy(nativeLayer(native), ...input.layers)
  } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', `the policy didn't resolve: ${messageOf(cause)}`, {
      cause,
    })
  }

  const environment = input.environment ?? policy.orchestrator.envDefault
  const environmentRef = entry(options.environments, environment)
  if (environmentRef === undefined) {
    const known = Object.keys(options.environments)
    throw new ConfigError(
      'CONFIG_UNKNOWN_ENVIRONMENT',
      `unknown environment "${environment}"; the known environments are ${known.length === 0 ? 'none' : known.map((n) => `"${n}"`).join(', ')}`,
    )
  }
  const { isolationDefault } = policy.orchestrator
  const isolation =
    input.isolation ??
    entry(isolationDefault.byEnvironment, environment) ??
    isolationDefault.default

  const globalsFactory = policy.core.injectGlobals
    ? (dialect?.globals?.factory ?? native?.globals ?? null)
    : null
  const scopeModules = dialect?.moduleScope?.modules ?? native?.modules
  let serialized: SerializedProjectConfig['policy']
  try {
    serialized = serializePolicy(policy)
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the policy can't go to a worker: ${messageOf(cause)}`,
      {
        cause,
      },
    )
  }

  // A package specifier in a setup file resolves as an import of a test would: Node's own
  // conditions, `provino-source` and the project's `resolve.conditions`.
  const packageResolution = {
    conditions: [...new Set(['node', 'provino-source', ...(input.extraConditions ?? [])])],
    extensions: LOADER_EXTENSIONS,
  }
  const [[setupFiles, setupFilesAfterEnv], conditions] = await inParallel(
    Promise.all([
      resolveSetupFiles(input.setupFiles, rootDir, 'setupFiles', packageResolution),
      resolveSetupFiles(
        input.setupFilesAfterEnv,
        rootDir,
        input.setupFilesAfterEnvKey,
        packageResolution,
      ),
    ]),
    loaderConditions(policy, environment, input.environmentOptions),
  )
  const globalValues = nonEmpty(input.globalValues)
  const fakeTimers = nonEmpty(input.fakeTimers)
  const config: UnseededProjectConfig = {
    name: input.name,
    rootDir,
    ci: options.ci,
    policy: serialized,
    environment: {
      module: environmentRef.module,
      export: environmentRef.export,
      options: input.environmentOptions,
      ...(input.environmentResolverOptions === undefined
        ? {}
        : { resolverOptions: input.environmentResolverOptions }),
    },
    globals: globalsFactory,
    // The factory stays whether or not globals are injected: it also serves the imports (`@jest/globals`).
    moduleScope: dialect?.moduleScope?.factory ?? native?.moduleScope ?? null,
    ...(dialect?.environmentResolver === undefined
      ? {}
      : { environmentResolver: dialect.environmentResolver }),
    ...(globalValues === undefined ? {} : { globalValues }),
    ...(fakeTimers === undefined ? {} : { fakeTimers }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.snapshotResolver === undefined ? {} : { snapshotResolver: input.snapshotResolver }),
    ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
    ...(input.randomize === true ? { randomize: true as const } : {}),
    setupFiles,
    setupFilesAfterEnv,
    loader: {
      // The dialect's hoist policy crosses by value: data, with `RegExp` and `Set` leaves (B13c Gap 12).
      // With no dialect, the native runtime's (B27j): `mock`/`unmock` imported from its served module.
      hoist: dialect?.loader?.hoist ?? native?.hoist ?? null,
      // A module's own bindings (Jest's `jest`) are part of what `injectGlobals` injects: off, the
      // wrapper declares none, so a module that names one gets a `ReferenceError` as in jest-runtime
      // (and `typeof jest` is 'undefined').
      moduleScope: policy.core.injectGlobals ? (dialect?.moduleScope?.names ?? []) : [],
      ...(scopeModules === undefined ? {} : { scopeModules }),
      ...(dialect?.moduleScope?.mappable === undefined
        ? {}
        : { scopeMappable: dialect.moduleScope.mappable }),
      extensions: Object.freeze([...LOADER_EXTENSIONS]),
      conditions: [...new Set([...conditions, ...(input.extraConditions ?? [])])],
      tsconfig: input.tsconfig ?? 'auto',
      ...(input.define === undefined ? {} : { define: input.define }),
      mappers: [],
      typescript: 'oxc',
      ...(input.transform === undefined ? {} : { transform: input.transform }),
      ...(input.transformClaims === undefined ? {} : { transformClaims: input.transformClaims }),
      ...resolverKeys(input),
    },
  }
  assertWorkerConfig(config)

  return {
    name: input.name,
    rootDir,
    dialect,
    policy,
    include: policy.orchestrator.include,
    exclude: policy.orchestrator.exclude,
    discovery: input.discovery,
    environment,
    isolation,
    config,
    ...(input.cacheDirectory === undefined ? {} : { cacheDirectory: input.cacheDirectory }),
    ...(input.globalSetup === undefined ? {} : { globalSetup: input.globalSetup }),
    ...(input.affected === undefined ? {} : { affected: input.affected }),
  }
}
