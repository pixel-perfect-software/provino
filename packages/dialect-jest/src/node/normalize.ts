// T11.6: Jest 30.5's config normalizer, `jest-config` 30.5.2 `normalize.ts` rebuilt step for step,
// with `index.ts`'s `readConfig` (the split into the project and global configs) and `readConfigs`
// (`projects`). Its output is `readConfig(...)`'s, key for key: the sample check
// (`pnpm bench:jest-config sample`) compares the two on Jest configs from real repositories.
// Behaviour it copies on purpose, quirks included (D7: documented behaviour is reproduced):
// - a key the switch doesn't handle (`preset`, `ci`, unknown keys…) comes out `undefined`;
// - `moduleNameMapper` keeps the config's keys first; `transform` gets `babel-jest` when no
//   pattern matches `a.js`/`a.ts`; an exact `'babel-jest'` is Jest's own copy;
// - `testEnvironment`, `runner`, watch plugins and the sequencer try `jest-<kind>-<name>` from
//   `rootDir`, then from Jest, then `<name>` from both;
// - `projects` globs expand in glob 13's order (`glob.ts`) against the working directory.
// Jest's built-in packages resolve through `JestRequireResolve` (see `resolution.ts`).
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, statSync } from 'node:fs'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import {
  dirname,
  isAbsolute,
  join,
  normalize as normalizePath,
  relative,
  resolve,
  sep,
} from 'node:path'
import type { Diagnostic } from '@provino/types'
import { JestConfigError, messageOf } from './errors.ts'
import { isJSONString, JEST_CONFIG_EXT_ORDER, resolveJestConfigPath, sourceOf } from './find.ts'
import { globSync } from './glob.ts'
import { inlineProjectOptions, loadJestConfig } from './load.ts'
import {
  escapeGlobCharacters,
  NODE_MODULES_REGEXP,
  replacePathSepForGlob,
  replacePathSepForRegex,
  replaceRootDirInPath,
  replaceRootDirTags,
  tryRealpath,
} from './paths.ts'
import { setupPreset } from './preset.ts'
import {
  createJestResolution,
  type JestRequireResolve,
  type JestResolution,
  projectJestRequireResolve,
} from './resolution.ts'
import { CONFIG_ERROR_TITLE, DOCUMENTATION_NOTE, validationText } from './text.ts'
import type {
  JestArgv,
  JestGlobalConfig,
  JestInitialOptions,
  JestLoadedConfig,
  JestProjectConfig,
  JestReadConfig,
} from './types.ts'
import { validateJestConfig } from './validate.ts'

type Options = Record<string, unknown>

/** `constants.ts` L11. */
const DEFAULT_JS_PATTERN = '\\.[jt]sx?$'

/**
 * How the normalizer runs. Everything is optional: the defaults are a CLI run in the current
 * directory with no flags, and Jest's packages found through the project's own Jest.
 * @public
 */
export interface NormalizeOptions {
  /** Jest's `argv` (CLI values). Default: none. */
  readonly argv?: JestArgv
  /** The working directory Jest runs in. Default: `process.cwd()`. */
  readonly cwd?: string
  /**
   * Where Jest's built-in packages (`babel-jest`, `jest-environment-node`, `jest-circus/runner`,
   * `jest-runner`, `@jest/test-sequencer`) resolve from. Default: the project's own Jest
   * (`projectJestRequireResolve(rootDir)`); without one, each stays its bare name.
   */
  readonly requireResolve?: JestRequireResolve
  /** The environment variables Jest reads (`CI`, `NODE_PATH`). Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Whether this is a CI run (Jest's `ci-info`). Default: from `env`. */
  readonly ci?: boolean
  /** Jest's random seed when `argv.seed` is unset. Default: random. */
  readonly seed?: number
}

/** One normalized config before the split, with what validation reported. */
export interface NormalizedJestOptions {
  readonly options: Readonly<Options>
  /** Whether the config (its preset, or `--cacheDirectory`) named a `cacheDirectory` (D70). */
  readonly cacheDirectorySet: boolean
  readonly hasDeprecationWarnings: boolean
  readonly diagnostics: readonly Diagnostic[]
}

/** `ci-info` 4's `isCI`, for the variables CI services set (vendor detection is left out). */
function ciFromEnvironment(env: NodeJS.ProcessEnv): boolean {
  if (env.CI === 'false') return false
  return [
    'BUILD_ID',
    'BUILD_NUMBER',
    'CI',
    'CI_APP_ID',
    'CI_BUILD_ID',
    'CI_BUILD_NUMBER',
    'CI_NAME',
    'CONTINUOUS_INTEGRATION',
    'RUN_ID',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'CIRCLECI',
    'TRAVIS',
    'BUILDKITE',
    'TF_BUILD',
    'JENKINS_URL',
  ].some((name) => !!env[name])
}

/** `getCacheDirectory.ts`: Jest's default `cacheDirectory`, which is not Provino's to use (D70). */
export function jestDefaultCacheDirectory(): string {
  const base = join(tryRealpath(tmpdir()), 'jest')
  return typeof process.getuid === 'function' ? `${base}_${process.getuid().toString(36)}` : base
}

/** `Defaults.ts`: Jest 30.5's defaults, before normalization. */
export function jestDefaults(ci: boolean): Readonly<Options> {
  return {
    automock: false,
    bail: 0,
    cache: true,
    cacheDirectory: jestDefaultCacheDirectory(),
    changedFilesWithAncestor: false,
    ci,
    clearMocks: false,
    collectCoverage: false,
    coveragePathIgnorePatterns: [NODE_MODULES_REGEXP],
    coverageProvider: 'babel',
    coverageReporters: ['json', 'text', 'lcov', 'clover'],
    detectLeaks: false,
    detectOpenHandles: false,
    errorOnDeprecated: false,
    expand: false,
    extensionsToTreatAsEsm: [],
    fakeTimers: { enableGlobally: false },
    forceCoverageMatch: [],
    globals: {},
    haste: {
      computeSha1: false,
      enableSymlinks: false,
      forceNodeFilesystemAPI: true,
      throwOnModuleCollision: false,
    },
    injectGlobals: true,
    listTests: false,
    maxConcurrency: 5,
    maxWorkers: '50%',
    moduleDirectories: ['node_modules'],
    moduleFileExtensions: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'json', 'node'],
    moduleNameMapper: {},
    modulePathIgnorePatterns: [],
    noStackTrace: false,
    notify: false,
    notifyMode: 'failure-change',
    openHandlesTimeout: 1000,
    passWithNoTests: false,
    prettierPath: 'prettier',
    resetMocks: false,
    resetModules: false,
    restoreMocks: false,
    roots: ['<rootDir>'],
    runTestsByPath: false,
    runner: 'jest-runner',
    setupFiles: [],
    setupFilesAfterEnv: [],
    skipFilter: false,
    slowTestThreshold: 5,
    snapshotFormat: { escapeString: false, printBasicPrototype: false },
    snapshotSerializers: [],
    testEnvironment: 'jest-environment-node',
    testEnvironmentOptions: {},
    testFailureExitCode: 1,
    testLocationInResults: false,
    testMatch: ['**/__tests__/**/*.?([mc])[jt]s?(x)', '**/?(*.)+(spec|test).?([mc])[jt]s?(x)'],
    testPathIgnorePatterns: [NODE_MODULES_REGEXP],
    testRegex: [],
    testRunner: 'jest-circus/runner',
    testSequencer: '@jest/test-sequencer',
    transformIgnorePatterns: [NODE_MODULES_REGEXP, `\\.pnp\\.[^\\${sep}]+$`],
    useStderr: false,
    waitForUnhandledRejections: false,
    watch: false,
    watchPathIgnorePatterns: [],
    watchman: true,
    workerGracefulExitTimeout: 500,
    workerThreads: false,
  }
}

