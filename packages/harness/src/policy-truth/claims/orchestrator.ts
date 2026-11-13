// The evidence for the `orchestrator`, `report` and `coverage` slices and the dialects' global
// names (T1.7). Black-box runs show exit codes, where files run and what the default reporter
// prints; `policy/defaults` holds the config defaults no run shows (D27).
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { globalSetupFailure as jestGlobalSetupFailure } from '@provino/dialect-jest/global-setup'
import { jestEnvironmentConditions } from '@provino/dialect-jest/runtime'
import { vitestEnvironmentConditions } from '@provino/dialect-vitest/runtime'
import { globalSetupFailure as neutralGlobalSetupFailure } from '@provino/policy/behaviours'
import type { EnvironmentRequest, GlobalSetupFailure } from '@provino/types'
import type { Golden } from '../../golden.ts'
import { type Claims, each, golden, own, pending } from '../evidence.ts'
import { capturedFile, observation, observedOf, oneOf, statusOf } from '../observe.ts'

const exitCode = (g: Golden): unknown => observedOf(g).exitCode
/** The one test whose title starts with `prefix`, read for what follows it. */
const titleAfter = (g: Golden, prefix: string): string => {
  const titles = g.files.flatMap((file) => file.tests.map((test) => test.id.path.join(' ')))
  const found = titles.filter((title) => title.startsWith(prefix))
  if (found.length === 0) throw new Error(`${g.suite} (${g.runner}) has no test "${prefix}..."`)
  return found.map((title) => title.slice(prefix.length)).join(', ')
}
/**
 * Which `process` a golden's files saw: `per-file` when every test titled `prefix…` reads
 * `isolated` (what a file sees when nothing an earlier file did to `process` reached it), else
 * `shared`. A file that ran first in the worker says so (`the first file ran before, in this
 * worker: true`), or the reading would say nothing.
 */
const processObjectOf = (g: Golden, prefix: string, isolated = '0'): string => {
  const titles = g.files.flatMap((file) => file.tests.map((test) => test.id.path.join(' ')))
  const order = titles.filter((title) => title.startsWith('the first file ran before'))
  if (order.some((title) => !title.endsWith(': true'))) {
    throw new Error(`${g.suite} (${g.runner}) did not run its files in order in one worker`)
  }
  const values = titles
    .filter((title) => title.startsWith(prefix))
    .map((t) => t.slice(prefix.length))
  if (values.length === 0) throw new Error(`${g.suite} (${g.runner}) has no test "${prefix}..."`)
  return values.every((value) => value === isolated) ? 'per-file' : 'shared'
}
/** The default reporter's line naming the failing test. */
const failureLine = (g: Golden): string => {
  const lines = `${observedOf(g).stdout ?? ''}\n${observedOf(g).stderr ?? ''}`.split('\n')
  const line = lines.find((text) => text.includes('the failing test'))
  if (line === undefined) throw new Error(`${g.suite} (${g.runner}) printed no failure line`)
  return line
}

/** The eight files of the `cli/shard-*-of-3` fixtures, as Jest names them (root-relative, `/`). */
const SHARD_FILES: readonly string[] = [
  'alpha.test.ts',
  'bravo.test.ts',
  'charlie.test.ts',
  'delta.test.ts',
  'echo.test.ts',
  'foxtrot.test.ts',
  'golf.test.ts',
  'sub/hotel.test.ts',
]

/** The files of slice `index` (1-based) of `count` out of `ordered`: the first `length % count` slices are one longer. */
const sliceOf = (ordered: readonly string[], index: number, count: number): string[] => {
  const size = (position: number): number =>
    Math.floor(ordered.length / count) + (position < ordered.length % count ? 1 : 0)
  let start = 0
  for (let position = 0; position < index - 1; position++) start += size(position)
  return ordered.slice(start, start + size(index - 1))
}

/**
 * Which split a `--shard=i/n` golden shows: the files Jest ran (its PASS lines) against the slice of
 * the sha1 order and the slice of the path order. `unknown` when neither is what it ran.
 */
