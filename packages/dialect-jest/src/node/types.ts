// The shapes the Jest config reader produces: `@jest/types` 30.5's `Config.ProjectConfig` and
// `Config.GlobalConfig`, key for key (the split `jest-config` `index.ts` L123-L245 makes). Every key
// is present, as in Jest's frozen objects; one Jest leaves unset holds `undefined`. Values a user
// passes through untouched (`globals`, `testEnvironmentOptions`, …) stay `unknown` inside.

/**
 * A Jest config as a file gives it (`Config.InitialOptions`), before validation. The loader sets
 * `rootDir`.
 * @public
 */
export type JestInitialOptions = Readonly<Record<string, unknown>>

/** @public */
export interface JestDisplayName {
  readonly name: string
  readonly color: string
}

/** A transform rule after normalization: pattern, resolved transformer, options. @public */
export type JestTransformEntry = readonly [
  pattern: string,
  path: string,
  options: Readonly<Record<string, unknown>>,
]

/** A `moduleNameMapper` rule after normalization: pattern, target(s). @public */
export type JestMapperEntry = readonly [pattern: string, target: string | readonly string[]]

/** A reporter after normalization: name or resolved path, options. @public */
export type JestReporterEntry = readonly [name: string, options: Readonly<Record<string, unknown>>]

/**
 * One project's normalized config: what `readConfig(...).projectConfig` returns.
 * @public
 */
export interface JestProjectConfig {
  readonly automock: boolean
  readonly cache: boolean
  readonly cacheDirectory: string
  readonly clearMocks: boolean
  readonly collectCoverage: boolean
  readonly collectCoverageFrom: readonly string[]
  readonly coverageDirectory: string
  readonly coveragePathIgnorePatterns: readonly string[]
  readonly coverageProvider: string
  readonly cwd: string
  readonly dependencyExtractor: string | undefined
  readonly detectLeaks: boolean
  readonly detectOpenHandles: boolean
  readonly displayName: JestDisplayName | undefined
  readonly errorOnDeprecated: boolean
  readonly extensionsToTreatAsEsm: readonly string[]
  readonly fakeTimers: Readonly<Record<string, unknown>>
  readonly filter: string | undefined
  readonly forceCoverageMatch: readonly string[]
  readonly globalSetup: string | undefined
  readonly globalTeardown: string | undefined
  readonly globals: Readonly<Record<string, unknown>>
  readonly haste: Readonly<Record<string, unknown>>
  readonly id: string
  readonly injectGlobals: boolean
  readonly moduleDirectories: readonly string[]
  readonly moduleFileExtensions: readonly string[]
  readonly moduleNameMapper: readonly JestMapperEntry[]
  readonly modulePathIgnorePatterns: readonly string[]
  readonly modulePaths: readonly string[] | undefined
  readonly openHandlesTimeout: number
  readonly prettierPath: string | null
  readonly resetMocks: boolean
  readonly resetModules: boolean
  readonly resolver: string | undefined
  readonly restoreMocks: boolean
  readonly rootDir: string
  readonly roots: readonly string[]
  readonly runner: string
  readonly runnerOptions: Readonly<Record<string, unknown>>
  readonly runtime: string | undefined
  readonly sandboxInjectedGlobals: readonly string[]
  readonly setupFiles: readonly string[]
  readonly setupFilesAfterEnv: readonly string[]
  readonly silent: boolean | undefined
  readonly skipFilter: boolean
  readonly skipNodeResolution: boolean | undefined
  readonly slowTestThreshold: number
  readonly snapshotFormat: Readonly<Record<string, unknown>>
  readonly snapshotResolver: string | undefined
  readonly snapshotSerializers: readonly string[]
  readonly testEnvironment: string
  readonly testEnvironmentOptions: Readonly<Record<string, unknown>>
  readonly testLocationInResults: boolean
  readonly testMatch: readonly string[]
  readonly testPathIgnorePatterns: readonly string[]
  readonly testRegex: readonly string[]
  readonly testRunner: string
  readonly testTimeout: number | undefined
  readonly transform: readonly JestTransformEntry[]
  readonly transformIgnorePatterns: readonly string[]
  readonly unmockedModulePathPatterns: readonly string[] | undefined
  readonly verbose: boolean | undefined
  readonly waitForUnhandledRejections: boolean
  readonly watchPathIgnorePatterns: readonly string[]
}