function configError(
  message: string,
  code: 'JEST_CONFIG_INVALID' | 'JEST_CONFIG_MODULE_NOT_FOUND' = 'JEST_CONFIG_INVALID',
): JestConfigError {
  return new JestConfigError(code, validationText(CONFIG_ERROR_TITLE, message, DOCUMENTATION_NOTE))
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown, key: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new JestConfigError('JEST_CONFIG_INVALID', `"${key}" must be an array`)
  }
  return value
}

function asString(value: unknown, key: string): string {
  if (typeof value !== 'string') {
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      `"${key}" must hold strings (got ${typeof value})`,
    )
  }
  return value
}

/** `verifyDirectoryExists` (L115-L146). */
function verifyDirectoryExists(path: string, key: string, cwd?: string): void {
  let isDirectory: boolean
  try {
    // Jest stats a relative path against the process's working directory; ours, against `cwd`.
    isDirectory = statSync(cwd === undefined ? path : resolve(cwd, path)).isDirectory()
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      throw configError(`  Directory ${path} in the ${key} option was not found.`)
    }
    throw configError(
      `  Got an error trying to find ${path} in the ${key} option.\n\n  Error was: ${messageOf(error)}`,
    )
  }
  if (!isDirectory) throw configError(`  ${path} in the ${key} option is not a directory.`)
}

/** The run's state: the resolver, Jest's own packages, and the names that stayed bare. */
interface Run {
  readonly argv: JestArgv & { _: (string | number)[] }
  readonly cwd: string
  readonly resolution: JestResolution
  /** Jest's own package names kept bare because no Jest install resolved them. */
  readonly bare: Set<string>
  readonly ci: boolean
  readonly seed: number | undefined
  /** Whether Jest's own install resolves its packages (`babel-jest` finds one). */
  readonly jestFound: boolean
}

/** Jest's own `require.resolve`, or the bare name when no Jest install has it. */
function jestRequire(run: Run, specifier: string): string {
  const found = run.resolution.requireResolve(specifier)
  if (found !== undefined) return found
  run.bare.add(specifier)
  return specifier
}

/**
 * The packages Jest 30.5 ships (`jest-config`'s own dependencies that a config can name). With no
 * Jest install to resolve them from, one of these stays its bare name rather than failing, so a
 * project that dropped Jest for Provino still reads.
 */
const JEST_BUILTINS: ReadonlySet<string> = new Set([
  'babel-jest',
  'jest-environment-node',
  'jest-circus',
  'jest-circus/runner',
  'jest-runner',
  '@jest/test-sequencer',
])

/** `requireResolveFunction` in `resolveWithPrefix`: Jest's install, else a built-in stays bare. */
function fromJestInstall(run: Run, name: string): string | undefined {
  const found = run.resolution.requireResolve(name)
  if (found !== undefined) return found
  if (!run.jestFound && JEST_BUILTINS.has(name)) {
    run.bare.add(name)
    return name
  }
  return undefined
}

/** `utils.ts` `resolve` (L31-L55). */
function resolveOption(
  run: Run,
  resolver: string | undefined,
  key: string,
  filePath: string,
  rootDir: string,
  optional = false,
): string | null {
  if (run.bare.has(filePath)) return filePath
  const module = run.resolution.findNodeModule(replaceRootDirInPath(rootDir, filePath), {
    basedir: rootDir,
    resolver,
  })
  if (!module && !optional) {
    throw configError(
      `  Module ${filePath} in the ${key} option was not found.\n         <rootDir> is: ${rootDir}`,
      'JEST_CONFIG_MODULE_NOT_FOUND',
    )
  }
  return module
}

/** `jest-resolve` `utils.ts` `resolveWithPrefix` (L37-L89). */
function resolveWithPrefix(
  run: Run,
  resolver: string | undefined,
  options: {
    readonly filePath: string
    readonly humanOptionName: string
    readonly optionName: string
    readonly prefix: string
    readonly rootDir: string
  },
): string {
  const { filePath, humanOptionName, optionName, prefix, rootDir } = options
  if (run.bare.has(filePath)) return filePath
  const fileName = replaceRootDirInPath(rootDir, filePath)
  const find = (name: string) => run.resolution.findNodeModule(name, { basedir: rootDir, resolver })
  const prefixed = find(`${prefix}${fileName}`)
  if (prefixed) return prefixed
  const fromJest = fromJestInstall(run, `${prefix}${fileName}`)
  if (fromJest !== undefined) return fromJest
  const plain = find(fileName)
  if (plain) return plain
  const plainFromJest = fromJestInstall(run, fileName)
  if (plainFromJest !== undefined) return plainFromJest
  throw new JestConfigError(
    'JEST_CONFIG_MODULE_NOT_FOUND',
    validationText(
      CONFIG_ERROR_TITLE,
      `  ${humanOptionName} ${fileName} cannot be found. Make sure the ${optionName} configuration option points to an existing node module.`,
      DOCUMENTATION_NOTE,
    ),
  )
}

/** `resolveTestEnvironment` (`jest-resolve` `utils.ts` L98-L125). */
function resolveTestEnvironment(run: Run, rootDir: string, testEnvironment: string): string {
  const filePath = testEnvironment === 'jsdom' ? 'jest-environment-jsdom' : testEnvironment
  try {
    return resolveWithPrefix(run, undefined, {
      filePath,
      humanOptionName: 'Test environment',
      optionName: 'testEnvironment',
      prefix: 'jest-environment-',
      rootDir,
    })
  } catch (error) {
    if (filePath === 'jest-environment-jsdom' && error instanceof JestConfigError) {
      throw new JestConfigError(
        error.code,
        `${error.message}\n\nAs of Jest 28 "jest-environment-jsdom" is no longer shipped by default, make sure to install it separately.`,
      )
    }
    throw error
  }
}

/** `setFromArgv.ts`. */
function setFromArgv(options: JestInitialOptions, argv: JestArgv): Options {
  const special = new Set(['_', '$0', 'h', 'help', 'config'])
  const fromArgv: Options = {}
  for (const key of Object.keys(argv)) {
    const value = argv[key]
    if (value === undefined || special.has(key)) continue
    switch (key) {
      case 'coverage':
        fromArgv.collectCoverage = value
        break
      case 'json':
        fromArgv.useStderr = value
        break
      case 'watchAll':
        fromArgv.watch = false
        fromArgv.watchAll = value
        break
      case 'env':
        fromArgv.testEnvironment = value
        break
      case 'coverageThreshold':
      case 'globals':
      case 'haste':
      case 'moduleNameMapper':
      case 'testEnvironmentOptions':
      case 'transform':
        if (typeof value === 'string' && isJSONString(value)) fromArgv[key] = JSON.parse(value)
        break
      default:
        fromArgv[key] = value
    }
  }
  const config = argv.config
  const inline: Options =
    typeof config === 'string' && isJSONString(config) ? (JSON.parse(config) as Options) : {}
  return { ...options, ...inline, ...fromArgv }
}

