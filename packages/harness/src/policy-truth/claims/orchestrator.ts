// The evidence for the `orchestrator`, `report` and `coverage` slices and the dialects' global
// names (T1.7). Black-box runs show exit codes, where files run and what the default reporter
// prints; `policy/defaults` holds the config defaults no run shows (D27).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { jestPolicy } from '@provino/dialect-jest'
import { jestDependencyExtractor } from '@provino/dialect-jest/affected'
import { globalSetupFailure as jestGlobalSetupFailure } from '@provino/dialect-jest/global-setup'
import { jestEnvironmentConditions } from '@provino/dialect-jest/runtime'
import { vitestEnvironmentConditions } from '@provino/dialect-vitest/runtime'
import { scanSource } from '@provino/loader/graph'
import { globalSetupFailure as neutralGlobalSetupFailure } from '@provino/policy/behaviours'
import type { EnvironmentRequest, GlobalSetupFailure } from '@provino/types'
import { defaultFixturesRoot } from '../../fixture.ts'
import type { Golden } from '../../golden.ts'
import { type Claims, each, golden, own, pending } from '../evidence.ts'
import {
  capturedFile,
  observation,
  observedOf,
  oneOf,
  refTo,
  statusOf,
  titlesOf,
} from '../observe.ts'

const exitCode = (g: Golden): unknown => observedOf(g).exitCode
/** The one test whose title starts with `prefix`, read for what follows it. */
const titleAfter = (g: Golden, prefix: string): string => {
  const titles = titlesOf(g)
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
  const titles = titlesOf(g)
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
const affectedVitestPending = pending(
  'T11.16',
  "Vitest's `--changed` and its graph are not recorded; the neutral value stands until then",
)

/** The test files a `changed/*` listing golden holds (`--listTests`), root-relative. */
const listedTests = (g: Golden): readonly string[] =>
  capturedFile(g, '.harness-out/jest.json')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^<root>\//, ''))
/** Whether the listing golden holds exactly these test files. */
const lists = (g: Golden, files: readonly string[]): boolean =>
  isDeepStrictEqual(listedTests(g).toSorted(), files.toSorted())

/**
 * Whether an extractor (the value: a ref to haste's, or `null` for the neutral lexer) predicts the
 * files a `changed/related-extractor-*` golden listed for `src/foo.ts`: the fixture's test files
 * whose read specifiers hold `./src/foo.ts`. Each fixture has one test file the two read alike and
 * one they read apart (a commented `require` and a `jest.requireActual`; a `...require(`).
 */
const extractorMatches = (g: Golden, value: unknown): boolean => {
  let extract: (code: string) => readonly string[]
  if (value === null) extract = (code) => scanSource(code).edges.map((edge) => edge.specifier)
  else if (refTo('@provino/dialect-jest/affected', 'jestDependencyExtractor')(value)) {
    const extractor = jestDependencyExtractor()
    extract = (code) => [...extractor.extract(code, '', () => new Set<string>())]
  } else return false
  const dir = path.join(defaultFixturesRoot(), g.suite)
  const predicted = readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => extract(readFileSync(path.join(dir, name), 'utf8')).includes('./src/foo.ts'))
  return lists(g, predicted)
}

/** `orchestrator.changedFiles` under the Jest dialect: the ref the bin's test holds to the goldens. */
const JEST_CHANGED_FILES: unknown = jestPolicy.orchestrator?.changedFiles

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

/** The seven files of the `cli/vitest-shard-*-of-3` fixtures, root-relative. */
const VITEST_SHARD_FILES: readonly string[] = [
  'alpha.test.ts',
  'beta.test.ts',
  'delta.test.ts',
  'epsilon.test.ts',
  'eta.test.ts',
  'gamma.test.ts',
  'zeta.test.ts',
]

/**
 * Which split a `cli/vitest-shard-*` golden shows: the files its json report holds against the
 * slices of the sha1 order of the paths with and without a leading `/`, and of the path order.
 */
