// The evidence for the `orchestrator`, `report` and `coverage` slices and the dialects' global
// names (T1.7). Black-box runs show exit codes, where files run and what the default reporter
// prints; `policy/defaults` holds the config defaults no run shows (D27).
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
  'orchestrator.environmentConditions': pending(
    'B17c',
    "the environment's export conditions are T8.7's",
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