/** `normalizeRootDir` (L381-L405). */
function normalizeRootDir(options: Options, cwd: string): Options & { rootDir: string } {
  if (!options.rootDir || typeof options.rootDir !== 'string') {
    throw configError('  Configuration option rootDir must be specified.')
  }
  let rootDir = normalizePath(options.rootDir)
  // `tryRealpath` makes a relative `rootDir` that exists absolute (against the working directory),
  // and leaves one that doesn't as it is, for the error below.
  const absolute = resolve(cwd, rootDir)
  try {
    const real = tryRealpath(absolute)
    if (real !== absolute || existsSync(absolute)) rootDir = real
  } catch {
    // ignored, as upstream
  }
  verifyDirectoryExists(rootDir, 'rootDir', cwd)
  return { ...options, rootDir }
}

/** `normalizeMissingOptions` (L359-L379). */
function normalizeMissingOptions(
  options: Options & { rootDir: string },
  configPath: string | null,
  projectIndex: number,
): Options & { rootDir: string } {
  if (!options.id) {
    options.id = createHash('sha1')
      .update(options.rootDir)
      .update(configPath || '')
      .update(String(projectIndex))
      .digest('hex')
      .slice(0, 32)
  }
  if (!options.setupFiles) options.setupFiles = []
  return options
}

/** `setupBabelJest` (L262-L303). */
function setupBabelJest(run: Run, options: Options): void {
  const transform = options.transform
  if (!transform) {
    options.transform = { [DEFAULT_JS_PATTERN]: jestRequire(run, 'babel-jest') }
    return
  }
  if (!isRecord(transform)) return
  const copy: Record<string, unknown> = { ...transform }
  const test = (pattern: string, samples: readonly string[]) => {
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error) {
      throw new JestConfigError('JEST_CONFIG_INVALID', messageOf(error), { cause: error })
    }
    return samples.some((sample) => regex.test(sample))
  }
  const keys = Object.keys(copy)
  const jsPattern = keys.find((pattern) => test(pattern, ['a.js', 'a.jsx']))
  const tsPattern = keys.find((pattern) => test(pattern, ['a.ts', 'a.tsx']))
  for (const pattern of [jsPattern, tsPattern]) {
    if (!pattern) continue
    const transformer = copy[pattern]
    if (Array.isArray(transformer)) {
      if (transformer[0] === 'babel-jest') {
        copy[pattern] = [jestRequire(run, 'babel-jest'), ...transformer.slice(1)]
      }
    } else if (transformer === 'babel-jest') {
      copy[pattern] = jestRequire(run, 'babel-jest')
    }
  }
  options.transform = copy
}

/** `normalizeCollectCoverageFrom` (L305-L335). */
function normalizeCollectCoverageFrom(value: unknown): readonly string[] | undefined {
  let out: unknown
  if (!value) out = []
  if (Array.isArray(value)) out = value
  else {
    try {
      out = JSON.parse(value as string)
    } catch {
      // not JSON
    }
    if (value && !Array.isArray(out)) out = [value]
  }
  if (!Array.isArray(out)) return undefined
  return out.map((filePath: unknown) =>
    asString(filePath, 'collectCoverageFrom').replace(/^(!?)(<rootDir>\/)(.*)/, '$1$3'),
  )
}

/** `normalizeUnmockedModulePathPatterns` (L337-L357): `<rootDir>` replaced everywhere. */
function normalizePatterns(value: unknown, key: string, rootDir: string): readonly string[] {
  return asArray(value, key).map((pattern) =>
    replacePathSepForRegex(asString(pattern, key).replaceAll('<rootDir>', rootDir)),
  )
}

/** `normalizeReporters` (L407-L448) with `validateReporters` (`ReporterValidationErrors.ts`). */
function normalizeReporters(run: Run, reporters: unknown, rootDir: string): unknown[] | undefined {
  if (!reporters || !Array.isArray(reporters)) return undefined
  const title = '● Reporter Validation Error'
  reporters.forEach((reporter: unknown, index) => {
    if (Array.isArray(reporter)) {
      const [path, options] = reporter as readonly unknown[]
      const detail = (valueIndex: number, value: unknown, expected: string, valueName: string) =>
        new JestConfigError(
          'JEST_CONFIG_INVALID',
          validationText(
            title,
            `  Unexpected value for ${valueName} at index ${valueIndex} of reporter at index ${index}\n` +
              '  Expected:\n' +
              `    ${expected}\n` +
              '  Got:\n' +
              `    ${typeName(value)}\n` +
              '  Reporter configuration:\n' +
              `    ${JSON.stringify(reporter, null, 2).split('\n').join('\n    ')}`,
            DOCUMENTATION_NOTE,
          ),
        )
      if (typeof path !== 'string') throw detail(0, path, 'string', 'Path')
      if (typeof options !== 'object') throw detail(1, options, 'object', 'Reporter Configuration')
    } else if (typeof reporter !== 'string') {
      throw new JestConfigError(
        'JEST_CONFIG_INVALID',
        validationText(
          title,
          `  Reporter at index ${index} must be of type:\n    array or string\n  but instead received:\n    ${typeName(reporter)}`,
          DOCUMENTATION_NOTE,
        ),
      )
    }
  })
  return reporters.map((entry: unknown) => {
    const config: unknown[] = typeof entry === 'string' ? [entry, {}] : [...(entry as unknown[])]
    const reporterPath = replaceRootDirInPath(rootDir, config[0] as string)
    if (!['agent', 'default', 'github-actions', 'summary'].includes(reporterPath)) {
      const reporter = run.resolution.findNodeModule(reporterPath, { basedir: rootDir })
      if (!reporter) {
        throw new JestConfigError(
          'JEST_CONFIG_MODULE_NOT_FOUND',
          `Could not resolve a module for a custom reporter.\n  Module name: ${reporterPath}`,
        )
      }
      config[0] = reporter
    }
    return config
  })
}

/** `@jest/get-type`'s names, for the reporter messages. */
function typeName(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') {
    const maker: unknown = Reflect.get(value, 'constructor')
    if (maker === RegExp) return 'regexp'
    if (maker === Map) return 'map'
    if (maker === Set) return 'set'
    if (maker === Date) return 'date'
    return 'object'
  }
  return typeof value
}

