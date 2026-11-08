// Jest 30.5's example configs, which validation checks keys and types against: `jest-config`
// `ValidConfig.ts` L16-L227 (`initialOptions`) and L229-L345 (`initialProjectOptions`), copied as
// data in the same key order (the "did you mean" search takes the first close key in that order).
// A key in the first and not the second is global-only. `multipleValid` marks a key that takes
// any of several shapes (`jest-validate` `multipleValidOptions`).
import { NODE_MODULES_REGEXP } from './paths.ts'

const MULTIPLE: unique symbol = Symbol('provino.jest.multipleValidOptions')

/** An array of alternative example values (`jest-validate` `condition.ts` L34-L50). */
export type MultipleValid = readonly unknown[] & { readonly [MULTIPLE]: true }

/** `multipleValidOptions(...)`. */
export function multipleValid(...values: readonly unknown[]): MultipleValid {
  return Object.assign([...values], { [MULTIPLE]: true as const })
}

/** `getValues` (`condition.ts` L23-L32): the alternatives, or the one example. */
export function exampleValues(example: unknown): readonly unknown[] {
  return Array.isArray(example) && MULTIPLE in example ? example : [example]
}

/** pretty-format 30.5.1's `DEFAULT_OPTIONS` (`index.ts` L407-L421), `snapshotFormat`'s example. */
const PRETTY_FORMAT_DEFAULTS: Readonly<Record<string, unknown>> = {
  callToJSON: true,
  compareKeys: undefined,
  escapeRegex: false,
  escapeString: true,
  highlight: false,
  indent: 2,
  maxDepth: Number.POSITIVE_INFINITY,
  maxWidth: Number.POSITIVE_INFINITY,
  min: false,
  plugins: [],
  printBasicPrototype: true,
  printFunctionName: true,
  theme: { comment: 'gray', content: 'reset', prop: 'yellow', tag: 'cyan', value: 'green' },
}

const FAKE_TIMERS = {
  advanceTimers: multipleValid(40, true),
  doNotFake: [
    'Date',
    'hrtime',
    'nextTick',
    'performance',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'setImmediate',
    'clearImmediate',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
  ],
  enableGlobally: true,
  legacyFakeTimers: false,
  now: 1_483_228_800_000,
  timerLimit: 1000,
}

const HASTE = {
  computeSha1: true,
  defaultPlatform: 'ios',
  enableSymlinks: false,
  forceNodeFilesystemAPI: true,
  hasteImplModulePath: '<rootDir>/haste_impl.js',
  hasteMapModulePath: '',
  platforms: ['ios', 'android'],
  retainAllFiles: false,
  throwOnModuleCollision: false,
}

const MODULE_FILE_EXTENSIONS = [
  'js',
  'mjs',
  'cjs',
  'json',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'node',
]

const DISPLAY_NAME = multipleValid('test-config', { color: 'blue', name: 'test-config' })
const RUNNER = multipleValid('jest-runner', ['jest-runner', ['jest-runner', { option: true }]])
const TEST_REGEX = multipleValid('(/__tests__/.*|(\\.|/)(test|spec))\\.[mc]?[jt]sx?$', [
  '/__tests__/\\.test\\.[mc]?[jt]sx?$',
  '/__tests__/\\.spec\\.[mc]?[jt]sx?$',
])
const TEST_MATCH_DEFAULT = [
  '**/__tests__/**/*.?([mc])[jt]s?(x)',
  '**/?(*.)+(spec|test).?([mc])[jt]s?(x)',
]

/**
 * `initialOptions`: every key a root config may hold.
 * @internal
 */