const vitestShardSplit = (g: Golden): string => {
  const [, index, count] = /shard-(\d+)-of-(\d+)$/.exec(g.suite) ?? []
  if (index === undefined || count === undefined) throw new Error(`${g.suite} is no shard fixture`)
  const report = (observedOf(g) as { json?: Record<string, { testResults?: { name: string }[] }> })
    .json?.['.harness-out/vitest.json']
  const ran = (report?.testResults ?? []).map((file) => file.name.replace('<root>/', '')).toSorted()
  const byHashOf = (key: (name: string) => string): string[] =>
    VITEST_SHARD_FILES.toSorted((a, b) => {
      const [ha, hb] = [a, b].map((name) => createHash('sha1').update(key(name)).digest('hex'))
      return (ha as string) < (hb as string) ? -1 : 1
    })
  const expected = (ordered: readonly string[]): string[] =>
    sliceOf(ordered, Number(index), Number(count)).toSorted()
  if (isDeepStrictEqual(ran, expected(byHashOf((name) => `/${name}`)))) return 'rooted-sha1-slice'
  if (isDeepStrictEqual(ran, expected(byHashOf((name) => name)))) return 'sha1-slice'
  if (isDeepStrictEqual(ran, expected(VITEST_SHARD_FILES.toSorted()))) return 'path-slice'
  return `unknown: ${ran.join(', ')}`
}

/** What a recorded black-box run printed on stderr (Jest writes its report there). */
const stderrOf = (g: Golden): string => observedOf(g).stderr ?? ''
/**
 * What a golden's files with no test (`empty`) ended as, from the reporter's header lines: `fail`
 * when all are FAIL, `pass` when all are PASS, and a golden that shows neither (or a mix) is not
 * evidence. A file that declared tests (`declared`: only skipped or todo ones, or every one left
 * out by `-t`) is never this rule's, so a golden where one of them failed is no evidence either:
 * it would read a rule that fails too much as Jest's.
 */
const noTestsFileOf = (
  g: Golden,
  {
    empty,
    declared = [],
  }: { readonly empty: readonly string[]; readonly declared?: readonly string[] },
): string => {
  const lines = stderrOf(g).split('\n')
  const states = empty.map((file) => {
    const header = lines.find((line) => /^(PASS|FAIL) /.test(line) && line.endsWith(file))
    return header?.slice(0, 4)
  })
  for (const file of declared) {
    const status = g.files.find((candidate) => candidate.file === file)?.status
    if (status === undefined || status === 'crashed' || status === 'failed') {
      throw new Error(
        `${g.suite} (${g.runner}): ${file} declares tests, so it can't have ${status}`,
      )
    }
  }
  if (states.every((state) => state === 'FAIL')) return 'fail'
  if (states.every((state) => state === 'PASS')) return 'pass'
  throw new Error(`${g.suite} (${g.runner}): the empty files have no common PASS or FAIL line`)
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
  { module: '@provino/dialect-jest/global-setup', fn: jestGlobalSetupFailure },
  { module: '@provino/policy/behaviours', fn: neutralGlobalSetupFailure },
]

/**
 * Whether the ref (the dialect's `globalSetup.failure`) reports what the fixture's setup throws as
 * Jest's CLI printed it: the class and the message of the error the behaviour returns are the
 * golden's whole stderr, which `keepLines` cut to the lines that are no stack frame.
 */