/** `validateExtensionsToTreatAsEsm` (L485-L534). */
function validateExtensionsToTreatAsEsm(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) return
  const extensions = value.map((ext) => asString(ext, 'extensionsToTreatAsEsm'))
  const print = (list: readonly string[]) =>
    `extensionsToTreatAsEsm: [${list.map((ext) => `'${ext}'`).join(', ')}]`
  if (extensions.some((ext) => !ext.startsWith('.'))) {
    throw configError(
      `  Option: ${print(extensions)} includes a string that does not start with a period (.).
  Please change your configuration to ${print(extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)))}.`,
    )
  }
  if (extensions.includes('.js')) {
    throw configError(
      `  Option: ${print(extensions)} includes '.js' which is always inferred based on type in its nearest package.json.`,
    )
  }
  if (extensions.includes('.cjs')) {
    throw configError(
      `  Option: ${print(extensions)} includes '.cjs' which is always treated as CommonJS.`,
    )
  }
  if (extensions.includes('.mjs')) {
    throw configError(
      `  Option: ${print(extensions)} includes '.mjs' which is always treated as an ECMAScript Module.`,
    )
  }
}

/** `color.ts`. */
function displayNameColor(seed: string | undefined): string {
  if (seed === undefined) return 'white'
  const colors = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
  return (
    colors[createHash('sha256').update(seed).digest().readUInt32LE(0) % colors.length] ?? 'white'
  )
}

/** `stringToBytes.ts`. */
function stringToBytes(input: unknown, percentageReference: number): number | null | undefined {
  if (input === null || input === undefined) return input
  let value = input
  if (typeof value === 'string') {
    if (Number.isNaN(Number.parseFloat(value.slice(-1)))) {
      const match = value.match(/(.*?)([^\d.-]+)$/i) ?? []
      const numericString = match[1]
      const trailing = match[2]?.toLowerCase()
      if (trailing && numericString) {
        const numeric = Number.parseFloat(numericString)
        switch (trailing) {
          case '%':
            value = numeric / 100
            break
          case 'kb':
          case 'k':
            return numeric * 1000
          case 'kib':
            return numeric * 1024
          case 'mb':
          case 'm':
            return numeric * 1000 * 1000
          case 'mib':
            return numeric * 1024 * 1024
          case 'gb':
          case 'g':
            return numeric * 1000 * 1000 * 1000
          case 'gib':
            return numeric * 1024 * 1024 * 1024
        }
      }
    } else value = Number.parseFloat(value)
  }
  if (typeof value === 'number') {
    if (value === 0) return 0
    if (value <= 1 && value > 0) return Math.floor(value * percentageReference)
    if (value > 1) return Math.floor(value)
    throw new JestConfigError('JEST_CONFIG_INVALID', 'Unexpected numerical input')
  }
  throw new JestConfigError('JEST_CONFIG_INVALID', 'Unexpected input')
}

/** `getMaxWorkers.ts`. */
function maxWorkers(argv: JestArgv, options: Options): number {
  const parse = (value: unknown): number => {
    const parsed = Number.parseInt(String(value), 10)
    if (typeof value === 'string' && value.trim().endsWith('%') && parsed > 0 && parsed <= 100) {
      return Math.max(Math.floor((parsed / 100) * availableParallelism()), 1)
    }
    return parsed > 0 ? parsed : 1
  }
  if (argv.runInBand) return 1
  if (argv.maxWorkers) return parse(argv.maxWorkers)
  if (options.maxWorkers) return parse(options.maxWorkers)
  const cpus = availableParallelism()
  return Math.max(argv.watch || argv.watchAll ? Math.floor(cpus / 2) : cpus - 1, 1)
}

/** `parseShardPair.ts`. */
function parseShardPair(pair: string): { shardIndex: number; shardCount: number } {
  const [shardIndex, shardCount] = pair
    .split('/')
    .filter((d) => /^\d+$/.test(d))
    .map((d) => Number.parseInt(d, 10))
    .filter((n) => !Number.isNaN(n))
  if (shardIndex === undefined || shardCount === undefined || pair.split('/').length !== 2) {
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      'The shard option requires a string in the format of <n>/<m>.',
    )
  }
  if (shardCount < 1)
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      'The shard option <m> requires a positive integer.',
    )
  if (shardIndex < 1)
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      'The shard option <n> requires a positive integer.',
    )
  if (shardIndex > shardCount)
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      'The shard option <n> must be less or equal than <m>.',
    )
  return { shardIndex, shardCount }
}

/**
 * Normalizes one config as Jest's `normalize(initialOptions, argv, configPath, projectIndex,
 * isProjectOptions)` does: validation, `rootDir`, the preset, Jest's defaults, `<rootDir>` and
 * every path resolved. Throws `JestConfigError` where Jest throws.
 * @public
 */
