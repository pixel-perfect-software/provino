// T11.16: Vitest 5.0.5's command-line options, as `createCLI` registers them with cac
// (`packages/vitest/src/node/cli/cli-config.ts` walked by `cac.ts` `addCommand`, v5.0.5): one row per
// option that has a description (cac registers no other), in registration order, with the
// description as cac prints it. `flag` is cac's raw name (`-t, --testNamePattern <pattern>`),
// `path` the option's key in Vitest's options (`sequence.shuffle`). `value` names what Vitest's
// `transform` does with the value: `array` (`toArray`), `normalize` (pathe's `normalize`), or one
// of the option's own transforms (`cli.ts` holds each, with its line). `cli.test.ts` holds the rows
// to the real `createCLI()`'s options in order.
//
// `support` is Provino's: `request` (`provino vitest` reads it from the command line), `config`
// (handed to the config reader as `test`, which applies it or warns `VITEST_CONFIG_NOT_APPLIED`),
// `refuse` (an error naming `owner`), `warn` (read and not applied, naming `owner`).

// The owners several rows share: the reason `provino vitest` prints after a refusal or a warning.
const PARKED = 'not built yet'
const COVERAGE = 'Vitest coverage is not built yet'
const EXPERIMENTAL = 'experimental flags are not applied'
const NODE_ONLY = 'not planned: Provino runs Node only'
const VITEST_UI = 'not planned: Vitest UI'
const TYPE_TESTS = 'not planned: type tests'
const TEST_TAGS = 'test tags are not built yet'
const CHANGED = '--changed is not built yet'
const NO_WATCH = 'no watch mode under provino vitest'
const COLLECTS_BY_RUNNING = 'Provino collects by running the files'

/**
 * What `provino vitest` does with an option.
 * @public
 */
export type VitestCliSupport = 'request' | 'config' | 'refuse' | 'warn'

/**
 * What Vitest's `transform` does with an option's value (`cac.ts` `addCommand`).
 * @public
 */
export type VitestCliValue =
  | 'array'
  | 'normalize'
  | 'api'
  | 'silent'
  | 'nested-boolean'
  | 'yes-no'
  | 'watermarks'
  | 'browser'
  | 'browser-trace'
  | 'locators'
  | 'inspect'
  | 'retry-condition'
  | 'expect'
  | 'expect-poll'
  | 'merge-reports'
  | 'import-durations'
  | 'import-durations-print'

/** What every Vitest command-line option has. */
interface VitestCliOptionBase {
  readonly flag: string
  readonly path: string
  readonly description: string
  readonly value?: VitestCliValue
  /** `array: true` on an option whose `transform` is its own (it may then take several values). */
  readonly array?: true
}

/**
 * One Vitest command-line option: one Provino refuses or warns about names its owner, one it reads
 * has none.
 * @public
 */
export type VitestCliOption =
  | (VitestCliOptionBase & { readonly support: 'request' | 'config'; readonly owner?: never })
  | (VitestCliOptionBase & { readonly support: 'refuse' | 'warn'; readonly owner: string })

/**
 * The options of every command but `list`, in cac's order (`-v, --version` first and `-h, --help`
 * last are cac's own, added by `cli.version` and `cli.help`).
 * @public
 */