const failureMatches = (g: Golden, value: unknown): boolean => {
  const failure = FAILURES.find((known) => refTo(known.module, 'globalSetupFailure')(value))
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
  // A key during a run (`watch/key-during-run`): Jest's run log has the interrupted run with no
  // file, the one it killed left out. `provino`'s `jest-watch.test.ts` holds the bin to it.
  'orchestrator.watch.interruptedFiles': each(
    golden('watch/key-during-run', {
      read: (g) => {
        const runs = (observedOf(g) as { readonly runs?: unknown }).runs
        const [run] = Array.isArray(runs)
          ? (runs as { files?: unknown; wasInterrupted?: unknown }[])
          : []
        if (run?.wasInterrupted !== true || !Array.isArray(run.files)) {
          throw new Error(`${g.suite} (${g.runner}) has no interrupted run`)
        }
        return run.files.length === 0 ? 'drop' : 'report'
      },
    }),
    pending('T11.16', "Vitest's watch mode (its rerun on a key) is T11.16's"),
  ),
  // B23c (D118): changed-file and affected-test selection. Jest's values come from the `changed/*`
  // goldens, recorded by B23c Phase 2 and compared by Phase 5; Vitest's `--changed` runs other
  // commands (T11.16). The neutral values are ours and are pinned in `@provino/policy`'s test.
  // Jest 30.5.2's selection, held whole: `provino`'s `jest-changed.test.ts` runs every `changed/*`
  // golden through the bin (the hermetic git steps, the listed set, the kept lines, the exit code),
  // which only Jest's provider passes (the neutral `null` refuses `-o`).
  'orchestrator.changedFiles': each(
    own(
      'packages/provino/test/jest-changed.test.ts',
      'orchestrator.changedFiles',
      JEST_CHANGED_FILES,
      "jest-changed-files rebuilt: Jest's git, hg and sl commands, held to the 38 `changed/*` recordings through the bin; hg and sl to the real adapters' calls (D27)",
    ),
    affectedVitestPending,
  ),
  // Haste reads a `jest.requireActual` and skips a commented `require`; it skips `...require(` too.
  'orchestrator.affected.extractor': each(
    [
      golden('changed/related-extractor-comments', { matches: extractorMatches }),
      golden('changed/related-extractor-spread', { matches: extractorMatches }),
    ],
    affectedVitestPending,
  ),
  // `src/__mocks__/foo.ts` reaches the test that requires `./src/foo` (the adjacent mock), and
  // `__mocks__/ghost.ts` the test that requires the unresolvable `ghost` (the root mock by name).
  'orchestrator.affected.mockEdges.dir': each(
    golden('changed/related-mock-adjacent', {
      read: (g) => (lists(g, ['foo.test.ts']) ? '__mocks__' : listedTests(g).join(', ')),
    }),
    affectedVitestPending,
  ),
  'orchestrator.affected.mockEdges.adjacent': each(
    golden('changed/related-mock-adjacent', { read: (g) => lists(g, ['foo.test.ts']) }),
    affectedVitestPending,
  ),
  'orchestrator.affected.mockEdges.byName': each(
    golden('changed/related-mock-root', { read: (g) => lists(g, ['ghost.test.ts']) }),
    affectedVitestPending,
  ),
  // A config file and a setup file reach no test: Jest selects by the graph alone.
  'orchestrator.affected.invalidateAll': each(
    [
      golden('changed/related-config-file', {
        read: (g) => (lists(g, []) ? 'none' : 'project-inputs'),
      }),
      golden('changed/related-setup-file', {
        read: (g) => (lists(g, []) ? 'none' : 'project-inputs'),
      }),
    ],
    affectedVitestPending,
  ),
  'orchestrator.affected.graph': each(
    pending(
      'T9.12',
      'no `changed/*` recording runs `-o` after a run whose loaded modules a recorded graph would read, so static and recorded selection give the same files on every one',
    ),
    affectedVitestPending,
  ),
  // An edge resolves with `require`, `node` and `default`, not `import` (SearchSource passes no
  // conditions: defaultResolver.ts L181-L187).
  'orchestrator.affected.conditions': each(
    golden('changed/related-exports-conditions', {
      read: (g) =>
        lists(g, ['default.test.ts', 'node.test.ts', 'require.test.ts']) ? 'none' : 'environment',
    }),
    affectedVitestPending,
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
  // A matched file that declares no test (a helper under `__tests__`, a file of one empty
  // `describe`) is a FAIL line and a failed suite, "Your test suite must contain at least one
  // test.", with and without `--passWithNoTests`; the passing file next to them is read too. A
  // file whose tests are only todo or skipped, or that `-t` left none of, is not one of them
  // (`noTestsFileOf`'s `declared` throws on a golden that fails them).
  'orchestrator.noTestsFile': each(
    [
      golden('cli/empty-test-file', {
        read: (g) => noTestsFileOf(g, { empty: ['describe-only.test.ts', '__tests__/helper.ts'] }),
      }),
      golden('cli/empty-test-file-pass-with-no-tests', {
        read: (g) => noTestsFileOf(g, { empty: ['describe-only.test.ts', '__tests__/helper.ts'] }),
      }),
      golden('cli/empty-test-file-skipped-and-todo', {
        read: (g) =>
          noTestsFileOf(g, {
            empty: ['describe-only.test.ts'],
            declared: [
              'todo-only.test.ts',
              'skip-only.test.ts',
              'skipped-describe.test.ts',
              'passes.test.ts',
            ],
          }),
      }),
      golden('cli/empty-test-file-name-pattern', {
        read: (g) =>
          noTestsFileOf(g, { empty: ['describe-only.test.ts'], declared: ['has-tests.test.ts'] }),
      }),
    ],
    pending(
      'T11.16',
      "no Vitest fixture records what a file with no test ends as (5.0.5's `runFiles` fails it unless `passWithNoTests`)",
    ),
  ),
  // Jest's console entries keep the call site, and its text prints it under each entry.
  'orchestrator.consoleOrigin': each(
    golden('cli/report-default', {
      read: (g) =>
        /\n {6}at Object\.log \(console\.test\.ts:4:11\)/.test(stderrOf(g)) ? 'stack' : 'none',
    }),
    pending('T11.16', 'no Vitest fixture records a console call site'),
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
  // Jest 30.5.2, given two workers, ran a single file inline (`policy/orchestrator-run-in-band`):
  // `single`. Vitest forked it. The 20-files and 1000 ms numbers are read from
  // `testSchedulerHelper.ts` (L10, L76); showing them needs a warm timings cache.
  'orchestrator.inBand.single': golden('orchestrator-run-in-band', {
    read: (g) => titleAfter(g, 'the only file runs in: ') === 'inline',
  }),
  'orchestrator.inBand.fastFileCount': pending(
    'B14',
    'jest-core testSchedulerHelper.ts L76 (`tests.length <= 20`): no fixture warms the timings cache',
  ),
  'orchestrator.inBand.slowMs': pending(
    'B14',
    'jest-core testSchedulerHelper.ts L10 (`SLOW_TEST_TIME`): no fixture warms the timings cache',
  ),
  // Jest 30.5.2's `--shard=i/3` over 8 files (`cli/shard-1-of-3` to `-3-of-3`): each shard ran the
  // slice of the sha1 order of the paths (3, 3, 2 files), which a path-sorted slice would not give.
  // Vitest 5.0.5's `BaseSequencer.shard` (`cli/vitest-shard-1-of-3` to `-3-of-3`, 7 files: 3, 2, 2)
  // ran the slice of the sha1 order of each path with its leading `/`.
  'orchestrator.shard.fallback': each(
    [
      golden('cli/shard-1-of-3', { read: shardSplit }),
      golden('cli/shard-2-of-3', { read: shardSplit }),
      golden('cli/shard-3-of-3', { read: shardSplit }),
    ],
    [
      golden('cli/vitest-shard-1-of-3', { read: vitestShardSplit }),
      golden('cli/vitest-shard-2-of-3', { read: vitestShardSplit }),
      golden('cli/vitest-shard-3-of-3', { read: vitestShardSplit }),
    ],
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

/** The files of a recorded `coverage-final.json`. */
const v8FinalOf = (g: Golden): Readonly<Record<string, unknown>> => {
  const final = observedOf(g).json?.['coverage/coverage-final.json']
  return typeof final === 'object' && final !== null && !Array.isArray(final)
    ? (final as Readonly<Record<string, unknown>>)
    : {}
}

/**
 * Whether a line of the golden's stderr is the template filled in: `{metric}` a metric's name,
 * `{actual}` and `{threshold}` numbers, `{name}` and `{path}` the group (or the file) as written.
 */
const thresholdLineMatches = (g: Golden, template: unknown): boolean => {
  if (typeof template !== 'string') return false
  const pattern = template
    .split(/(\{\w+\})/)
    .map((part) => {
      switch (part) {
        case '{metric}':
          return '(?:statements|branches|lines|functions)'
        case '{actual}':
        case '{threshold}':
          return '-?\\d+(?:\\.\\d+)?'
        case '{name}':
        case '{path}':
          return '.+?'
        default:
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
    })
    .join('')
  const line = new RegExp(`^${pattern}$`)
  return stderrOf(g)
    .split('\n')
    .some((text) => line.test(text))
}

export const coverageClaims: Claims = {
  // `src/deep/partial.ts` is under a path group it meets and a glob group it misses; Jest reports
  // the glob group's miss, so a file counts for every group that names it.
  'coverage.thresholdGrouping': each(
    golden('coverage/threshold-overlap', {
      read: (g) =>
        stderrOf(g).includes('"<root>/src/deep/partial.ts" threshold')
          ? 'every-match'
          : 'first-match',
    }),
    pending('B25', "Vitest's grouping is B25's"),
  ),
  // `collectCoverageFrom` names `src/**/*.ts`, and the file no test imports is in the report.
  'coverage.includeUntestedByDefault': each(
    golden('coverage/babel-providers-sample', {
      read: (g) => {
        const final = observedOf(g).json?.['coverage/coverage-final.json']
        return typeof final === 'object' && final !== null
          ? Object.keys(final).some((path) => path.endsWith('/src/untested.ts'))
          : undefined
      },
    }),
    pending('B25', "Vitest's coverage is B25's"),
  ),
  'coverage.reportsDirectory': golden('defaults'),
  // Every file of Jest's v8 report carries `all`, which only v8-to-istanbul writes (its
  // `--all` mark): no Istanbul instrumenter and no AST converter puts it there.
  'coverage.v8Conversion': each(
    golden('coverage/v8-providers-sample', {
      read: (g) => {
        const files = Object.values(v8FinalOf(g))
        return files.length > 0 &&
          files.every((file) => typeof file === 'object' && file !== null && 'all' in file)
          ? 'v8-to-istanbul'
          : 'ast'
      },
    }),
    pending('B25', "Vitest's converter is B25's"),
  ),
  // A statement counted more than once: V8 counted calls, not only that a range ran.
  'coverage.v8HitCounts': each(
    golden('coverage/v8-providers-sample', {
      read: (g) =>
        Object.values(v8FinalOf(g)).some(
          (file) =>
            typeof file === 'object' &&
            file !== null &&
            's' in file &&
            typeof file.s === 'object' &&
            file.s !== null &&
            Object.values(file.s).some((hits) => typeof hits === 'number' && hits > 1),
        ),
    }),
    pending('B25', "Vitest's V8 collection is B25's"),
  ),
  // `greet.js` starts with a hashbang and has no map: Jest's module function, which covers the
  // code V8 ran, ends that many characters before the file does (on line 15 of 16).
  'coverage.v8Hashbang': each(
    golden('coverage/v8-commonjs', {
      read: (g) => {
        const greet = Object.entries(v8FinalOf(g)).find(([path]) => path.endsWith('/greet.js'))?.[1]
        const branch =
          typeof greet === 'object' && greet !== null && 'branchMap' in greet
            ? (greet.branchMap as Record<string, { loc?: { end?: { line?: number } } }>)['0']
            : undefined
        const end = branch?.loc?.end?.line
        return end === undefined ? undefined : end < 16 ? 'removed' : 'kept'
      },
    }),
    pending('B25', "Vitest's V8 collection is B25's"),
  ),
  // Both tests read `globalThis.__coverage__`; they pass only when the counters live there.
  'coverage.istanbulVariable': each(
    golden('coverage/istanbul-variable', {
      read: (g) =>
        statusOf(g, 'the counters live in globalThis.__coverage__, keyed by the module path') ===
          'passed' && statusOf(g, 'a call moves its function counter in that global') === 'passed'
          ? '__coverage__'
          : undefined,
    }),
    pending('B25', "Vitest's Istanbul provider is B25's"),
  ),
  // The glob group's lines name each file (`"<root>/src/grade.ts" threshold`), not the glob: Jest
  // checks a glob group file by file.
  'coverage.globThresholdScope': each(
    golden('coverage/threshold-path-glob', {
      read: (g) =>
        stderrOf(g).includes('"<root>/src/grade.ts" threshold') ? 'per-file' : 'aggregate',
    }),
    pending('B25', "Vitest's glob thresholds are B25's"),
  ),
  'coverage.thresholdMessages.belowMinimum': each(
    golden('coverage/threshold-global', { matches: thresholdLineMatches }),
    pending('B25', "Vitest's threshold texts are B25's"),
  ),
  'coverage.thresholdMessages.aboveMaximumUncovered': each(
    golden('coverage/threshold-negative', { matches: thresholdLineMatches }),
    pending('B25', "Vitest's threshold texts are B25's"),
  ),
  'coverage.thresholdMessages.notFound': each(
    golden('coverage/threshold-not-found', { matches: thresholdLineMatches }),
    pending('B25', "Vitest's threshold texts are B25's"),
  ),
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