export async function normalizeJestConfig(
  initialOptions: JestInitialOptions,
  context: {
    readonly configPath: string | null
    readonly projectIndex?: number
    readonly isProjectOptions?: boolean
  },
  options: NormalizeOptions = {},
): Promise<NormalizedJestOptions> {
  const { configPath } = context
  const projectIndex = context.projectIndex ?? Number.POSITIVE_INFINITY
  const validation = validateJestConfig(initialOptions, context.isProjectOptions ?? false)
  const argv: Run['argv'] = { ...(options.argv ?? {}), _: [...(options.argv?._ ?? [])] }

  const cwd = options.cwd ?? process.cwd()
  let merged = normalizeMissingOptions(
    normalizeRootDir(setFromArgv(initialOptions, argv), cwd),
    configPath,
    projectIndex,
  )
  const resolution = createJestResolution(
    options.requireResolve ?? projectJestRequireResolve(merged.rootDir),
  )
  const run: Run = {
    argv,
    cwd,
    resolution,
    bare: new Set(),
    ci: options.ci ?? ciFromEnvironment(options.env ?? process.env),
    seed: options.seed,
    jestFound: resolution.requireResolve('babel-jest') !== undefined,
  }
  const DEFAULTS = jestDefaults(run.ci)
  const rootDir = (): string => merged.rootDir

  if (merged.preset) {
    merged = (await setupPreset(
      merged,
      asString(merged.preset, 'preset'),
      run.resolution,
    )) as Options & { rootDir: string }
  }
  if (!merged.setupFilesAfterEnv) merged.setupFilesAfterEnv = []
  merged.testEnvironment = resolveTestEnvironment(
    run,
    rootDir(),
    asString(
      merged.testEnvironment || jestRequire(run, 'jest-environment-node'),
      'testEnvironment',
    ),
  )
  if (!merged.roots) merged.roots = [rootDir()]
  const testRunner = merged.testRunner
  if (
    !testRunner ||
    testRunner === 'circus' ||
    testRunner === 'jest-circus' ||
    testRunner === 'jest-circus/runner'
  ) {
    merged.testRunner = jestRequire(run, 'jest-circus/runner')
  } else if (testRunner === 'jasmine2') {
    const jasmine = run.resolution.requireResolve('jest-jasmine2')
    if (jasmine === undefined) {
      throw configError(
        'jest-jasmine is no longer shipped by default with Jest, you need to install it explicitly or provide an absolute path to Jest',
      )
    }
    merged.testRunner = jasmine
  }
  if (!merged.coverageDirectory) merged.coverageDirectory = resolve(rootDir(), 'coverage')
  setupBabelJest(run, merged)

  const cacheDirectorySet = Boolean(merged.cacheDirectory)
  const out: Options = { ...DEFAULTS }
  let resolver: string | undefined
  if (merged.resolver) {
    resolver =
      resolveOption(run, undefined, 'resolver', asString(merged.resolver, 'resolver'), rootDir()) ??
      undefined
    out.resolver = resolver
    if (resolver !== undefined) await run.resolution.preloadResolver(resolver)
  }
  validateExtensionsToTreatAsEsm(merged.extensionsToTreatAsEsm)
  if (merged.watchman == null) merged.watchman = DEFAULTS.watchman

  for (const key of Object.keys(merged)) {
    if (key === 'resolver') continue
    const option = merged[key]
    let value: unknown
    switch (key) {
      case 'setupFiles':
      case 'setupFilesAfterEnv':
      case 'snapshotSerializers':
        value =
          option &&
          asArray(option, key).map((filePath) =>
            resolveOption(run, resolver, key, asString(filePath, key), rootDir()),
          )
        break
      case 'modulePaths':
      case 'roots':
        value =
          option &&
          asArray(option, key).map((filePath) =>
            resolve(rootDir(), replaceRootDirInPath(rootDir(), asString(filePath, key))),
          )
        break
      case 'collectCoverageFrom':
        value = normalizeCollectCoverageFrom(option)
        break
      case 'cacheDirectory':
      case 'coverageDirectory':
        value = option && resolve(rootDir(), replaceRootDirInPath(rootDir(), asString(option, key)))
        break
      case 'dependencyExtractor':
      case 'globalSetup':
      case 'globalTeardown':
      case 'runtime':
      case 'snapshotResolver':
      case 'testResultsProcessor':
      case 'testRunner':
      case 'filter':
        value = option && resolveOption(run, resolver, key, asString(option, key), rootDir())
        break
      case 'runner': {
        let runnerPath: string | undefined
        if (Array.isArray(option)) {
          if (typeof option[0] !== 'string' || option[0].length === 0) {
            throw configError(
              '  Runner must be a string or a tuple [string, object].\n' +
                '  Configuration Documentation:\n' +
                '  https://jestjs.io/docs/configuration#runner-string--string-object',
            )
          }
          runnerPath = option[0]
          const runnerOptions: unknown = option[1]
          if (
            runnerOptions != null &&
            (typeof runnerOptions !== 'object' ||
              Array.isArray(runnerOptions) ||
              Object.getPrototypeOf(runnerOptions) !== Object.prototype)
          ) {
            throw configError(
              '  Runner options must be a plain object.\n' +
                '  Configuration Documentation:\n' +
                '  https://jestjs.io/docs/configuration#runner-string--string-object',
            )
          }
          out.runnerOptions = runnerOptions ?? {}
        } else {
          runnerPath = option as string | undefined
          out.runnerOptions = {}
        }
        value =
          runnerPath &&
          resolveWithPrefix(run, resolver, {
            filePath: runnerPath,
            humanOptionName: 'Jest Runner',
            optionName: 'runner',
            prefix: 'jest-runner-',
            rootDir: rootDir(),
          })
        break
      }
      case 'prettierPath':
        value =
          option &&
          resolveOption(
            run,
            resolver,
            key,
            asString(option, key),
            rootDir(),
            option === DEFAULTS.prettierPath,
          )
        break
      case 'moduleNameMapper': {
        const mapper = option
        value =
          mapper &&
          Object.keys(mapper).map((regex) => {
            const item: unknown = Reflect.get(mapper as object, regex)
            return item && [regex, replaceRootDirTags(rootDir(), item)]
          })
        break
      }
      case 'transform': {
        const transform = option
        value =
          transform &&
          Object.keys(transform).map((regex) => {
            const element: unknown = Reflect.get(transform as object, regex)
            const path = Array.isArray(element) ? element[0] : element
            return [
              regex,
              resolveOption(run, resolver, key, asString(path, key), rootDir()),
              Array.isArray(element) ? element[1] : {},
            ]
          })
        break
      }
      case 'reporters':
        value = normalizeReporters(run, option, rootDir())
        break
      case 'coveragePathIgnorePatterns':
      case 'modulePathIgnorePatterns':
      case 'testPathIgnorePatterns':
      case 'transformIgnorePatterns':
      case 'watchPathIgnorePatterns':
      case 'unmockedModulePathPatterns':
        value = normalizePatterns(option, key, rootDir())
        break
      case 'haste': {
        const haste: Record<string, unknown> = { ...(option as object) }
        if (haste.hasteImplModulePath != null) {
          haste.hasteImplModulePath =
            resolveOption(
              run,
              resolver,
              'haste.hasteImplModulePath',
              replaceRootDirInPath(
                rootDir(),
                asString(haste.hasteImplModulePath, 'haste.hasteImplModulePath'),
              ),
              rootDir(),
            ) || undefined
        }
        value = haste
        break
      }
      case 'projects':
        value = ((option || []) as readonly unknown[])
          .map((project) =>
            typeof project === 'string' ? replaceRootDirTags(rootDir(), project) : project,
          )
          .flatMap((project) => {
            const matches = typeof project === 'string' ? globSync(project, run.cwd) : []
            return matches.length > 0 ? matches : [project]
          })
        break
      case 'moduleDirectories':
      case 'testMatch': {
        const raw = Array.isArray(option) || option == null ? option : [option]
        const replaced = replaceRootDirTags(escapeGlobCharacters(rootDir()), raw)
        value = replaced
          ? Array.isArray(replaced)
            ? replaced.map((item: unknown) => replacePathSepForGlob(asString(item, key)))
            : replacePathSepForGlob(asString(replaced, key))
          : replaced
        break
      }
      case 'testRegex':
        value = option
          ? (Array.isArray(option) ? option : [option]).map((item: unknown) =>
              replacePathSepForRegex(asString(item, key)),
            )
          : []
        break
      case 'moduleFileExtensions':
        value = option
        if (
          Array.isArray(value) &&
          (merged.runner === undefined || merged.runner === DEFAULTS.runner) &&
          !value.includes('js')
        ) {
          throw configError(
            "  moduleFileExtensions must include 'js':\n" +
              '  but instead received:\n' +
              `    ${JSON.stringify(value)}\n  Please change your configuration to include 'js'.`,
          )
        }
        break
      case 'bail':
        if (typeof option === 'boolean') value = option ? 1 : 0
        else if (typeof option === 'string') {
          value = 1
          argv._.push(option)
        } else value = option
        break
      case 'displayName':
        if (typeof option === 'object' && option !== null) {
          const name: unknown = Reflect.get(option, 'name')
          const color: unknown = Reflect.get(option, 'color')
          if (!name || !color || typeof name !== 'string' || typeof color !== 'string') {
            throw configError(
              '  Option "displayName" must be of type:\n\n  {\n    name: string;\n    color: string;\n  }\n',
            )
          }
          value = option
        } else {
          const runner = merged.runner
          value = {
            color: displayNameColor(
              (Array.isArray(runner) ? runner[0] : runner) as string | undefined,
            ),
            name: option,
          }
        }
        break
      case 'testTimeout':
        if ((option as number) < 0) {
          throw configError('  Option "testTimeout" must be a natural number.')
        }
        value = option
        break
      case 'snapshotFormat':
        value = { ...(DEFAULTS.snapshotFormat as object), ...(option as object) }
        break
      case 'automock':
      case 'cache':
      case 'changedSince':
      case 'changedFilesWithAncestor':
      case 'clearMocks':
      case 'collectCoverage':
      case 'coverageProvider':
      case 'coverageReporters':
      case 'coverageThreshold':
      case 'detectLeaks':
      case 'detectOpenHandles':
      case 'errorOnDeprecated':
      case 'expand':
      case 'extensionsToTreatAsEsm':
      case 'globals':
      case 'fakeTimers':
      case 'findRelatedTests':
      case 'forceCoverageMatch':
      case 'forceExit':
      case 'injectGlobals':
      case 'lastCommit':
      case 'listTests':
      case 'logHeapUsage':
      case 'maxConcurrency':
      case 'id':
      case 'noStackTrace':
      case 'notify':
      case 'notifyMode':
      case 'onlyChanged':
      case 'onlyFailures':
      case 'openHandlesTimeout':
      case 'outputFile':
      case 'passWithNoTests':
      case 'randomize':
      case 'replname':
      case 'resetMocks':
      case 'resetModules':
      case 'restoreMocks':
      case 'rootDir':
      case 'runTestsByPath':
      case 'sandboxInjectedGlobals':
      case 'silent':
      case 'showSeed':
      case 'skipFilter':
      case 'skipNodeResolution':
      case 'slowTestThreshold':
      case 'testEnvironment':
      case 'testEnvironmentOptions':
      case 'testFailureExitCode':
      case 'testLocationInResults':
      case 'testNamePattern':
      case 'useStderr':
      case 'verbose':
      case 'waitForUnhandledRejections':
      case 'watch':
      case 'watchAll':
      case 'watchman':
      case 'workerGracefulExitTimeout':
      case 'workerThreads':
        value = option
        break
      case 'workerIdleMemoryLimit':
        value = stringToBytes(option, totalmem())
        break
      case 'watchPlugins':
        value = ((option || []) as readonly unknown[]).map((plugin) => {
          const [path, config] = typeof plugin === 'string' ? [plugin, {}] : (plugin as unknown[])
          return {
            config: typeof plugin === 'string' ? {} : config || {},
            path: resolveWithPrefix(run, resolver, {
              filePath: asString(path, 'watchPlugins'),
              humanOptionName: 'Watch plugin',
              optionName: 'watchPlugins',
              prefix: 'jest-watch-',
              rootDir: rootDir(),
            }),
          }
        })
        break
    }
    out[key] = value
  }

  const haste = merged.haste
  if (merged.watchman && isRecord(haste) && haste.enableSymlinks) {
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      validationText(
        'Validation Error',
        'haste.enableSymlinks is incompatible with watchman',
        'Either set haste.enableSymlinks to false or do not use watchman',
      ),
    )
  }
  for (const [index, root] of asArray(out.roots, 'roots').entries()) {
    verifyDirectoryExists(asString(root, 'roots'), `roots[${index}]`)
  }
  try {
    out.cwd = tryRealpath(run.cwd)
  } catch {
    // ignored, as upstream
  }
  out.testSequencer = resolveWithPrefix(run, resolver, {
    filePath: asString(
      merged.testSequencer || jestRequire(run, '@jest/test-sequencer'),
      'testSequencer',
    ),
    humanOptionName: 'Jest Sequencer',
    optionName: 'testSequencer',
    prefix: 'jest-sequencer-',
    rootDir: rootDir(),
  })
  if (out.runner === DEFAULTS.runner) out.runner = jestRequire(run, 'jest-runner')
  if (out.runnerOptions == null) out.runnerOptions = {}
  out.nonFlagArgs = argv._.map((arg) => `${arg}`)
  const testPathPatterns = [
    ...argv._.map((arg) => arg.toString()),
    ...(Array.isArray(argv.testPathPatterns) ? argv.testPathPatterns.map(String) : []),
  ]
  out.testPathPatterns = testPathPatterns
  out.json = !!argv.json
  out.testFailureExitCode = Number.parseInt(String(out.testFailureExitCode), 10)
  if (out.lastCommit || out.changedFilesWithAncestor || out.changedSince) out.onlyChanged = true
  if (argv.all) {
    out.onlyChanged = false
    out.onlyFailures = false
  } else if (testPathPatterns.length > 0) {
    out.onlyChanged = out.watch
  }
  out.randomize = out.randomize || argv.randomize
  out.showSeed = out.randomize || out.showSeed || argv.showSeed
  const bound = 2 ** 31
  const seed =
    typeof argv.seed === 'number'
      ? argv.seed
      : (run.seed ?? Math.floor((2 ** 32 - 1) * Math.random() - bound))
  if (seed < -bound || seed > bound - 1) {
    throw new JestConfigError(
      'JEST_CONFIG_INVALID',
      validationText(
        'Validation Error',
        `seed value must be between \`-0x80000000\` and \`0x7fffffff\` inclusive - instead it is ${seed}`,
      ),
    )
  }
  out.seed = seed
  if (!out.onlyChanged) out.onlyChanged = false
  if (!out.lastCommit) out.lastCommit = false
  if (!out.onlyFailures) out.onlyFailures = false
  if (!out.watchAll) out.watchAll = false
  if (out.moduleNameMapper === DEFAULTS.moduleNameMapper) out.moduleNameMapper = []
  if (argv.ci != null) out.ci = argv.ci
  out.updateSnapshot = out.ci && !argv.updateSnapshot ? 'none' : argv.updateSnapshot ? 'all' : 'new'
  out.collectTests = argv.collectTests || false
  out.maxConcurrency = Number.parseInt(String(out.maxConcurrency), 10)
  out.maxWorkers = maxWorkers(argv, merged)
  out.runInBand = argv.runInBand || false
  const testRegex = asArray(out.testRegex, 'testRegex')
  if (testRegex.length > 0 && merged.testMatch) {
    throw configError('  Configuration options testMatch and testRegex cannot be used together.')
  }
  if (testRegex.length > 0 && !merged.testMatch) out.testMatch = []
  if (argv.json && !argv.outputFile) {
    out.coverageReporters = ((out.coverageReporters || []) as readonly unknown[]).filter(
      (reporter) => reporter !== 'text',
    )
  }
  if (out.collectCoverage && argv.findRelatedTests) {
    let from = (out.nonFlagArgs as readonly string[]).map((filename) => {
      const replaced = replaceRootDirInPath(rootDir(), filename)
      return isAbsolute(replaced) ? relative(rootDir(), replaced) : replaced
    })
    if (out.collectCoverageFrom) {
      // `globsToMatcher` (picomatch) isn't ported; the CLI that passes `findRelatedTests` is T11.7's.
      from = [...(out.collectCoverageFrom as readonly string[]), ...from]
    }
    out.collectCoverageFrom = from
  } else if (!out.collectCoverageFrom) {
    out.collectCoverageFrom = []
  }
  if (!out.findRelatedTests) out.findRelatedTests = false
  if (!out.projects) out.projects = []
  if (!out.sandboxInjectedGlobals) out.sandboxInjectedGlobals = []
  if (!out.forceExit) out.forceExit = false
  if (!out.logHeapUsage) out.logHeapUsage = false
  if (typeof argv.shard === 'string') out.shard = parseShardPair(argv.shard)

  return {
    options: out,
    cacheDirectorySet,
    hasDeprecationWarnings: validation.hasDeprecationWarnings,
    diagnostics: validation.diagnostics,
  }
}