export const VITEST_CLI_OPTIONS: readonly VitestCliOption[] = [
  {
    flag: '-v, --version',
    path: 'version',
    description: 'Display version number',
    support: 'refuse',
    owner: 'the real vitest prints its version',
  },
  {
    flag: '-r, --root <path>',
    path: 'root',
    description: 'Root path',
    value: 'normalize',
    support: 'request',
  },
  {
    flag: '-c, --config <path>',
    path: 'config',
    description: 'Path to config file',
    value: 'normalize',
    support: 'request',
  },
  {
    flag: '-u, --update [type]',
    path: 'update',
    description: 'Update snapshot (accepts boolean, "new", "all" or "none")',
    support: 'request',
  },
  {
    flag: '-w, --watch',
    path: 'watch',
    description: 'Enable watch mode',
    support: 'refuse',
    owner: NO_WATCH,
  },
  {
    flag: '-t, --testNamePattern <pattern>',
    path: 'testNamePattern',
    description: 'Run tests with full names matching the specified regexp pattern',
    support: 'request',
  },
  {
    flag: '--dir <path>',
    path: 'dir',
    description: 'Base directory to scan for the test files',
    value: 'normalize',
    support: 'config',
  },
  {
    flag: '--ui ',
    path: 'ui',
    description: 'Enable UI',
    support: 'refuse',
    owner: VITEST_UI,
  },
  {
    flag: '--open',
    path: 'open',
    description: 'Open UI automatically (default: !process.env.CI)',
    support: 'refuse',
    owner: VITEST_UI,
  },
  {
    flag: '--api [port]',
    path: 'api',
    description:
      "Specify server port. Note if the port is already being used, Vite will automatically try the next available port so this may not be the actual port the server ends up listening on. If true will be set to 51204 or 63315 in browser mode. Use '--help --api' for more info.",
    value: 'api',
    support: 'refuse',
    owner: VITEST_UI,
  },
  {
    flag: '--api.port [port]',
    path: 'api.port',
    description:
      'Specify server port. Note if the port is already being used, Vite will automatically try the next available port so this may not be the actual port the server ends up listening on. If true will be set to 51204',
    support: 'refuse',
    owner: VITEST_UI,
  },
  {
    flag: '--api.host [host]',
    path: 'api.host',
    description:
      'Specify which IP addresses the server should listen on. Set this to 0.0.0.0 or true to listen on all addresses, including LAN and public addresses',
    support: 'refuse',
    owner: VITEST_UI,
  },
  {
    flag: '--api.strictPort',
    path: 'api.strictPort',
    description:
      'Set to true to exit if port is already in use, instead of automatically trying the next available port',
    support: 'refuse',
    owner: VITEST_UI,
  },
  {
    flag: '--api.allowExec',
    path: 'api.allowExec',
    description:
      'Allow API to execute code. (Be careful when enabling this option in untrusted environments)',
    support: 'refuse',
    owner: VITEST_UI,
  },
  {
    flag: '--api.allowWrite',
    path: 'api.allowWrite',
    description:
      'Allow API to edit files. (Be careful when enabling this option in untrusted environments)',
    support: 'refuse',
    owner: VITEST_UI,
  },
  {
    flag: '--silent [value]',
    path: 'silent',
    description:
      "Silent console output from tests. Use 'passed-only' to see logs from failing tests only.",
    value: 'silent',
    support: 'request',
  },
  {
    flag: '--hideSkippedTests',
    path: 'hideSkippedTests',
    description: 'Hide logs for skipped tests',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--reporter <name>',
    path: 'reporters',
    description:
      'Specify reporters (default, agent, minimal, blob, verbose, dot, json, tap, tap-flat, junit, tree, hanging-process, github-actions)',
    value: 'array',
    support: 'request',
  },
  {
    flag: '--outputFile <filename/-s>',
    path: 'outputFile',
    description:
      "Write test results to a file when supporter reporter is also specified, use cac's dot notation for individual outputs of multiple reporters (example: --outputFile.tap=./tap.txt)",
    support: 'request',
  },
  {
    flag: '--coverage ',
    path: 'coverage',
    description: "Enable coverage report. Use '--help --coverage' for more info.",
    value: 'nested-boolean',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.provider <name>',
    path: 'coverage.provider',
    description:
      'Select the tool for coverage collection, available values are: "v8", "istanbul" and "custom"',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.enabled',
    path: 'coverage.enabled',
    description:
      'Enables coverage collection. Can be overridden using the --coverage CLI option (default: false)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.include <pattern>',
    path: 'coverage.include',
    description:
      'Files included in coverage as glob patterns. May be specified more than once when using multiple patterns. By default only files covered by tests are included.',
    value: 'array',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.exclude <pattern>',
    path: 'coverage.exclude',
    description:
      'Files to be excluded in coverage. May be specified more than once when using multiple extensions.',
    value: 'array',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.clean',
    path: 'coverage.clean',
    description: 'Clean coverage results before running tests (default: true)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.cleanOnRerun',
    path: 'coverage.cleanOnRerun',
    description: 'Clean coverage report on watch rerun (default: true)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.reportsDirectory <path>',
    path: 'coverage.reportsDirectory',
    description: 'Directory to write coverage report to (default: ./coverage)',
    value: 'normalize',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.reporter <name>',
    path: 'coverage.reporter',
    description:
      'Coverage reporters to use. Visit [coverage.reporter](https://vitest.dev/config/coverage#coverage-reporter) for more information (default: ["text", "html", "clover", "json"])',
    value: 'array',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.reportOnFailure',
    path: 'coverage.reportOnFailure',
    description: 'Generate coverage report even when tests fail (default: false)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.allowExternal',
    path: 'coverage.allowExternal',
    description: 'Collect coverage of files outside the project root (default: false)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.skipFull',
    path: 'coverage.skipFull',
    description:
      'Do not show files with 100% statement, branch, and function coverage (default: false)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.thresholds.100',
    path: 'coverage.thresholds.100',
    description: 'Shortcut to set all coverage thresholds to 100 (default: false)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.thresholds.perFile <boolean>',
    path: 'coverage.thresholds.perFile',
    description:
      'Check thresholds per file. See --coverage.thresholds.lines, --coverage.thresholds.functions, --coverage.thresholds.branches and --coverage.thresholds.statements for the actual thresholds (default: false). Object form is available in config files only.',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.thresholds.autoUpdate <boolean|function>',
    path: 'coverage.thresholds.autoUpdate',
    description:
      'Update threshold values: "lines", "functions", "branches" and "statements" to configuration file when current coverage is above the configured thresholds (default: false)',
    value: 'yes-no',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.thresholds.lines <number>',
    path: 'coverage.thresholds.lines',
    description:
      'Threshold for lines. Visit [istanbuljs](https://github.com/istanbuljs/nyc#coverage-thresholds) for more information. This option is not available for custom providers',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.thresholds.functions <number>',
    path: 'coverage.thresholds.functions',
    description:
      'Threshold for functions. Visit [istanbuljs](https://github.com/istanbuljs/nyc#coverage-thresholds) for more information. This option is not available for custom providers',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.thresholds.branches <number>',
    path: 'coverage.thresholds.branches',
    description:
      'Threshold for branches. Visit [istanbuljs](https://github.com/istanbuljs/nyc#coverage-thresholds) for more information. This option is not available for custom providers',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.thresholds.statements <number>',
    path: 'coverage.thresholds.statements',
    description:
      'Threshold for statements. Visit [istanbuljs](https://github.com/istanbuljs/nyc#coverage-thresholds) for more information. This option is not available for custom providers',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.ignoreClassMethods <name>',
    path: 'coverage.ignoreClassMethods',
    description:
      'Array of class method names to ignore for coverage. Visit [istanbuljs](https://github.com/istanbuljs/nyc#ignoring-methods) for more information. This option is only available for the istanbul providers (default: [])',
    value: 'array',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.processingConcurrency <number>',
    path: 'coverage.processingConcurrency',
    description:
      'Concurrency limit used when processing the coverage results. (default min between 20 and the number of CPUs)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.customProviderModule <path>',
    path: 'coverage.customProviderModule',
    description:
      'Specifies the module name or path for the custom coverage provider module. Visit [Custom Coverage Provider](https://vitest.dev/guide/coverage#custom-coverage-provider) for more information. This option is only available for custom providers',
    value: 'normalize',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.watermarks.statements <watermarks>',
    path: 'coverage.watermarks.statements',
    description: 'High and low watermarks for statements in the format of <high>,<low>',
    value: 'watermarks',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.watermarks.lines <watermarks>',
    path: 'coverage.watermarks.lines',
    description: 'High and low watermarks for lines in the format of <high>,<low>',
    value: 'watermarks',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.watermarks.branches <watermarks>',
    path: 'coverage.watermarks.branches',
    description: 'High and low watermarks for branches in the format of <high>,<low>',
    value: 'watermarks',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.watermarks.functions <watermarks>',
    path: 'coverage.watermarks.functions',
    description: 'High and low watermarks for functions in the format of <high>,<low>',
    value: 'watermarks',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.changed <commit/branch>',
    path: 'coverage.changed',
    description:
      'Collect coverage only for files changed since a specified commit or branch (e.g., origin/main or HEAD~1). Inherits value from --changed by default.',
    value: 'yes-no',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.excludeAfterRemap',
    path: 'coverage.excludeAfterRemap',
    description:
      'Apply exclusions again after coverage has been remapped to original sources. (default: false)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.htmlDir <path>',
    path: 'coverage.htmlDir',
    description: 'Directory of HTML coverage output to be served in UI mode and HTML reporter.',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--coverage.autoAttachSubprocess',
    path: 'coverage.autoAttachSubprocess',
    description:
      'Track coverage of the node:child_process and node:worker_threads spawned during test run. Supported only by v8 provider. (default: false)',
    support: 'refuse',
    owner: COVERAGE,
  },
  {
    flag: '--mode <name>',
    path: 'mode',
    description: 'Override Vite mode (default: test)',
    support: 'request',
  },
  {
    flag: '--isolate',
    path: 'isolate',
    description:
      'Run every test file in isolation. To disable isolation, use --no-isolate (default: true)',
    support: 'config',
  },
  { flag: '--globals', path: 'globals', description: 'Inject apis globally', support: 'config' },
  {
    flag: '--injectCjsGlobals',
    path: 'injectCjsGlobals',
    description:
      'Inject CommonJS variables (module, exports, require, __filename, __dirname) into every test module. To disable, use --no-inject-cjs-globals (default: true)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--dom',
    path: 'dom',
    description: 'Mock browser API with happy-dom',
    support: 'config',
  },
  {
    flag: '--browser <name>',
    path: 'browser',
    description:
      "Run tests in the browser. Equivalent to --browser.enabled (default: false). Use '--help --browser' for more info.",
    value: 'browser',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.enabled',
    path: 'browser.enabled',
    description: 'Run tests in the browser. Equivalent to --browser.enabled (default: false)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.name <name>',
    path: 'browser.name',
    description:
      'Run all tests in a specific browser. Some browsers are only available for specific providers (see --browser.provider).',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.headless',
    path: 'browser.headless',
    description:
      'Run the browser in headless mode (i.e. without opening the GUI (Graphical User Interface)). If you are running Vitest in CI, it will be enabled by default (default: process.env.CI)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.ui',
    path: 'browser.ui',
    description: 'Show Vitest UI when running tests (default: !process.env.CI)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.detailsPanelPosition <position>',
    path: 'browser.detailsPanelPosition',
    description:
      'Default position for the details panel in browser mode. Either right (horizontal split) or bottom (vertical split) (default: right)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.connectTimeout <timeout>',
    path: 'browser.connectTimeout',
    description:
      'If connection to the browser takes longer, the test suite will fail (default: 60_000)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.dependencySourcemaps',
    path: 'browser.dependencySourcemaps',
    description:
      "Serve sourcemaps of dependencies to the browser in headless runs, used by devtools when debugging into node_modules. Reported test errors are source-mapped either way. Use --browser.dependencySourcemaps=false to speed up test runs if you don't step into dependency code (default: true)",
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.trackUnhandledErrors',
    path: 'browser.trackUnhandledErrors',
    description:
      'Control if Vitest catches uncaught exceptions so they can be reported (default: true)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.trace <mode>',
    path: 'browser.trace',
    description:
      'Enable trace view mode. Supported: "on", "off", "on-first-retry", "on-all-retries", "retain-on-failure".',
    value: 'browser-trace',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.traceView ',
    path: 'browser.traceView',
    description:
      "Enable Vitest trace-view collection for browser tests (default: false). Use '--help --browser.traceView' for more info.",
    value: 'nested-boolean',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.traceView.enabled',
    path: 'browser.traceView.enabled',
    description: 'Enable Vitest trace-view collection for browser tests (default: false)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.traceView.recordCanvas',
    path: 'browser.traceView.recordCanvas',
    description: 'Capture canvas pixels in trace-view snapshots (default: false)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.traceView.inlineImages',
    path: 'browser.traceView.inlineImages',
    description: 'Inline loaded image pixels in trace-view snapshots (default: false)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.locators <options>',
    path: 'browser.locators',
    description:
      "Options for how locators should be handled by default. Use '--help --browser.locators' for more info.",
    value: 'locators',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--browser.locators.exact',
    path: 'browser.locators.exact',
    description: 'Should locators match the text exactly by default (default: true)',
    support: 'refuse',
    owner: NODE_ONLY,
  },
  {
    flag: '--pool <pool>',
    path: 'pool',
    description: 'Specify pool, if not running in the browser (default: forks)',
    support: 'config',
  },
  {
    flag: '--execArgv <option>',
    path: 'execArgv',
    description:
      'Pass additional arguments to node process when spawning worker_threads or child_process.',
    value: 'array',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--vmMemoryLimit <limit>',
    path: 'vmMemoryLimit',
    description: 'Memory limit for VM pools. If you see memory leaks, try to tinker this value.',
    support: 'refuse',
    owner: 'it needs the realm isolation tier, which is not available yet',
  },
  {
    flag: '--fileParallelism',
    path: 'fileParallelism',
    description:
      'Should all test files run in parallel. Use --no-file-parallelism to disable (default: true)',
    support: 'config',
  },
  {
    flag: '--maxWorkers <workers>',
    path: 'maxWorkers',
    description: 'Maximum number or percentage of workers to run tests in',
    support: 'config',
  },
  {
    flag: '--environment <name>',
    path: 'environment',
    description: 'Specify runner environment, if not running in the browser (default: node)',
    support: 'config',
  },
  {
    flag: '--passWithNoTests',
    path: 'passWithNoTests',
    description: 'Pass when no tests are found',
    support: 'request',
  },
  {
    flag: '--logHeapUsage',
    path: 'logHeapUsage',
    description: 'Show the size of heap for each test when running in node',
    support: 'config',
  },
  {
    flag: '--detectAsyncLeaks',
    path: 'detectAsyncLeaks',
    description: 'Detect asynchronous resources leaking from the test file (default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--allowOnly',
    path: 'allowOnly',
    description: 'Allow tests and suites that are marked as only (default: !process.env.CI)',
    support: 'config',
  },
  {
    flag: '--dangerouslyIgnoreUnhandledErrors',
    path: 'dangerouslyIgnoreUnhandledErrors',
    description: 'Ignore any unhandled errors that occur',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--shard <shards>',
    path: 'shard',
    description: 'Test suite shard to execute in a format of <index>/<count>',
    support: 'request',
  },
  {
    flag: '--changed [since]',
    path: 'changed',
    description: 'Run tests that are affected by the changed files (default: false)',
    support: 'refuse',
    owner: CHANGED,
  },
  {
    flag: '--sequence <options>',
    path: 'sequence',
    description: "Options for how tests should be sorted. Use '--help --sequence' for more info.",
    support: 'config',
  },
  {
    flag: '--sequence.shuffle ',
    path: 'sequence.shuffle',
    description:
      "Run files and tests in a random order. Enabling this option will impact Vitest's cache and have a performance impact. May be useful to find tests that accidentally depend on another run previously (default: false). Use '--help --sequence.shuffle' for more info.",
    support: 'config',
  },
  {
    flag: '--sequence.shuffle.files',
    path: 'sequence.shuffle.files',
    description:
      'Run files in a random order. Long running tests will not start earlier if you enable this option. (default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--sequence.shuffle.tests',
    path: 'sequence.shuffle.tests',
    description: 'Run tests in a random order (default: false)',
    support: 'config',
  },
  {
    flag: '--sequence.concurrent',
    path: 'sequence.concurrent',
    description: 'Make tests run in parallel (default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--sequence.seed <seed>',
    path: 'sequence.seed',
    description:
      'Set the randomization seed. This option will have no effect if --sequence.shuffle is falsy. Visit ["Random Seed" page](https://en.wikipedia.org/wiki/Random_seed) for more information',
    support: 'config',
  },
  {
    flag: '--sequence.hooks <order>',
    path: 'sequence.hooks',
    description:
      'Changes the order in which hooks are executed. Accepted values are: "stack", "list" and "parallel". Visit [sequence.hooks](https://vitest.dev/config/sequence#sequence-hooks) for more information (default: "stack")',
    support: 'config',
  },
  {
    flag: '--sequence.setupFiles <order>',
    path: 'sequence.setupFiles',
    description:
      'Changes the order in which setup files are executed. Accepted values are: "list" and "parallel". If set to "list", will run setup files in the order they are defined. If set to "parallel", will run setup files in parallel (default: "list")',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--inspect [[host:]port]',
    path: 'inspect',
    description: 'Enable Node.js inspector (default: 127.0.0.1:9229)',
    value: 'inspect',
    support: 'refuse',
    owner: 'not planned: use node --inspect',
  },
  {
    flag: '--inspectBrk [[host:]port]',
    path: 'inspectBrk',
    description: 'Enable Node.js inspector and break before the test starts',
    value: 'inspect',
    support: 'refuse',
    owner: 'not planned: use node --inspect-brk',
  },
  {
    flag: '--testTimeout <timeout>',
    path: 'testTimeout',
    description:
      'Default timeout of a test in milliseconds (default: 5000). Use 0 to disable timeout completely.',
    support: 'config',
  },
  {
    flag: '--hookTimeout <timeout>',
    path: 'hookTimeout',
    description:
      'Default hook timeout in milliseconds (default: 10000). Use 0 to disable timeout completely.',
    support: 'config',
  },
  {
    flag: '--bail <number>',
    path: 'bail',
    description: 'Stop test execution when given number of tests have failed (default: 0)',
    support: 'config',
  },
  {
    flag: '--retry <times>',
    path: 'retry',
    description:
      "Retry the test specific number of times if it fails (default: 0). Use '--help --retry' for more info.",
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--retry.count <times>',
    path: 'retry.count',
    description: 'Number of times to retry a test if it fails (default: 0)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--retry.delay <ms>',
    path: 'retry.delay',
    description: 'Delay in milliseconds between retry attempts (default: 0)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--retry.condition <pattern>',
    path: 'retry.condition',
    description:
      'Regex pattern to match error messages that should trigger a retry. Only errors matching this pattern will cause a retry (default: retry on all errors)',
    value: 'retry-condition',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--repeats <number>',
    path: 'repeats',
    description:
      'Repeat every test a specific number of times regardless of the result (default: 0)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff <path>',
    path: 'diff',
    description:
      "DiffOptions object or a path to a module which exports DiffOptions object. Use '--help --diff' for more info.",
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.aAnnotation <annotation>',
    path: 'diff.aAnnotation',
    description: 'Annotation for expected lines (default: Expected)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.aIndicator <indicator>',
    path: 'diff.aIndicator',
    description: 'Indicator for expected lines (default: -)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.bAnnotation <annotation>',
    path: 'diff.bAnnotation',
    description: 'Annotation for received lines (default: Received)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.bIndicator <indicator>',
    path: 'diff.bIndicator',
    description: 'Indicator for received lines (default: +)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.commonIndicator <indicator>',
    path: 'diff.commonIndicator',
    description: 'Indicator for common lines (default:  )',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.contextLines <lines>',
    path: 'diff.contextLines',
    description: 'Number of lines of context to show around each change (default: 5)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.emptyFirstOrLastLinePlaceholder <placeholder>',
    path: 'diff.emptyFirstOrLastLinePlaceholder',
    description: 'Placeholder for an empty first or last line (default: "")',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.expand',
    path: 'diff.expand',
    description: 'Expand all common lines (default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.includeChangeCounts',
    path: 'diff.includeChangeCounts',
    description: 'Include comparison counts in diff output (default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.omitAnnotationLines',
    path: 'diff.omitAnnotationLines',
    description: 'Omit annotation lines from the output (default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.printBasicPrototype',
    path: 'diff.printBasicPrototype',
    description: 'Print basic prototype Object and Array (default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.maxDepth <maxDepth>',
    path: 'diff.maxDepth',
    description: 'Limit the depth to recurse when printing nested objects (default: 20)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.truncateThreshold <threshold>',
    path: 'diff.truncateThreshold',
    description: 'Number of lines to show before and after each change (default: 0)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--diff.truncateAnnotation <annotation>',
    path: 'diff.truncateAnnotation',
    description: 'Annotation for truncated lines (default: ... Diff result is truncated)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--exclude <glob>',
    path: 'exclude',
    description: 'Additional file globs to be excluded from test',
    value: 'array',
    support: 'config',
  },
  {
    flag: '--expandSnapshotDiff',
    path: 'expandSnapshotDiff',
    description: 'Show full diff when snapshot fails',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--disableConsoleIntercept',
    path: 'disableConsoleIntercept',
    description: 'Disable automatic interception of console logging (default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--typecheck ',
    path: 'typecheck',
    description:
      "Enable typechecking alongside tests (default: false). Use '--help --typecheck' for more info.",
    value: 'nested-boolean',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '--typecheck.enabled',
    path: 'typecheck.enabled',
    description: 'Enable typechecking alongside tests (default: false)',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '--typecheck.only',
    path: 'typecheck.only',
    description: 'Run only typecheck tests. This automatically enables typecheck (default: false)',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '--typecheck.checker <name>',
    path: 'typecheck.checker',
    description:
      'Specify the typechecker to use. Available values are: "tsc" and "vue-tsc" and a path to an executable (default: "tsc")',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '--typecheck.allowJs',
    path: 'typecheck.allowJs',
    description:
      'Allow JavaScript files to be typechecked. By default takes the value from tsconfig.json',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '--typecheck.ignoreSourceErrors',
    path: 'typecheck.ignoreSourceErrors',
    description: 'Ignore type errors from source files',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '--typecheck.build',
    path: 'typecheck.build',
    description: 'Use TypeScript build mode',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '--typecheck.tsconfig <path>',
    path: 'typecheck.tsconfig',
    description: 'Path to a custom tsconfig file',
    value: 'normalize',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '--typecheck.spawnTimeout <time>',
    path: 'typecheck.spawnTimeout',
    description: 'Minimum time in milliseconds it takes to spawn the typechecker',
    support: 'refuse',
    owner: TYPE_TESTS,
  },
  {
    flag: '-p, --project <name>',
    path: 'project',
    description:
      'The name of the project to run if you are using Vitest workspace feature. This can be repeated for multiple projects: --project=1 --project=2. You can also filter projects using wildcards like --project=packages*, and exclude projects with --project=!pattern. A project runs if it matches no negated pattern and, when regular patterns are also given, matches at least one of them.',
    value: 'array',
    support: 'request',
  },
  {
    flag: '--slowTestThreshold <threshold>',
    path: 'slowTestThreshold',
    description:
      'Threshold in milliseconds for a test or suite to be considered slow (default: 300)',
    support: 'config',
  },
  {
    flag: '--teardownTimeout <timeout>',
    path: 'teardownTimeout',
    description: 'Default timeout of a teardown function in milliseconds (default: 10000)',
    support: 'config',
  },
  {
    flag: '--cache ',
    path: 'cache',
    description:
      'Store the results of test runs to run failed and longer test files first (default: true)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--maxConcurrency <number>',
    path: 'maxConcurrency',
    description:
      'Maximum number of concurrent tests and suites during test file execution (default: 5)',
    support: 'config',
  },
  {
    flag: '--fsModuleCache',
    path: 'fsModuleCache',
    description:
      'Cache transformed modules on the file system and reuse them between reruns (default: true)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--fsModuleCachePath <path>',
    path: 'fsModuleCachePath',
    description:
      'Directory where the fsModuleCache is stored (default: node_modules/.vitest-cache)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--expect ',
    path: 'expect',
    description: "Configuration options for expect() matches. Use '--help --expect' for more info.",
    value: 'expect',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--expect.requireAssertions',
    path: 'expect.requireAssertions',
    description: 'Require that all tests have at least one assertion',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--expect.poll ',
    path: 'expect.poll',
    description: "Default options for expect.poll(). Use '--help --expect.poll' for more info.",
    value: 'expect-poll',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--expect.poll.interval <interval>',
    path: 'expect.poll.interval',
    description: 'Poll interval in milliseconds for expect.poll() assertions (default: 50)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--expect.poll.timeout <timeout>',
    path: 'expect.poll.timeout',
    description: 'Poll timeout in milliseconds for expect.poll() assertions (default: 1000)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--printConsoleTrace',
    path: 'printConsoleTrace',
    description: 'Always print console stack traces',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--includeTaskLocation',
    path: 'includeTaskLocation',
    description: 'Collect test and suite locations in the location property',
    support: 'request',
  },
  {
    flag: '--attachmentsDir <dir>',
    path: 'attachmentsDir',
    description:
      'The directory where attachments from context.annotate are stored in (default: .vitest/attachments)',
    support: 'refuse',
    owner: PARKED,
  },
  { flag: '--run', path: 'run', description: 'Disable watch mode', support: 'request' },
  {
    flag: '--no-color',
    path: 'color',
    description: 'Removes colors from the console output',
    support: 'request',
  },
  {
    flag: '--clearScreen',
    path: 'clearScreen',
    description: 'Clear terminal screen when re-running tests during watch mode (default: true)',
    support: 'warn',
    owner: 'it only applies in watch mode',
  },
  {
    flag: '--configLoader <loader>',
    path: 'configLoader',
    description:
      'Use bundle to bundle the config with esbuild or runner (experimental) to process it on the fly. This is only available in vite version 6.1.0 and above. (default: bundle)',
    support: 'warn',
    owner: 'Provino imports the config natively',
  },
  {
    flag: '--standalone',
    path: 'standalone',
    description:
      'Start Vitest without running tests. Tests will be running only on change. If browser mode is enabled, the UI will be opened automatically. This option is ignored when CLI file filters are passed. (default: false)',
    support: 'refuse',
    owner: NO_WATCH,
  },
  {
    flag: '--mergeReports [path]',
    path: 'mergeReports',
    description:
      "Path to a blob reports directory. If this options is used, Vitest won't run any tests, it will only report previously recorded tests",
    value: 'merge-reports',
    support: 'refuse',
    owner: 'blob reports are not built yet',
  },
  {
    flag: '--listTags [type]',
    path: 'listTags',
    description:
      'List all available tags instead of running tests. --list-tags=json will output tags in JSON format, unless there are no tags.',
    support: 'refuse',
    owner: TEST_TAGS,
  },
  {
    flag: '--clearCache',
    path: 'clearCache',
    description:
      'Delete all Vitest caches, including the fsModuleCache, without running any tests. This will reduce the performance in the subsequent test run.',
    support: 'refuse',
    owner: 'not built yet',
  },
  {
    flag: '--tagsFilter <expression>',
    path: 'tagsFilter',
    description:
      'Run only tests with the specified tags. You can use logical operators && (and), || (or) and ! (not) to create complex expressions, see [Test Tags](https://vitest.dev/guide/test-tags#syntax) for more information.',
    value: 'array',
    support: 'refuse',
    owner: TEST_TAGS,
  },
  {
    flag: '--strictTags',
    path: 'strictTags',
    description:
      'Should Vitest throw an error if test has a tag that is not defined in the config. (default: true)',
    support: 'refuse',
    owner: TEST_TAGS,
  },
  {
    flag: '--sharedViteServer',
    path: 'sharedViteServer',
    description:
      "Let inline projects that don't modify the Vite config reuse the Vite server of the config that declares them. (default: true)",
    support: 'warn',
    owner: 'the Vite bridge reads the config',
  },
  {
    flag: '--experimental <features>',
    path: 'experimental',
    description: "Experimental features.. Use '--help --experimental' for more info.",
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.importDurations ',
    path: 'experimental.importDurations',
    description:
      "Configure import duration collection and CLI display. Note that UI's \"Module Graph\" tab can always show import breakdown regardless of the print setting.. Use '--help --experimental.importDurations' for more info.",
    value: 'import-durations',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.importDurations.print <boolean|on-warn>',
    path: 'experimental.importDurations.print',
    description:
      'When to print import breakdown to CLI terminal. Use true to always print, false to never print, or on-warn to print only when imports exceed the warn threshold (default: false).',
    value: 'import-durations-print',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.importDurations.limit <number>',
    path: 'experimental.importDurations.limit',
    description:
      'Maximum number of imports to collect and display (default: 0, or 10 if print or UI is enabled).',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.importDurations.failOnDanger',
    path: 'experimental.importDurations.failOnDanger',
    description: 'Fail the test run if any import exceeds the danger threshold (default: false).',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.importDurations.thresholds ',
    path: 'experimental.importDurations.thresholds',
    description:
      "Duration thresholds in milliseconds for coloring and warnings.. Use '--help --experimental.importDurations.thresholds' for more info.",
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.importDurations.thresholds.warn <number>',
    path: 'experimental.importDurations.thresholds.warn',
    description:
      'Warning threshold - imports exceeding this are shown in yellow/orange (default: 100).',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.importDurations.thresholds.danger <number>',
    path: 'experimental.importDurations.thresholds.danger',
    description: 'Danger threshold - imports exceeding this are shown in red (default: 500).',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.viteModuleRunner',
    path: 'experimental.viteModuleRunner',
    description:
      "Control whether Vitest uses Vite's module runner to run the code or fallback to the native import. (default: true)",
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.nodeLoader',
    path: 'experimental.nodeLoader',
    description:
      'Controls whether Vitest will use Node.js Loader API to process in-source or mocked files. This has no effect if viteModuleRunner is enabled. Disabling this can increase performance. (default: true)',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.vcsProvider <path>',
    path: 'experimental.vcsProvider',
    description: 'Custom provider for detecting changed files. (default: git)',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.recordDependencies',
    path: 'experimental.recordDependencies',
    description:
      'Record the modules loaded by every test file in the cache and use the records with --changed and --related instead of the static module graph. A test file without a record always runs. (default: false)',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.preParse',
    path: 'experimental.preParse',
    description:
      'Parse test specifications before running them. This will apply .only flag and test name pattern across all files without running them. (default: false)',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.diagnostics ',
    path: 'experimental.diagnostics',
    description:
      "Print performance hints after the run when a configuration change would make it significantly faster. Hints never suggest changing options that were set explicitly. (default: true). Use '--help --experimental.diagnostics' for more info.",
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.diagnostics.isolate',
    path: 'experimental.diagnostics.isolate',
    description:
      'Print a hint estimating how much time isolate: false would save when isolate: true spends a significant amount of time spawning a worker per test file. (default: true)',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.diagnostics.environment',
    path: 'experimental.diagnostics.environment',
    description:
      'Print a hint when re-creating a DOM environment for every test file dominates the run and a vm pool would set it up once per worker. (default: true)',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.diagnostics.import',
    path: 'experimental.diagnostics.import',
    description:
      'Print a hint when test files repeatedly evaluate the same module graph (typical for barrel-file imports) and isolate: false would evaluate it once per worker. (default: true)',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '--experimental.diagnostics.transform',
    path: 'experimental.diagnostics.transform',
    description:
      'Print a hint when transforming modules dominates the run and fsModuleCache would persist the results across runs. (default: true)',
    support: 'warn',
    owner: EXPERIMENTAL,
  },
  {
    flag: '-h, --help',
    path: 'help',
    description: 'Display this message',
    support: 'refuse',
    owner: 'the real vitest prints its help',
  },
]