export const VALID_CONFIG: Readonly<Record<string, unknown>> = {
  automock: false,
  bail: multipleValid(false, 0),
  cache: true,
  cacheDirectory: '/tmp/user/jest',
  changedFilesWithAncestor: false,
  changedSince: 'master',
  ci: false,
  clearMocks: false,
  collectCoverage: true,
  collectCoverageFrom: ['src', '!public'],
  collectTests: false,
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [NODE_MODULES_REGEXP],
  coverageProvider: 'v8',
  coverageReporters: ['json', 'text', 'lcov', 'clover'],
  coverageThreshold: {
    global: { branches: 50, functions: 100, lines: 100, statements: 100 },
  },
  dependencyExtractor: '<rootDir>/dependencyExtractor.js',
  detectLeaks: false,
  detectOpenHandles: false,
  displayName: DISPLAY_NAME,
  errorOnDeprecated: false,
  expand: false,
  extensionsToTreatAsEsm: [],
  fakeTimers: FAKE_TIMERS,
  filter: '<rootDir>/filter.js',
  findRelatedTests: false,
  forceCoverageMatch: ['**/*.t.js'],
  forceExit: false,
  globalSetup: 'setup.js',
  globalTeardown: 'teardown.js',
  globals: { __DEV__: true },
  haste: HASTE,
  id: 'string',
  injectGlobals: true,
  json: false,
  lastCommit: false,
  listTests: false,
  logHeapUsage: true,
  maxConcurrency: 5,
  maxWorkers: '50%',
  moduleDirectories: ['node_modules'],
  moduleFileExtensions: MODULE_FILE_EXTENSIONS,
  moduleNameMapper: { '^React$': '<rootDir>/node_modules/react' },
  modulePathIgnorePatterns: ['<rootDir>/build/'],
  modulePaths: ['/shared/vendor/modules'],
  noStackTrace: false,
  notify: false,
  notifyMode: 'failure-change',
  onlyChanged: false,
  onlyFailures: false,
  openHandlesTimeout: 1000,
  outputFile: '/tmp/jest-results.json',
  passWithNoTests: false,
  preset: 'react-native',
  prettierPath: '<rootDir>/node_modules/prettier',
  projects: ['project-a', 'project-b/'],
  randomize: false,
  replname: 'jest-hierarchical-repl',
  reporters: ['default', 'custom-reporter-1', ['custom-reporter-2', { configValue: true }]],
  resetMocks: false,
  resetModules: false,
  resolver: '<rootDir>/resolver.js',
  restoreMocks: false,
  rootDir: '/',
  roots: ['<rootDir>'],
  runTestsByPath: false,
  runner: RUNNER,
  runtime: '<rootDir>',
  sandboxInjectedGlobals: [],
  setupFiles: ['<rootDir>/setup.js'],
  setupFilesAfterEnv: ['<rootDir>/testSetupFile.js'],
  showSeed: false,
  silent: true,
  skipFilter: false,
  skipNodeResolution: false,
  slowTestThreshold: 5,
  snapshotFormat: PRETTY_FORMAT_DEFAULTS,
  snapshotResolver: '<rootDir>/snapshotResolver.js',
  snapshotSerializers: ['my-serializer-module'],
  testEnvironment: 'jest-environment-node',
  testEnvironmentOptions: { url: 'http://localhost', userAgent: 'Agent/007' },
  testFailureExitCode: 1,
  testLocationInResults: false,
  testMatch: multipleValid(
    '**/__tests__/**/?(*.)+(spec|test).?([mc])[jt]s?(x)',
    TEST_MATCH_DEFAULT,
  ),
  testNamePattern: 'test signature',
  testPathIgnorePatterns: [NODE_MODULES_REGEXP],
  testRegex: TEST_REGEX,
  testResultsProcessor: 'processor-node-module',
  testRunner: 'circus',
  testSequencer: '@jest/test-sequencer',
  testTimeout: 5000,
  transform: { '\\.js$': '<rootDir>/preprocessor.js' },
  transformIgnorePatterns: [NODE_MODULES_REGEXP],
  unmockedModulePathPatterns: ['mock'],
  updateSnapshot: true,
  useStderr: false,
  verbose: false,
  waitForUnhandledRejections: false,
  watch: false,
  watchAll: false,
  watchPathIgnorePatterns: ['<rootDir>/e2e/'],
  watchPlugins: [
    'path/to/yourWatchPlugin',
    ['jest-watch-typeahead/filename', { key: 'k', prompt: 'do something with my custom prompt' }],
  ],
  watchman: true,
  workerGracefulExitTimeout: 500,
  workerIdleMemoryLimit: multipleValid(0.2, '50%'),
  workerThreads: true,
}

