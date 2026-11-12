import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  callBehaviour,
  createBehaviourLoader,
  resolvePolicy,
  serializePolicy,
} from '@provino/policy'
import type {
  Dialect,
  EnvironmentRef,
  IsolationTier,
  JsonValue,
  NeutralAlias,
  NeutralDiscovery,
  NeutralProject,
  NeutralResolution,
  Policy,
  PolicyOverrides,
  ProvinoConfigInput,
  SerializedLoaderConfig,
  SerializedProjectConfig,
  SerializedTransformConfig,
} from '@provino/types'
import { ConfigError } from './errors.ts'
import { dialectPolicy, selectDialect } from './internal/dialect.ts'
import { describe, isStringArray, messageOf, parseInput } from './internal/input.ts'
import { assertWorkerConfig } from './internal/refs.ts'
import { resolveSetupFiles } from './internal/setup-files.ts'
import { resolveTransforms } from './internal/transform.ts'

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
  /** Each environment by name, as an absolute ref the worker can import. */
  readonly environments: Readonly<
    Record<string, { readonly module: string; readonly export: string }>
  >
  /** Whether this is a CI run (`allowOnly: 'not-in-ci'`). */
  readonly ci: boolean
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
): PolicyOverrides {
  const orchestrator = {
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
  }
  return {
    ...(Object.keys(orchestrator).length === 0 ? {} : { orchestrator }),
    ...(globals === undefined ? {} : { core: { injectGlobals: globals } }),
  }
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
  if (!isAbsolute(options.configPath)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the config path must be absolute (got "${options.configPath}")`,
    )
  }
  const parsed = parseInput(input)
  const rootDir = resolve(dirname(options.configPath), parsed.root ?? '.')
  // The root check and `detect`'s read of the root are independent; a bad root is reported first.
  const [, dialect] = await inParallel(
    assertDirectory(rootDir),
    selectDialect(parsed.dialect, parsed.dialects ?? options.dialects, rootDir),
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
      layers: [dialectLayer, projectLayer(parsed.include, parsed.exclude, parsed.globals)],
      environment: parsed.environment,
      environmentOptions: {},
      isolation: parsed.isolation,
      setupFiles: [],
      setupFilesAfterEnv: parsed.setupFiles ?? [],
      setupFilesAfterEnvKey: 'setupFiles',
      discovery: null,
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
      isolation: undefined,
      setupFiles: neutral.setupFiles,
      setupFilesAfterEnv: neutral.setupFilesAfterEnv,
      setupFilesAfterEnvKey: 'setupFilesAfterEnv',
      discovery: neutral.discovery,
      transform: resolveTransforms(neutral),
      cacheDirectory: neutral.cacheDirectory,
      aliases: neutral.aliases,
      globalValues: neutral.globalValues,
      fakeTimers: neutral.fakeTimers,
      seed: neutral.seed,
      resolution: neutral.resolution,
    },
    { environments: options.environments, ci: options.ci },
  )
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
  /** The cache directory the config sets itself (D70); a neutral project's only. */
  readonly cacheDirectory?: string | undefined
  /** Name-mapping rules and resolver keys (T3.3); none for a `provino.config.*` project. */
  readonly aliases?: readonly NeutralAlias[] | undefined
  readonly resolution?: NeutralResolution | undefined
  readonly globalValues?: Readonly<Record<string, JsonValue>> | undefined
  readonly fakeTimers?: Readonly<Record<string, JsonValue>> | undefined
  readonly seed?: number | undefined
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
    ...(resolution?.moduleDirectories === undefined
      ? {}
      : { moduleDirectories: resolution.moduleDirectories }),
    ...(resolution?.modulePaths === undefined || resolution.modulePaths.length === 0
      ? {}
      : { modulePaths: resolution.modulePaths }),
    ...(resolution?.resolver === undefined
      ? {}
      : { resolver: { module: resolution.resolver, export: 'default' } }),
  }
}

/** The steps every project shares once its input is read: policy, environment, the worker config. */
async function finishProject(
  input: ProjectInput,
  options: Pick<ResolveProjectOptions, 'environments' | 'ci'>,
): Promise<ResolvedProject> {
  const { dialect, rootDir } = input
  let policy: Policy
  try {
    policy = resolvePolicy(...input.layers)
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

  const globalsFactory = policy.core.injectGlobals ? (dialect?.globals?.factory ?? null) : null
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

  const [[setupFiles, setupFilesAfterEnv], conditions] = await inParallel(
    Promise.all([
      resolveSetupFiles(input.setupFiles, rootDir, 'setupFiles'),
      resolveSetupFiles(input.setupFilesAfterEnv, rootDir, input.setupFilesAfterEnvKey),
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
    },
    globals: globalsFactory,
    // The factory stays whether or not globals are injected: it also serves the imports (`@jest/globals`).
    moduleScope: dialect?.moduleScope?.factory ?? null,
    ...(dialect?.environmentResolver === undefined
      ? {}
      : { environmentResolver: dialect.environmentResolver }),
    ...(globalValues === undefined ? {} : { globalValues }),
    ...(fakeTimers === undefined ? {} : { fakeTimers }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    setupFiles,
    setupFilesAfterEnv,
    loader: {
      // The dialect's hoist policy crosses by value: data, with `RegExp` and `Set` leaves (B13c Gap 12).
      hoist: dialect?.loader?.hoist ?? null,
      // A module's own bindings (Jest's `jest`) are part of what `injectGlobals` injects: off, the
      // wrapper declares none, so a module that names one gets a `ReferenceError` as in jest-runtime
      // (and `typeof jest` is 'undefined').
      moduleScope: policy.core.injectGlobals ? (dialect?.moduleScope?.names ?? []) : [],
      ...(dialect?.moduleScope?.modules === undefined
        ? {}
        : { scopeModules: dialect.moduleScope.modules }),
      ...(dialect?.moduleScope?.mappable === undefined
        ? {}
        : { scopeMappable: dialect.moduleScope.mappable }),
      extensions: Object.freeze([...LOADER_EXTENSIONS]),
      conditions,
      tsconfig: 'auto',
      mappers: [],
      typescript: 'oxc',
      ...(input.transform === undefined ? {} : { transform: input.transform }),
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
  }
}
