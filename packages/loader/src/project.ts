// The worker's loader from clone-safe settings. The worker entry may not import the resolver or the
// transform pipeline (the package manifest), so the loader builds them: resolver and pipeline from
// the project's `SerializedLoaderConfig`, then `createLoader` with the runner engine.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createBehaviourLoader } from '@provino/policy'
import { createNameMapper, createResolver } from '@provino/resolver'
import { createJestHost, createPipeline, lockfileHash } from '@provino/transform'
import type {
  CoverageInstrumenter,
  JestCustomResolver,
  Loader,
  ModuleMapper,
  ModuleMapperFactory,
  ModulePolicy,
  ModuleRef,
  Pipeline,
  SerializedLoaderConfig,
} from '@provino/types'
import { LoaderError } from './errors.ts'
import { initLexer } from './graph/index.ts'
import { createLoader } from './loader.ts'

/**
 * The config's `tsconfig` for the resolver and the pipeline: `'auto'` and `false` pass through, and
 * any other string is the path of the tsconfig file, read against `root` (not the process cwd) and
 * required to exist. (`'auto'` is a string too, so a bare `typeof` check would take it for a file.)
 */
function tsconfigFor(
  root: string,
  tsconfig: SerializedLoaderConfig['tsconfig'],
): 'auto' | false | string {
  if (tsconfig === 'auto' || tsconfig === false) return tsconfig
  const file = resolve(root, tsconfig)
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new LoaderError(
      'LOADER_TSCONFIG_NOT_FOUND',
      `loader.tsconfig ${JSON.stringify(tsconfig)} is not a file: ${file} (a relative path is read against ${root})`,
    )
  }
  return file
}

/** Whether a mapper factory's result is a `ModuleMapper`: a string `id` and a `map` function. */
function isModuleMapper(value: unknown): value is ModuleMapper {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'map') === 'function'
  )
}

/**
 * Calls the mapper factory loaded for `loader.mappers[index]`. A factory that throws, or returns
 * anything but a mapper, is a coded error naming the entry instead of a crash in the resolver.
 */
function buildMapper(
  factory: ModuleMapperFactory,
  options: Parameters<ModuleMapperFactory>[0],
  index: number,
): ModuleMapper {
  const entry = `loader.mappers[${index}]`
  let mapper: unknown
  try {
    mapper = factory(options)
  } catch (cause) {
    throw new LoaderError('LOADER_INVALID_MAPPER', `${entry}: the mapper factory threw`, { cause })
  }
  if (!isModuleMapper(mapper)) {
    throw new LoaderError(
      'LOADER_INVALID_MAPPER',
      `${entry}: the mapper factory must return an object with a string id and a map function`,
    )
  }
  return mapper
}

/** Loads a Jest `resolver` module by ref: a function, or an object with `sync` and/or `async`. */
async function loadCustomResolver(
  behaviours: ReturnType<typeof createBehaviourLoader>,
  ref: ModuleRef,
): Promise<JestCustomResolver> {
  const loaded: unknown = await behaviours.load(ref)
  if (typeof loaded === 'function') return loaded as JestCustomResolver
  if (
    typeof loaded === 'object' &&
    loaded !== null &&
    (typeof Reflect.get(loaded, 'sync') === 'function' ||
      typeof Reflect.get(loaded, 'async') === 'function')
  ) {
    return loaded as JestCustomResolver
  }
  throw new LoaderError(
    'LOADER_INVALID_MAPPER',
    `loader.resolver: the module must export a function or an object with sync/async`,
  )
}

/**
 * Coverage for a project's loader (B23b): the Istanbul instrumenter its pipeline calls on a file
 * requested with `instrument: true`, and which files those are.
 * @public
 */
export interface ProjectCoverage {
  readonly instrumenter: CoverageInstrumenter
  /** Whether the user module at this absolute path is instrumented (`createCoverageFilter`). */
  readonly shouldInstrument: (path: string) => boolean
}

/**
 * Options for `createProjectLoader`.
 * @public
 */
export interface ProjectLoaderOptions {
  readonly coverage?: ProjectCoverage
}

