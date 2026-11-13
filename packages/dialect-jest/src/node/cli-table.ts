// T11.7: the options of the Jest 30.5.2 command line, `jest-cli` `src/args.ts` `options` (copied
// as data: the keys in its order, each one's type, alias, `requiresArg`, `string` and `choices`,
// and its description). The `support` and `owner` fields are ours (T11.7's classification: what
// Provino does with the flag today). `cli.test.ts` fails when `jest-cli`'s own table gains, loses
// or changes an option, and prints how many options each `support` holds.

/**
 * What Provino does with a flag.
 *
 * - `request`: it becomes a field of the `RunRequest`.
 * - `config`: a Jest config option given on the command line; it reaches the config reader through
 *   the parsed argv (`setFromArgv`), so the parser adds nothing.
 * - `accepted`: harmless here; nothing to say.
 * - `warn`: accepted, but has no effect yet (`owner` is the task that will apply it); a warning.
 * - `refuse`: no backend yet (`owner` is the task that builds it); an error diagnostic when given.
 * @public
 */
export type JestCliSupport = 'request' | 'config' | 'accepted' | 'warn' | 'refuse'

/**
 * One option of Jest's command line.
 * @public
 */
export interface JestCliOption {
  /** yargs' type for the option; absent for the two choice-only options. */
  readonly type?: 'boolean' | 'string' | 'number' | 'array'
  /** The single-letter or short alias (`-b`, `-w`, `--env`). */
  readonly alias?: string
  /** yargs `requiresArg`: the flag needs a value after it. */
  readonly requiresArg?: true
  /** yargs `string`: an array option whose elements stay strings (no number coercion). */
  readonly string?: true
  /** yargs `choices`: the only values the option accepts. */
  readonly choices?: readonly string[]
  readonly description: string
  readonly support: JestCliSupport
  /** For `warn` and `refuse`: the task, track or decision that owns the missing piece. */
  readonly owner?: string
}

/**
 * Jest 30.5.2's CLI options: `jest-cli` `src/args.ts`'s `options` object (`build/index.js` L70
 * onward), the keys in its order, each with Provino's classification.
 * @public
 */