/**
 * `initialProjectOptions`: the keys a project in `projects` may hold.
 * @internal
 */
export const VALID_PROJECT_CONFIG: Readonly<Record<string, unknown>> = {
  automock: false,
  cache: true,
  cacheDirectory: '/tmp/user/jest',
  clearMocks: false,
  collectCoverage: false,
  collectCoverageFrom: ['src', '!public'],
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [NODE_MODULES_REGEXP],
  coverageProvider: 'v8',
  dependencyExtractor: '<rootDir>/dependencyExtractor.js',
  detectLeaks: false,
  detectOpenHandles: false,
  displayName: DISPLAY_NAME,
  errorOnDeprecated: false,
  extensionsToTreatAsEsm: [],
  fakeTimers: FAKE_TIMERS,
  filter: '<rootDir>/filter.js',
  forceCoverageMatch: ['**/*.t.js'],
  globalSetup: 'setup.js',
  globalTeardown: 'teardown.js',
  globals: { __DEV__: true },
  haste: HASTE,
  id: 'string',
  injectGlobals: true,
  moduleDirectories: ['node_modules'],
  moduleFileExtensions: MODULE_FILE_EXTENSIONS,
  moduleNameMapper: { '^React$': '<rootDir>/node_modules/react' },
  modulePathIgnorePatterns: ['<rootDir>/build/'],
  modulePaths: ['/shared/vendor/modules'],
  openHandlesTimeout: 1000,
  preset: 'react-native',
  prettierPath: '<rootDir>/node_modules/prettier',
  resetMocks: false,
  resetModules: false,
  resolver: '<rootDir>/resolver.js',
  restoreMocks: false,
  rootDir: '/',
  roots: ['<rootDir>'],
  runner: RUNNER,
  runtime: '<rootDir>',
  sandboxInjectedGlobals: [],
  setupFiles: ['<rootDir>/setup.js'],
  setupFilesAfterEnv: ['<rootDir>/testSetupFile.js'],
  silent: false,
  skipFilter: false,
  skipNodeResolution: false,
  slowTestThreshold: 5,
  snapshotFormat: PRETTY_FORMAT_DEFAULTS,
  snapshotResolver: '<rootDir>/snapshotResolver.js',
  snapshotSerializers: ['my-serializer-module'],
  testEnvironment: 'jest-environment-node',
  testEnvironmentOptions: { url: 'http://localhost', userAgent: 'Agent/007' },
  testLocationInResults: false,
  testMatch: TEST_MATCH_DEFAULT,
  testPathIgnorePatterns: [NODE_MODULES_REGEXP],
  testRegex: TEST_REGEX,
  testRunner: 'circus',
  testTimeout: 5000,
  transform: { '\\.js$': '<rootDir>/preprocessor.js' },
  transformIgnorePatterns: [NODE_MODULES_REGEXP],
  unmockedModulePathPatterns: ['mock'],
  verbose: false,
  waitForUnhandledRejections: false,
  watchPathIgnorePatterns: ['<rootDir>/e2e/'],
}

/**
 * The global-only keys: in the root config's table, not the project's (`normalize.ts` L66-L70).
 * @internal
 */
export const GLOBAL_ONLY_OPTIONS: ReadonlySet<string> = new Set(
  Object.keys(VALID_CONFIG).filter((key) => !Object.hasOwn(VALID_PROJECT_CONFIG, key)),
)