/**
 * Creates the worker's loader for one project. `config.mappers` are loaded by `ModuleRef` first,
 * which is why this is async. Mock hoisting follows `config.hoist` (the dialect's policy, by
 * value), and every module's wrapper declares `config.moduleScope`'s names. `config.transform`'s
 * transformers are loaded here, in the worker, from their own paths (T3.8); a file one of them
 * matches goes through it, every other file through Oxc. `config.cacheDir` turns the transform cache
 * on (T3.6): a file's record is read from it before any work and written after.
 * @public
 */
export async function createProjectLoader(
  root: string,
  config: SerializedLoaderConfig,
  policy: ModulePolicy,
  options: ProjectLoaderOptions = {},
): Promise<Loader> {
  return (await buildProjectLoader(root, config, policy, options)).loader
}

/**
 * A project's loader with the pipeline it transforms through: the coordinator transforms files the
 * tests never loaded with it, for coverage.
 */
export async function buildProjectLoader(
  root: string,
  config: SerializedLoaderConfig,
  policy: ModulePolicy,
  options: ProjectLoaderOptions,
): Promise<{ readonly loader: Loader; readonly pipeline: Pipeline }> {
  const tsconfig = tsconfigFor(root, config.tsconfig)
  const behaviours = createBehaviourLoader()
  // In config order: the first mapper to hit wins.
  const mappers: ModuleMapper[] = await Promise.all(
    config.mappers.map(async (mapper, index) =>
      buildMapper(await behaviours.load(mapper.factory), mapper.options, index),
    ),
  )
  const transformers =
    config.transform === undefined || config.transform.rules.length === 0
      ? undefined
      : await createJestHost(config.transform)
  // Name-mapping rules run before the mapper factories, as Jest's `moduleNameMapper` runs first.
  const aliases = config.aliases ?? []
  if (aliases.length > 0) {
    mappers.unshift(
      createNameMapper({
        rootDir: root,
        rules: aliases.map(({ pattern, targets }) => ({ pattern, targets })),
      }),
    )
  }
  const custom =
    config.resolver === undefined
      ? undefined
      : await loadCustomResolver(behaviours, config.resolver)
  // The lexer's WebAssembly build starts here, once per worker, where an `await` is free (B13d Gap 9).
  if (policy.mocksReachShared) await initLexer()
  const pipeline = createPipeline({
    root,
    typescript: config.typescript,
    tsconfig,
    hoist: config.hoist,
    runnerForm: true,
    cache: config.cacheDir === undefined ? false : { dir: config.cacheDir },
    ...(config.codeIdentity === undefined ? {} : { codeIdentity: config.codeIdentity }),
    ...(transformers === undefined ? {} : { transformers }),
    ...(options.coverage === undefined ? {} : { instrumenter: options.coverage.instrumenter }),
  })
  const loader = createLoader({
    root,
    engine: 'runner',
    graphCache: config.cacheDir ?? null,
    lockfileHash:
      policy.mocksReachShared && config.cacheDir !== undefined ? lockfileHash(root) : null,
    resolver: createResolver({
      root,
      mappers,
      extensions: config.extensions,
      tsconfig: tsconfig === 'auto' || tsconfig === false ? tsconfig : { configFile: tsconfig },
      ...(config.moduleDirectories === undefined
        ? {}
        : { moduleDirectories: config.moduleDirectories }),
      ...(config.modulePaths === undefined ? {} : { modulePaths: config.modulePaths }),
      ...(custom === undefined ? {} : { custom }),
    }),
    transformer: pipeline,
    policy,
    ...(options.coverage === undefined
      ? {}
      : { shouldInstrument: options.coverage.shouldInstrument }),
    conditions: config.conditions,
    ...(config.resolver === undefined ? {} : { resolverName: config.resolver.module }),
    ...(policy.mapperMiss === null
      ? {}
      : { formatMapperMiss: await behaviours.load(policy.mapperMiss) }),
    ...(config.moduleScope.length === 0 && (config.scopeModules ?? []).length === 0
      ? {}
      : {
          moduleScope: {
            names: config.moduleScope,
            modules: config.scopeModules ?? [],
            ...(config.scopeMappable === undefined ? {} : { mappable: config.scopeMappable }),
          },
        }),
  })
  return { loader, pipeline }
}