const shardSplit = (g: Golden): string => {
  const [, index, count] = /shard-(\d+)-of-(\d+)$/.exec(g.suite) ?? []
  if (index === undefined || count === undefined) throw new Error(`${g.suite} is no shard fixture`)
  const ran = stderrOf(g)
    .split('\n')
    .flatMap((line) => (line.startsWith('PASS ') ? [line.slice(5).replace(/^\.\//, '')] : []))
    .toSorted()
  const bySha1 = SHARD_FILES.toSorted((a, b) => {
    const [ha, hb] = [a, b].map((name) => createHash('sha1').update(name).digest('hex'))
    return (ha as string) < (hb as string) ? -1 : 1
  })
  const expected = (ordered: readonly string[]): string[] =>
    sliceOf(ordered, Number(index), Number(count)).toSorted()
  if (isDeepStrictEqual(ran, expected(bySha1))) return 'sha1-slice'
  if (isDeepStrictEqual(ran, expected(SHARD_FILES.toSorted()))) return 'path-slice'
  return `unknown: ${ran.join(', ')}`
}

/** What a recorded black-box run printed on stderr (Jest writes its report there). */
const stderrOf = (g: Golden): string => observedOf(g).stderr ?? ''

/** The pragmas whose file failed to start, in the order a file with both shows they win. */
const pragmasRead = (g: Golden): readonly string[] => {
  const started = (file: string): boolean =>
    g.files.some((entry) => entry.file === file && entry.status !== 'crashed')
  const read = ['vitest-environment', 'jest-environment', 'provino-environment'].filter(
    (pragma) => !started(`${pragma.replace('-environment', '')}-pragma.test.ts`),
  )
  // `both-pragmas` names node in @vitest-environment and nothing real in @jest-environment.
  return started('both-pragmas.test.ts') ? read : read.toReversed()
}

/** What each `env/conditions-*` fixture configures: the environment the request names. */
const CONDITION_ENVIRONMENTS: Readonly<Record<string, EnvironmentRequest>> = {
  'env/conditions-jsdom': { name: 'jsdom' },
  // The one options shape every Jest environment has: `testEnvironmentOptions` under `projectConfig`.
  'env/conditions-custom': {
    name: 'jsdom',
    options: { projectConfig: { testEnvironmentOptions: { customExportConditions: [''] } } },
  },
  'env/conditions-node': { name: 'node' },
  'env/conditions-vitest-jsdom': { name: 'jsdom' },
}

/** The keys of the fixtures' `dual` package `exports`, in the order a resolver tries them. */
const DUAL_EXPORTS_ORDER = ['browser', 'node', 'import', 'require', 'default'] as const

/**
 * Whether the value (a ref to Jest's `jestEnvironmentConditions`) predicts the variant the golden's
 * real Jest resolved: the first key of the `dual` package that is among the conditions, plus
 * `require` (the fixtures `require` it from CommonJS).
 */
const CONDITIONS_BY_RUNNER: Readonly<
  Record<
    string,
    {
      readonly export: string
      readonly fn: (env: EnvironmentRequest) => readonly string[]
      /** The fixtures `require` the package under Jest (CommonJS) and `import` it under Vitest. */
      readonly token: string
    }
  >
> = {
  jest: { export: 'jestEnvironmentConditions', fn: jestEnvironmentConditions, token: 'require' },
  vitest: {
    export: 'vitestEnvironmentConditions',
    fn: vitestEnvironmentConditions,
    token: 'import',
  },
}

/** What the setup of each `cli/global-setup-throws*` fixture throws, as that fixture's `setup.ts` does. */
const THROWN_BY_FIXTURE: Readonly<Record<string, () => unknown>> = {
  'cli/global-setup-throws': () => new Error('setup failed'),
  'cli/global-setup-throws-typeerror': () =>
    new TypeError('setup failed\nsecond line of the message'),
  'cli/global-setup-throws-object': () => ({
    code: 42,
    detail: { list: ['a', 'b'], deeper: { deepest: { gone: true } } },
  }),
  'cli/global-setup-throws-string': () => 'setup gave up',
}

/** The behaviours a `globalSetup.failure` ref can name, by the module it is in. */
const FAILURES: readonly { readonly module: string; readonly fn: GlobalSetupFailure }[] = [
  { module: import.meta.resolve('@provino/dialect-jest/global-setup'), fn: jestGlobalSetupFailure },
  { module: import.meta.resolve('@provino/policy/behaviours'), fn: neutralGlobalSetupFailure },
]

/**
 * Whether the ref (the dialect's `globalSetup.failure`) reports what the fixture's setup throws as
 * Jest's CLI printed it: the class and the message of the error the behaviour returns are the
 * golden's whole stderr, which `keepLines` cut to the lines that are no stack frame.
 */
const failureMatches = (g: Golden, value: unknown): boolean => {
  const ref = value as { readonly module?: unknown; readonly export?: unknown } | null
  const failure = FAILURES.find(
    (known) => known.module === ref?.module && ref?.export === 'globalSetupFailure',
  )
  const thrown = THROWN_BY_FIXTURE[g.suite]
  if (thrown === undefined) throw new Error(`no setup is known for ${g.suite}`)
  if (failure === undefined) return false
  const reported = failure.fn(thrown(), { hook: 'globalSetup', path: '<root>/setup.ts' })
  return `${reported.name}: ${reported.message}` === String(observedOf(g).stderr ?? '')
}

const conditionsMatch = (g: Golden, value: unknown): boolean => {
  const runner = CONDITIONS_BY_RUNNER[g.runner]
  if (runner === undefined) throw new Error(`no conditions are known for the runner ${g.runner}`)
  const ref = value as { readonly export?: unknown } | null
  if (ref?.export !== runner.export) return false
  const environment = CONDITION_ENVIRONMENTS[g.suite]
  if (environment === undefined) throw new Error(`no environment is known for ${g.suite}`)
  const conditions = new Set([...runner.fn(environment), runner.token])
  const predicted = DUAL_EXPORTS_ORDER.find((key) => key === 'default' || conditions.has(key))
  const test = g.files.flatMap((file) => file.tests)[0]
  if (test === undefined || test.status !== 'passed') {
    throw new Error(`${g.suite} (${g.runner}) has no passing test`)
  }
  return test.id.path.join(' ').includes(`${predicted} variant`)
}

/** The isolation tiers both dialects' tests pin: `registry` (D6), and `realm` for a DOM. */
const ISOLATION = { default: 'registry', byEnvironment: { jsdom: 'realm', 'happy-dom': 'realm' } }

export const orchestratorClaims: Claims = {
  'orchestrator.include': golden('defaults'),
  'orchestrator.exclude': golden('defaults'),
  'orchestrator.bail.checkAfter': golden('orchestrator-bail', {
    // With --bail=1: does the file's second test run after the first fails?
    read: (g) => {
      const status = statusOf(g, 'would pass next')
      return oneOf(status, [
        ['file', status === 'passed'],
        ['test', status === 'notRun' || status === 'skipped'],
      ])
    },
  }),
  'orchestrator.watchDefault': each(
    golden('defaults'),
    pending(
      'D47',
      'Vitest watches when stdin is a TTY outside CI and agents (configDefaults.watch); a recorded run has no TTY, so no run shows that half',
    ),
  ),
  'orchestrator.watch.initialRun': pending(
    'T9.11',
    'watch mode is not built, and a recorded run cannot enter it',
  ),
  'orchestrator.passWithNoTests': each(
    [golden('orchestrator-no-tests', { read: (g) => exitCode(g) === 0 }), golden('defaults')],
    golden('orchestrator-no-tests', { read: (g) => exitCode(g) === 0 }),
  ),
  // Jest's runner marks a suite skipped only when every test is pending, so a file with a todo
  // test gets a PASS line; the golden holds a todo-only file next to an all-skipped one.
  'orchestrator.todoOnlyFile': each(
    golden('cli/report-todo-only', {
      read: (g) => (stderrOf(g).includes('PASS ./todo-only.test.ts') ? 'pass' : 'skip'),
    }),
    pending('T11.16', 'no Vitest fixture records what a file of only todo tests ends as'),
  ),
  // One worker runs two files: the second sees none of the listeners the first added to
  // `process`, and not the `env` variable it set; twelve files whose setup file adds an `exit`
  // listener each count one.
  'orchestrator.processObject': each(
    [
      golden('env/process-per-file-listeners', {
        read: (g) => processObjectOf(g, 'exit listeners: '),
      }),
      golden('env/process-per-file-env', {
        read: (g) => processObjectOf(g, "the first file's variable: ", 'undefined'),
      }),
      golden('env/process-setup-listener-per-file', {
        read: (g) => processObjectOf(g, 'exit listeners after the setup file: ', '1'),
      }),
    ],
    pending('T11.16', 'no Vitest fixture records which `process` a test file sees'),
  ),
  'orchestrator.exitCodes.failure': golden('orchestrator-exit-codes', { read: exitCode }),
  'orchestrator.exitCodes.noTests': golden('orchestrator-no-tests', { read: exitCode }),
  // A flag the runner doesn't know: Jest names it, Vitest's cac throws; both exit with 1. A bad
  // Jest config (`cli/bad-config`) exits with 1 as well.
  'orchestrator.exitCodes.usage': each(
    [golden('cli/unknown-flag', { read: exitCode }), golden('cli/bad-config', { read: exitCode })],
    golden('cli/unknown-flag', { read: exitCode }),
  ),
  // Does a relative glob find the test file? Jest matches the absolute path, so it doesn't.
  'orchestrator.globMatchesOn': golden('orchestrator-match-path', {
    read: (g) => (g.files.length === 0 ? 'absolute-path' : 'root-relative-path'),
  }),
  'orchestrator.exitCodes.unhandled': each(
    golden('orchestrator-unhandled', { read: exitCode }),
    golden('core-late-error', { read: exitCode }),
  ),
  'orchestrator.unhandledErrors': each(
    // Every test passed and an afterAll threw: the run still fails.
    golden('orchestrator-unhandled', {
      read: (g) =>
        statusOf(g, 'passes') === 'passed' && exitCode(g) !== 0 ? 'fail-run' : 'ignore',
    }),
    // Every test passed and a timer threw after its test: the run still fails.
    golden('core-late-error', {
      read: (g) =>
        statusOf(g, 'leaves a throwing timer behind') === 'passed' && exitCode(g) !== 0
          ? 'fail-run'
          : 'ignore',
    }),
  ),
  'orchestrator.coverageProvider': golden('defaults'),
  'orchestrator.coverageReporters': golden('defaults'),
  'orchestrator.slowTestThresholdMs': golden('defaults'),
  'orchestrator.isolationDefault': each(
    own(
      'packages/dialect-jest/src/dialect.test.ts',
      'isolationDefault',
      ISOLATION,
      'D6: the tier is ours',
    ),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'isolationDefault',
      ISOLATION,
      'the tier is ours (D6 for Jest, the same for Vitest)',
    ),
  ),
  'orchestrator.envDefault': golden('defaults'),
  'orchestrator.environmentPragmas': golden('orchestrator-pragmas', { read: pragmasRead }),
  // A behaviour, so the value is the ref. Jest's conditions come from the environment class (jsdom
  // `browser`, node `node`, a project's `customExportConditions`), which three recorded Jest runs
  // show (`env/conditions-jsdom`, `-custom`, `-node`): each golden says which variant of a package
  // with `browser`, `node`, `import`, `require` and `default` conditions Jest resolved, and the
  // value's own function must predict the same one for that fixture's environment. Vitest's half is
  // `env/conditions-vitest-jsdom`: under `environment: 'jsdom'` its resolver picks `node`, not `browser`.
  'orchestrator.environmentConditions': each(
    [
      golden('env/conditions-jsdom', { matches: conditionsMatch }),
      golden('env/conditions-custom', { matches: conditionsMatch }),
      golden('env/conditions-node', { matches: conditionsMatch }),
    ],
    golden('env/conditions-vitest-jsdom', { matches: conditionsMatch }),
  ),
  'orchestrator.pool.default': each(
    [
      golden('orchestrator-pool', { read: (g) => titleAfter(g, 'file a runs in: ') }),
      golden('defaults'),
    ],
    golden('orchestrator-pool', { read: (g) => titleAfter(g, 'file a runs in: ') }),
  ),
  'orchestrator.runInBand.auto': golden('orchestrator-run-in-band', {
    read: (g) => titleAfter(g, 'the only file runs in: ') === 'inline',
  }),
  // Jest 30.5.2's `--shard=i/3` over 8 files (`cli/shard-1-of-3` to `-3-of-3`): each shard ran the
  // slice of the sha1 order of the paths (3, 3, 2 files), which a path-sorted slice would not give.
  // Vitest 5.0.5's `BaseSequencer.shard` sorts by sha1 too (read from its source, not recorded).
  'orchestrator.shard.fallback': each(
    [
      golden('cli/shard-1-of-3', { read: shardSplit }),
      golden('cli/shard-2-of-3', { read: shardSplit }),
      golden('cli/shard-3-of-3', { read: shardSplit }),
    ],
    pending('T11.16', 'Vitest 5.0.5 shards by sha1 in its source; no fixture records it yet'),
  ),
  'orchestrator.sequence.unknownFirst': pending(
    'B21',
    "T9.6's sequencer; a recorded run lists files by path, so the order needs the sequencer's own code in a fixture (D27)",
  ),
  'orchestrator.globalSetup.signature': golden('orchestrator-global-setup', {
    read: (g) => {
      const text = capturedFile(g, 'global-setup.txt')
      const [first = '', ...rest] = text.split('\n')
      const shown = JSON.parse(first) as Record<string, unknown>
      return oneOf(text, [
        [
          'global-and-project-config',
          shown.arguments === 2 &&
            shown.firstHasRootDir === true &&
            shown.secondHasTestMatch === true,
        ],
        [
          'project-with-teardown',
          shown.arguments === 1 && shown.firstHasProvide === true && rest.includes('teardown ran'),
        ],
      ])
    },
  }),
  // Two projects, each with its own setup and teardown writing a line (`cli/global-setup-projects`):
  // Jest's teardown runs in the setups' order.
  'orchestrator.globalSetup.teardownOrder': each(
    golden('cli/global-setup-projects', {
      read: (g) => {
        const text = capturedFile(g, 'order.txt')
        const named = (word: string): string[] =>
          text
            .split('\n')
            .filter((line) => line.startsWith(`${word} `))
            .map((line) => line.slice(word.length + 1))
        const setups = named('setup')
        const teardowns = named('teardown')
        return oneOf(text, [
          ['in-order', isDeepStrictEqual(setups, teardowns)],
          ['reverse', isDeepStrictEqual(setups.toReversed(), teardowns)],
        ])
      },
    }),
    pending(
      'T11.16',
      "Vitest's global setup runs with its config reader; its source closes the projects last to first",
    ),
  ),
  // What a hook that throws is reported as. Jest's behaviour is held to the four recordings of a
  // setup that throws an Error, a TypeError whose message runs over two lines, an object and a
  // string: the header Jest's CLI printed (the class, then the message) is what the behaviour's
  // error says. A flip to the neutral behaviour words it differently, so it fails every one.
  'orchestrator.globalSetup.failure': each(
    [
      golden('cli/global-setup-throws', { matches: failureMatches }),
      golden('cli/global-setup-throws-typeerror', { matches: failureMatches }),
      golden('cli/global-setup-throws-object', { matches: failureMatches }),
      golden('cli/global-setup-throws-string', { matches: failureMatches }),
    ],
    pending(
      'T11.16',
      "Vitest's global setup runs with its config reader; its source rethrows the setup's own error, and no recording shows it yet",
    ),
  ),
}

export const reportClaims: Claims = {
  'report.displaySeparator': golden('report-default', {
    read: (g) => /the suite(.*?)the failing test/.exec(failureLine(g))?.[1],
  }),
  'report.defaultReporters': golden('defaults'),
  'report.failureTitleBullet': golden('report-default', {
    // The text before the title: Jest's bullet, or Vitest's FAIL line with no bullet.
    read: (g) => {
      const line = failureLine(g)
      return line.includes(' FAIL ') ? null : line.slice(0, line.indexOf('the suite'))
    },
  }),
  // Jest's `runJest` lists every test of a run of one file; the golden's check mark is that list.
  'report.listTestsForSingleFile': each(
    golden('cli/report-single-file', { read: (g) => stderrOf(g).includes('✓ adds') }),
    pending('T11.16', 'no Vitest fixture records a run of one file under its default reporter'),
  ),
  'report.resultStatusSkipped': pending(
    'T11.8',
    "the word Jest's --json uses for a skipped test is T11.8's to write; the recorder keeps only the converted status",
  ),
}

const coverageIsPhase2 = pending(
  'T8.9',
  'coverage is Phase 2 (T8.8-T8.10); its fixtures record the threshold rules',
)

export const coverageClaims: Claims = {
  'coverage.thresholdGrouping': coverageIsPhase2,
  'coverage.globThresholdScope': coverageIsPhase2,
  'coverage.includeUntestedByDefault': coverageIsPhase2,
  'coverage.reportsDirectory': golden('defaults'),
}

export const globalsClaims: Claims = {
  'globals.names': golden('core-globals-at-setup', {
    read: (g) => observation(g, 'globals in the test file'),
  }),
  'core.globalsBeforeSetupFiles': golden('core-globals-at-setup', {
    read: (g) => {
      const atSetup = observation(g, 'globals in a setupFiles module')
      const inFile = observation(g, 'globals in the test file')
      return JSON.stringify(atSetup) === JSON.stringify(inFile) ? 'all' : atSetup
    },
  }),
}