const GLOBAL_KEYS = [
  'bail',
  'changedFilesWithAncestor',
  'changedSince',
  'ci',
  'collectCoverage',
  'collectCoverageFrom',
  'collectTests',
  'coverageDirectory',
  'coverageProvider',
  'coverageReporters',
  'coverageThreshold',
  'detectLeaks',
  'detectOpenHandles',
  'errorOnDeprecated',
  'expand',
  'filter',
  'findRelatedTests',
  'forceExit',
  'globalSetup',
  'globalTeardown',
  'json',
  'lastCommit',
  'listTests',
  'logHeapUsage',
  'maxConcurrency',
  'maxWorkers',
  'noSCM',
  'noStackTrace',
  'nonFlagArgs',
  'notify',
  'notifyMode',
  'onlyChanged',
  'onlyFailures',
  'openHandlesTimeout',
  'outputFile',
  'passWithNoTests',
  'projects',
  'randomize',
  'replname',
  'reporters',
  'rootDir',
  'runInBand',
  'runTestsByPath',
  'seed',
  'shard',
  'showSeed',
  'silent',
  'skipFilter',
  'snapshotFormat',
  'testFailureExitCode',
  'testNamePattern',
  'testPathPatterns',
  'testResultsProcessor',
  'testSequencer',
  'testTimeout',
  'updateSnapshot',
  'useStderr',
  'verbose',
  'waitForUnhandledRejections',
  'watch',
  'watchAll',
  'watchPlugins',
  'watchman',
  'workerGracefulExitTimeout',
  'workerIdleMemoryLimit',
  'workerThreads',
] as const

