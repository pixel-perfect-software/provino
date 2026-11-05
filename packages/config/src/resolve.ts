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
  IsolationTier,
  Policy,
  PolicyOverrides,
  ProvinoConfigInput,
  SerializedProjectConfig,
} from '@provino/types'
import { ConfigError } from './errors.ts'
import { dialectPolicy, selectDialect } from './internal/dialect.ts'
import { describe, parseInput } from './internal/input.ts'
import { assertWorkerConfig } from './internal/refs.ts'
import { resolveSetupFiles } from './internal/setup-files.ts'

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
  /** The environment's name: `WorkerKey.environment`. */
  readonly environment: string
  readonly isolation: IsolationTier
  /** What each worker is started with. */
  readonly config: SerializedProjectConfig
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
async function loaderConditions(policy: Policy, environment: string): Promise<readonly string[]> {
  const behaviour = policy.orchestrator.environmentConditions
  let conditions: unknown
  try {
    conditions = await callBehaviour(createBehaviourLoader(), behaviour, { name: environment })
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_LOAD_FAILED',
      `can't get the resolver conditions for the "${environment}" environment from the policy's orchestrator.environmentConditions`,
      { cause },
    )
  }
  if (!Array.isArray(conditions) || !conditions.every(isString)) {
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
  await assertDirectory(rootDir)

  const dialect = await selectDialect(parsed.dialect, parsed.dialects ?? options.dialects, rootDir)
  const dialectLayer =
    dialect === null
      ? undefined
      : await dialectPolicy(
          dialect,
          Object.hasOwn(input, dialect.name) ? Reflect.get(input, dialect.name) : undefined,
        )
  let policy: Policy
  try {
    policy = resolvePolicy(
      dialectLayer,
      projectLayer(parsed.include, parsed.exclude, parsed.globals),
    )
  } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', `the policy didn't resolve: ${messageOf(cause)}`, {
      cause,
    })
  }

  const environment = parsed.environment ?? policy.orchestrator.envDefault
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
    parsed.isolation ??
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

  const config: SerializedProjectConfig = {
    name: parsed.name ?? '',
    rootDir,
    ci: options.ci,
    policy: serialized,
    environment: { module: environmentRef.module, export: environmentRef.export, options: {} },
    globals: globalsFactory,
    setupFiles: [],
    setupFilesAfterEnv: await resolveSetupFiles(parsed.setupFiles ?? [], rootDir),
    loader: {
      extensions: Object.freeze([...LOADER_EXTENSIONS]),
      conditions: await loaderConditions(policy, environment),
      tsconfig: 'auto',
      mappers: [],
      typescript: 'oxc',
    },
  }
  assertWorkerConfig(config)

  return {
    name: parsed.name ?? '',
    rootDir,
    dialect,
    policy,
    include: policy.orchestrator.include,
    exclude: policy.orchestrator.exclude,
    environment,
    isolation,
    config,
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