export const JEST_CLI_OPTIONS: Readonly<Record<string, JestCliOption>> = {
  all: {
    type: 'boolean',
    description:
      'The opposite of `onlyChanged`. If `onlyChanged` is set by default, running jest with `--all` will force Jest to run all tests instead of running only tests related to changed files.',
    support: 'accepted',
  },
  automock: { type: 'boolean', description: 'Automock all files by default.', support: 'config' },
  bail: {
    type: 'boolean',
    alias: 'b',
    description: 'Exit the test suite immediately after `n` number of failing tests.',
    support: 'config',
  },
  cache: {
    type: 'boolean',
    description: 'Whether to use the transform cache. Disable the cache using --no-cache.',
    support: 'request',
  },
  cacheDirectory: {
    type: 'string',
    requiresArg: true,
    description: 'The directory where Jest should store its cached  dependency information.',
    support: 'config',
  },
  changedFilesWithAncestor: {
    type: 'boolean',
    description:
      'Runs tests related to the current changes and the changes made in the last commit. Behaves similarly to `--onlyChanged`.',
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  changedSince: {
    type: 'string',
    requiresArg: true,
    description:
      'Runs tests related to the changes since the provided branch. If the current branch has diverged from the given branch, then only changes made locally will be tested. Behaves similarly to `--onlyChanged`.',
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  ci: {
    type: 'boolean',
    description:
      'Whether to run Jest in continuous integration (CI) mode. This option is on by default in most popular CI environments. It will prevent snapshots from being written unless explicitly requested.',
    support: 'request',
  },
  clearCache: {
    type: 'boolean',
    description:
      'Clears the configured Jest cache directory and then exits. Default directory can be found by calling jest --showConfig',
    support: 'request',
  },
  clearMocks: {
    type: 'boolean',
    description:
      'Automatically clear mock calls, instances, contexts and results before every test. Equivalent to calling jest.clearAllMocks() before each test.',
    support: 'config',
  },
  collectCoverage: {
    type: 'boolean',
    description: 'Alias for --coverage.',
    support: 'refuse',
    owner: 'T8.8',
  },
  collectCoverageFrom: {
    type: 'string',
    requiresArg: true,
    description:
      'A glob pattern relative to <rootDir> matching the files that coverage info needs to be collected from.',
    support: 'config',
  },
  collectTests: {
    type: 'boolean',
    description:
      'Discover and report all test cases without executing them. Prints a tree of test suites and test names.',
    support: 'refuse',
    owner: 'T11.8',
  },
  color: {
    type: 'boolean',
    description:
      'Forces test results output color highlighting (even if stdout is not a TTY). Set to false if you would like to have no colors.',
    support: 'request',
  },
  colors: { type: 'boolean', description: 'Alias for `--color`.', support: 'request' },
  config: {
    type: 'string',
    alias: 'c',
    requiresArg: true,
    description:
      'The path to a jest config file specifying how to find and execute tests. If no rootDir is set in the config, the directory containing the config file is assumed to be the rootDir for the project. This can also be a JSON encoded value which Jest will use as configuration.',
    support: 'request',
  },
  coverage: {
    type: 'boolean',
    description:
      'Indicates that test coverage information should be collected and reported in the output.',
    support: 'refuse',
    owner: 'T8.8',
  },
  coverageDirectory: {
    type: 'string',
    requiresArg: true,
    description: 'The directory where Jest should output its coverage files.',
    support: 'config',
  },
  coveragePathIgnorePatterns: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An array of regexp pattern strings that are matched against all file paths before executing the test. If the file path matches any of the patterns, coverage information will be skipped.',
    support: 'config',
  },
  coverageProvider: {
    requiresArg: true,
    choices: ['babel', 'v8'],
    description: 'Select between Babel and V8 to collect coverage',
    support: 'config',
  },
  coverageReporters: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'A list of reporter names that Jest uses when writing coverage reports. Any istanbul reporter can be used.',
    support: 'config',
  },
  coverageThreshold: {
    type: 'string',
    requiresArg: true,
    description:
      'A JSON string with which will be used to configure minimum threshold enforcement for coverage results',
    support: 'config',
  },
  debug: {
    type: 'boolean',
    description: 'Print debugging info about your jest config.',
    support: 'warn',
    owner: 'T9.7',
  },
  detectLeaks: {
    type: 'boolean',
    description:
      '**EXPERIMENTAL**: Detect memory leaks in tests. After executing a test, it will try to garbage collect the global object used, and fail if it was leaked',
    support: 'refuse',
    owner: 'T2.7',
  },
  detectOpenHandles: {
    type: 'boolean',
    description:
      'Print out remaining open handles preventing Jest from exiting at the end of a test run. Implies `runInBand`.',
    support: 'config',
  },
  errorOnDeprecated: {
    type: 'boolean',
    description: 'Make calling deprecated APIs throw helpful error messages.',
    support: 'config',
  },
  expand: {
    type: 'boolean',
    alias: 'e',
    description: 'Use this flag to show full diffs instead of a patch.',
    support: 'config',
  },
  filter: {
    type: 'string',
    requiresArg: true,
    description:
      'Path to a module exporting a filtering function. This method receives a list of tests which can be manipulated to exclude tests from running. Especially useful when used in conjunction with a testing infrastructure to filter known broken tests.',
    support: 'refuse',
    owner: 'no task yet',
  },
  findRelatedTests: {
    type: 'boolean',
    description:
      'Find related tests for a list of source files that were passed in as arguments. Useful for pre-commit hook integration to run the minimal amount of tests necessary.',
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  forceExit: {
    type: 'boolean',
    description:
      'Force Jest to exit after all tests have completed running. This is useful when resources set up by test code cannot be adequately cleaned up.',
    support: 'config',
  },
  globalSetup: {
    type: 'string',
    requiresArg: true,
    description: 'The path to a module that runs before All Tests.',
    support: 'config',
  },
  globalTeardown: {
    type: 'string',
    requiresArg: true,
    description: 'The path to a module that runs after All Tests.',
    support: 'config',
  },
  globals: {
    type: 'string',
    requiresArg: true,
    description:
      'A JSON string with map of global variables that need to be available in all test environments.',
    support: 'config',
  },
  haste: {
    type: 'string',
    requiresArg: true,
    description: 'A JSON string with map of variables for the haste module system',
    support: 'config',
  },
  ignoreProjects: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'Ignore the tests of the specified projects. Jest uses the attribute `displayName` in the configuration to identify each project.',
    support: 'accepted',
  },
  injectGlobals: {
    type: 'boolean',
    description: 'Should Jest inject global variables or not',
    support: 'config',
  },
  json: {
    type: 'boolean',
    description:
      'Prints the test results in JSON. This mode will send all other test output and user messages to stderr.',
    support: 'refuse',
    owner: 'T11.8',
  },
  lastCommit: {
    type: 'boolean',
    description:
      'Run all tests affected by file changes in the last commit made. Behaves similarly to `--onlyChanged`.',
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  listTests: {
    type: 'boolean',
    description:
      'Lists all tests Jest will run given the arguments and exits. Most useful in a CI system together with `--findRelatedTests` to determine the tests Jest will run based on specific files',
    support: 'request',
  },
  logHeapUsage: {
    type: 'boolean',
    description:
      'Logs the heap usage after every test. Useful to debug memory leaks. Use together with `--runInBand` and `--expose-gc` in node.',
    support: 'warn',
    owner: 'T9.7',
  },
  maxConcurrency: {
    type: 'number',
    requiresArg: true,
    description:
      'Specifies the maximum number of tests that are allowed to run concurrently. This only affects tests using `test.concurrent`.',
    support: 'config',
  },
  maxWorkers: {
    type: 'string',
    alias: 'w',
    requiresArg: true,
    description:
      'Specifies the maximum number of workers the worker-pool will spawn for running tests. This defaults to the number of the cores available on your machine. (its usually best not to override this default)',
    support: 'request',
  },
  moduleDirectories: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      "An array of directory names to be searched recursively up from the requiring module's location.",
    support: 'config',
  },
  moduleFileExtensions: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An array of file extensions your modules use. If you require modules without specifying a file extension, these are the extensions Jest will look for.',
    support: 'config',
  },
  moduleNameMapper: {
    type: 'string',
    requiresArg: true,
    description:
      'A JSON string with a map from regular expressions to module names or to arrays of module names that allow to stub out resources, like images or styles with a single module',
    support: 'config',
  },
  modulePathIgnorePatterns: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An array of regexp pattern strings that are matched against all module paths before those paths are to be considered "visible" to the module loader.',
    support: 'config',
  },
  modulePaths: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An alternative API to setting the NODE_PATH env variable, modulePaths is an array of absolute paths to additional locations to search when resolving modules.',
    support: 'config',
  },
  noStackTrace: {
    type: 'boolean',
    description: 'Disables stack trace in test results output',
    support: 'config',
  },
  notify: {
    type: 'boolean',
    description: 'Activates notifications for test results.',
    support: 'warn',
    owner: 'T9.7',
  },
  notifyMode: {
    requiresArg: true,
    choices: ['always', 'failure', 'success', 'change', 'success-change', 'failure-change'],
    description: 'Specifies when notifications will appear for test results.',
    support: 'warn',
    owner: 'T9.7',
  },
  onlyChanged: {
    type: 'boolean',
    alias: 'o',
    description:
      "Attempts to identify which tests to run based on which files have changed in the current repository. Only works if you're running tests in a git or hg repository at the moment.",
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  onlyFailures: {
    type: 'boolean',
    alias: 'f',
    description: 'Run tests that failed in the previous execution.',
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  openHandlesTimeout: {
    type: 'number',
    requiresArg: true,
    description:
      'Print a warning about probable open handles if Jest does not exit cleanly after this number of milliseconds. `0` to disable.',
    support: 'config',
  },
  outputFile: {
    type: 'string',
    requiresArg: true,
    description: 'Write test results to a file when the --json option is also specified.',
    support: 'refuse',
    owner: 'T11.8',
  },
  passWithNoTests: {
    type: 'boolean',
    description:
      'Will not fail if no tests are found (for example while using `--testPathPatterns`.)',
    support: 'request',
  },
  preset: {
    type: 'string',
    requiresArg: true,
    description: "A preset that is used as a base for Jest's configuration.",
    support: 'config',
  },
  prettierPath: {
    type: 'string',
    requiresArg: true,
    description: 'The path to the "prettier" module used for inline snapshots.',
    support: 'config',
  },
  projects: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'A list of projects that use Jest to run all tests of all projects in a single instance of Jest.',
    support: 'refuse',
    owner: 'the --projects flag, no task yet (a config `projects` runs)',
  },
  randomize: {
    type: 'boolean',
    description:
      'Shuffle the order of the tests within a file. In order to choose the seed refer to the `--seed` CLI option.',
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  reporters: {
    type: 'array',
    requiresArg: true,
    string: true,
    description: 'A list of custom reporters for the test suite.',
    support: 'refuse',
    owner: 'T11.9',
  },
  resetMocks: {
    type: 'boolean',
    description:
      'Automatically reset mock state before every test. Equivalent to calling jest.resetAllMocks() before each test.',
    support: 'config',
  },
  resetModules: {
    type: 'boolean',
    description:
      'If enabled, the module registry for every test file will be reset before running each individual test.',
    support: 'config',
  },
  resolver: {
    type: 'string',
    requiresArg: true,
    description: 'A JSON string which allows the use of a custom resolver.',
    support: 'config',
  },
  restoreMocks: {
    type: 'boolean',
    description:
      'Automatically restore mock state and implementation before every test. Equivalent to calling jest.restoreAllMocks() before each test.',
    support: 'config',
  },
  rootDir: {
    type: 'string',
    requiresArg: true,
    description: 'The root directory that Jest should scan for tests and modules within.',
    support: 'config',
  },
  roots: {
    type: 'array',
    requiresArg: true,
    string: true,
    description: 'A list of paths to directories that Jest should use to search for files in.',
    support: 'config',
  },
  runInBand: {
    type: 'boolean',
    alias: 'i',
    description:
      'Run all tests serially in the current process (rather than creating a worker pool of child processes that run tests). This is sometimes useful for debugging, but such use cases are pretty rare.',
    support: 'request',
  },
  runTestsByPath: {
    type: 'boolean',
    description:
      'Used when provided patterns are exact file paths. This avoids converting them into a regular expression and matching it against every single file.',
    support: 'request',
  },
  runner: {
    type: 'string',
    requiresArg: true,
    description: "Allows to use a custom runner instead of Jest's default test runner.",
    support: 'config',
  },
  seed: {
    type: 'number',
    requiresArg: true,
    description:
      'Sets a seed value that can be retrieved in a tests file via `jest.getSeed()`. If this option is not specified Jest will randomly generate the value. The seed value must be between `-0x80000000` and `0x7fffffff` inclusive.',
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  selectProjects: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'Run the tests of the specified projects. Jest uses the attribute `displayName` in the configuration to identify each project.',
    support: 'accepted',
  },
  setupFiles: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'A list of paths to modules that run some code to configure or set up the testing environment before each test.',
    support: 'config',
  },
  setupFilesAfterEnv: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'A list of paths to modules that run some code to configure or set up the testing framework before each test',
    support: 'config',
  },
  shard: {
    type: 'string',
    requiresArg: true,
    description:
      'Shard tests and execute only the selected shard, specify in the form "current/all". 1-based, for example "3/5".',
    // Read into the global config's `shard` (`parseShardPair`), which the command hands the run (T9.6).
    support: 'config',
  },
  showConfig: {
    type: 'boolean',
    description: 'Print your jest config and then exits.',
    support: 'request',
  },
  showSeed: {
    type: 'boolean',
    description:
      'Prints the seed value in the test report summary. See `--seed` for how to set this value',
    support: 'refuse',
    owner: 'Track 9, no task yet',
  },
  silent: {
    type: 'boolean',
    description: 'Prevent tests from printing messages through the console.',
    support: 'config',
  },
  skipFilter: {
    type: 'boolean',
    description:
      'Disables the filter provided by --filter. Useful for CI jobs, or local enforcement when fixing tests.',
    support: 'accepted',
  },
  snapshotSerializers: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'A list of paths to snapshot serializer modules Jest should use for snapshot testing.',
    support: 'config',
  },
  testEnvironment: {
    type: 'string',
    alias: 'env',
    requiresArg: true,
    description:
      'The test environment used for all tests. This can point to any file or node module. Examples: `jsdom`, `node` or `path/to/my-environment.js`',
    support: 'config',
  },
  testEnvironmentOptions: {
    type: 'string',
    requiresArg: true,
    description:
      'A JSON string with options that will be passed to the `testEnvironment`. The relevant options depend on the environment.',
    support: 'config',
  },
  testFailureExitCode: {
    type: 'string',
    requiresArg: true,
    description: 'Exit code of `jest` command if the test run failed',
    support: 'config',
  },
  testLocationInResults: {
    type: 'boolean',
    description: 'Add `location` information to the test results',
    support: 'accepted',
  },
  testMatch: {
    type: 'array',
    requiresArg: true,
    string: true,
    description: 'The glob patterns Jest uses to detect test files.',
    support: 'config',
  },
  testNamePattern: {
    type: 'string',
    alias: 't',
    requiresArg: true,
    description: 'Run only tests with a name that matches the regex pattern.',
    support: 'request',
  },
  testPathIgnorePatterns: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An array of regexp pattern strings that are matched against all test paths before executing the test. If the test path matches any of the patterns, it will be skipped.',
    support: 'config',
  },
  testPathPatterns: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An array of regexp pattern strings that are matched against all tests paths before executing the test.',
    support: 'request',
  },
  testRegex: {
    type: 'array',
    requiresArg: true,
    string: true,
    description: 'A string or array of string regexp patterns that Jest uses to detect test files.',
    support: 'config',
  },
  testResultsProcessor: {
    type: 'string',
    requiresArg: true,
    description:
      'Allows the use of a custom results processor. This processor must be a node module that exports a function expecting as the first argument the result object.',
    support: 'config',
  },
  testRunner: {
    type: 'string',
    requiresArg: true,
    description:
      'Allows to specify a custom test runner. The default is `jest-circus/runner`. A path to a custom test runner can be provided: `<rootDir>/path/to/testRunner.js`.',
    support: 'config',
  },
  testSequencer: {
    type: 'string',
    requiresArg: true,
    description:
      'Allows to specify a custom test sequencer. The default is `@jest/test-sequencer`. A path to a custom test sequencer can be provided: `<rootDir>/path/to/testSequencer.js`',
    support: 'config',
  },
  testTimeout: {
    type: 'number',
    requiresArg: true,
    description: 'This option sets the default timeouts of test cases.',
    support: 'config',
  },
  transform: {
    type: 'string',
    requiresArg: true,
    description: 'A JSON string which maps from regular expressions to paths to transformers.',
    support: 'config',
  },
  transformIgnorePatterns: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An array of regexp pattern strings that are matched against all source file paths before transformation.',
    support: 'config',
  },
  unmockedModulePathPatterns: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An array of regexp pattern strings that are matched against all modules before the module loader will automatically return a mock for them.',
    support: 'config',
  },
  updateSnapshot: {
    type: 'boolean',
    alias: 'u',
    description:
      'Use this flag to re-record snapshots. Can be used together with a test suite pattern or with `--testNamePattern` to re-record snapshot for test matching the pattern',
    support: 'request',
  },
  useStderr: { type: 'boolean', description: 'Divert all output to stderr.', support: 'accepted' },
  verbose: {
    type: 'boolean',
    description: 'Display individual test results with the test suite hierarchy.',
    support: 'config',
  },
  waitForUnhandledRejections: {
    type: 'boolean',
    description:
      'Gives one event loop turn to handle `rejectionHandled`, `uncaughtException` or `unhandledRejection`.',
    support: 'config',
  },
  watch: {
    type: 'boolean',
    description:
      'Watch files for changes and rerun tests related to changed files. If you want to re-run all tests when a file has changed, use the `--watchAll` option.',
    support: 'refuse',
    owner: 'T9.11',
  },
  watchAll: {
    type: 'boolean',
    description:
      'Watch files for changes and rerun all tests. If you want to re-run only the tests related to the changed files, use the `--watch` option.',
    support: 'refuse',
    owner: 'T9.11',
  },
  watchPathIgnorePatterns: {
    type: 'array',
    requiresArg: true,
    string: true,
    description:
      'An array of regexp pattern strings that are matched against all paths before trigger test re-run in watch mode. If the test path matches any of the patterns, it will be skipped.',
    support: 'config',
  },
  watchman: {
    type: 'boolean',
    description: 'Whether to use watchman for file crawling. Disable using --no-watchman.',
    support: 'accepted',
  },
  workerGracefulExitTimeout: {
    type: 'number',
    requiresArg: true,
    description:
      'Timeout in milliseconds for worker processes to exit gracefully after tests complete. Workers that do not exit in time are force-killed. Default: 500.',
    support: 'config',
  },
  workerThreads: {
    type: 'boolean',
    description:
      'Whether to use worker threads for parallelization. Child processes are used by default.',
    support: 'request',
  },
}