const PROJECT_KEYS = [
  'automock',
  'cache',
  'cacheDirectory',
  'clearMocks',
  'collectCoverage',
  'collectCoverageFrom',
  'coverageDirectory',
  'coveragePathIgnorePatterns',
  'coverageProvider',
  'cwd',
  'dependencyExtractor',
  'detectLeaks',
  'detectOpenHandles',
  'displayName',
  'errorOnDeprecated',
  'extensionsToTreatAsEsm',
  'fakeTimers',
  'filter',
  'forceCoverageMatch',
  'globalSetup',
  'globalTeardown',
  'globals',
  'haste',
  'id',
  'injectGlobals',
  'moduleDirectories',
  'moduleFileExtensions',
  'moduleNameMapper',
  'modulePathIgnorePatterns',
  'modulePaths',
  'openHandlesTimeout',
  'prettierPath',
  'resetMocks',
  'resetModules',
  'resolver',
  'restoreMocks',
  'rootDir',
  'roots',
  'runner',
  'runnerOptions',
  'runtime',
  'sandboxInjectedGlobals',
  'setupFiles',
  'setupFilesAfterEnv',
  'silent',
  'skipFilter',
  'skipNodeResolution',
  'slowTestThreshold',
  'snapshotFormat',
  'snapshotResolver',
  'snapshotSerializers',
  'testEnvironment',
  'testEnvironmentOptions',
  'testLocationInResults',
  'testMatch',
  'testPathIgnorePatterns',
  'testRegex',
  'testRunner',
  'testTimeout',
  'transform',
  'transformIgnorePatterns',
  'unmockedModulePathPatterns',
  'verbose',
  'waitForUnhandledRejections',
  'watchPathIgnorePatterns',
] as const

function pick(options: Readonly<Options>, keys: readonly string[]): Readonly<Options> {
  const out: Options = {}
  for (const key of keys) out[key] = key === 'noSCM' ? undefined : options[key]
  return Object.freeze(out)
}

/**
 * Splits normalized options into the global and project configs (`groupOptions`, `index.ts`
 * L123-L245).
 * @public
 */
export function groupJestOptions(options: Readonly<Options>): {
  readonly globalConfig: JestGlobalConfig
  readonly projectConfig: JestProjectConfig
} {
  return {
    globalConfig: pick(options, GLOBAL_KEYS) as unknown as JestGlobalConfig,
    projectConfig: pick(options, PROJECT_KEYS) as unknown as JestProjectConfig,
  }
}

/** `readConfig`'s options beside `NormalizeOptions` (its positional arguments, by name). */
export interface ReadJestConfigOptions extends NormalizeOptions {
  /** Read the config from the path, ignoring `argv.config` (Jest's `skipArgvConfigOption`). */
  readonly skipArgvConfigOption?: boolean
  /** For an inline project object: its parent config's directory. */
  readonly parentConfigDirname?: string | null
  readonly projectIndex?: number
  readonly skipMultipleConfigError?: boolean
  /** Validate as a project of `projects` (Jest's `isProjectOptions`). */
  readonly isProjectOptions?: boolean
}

