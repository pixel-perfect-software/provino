// The evidence for the `orchestrator`, `report` and `coverage` slices and the dialects' global
// names (T1.7). Black-box runs show exit codes, where files run and what the default reporter
// prints; `policy/defaults` holds the config defaults no run shows (D27).
import { jestEnvironmentConditions } from '@provino/dialect-jest/runtime'
import type { EnvironmentRequest } from '@provino/types'
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
/** The default reporter's line naming the failing test. */
const failureLine = (g: Golden): string => {
  const lines = `${observedOf(g).stdout ?? ''}\n${observedOf(g).stderr ?? ''}`.split('\n')
  const line = lines.find((text) => text.includes('the failing test'))
  if (line === undefined) throw new Error(`${g.suite} (${g.runner}) printed no failure line`)
  return line
}

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
}

/** The keys of the fixtures' `dual` package `exports`, in the order a resolver tries them. */
const DUAL_EXPORTS_ORDER = ['browser', 'node', 'import', 'require', 'default'] as const

/**
 * Whether the value (a ref to Jest's `jestEnvironmentConditions`) predicts the variant the golden's
 * real Jest resolved: the first key of the `dual` package that is among the conditions, plus
 * `require` (the fixtures `require` it from CommonJS).
 */
const conditionsMatch = (g: Golden, value: unknown): boolean => {
  const ref = value as { readonly export?: unknown } | null
  if (ref?.export !== 'jestEnvironmentConditions') return false
  const environment = CONDITION_ENVIRONMENTS[g.suite]
  if (environment === undefined) throw new Error(`no environment is known for ${g.suite}`)
  const conditions = new Set([...jestEnvironmentConditions(environment), 'require'])
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
  // value's own function must predict the same one for that fixture's environment. Vitest's half
  // (its jsdom environment) is part 3 of B17c.
  'orchestrator.environmentConditions': each(
    [
      golden('env/conditions-jsdom', { matches: conditionsMatch }),
      golden('env/conditions-custom', { matches: conditionsMatch }),
      golden('env/conditions-node', { matches: conditionsMatch }),
    ],
    pending('B17c', "Vitest's jsdom environment (T8.3, part 3) records its conditions"),
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
  'orchestrator.shard.fallback': pending('B21', 'sharding is T9.6s; nothing shards yet'),
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