/**
 * What `list` registers on top (`collectCliOptionsConfig`): `changed` replaced in its place, then
 * four options of its own. The `list` command's options are `VITEST_CLI_OPTIONS`' rows without cac's
 * two, with these applied.
 * @public
 */
export const VITEST_LIST_OPTIONS: readonly VitestCliOption[] = [
  {
    flag: '--changed [since]',
    path: 'changed',
    description: 'Print only tests that are affected by the changed files (default: false)',
    support: 'refuse',
    owner: CHANGED,
  },
  {
    flag: '--json [true/path]',
    path: 'json',
    description: 'Print collected tests as JSON or write to a file (Default: false)',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--filesOnly',
    path: 'filesOnly',
    description: 'Print only test files with out the test cases',
    support: 'refuse',
    owner: PARKED,
  },
  {
    flag: '--staticParse',
    path: 'staticParse',
    description: 'Parse files statically instead of running them to collect tests (default: true)',
    support: 'warn',
    owner: COLLECTS_BY_RUNNING,
  },
  {
    flag: '--staticParseConcurrency <limit>',
    path: 'staticParseConcurrency',
    description: 'How many tests to process at the same time (default: os.availableParallelism())',
    support: 'warn',
    owner: COLLECTS_BY_RUNNING,
  },
]