/** `readConfig`'s result, with the warnings validation produced. */
export interface JestReadOutcome extends JestReadConfig {
  /** Whether the config named a `cacheDirectory` (see `NormalizedJestOptions`). */
  readonly cacheDirectorySet: boolean
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Normalizes a config `loadJestConfig` read: the second half of `readConfig`.
 * @public
 */
export async function normalizeLoadedJestConfig(
  loaded: { readonly options: JestInitialOptions; readonly configPath: string | null },
  options: ReadJestConfigOptions = {},
): Promise<JestReadOutcome> {
  const normalized = await normalizeJestConfig(
    loaded.options,
    {
      configPath: loaded.configPath,
      projectIndex: options.projectIndex ?? Number.POSITIVE_INFINITY,
      isProjectOptions: options.isProjectOptions ?? false,
    },
    options,
  )
  return {
    configPath: loaded.configPath,
    ...groupJestOptions(normalized.options),
    hasDeprecationWarnings: normalized.hasDeprecationWarnings,
    cacheDirectorySet: normalized.cacheDirectorySet,
    diagnostics: normalized.diagnostics,
  }
}

/**
 * Reads and normalizes one config as Jest's `readConfig(argv, packageRootOrConfig, …)` does:
 * `packageRootOrConfig` is a path (a config file, or a directory searched as `jest` would), or an
 * inline project object with `parentConfigDirname`.
 * @public
 */
export function readJestConfig(
  packageRootOrConfig: string | JestInitialOptions,
  options: ReadJestConfigOptions = {},
): Promise<JestReadOutcome> {
  return readOne(packageRootOrConfig, options, new Map())
}

/**
 * The config files a `readJestConfigs` run has loaded, by path. Jest loads a file again each time
 * it reads it (the root of a run with no `projects`, or one whose `projects` list its own
 * directory, is read twice); ours loads it once and normalizes it each time, so the configs and
 * the warnings are Jest's and a config function runs once.
 */
type LoadedFiles = Map<string, JestInitialOptions>

async function readOne(
  packageRootOrConfig: string | JestInitialOptions,
  options: ReadJestConfigOptions,
  loadedFiles: LoadedFiles,
): Promise<JestReadOutcome> {
  const cwd = options.cwd ?? process.cwd()
  const config = options.argv?.config
  let initial: JestInitialOptions
  let configPath: string | null
  if (typeof packageRootOrConfig !== 'string') {
    if (!options.parentConfigDirname) {
      throw new JestConfigError(
        'JEST_CONFIG_INVALID',
        'Jest: Cannot use configuration as an object without a file path.',
      )
    }
    initial = inlineProjectOptions(packageRootOrConfig, options.parentConfigDirname)
    configPath = null
  } else if (typeof config === 'string' && isJSONString(config)) {
    const loaded = await loadJestConfig({ kind: 'inline', path: packageRootOrConfig, text: config })
    initial = loaded.options
    configPath = null
  } else {
    const target =
      !options.skipArgvConfigOption && typeof config === 'string' ? config : packageRootOrConfig
    const path = resolveJestConfigPath(target, cwd, {
      skipMultipleConfigError: options.skipMultipleConfigError ?? false,
    })
    const loaded = loadedFiles.get(path) ?? (await loadJestConfig(sourceOf(path))).options
    loadedFiles.set(path, loaded)
    initial = loaded
    configPath = path
  }
  return normalizeLoadedJestConfig({ options: initial, configPath }, options)
}

/** `readConfigs`' result, with every project's warnings. */
export interface JestReadConfigsOutcome {
  readonly globalConfig: JestGlobalConfig
  readonly configs: readonly JestProjectConfig[]
  /** Per config, whether it named a `cacheDirectory` (see `NormalizedJestOptions`). */
  readonly cacheDirectorySet: readonly boolean[]
  readonly hasDeprecationWarnings: boolean
  readonly diagnostics: readonly Diagnostic[]
}

function duplicateMessage(configPath: string, first: unknown, second: unknown): string {
  // index.ts L263-L276
  return `Whoops! Two projects resolved to the same config path: ${configPath}:

  Project 1: ${String(first)}
  Project 2: ${String(second)}

This usually means that your "projects" config includes a directory that doesn't have any configuration recognizable by Jest. Please fix it.
`
}

/**
 * Reads every project of a run as Jest's `readConfigs(argv, projectPaths)` does: the first path's
 * config, then each entry of its `projects` (globs expanded, paths to directories or config
 * files, inline objects), validated as projects unless one is the root config itself. Running
 * several is `runProjects`'s (D29); this reads them. `root` is the first path's config when the caller has
 * loaded it already (the config reader's `resolve` step), so it isn't loaded again. Each config
 * file is loaded once, and normalized as often as Jest reads it (see `LoadedFiles`).
 * @public
 */
export async function readJestConfigs(
  projectPaths: readonly string[],
  options: NormalizeOptions = {},
  root?: JestLoadedConfig,
): Promise<JestReadConfigsOutcome> {
  const cwd = options.cwd ?? process.cwd()
  const argv = options.argv ?? {}
  const loadedFiles: LoadedFiles = new Map()
  if (root?.configPath) loadedFiles.set(root.configPath, root.options)
  let globalConfig: JestGlobalConfig | undefined
  let hasDeprecationWarnings = false
  let configs: JestProjectConfig[] = []
  let cacheDirectorySet: boolean[] = []
  let projects: readonly (string | Readonly<Record<string, unknown>>)[] = projectPaths
  let configPath: string | null | undefined
  const diagnostics: Diagnostic[] = []
  if (projectPaths.length === 1) {
    const parsed =
      root === undefined
        ? await readOne(projectPaths[0] ?? cwd, options, loadedFiles)
        : await normalizeLoadedJestConfig(root, options)
    configPath = parsed.configPath
    hasDeprecationWarnings = parsed.hasDeprecationWarnings
    globalConfig = parsed.globalConfig
    configs = [parsed.projectConfig]
    cacheDirectorySet = [parsed.cacheDirectorySet]
    diagnostics.push(...parsed.diagnostics)
    if (globalConfig.projects.length > 0) projects = globalConfig.projects
  } else if (projectPaths.length > 1 && argv.config) {
    const parsed = await readOne(cwd, options, loadedFiles)
    configPath = parsed.configPath
    hasDeprecationWarnings = parsed.hasDeprecationWarnings
    globalConfig = parsed.globalConfig
    diagnostics.push(...parsed.diagnostics)
  }
  if (projects.length > 0) {
    const realCwd = cwd
    const projectIsCwd = projects[0] === realCwd
    // index.ts L414-L425: a file a glob matched that can't be a config is dropped.
    const kept = projects.filter(
      (root) =>
        typeof root !== 'string' ||
        !existsSync(resolve(cwd, root)) ||
        lstatSync(resolve(cwd, root)).isDirectory() ||
        JEST_CONFIG_EXT_ORDER.some((ext) => root.endsWith(ext)),
    )
    const parentConfigDirname = configPath ? dirname(configPath) : realCwd
    const parsedConfigs = await Promise.all(
      kept.map(async (root, projectIndex) => {
        const onlyProject = projectIndex === 0 && projects.length === 1
        const skipArgvConfigOption = !(onlyProject && projectIsCwd)
        const suppliesGlobalConfig =
          (globalConfig == null && projectIndex === 0) ||
          (configPath != null &&
            typeof root === 'string' &&
            resolveJestConfigPath(root, realCwd, { skipMultipleConfigError: projectIsCwd }) ===
              configPath)
        return readOne(
          root,
          {
            ...options,
            skipArgvConfigOption,
            parentConfigDirname,
            projectIndex,
            skipMultipleConfigError: projectIsCwd,
            isProjectOptions: skipArgvConfigOption && !suppliesGlobalConfig,
          },
          loadedFiles,
        )
      }),
    )
    if (projects.length > 1) {
      const seen = new Map<string, number>()
      parsedConfigs.forEach((parsed, index) => {
        if (parsed.configPath === null) return
        const earlier = seen.get(parsed.configPath)
        if (earlier !== undefined) {
          throw new JestConfigError(
            'JEST_CONFIG_DUPLICATE_PROJECT',
            duplicateMessage(parsed.configPath, projects[index], projects[earlier]),
          )
        }
        seen.set(parsed.configPath, index)
      })
    }
    configs = parsedConfigs.map((parsed) => parsed.projectConfig)
    cacheDirectorySet = parsedConfigs.map((parsed) => parsed.cacheDirectorySet)
    for (const parsed of parsedConfigs) diagnostics.push(...parsed.diagnostics)
    if (!hasDeprecationWarnings) {
      hasDeprecationWarnings = parsedConfigs.some((parsed) => parsed.hasDeprecationWarnings)
    }
    if (globalConfig === undefined) globalConfig = parsedConfigs[0]?.globalConfig
  }
  if (globalConfig === undefined || configs.length === 0) {
    throw new JestConfigError(
      'JEST_CONFIG_NOT_FOUND',
      'jest: No configuration found for any project.',
    )
  }
  return { globalConfig, configs, cacheDirectorySet, hasDeprecationWarnings, diagnostics }
}