/**
 * The run-wide config: what `readConfig(...).globalConfig` returns. `testPathPatterns` holds the
 * patterns (Jest wraps them in a `TestPathPatterns` object).
 * @public
 */
export interface JestGlobalConfig {
  readonly bail: number
  readonly changedFilesWithAncestor: boolean
  readonly changedSince: string | undefined
  readonly ci: boolean
  readonly collectCoverage: boolean
  readonly collectCoverageFrom: readonly string[]
  readonly collectTests: boolean
  readonly coverageDirectory: string
  readonly coverageProvider: string
  readonly coverageReporters: readonly unknown[]
  readonly coverageThreshold: Readonly<Record<string, unknown>> | undefined
  readonly detectLeaks: boolean
  readonly detectOpenHandles: boolean
  readonly errorOnDeprecated: boolean
  readonly expand: boolean
  readonly filter: string | undefined
  readonly findRelatedTests: boolean
  readonly forceExit: boolean
  readonly globalSetup: string | undefined
  readonly globalTeardown: string | undefined
  readonly json: boolean
  readonly lastCommit: boolean
  readonly listTests: boolean
  readonly logHeapUsage: boolean
  readonly maxConcurrency: number
  readonly maxWorkers: number
  readonly noSCM: undefined
  readonly noStackTrace: boolean
  readonly nonFlagArgs: readonly string[]
  readonly notify: boolean
  readonly notifyMode: string
  readonly onlyChanged: boolean
  readonly onlyFailures: boolean
  readonly openHandlesTimeout: number
  readonly outputFile: string | undefined
  readonly passWithNoTests: boolean
  readonly projects: readonly (string | Readonly<Record<string, unknown>>)[]
  readonly randomize: boolean | undefined
  readonly replname: string | undefined
  readonly reporters: readonly JestReporterEntry[] | undefined
  readonly rootDir: string
  readonly runInBand: boolean
  readonly runTestsByPath: boolean
  readonly seed: number
  readonly shard: { readonly shardIndex: number; readonly shardCount: number } | undefined
  readonly showSeed: boolean | undefined
  readonly silent: boolean | undefined
  readonly skipFilter: boolean
  readonly snapshotFormat: Readonly<Record<string, unknown>>
  readonly testFailureExitCode: number
  readonly testNamePattern: string | undefined
  readonly testPathPatterns: readonly string[]
  readonly testResultsProcessor: string | undefined
  readonly testSequencer: string
  readonly testTimeout: number | undefined
  readonly updateSnapshot: 'all' | 'new' | 'none'
  readonly useStderr: boolean
  readonly verbose: boolean | undefined
  readonly waitForUnhandledRejections: boolean
  readonly watch: boolean
  readonly watchAll: boolean
  readonly watchPlugins: readonly { readonly path: string; readonly config: unknown }[] | undefined
  readonly watchman: boolean
  readonly workerGracefulExitTimeout: number | undefined
  readonly workerIdleMemoryLimit: number | undefined
  readonly workerThreads: boolean | undefined
}

/**
 * The CLI values the config reader honours, as Jest's `argv` carries them (`Config.Argv`). B14b's
 * reader passes `{}` unless a caller sets some; the CLI parser (T11.7) fills it.
 * @public
 */
export type JestArgv = Readonly<Record<string, unknown>> & {
  readonly _?: readonly (string | number)[]
}

/**
 * A config as `loadJestConfig` loads it (the reader's `load` step): the file's options with
 * `rootDir` set, and its path (`null` for inline JSON).
 * @public
 */
export interface JestLoadedConfig {
  readonly options: JestInitialOptions
  readonly configPath: string | null
}

/**
 * One read config: `readConfig`'s result.
 * @public
 */
export interface JestReadConfig {
  readonly configPath: string | null
  readonly globalConfig: JestGlobalConfig
  readonly projectConfig: JestProjectConfig
  readonly hasDeprecationWarnings: boolean
}
