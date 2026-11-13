// T11.7: the Jest command line against real `jest-cli` 30.5.2. Every command line below (about
// 150 written by hand from Track 11's F5 table, one set per option, and a generated set from a
// seeded PRNG) goes through `buildArgv` in ONE child process (`internal/cli-oracle-child.ts`, which
// stubs `process.exit` and the console, since yargs prints and exits on a bad line), and
// `parseJestArgv` must give the same argv, or fail where Jest fails with Jest's text.
//
// What the parser does not rebuild, and refuses by name (`JEST_CLI_UNSUPPORTED`, or
// `JEST_CLI_UNSUPPORTED_FORM` for a form of its own) instead of parsing differently:
// - `--help`, `-h`, a trailing `help` positional and `--version`: yargs prints text and exits 0.
// - `--get-yargs-completions`: yargs answers a shell completion request and exits.
// The tests assert both that these are refused and that real Jest exits 0 on them.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  JEST_CLI_OPTIONS,
  JestCliError,
  jestArgvToRunRequest,
  jestCli,
  jestFlags,
  parseJestArgv,
  parseJestCli,
} from './cli.ts'
import { jestNodeDialect } from './index.ts'
import { encodeForCompare } from './internal/cli-encode.ts'
import {
  type OracleOutcome,
  oracleOptions,
  plain,
  runCliOracleParallel,
} from './internal/cli-oracle.ts'

// --- the corpus ----------------------------------------------------------------------------------

/** Track 11 F5's Jest column, and the forms its "Done when" names (camel and dashed, aliases). */
const F5_ROWS: readonly (readonly string[])[] = [
  [],
  ['src/a.test.ts'],
  ['a', 'b', 'c'],
  ['--testPathPatterns', 'a', 'b'],
  ['--testPathPatterns=a'],
  ['--test-path-patterns', 'a', 'b'],
  ['--test-path-patterns=a'],
  ['--runTestsByPath', 'src/a.test.ts', 'src/b.test.ts'],
  ['--run-tests-by-path', 'src/a.test.ts'],
  ['-t', 'foo'],
  ['-t=foo'],
  ['-tfoo'],
  ['-t', 'foo bar'],
  ['--testNamePattern', 'foo'],
  ['--testNamePattern=foo'],
  ['--test-name-pattern=foo'],
  ['--watch'],
  ['--watchAll'],
  ['--watchAll=false'],
  ['--watch-all'],
  ['--coverage'],
  ['--coverage=false'],
  ['--no-coverage'],
  ['--collectCoverage'],
  ['--coverageProvider', 'v8'],
  ['--coverageProvider=babel'],
  ['--coverage-provider', 'v8'],
  ['--collectCoverageFrom', 'src/**'],
  ['--collectCoverageFrom=src/**/*.ts'],
  ['--coverageDirectory', 'out'],
  ['--reporters', 'default', 'jest-junit'],
  ['--reporters=default', '--reporters=summary'],
  ['--json'],
  ['--json', '--outputFile', 'out.json'],
  ['--outputFile=out.json'],
  ['--useStderr'],
  ['-i'],
  ['--runInBand'],
  ['--run-in-band'],
  ['-w', '2'],
  ['-w=2'],
  ['-w2'],
  ['--maxWorkers', '2'],
  ['--maxWorkers=2'],
  ['--maxWorkers=50%'],
  ['--maxWorkers', '50%'],
  ['--max-workers=50%'],
  ['--shard', '1/3'],
  ['--shard=2/3'],
  ['-o'],
  ['--onlyChanged'],
  ['--only-changed'],
  ['--changedSince', 'main'],
  ['--changedSince=origin/main'],
  ['--lastCommit'],
  ['--findRelatedTests', 'src/a.ts', 'src/b.ts'],
  ['--find-related-tests', 'src/a.ts'],
  ['--passWithNoTests'],
  ['--pass-with-no-tests'],
  ['--passWithNoTests=false'],
  ['--silent'],
  ['--verbose'],
  ['-u'],
  ['--updateSnapshot'],
  ['--update-snapshot'],
  ['--ci'],
  ['--no-ci'],
  ['--ci=false'],
  ['-b'],
  ['--bail'],
  ['--bail=2'],
  ['--bail', '2'],
  ['--listTests'],
  ['--list-tests'],
  ['--listTests', '--json'],
  ['--collectTests'],
  ['--detectOpenHandles'],
  ['--forceExit'],
  ['--openHandlesTimeout', '500'],
  ['--clearCache'],
  ['--no-cache'],
  ['--cache=false'],
  ['--cache'],
  ['--showConfig'],
  ['--testLocationInResults'],
  ['--env', 'jsdom'],
  ['-e'],
  ['--testEnvironment', 'node'],
  ['--testEnvironment=jsdom'],
  ['--randomize'],
  ['--seed', '5'],
  ['--seed=12345'],
  ['--showSeed'],
  ['--selectProjects', 'a', 'b'],
  ['--ignoreProjects', 'a'],
  ['--projects', 'a', 'b'],
  ['-c', 'jest.config.js'],
  ['-c=jest.config.js'],
  ['--config', 'jest.config.ts'],
  ['--config=jest.config.json'],
  ['--config', '{"testMatch":["a"]}'],
  ['--config={"a":1}'],
  ['-c', '{"a":1}'],
  ['--debug'],
  ['--workerThreads'],
  ['--worker-threads'],
  ['--ci', '--runInBand', '--passWithNoTests', 'src/a.test.ts'],
  ['-i', '-b', '-t', 'foo', 'src'],
  ['-ib'],
  ['-bi'],
  ['-ibe'],
  ['-bu'],
  ['-ou'],
  ['-t', 'foo', '-w', '2'],
]

/** Greedy arrays, `--`, numbers, repeats, negation and the odd yargs forms. */
const YARGS_ROWS: readonly (readonly string[])[] = [
  ['--testMatch', 'a', 'b', 'c'],
  ['--testMatch', 'a', '--bail', 'b'],
  ['--testMatch', 'a', '--', 'b'],
  ['--testMatch=a', 'b', 'c'],
  ['--testMatch=a', '--testMatch=b'],
  ['--testMatch', 'a', '--testMatch', 'b'],
  ['--roots', '1', '2'],
  ['--roots=1'],
  ['--setupFiles', '-1'],
  ['--', 'a', 'b'],
  ['a', '--', '--bail'],
  ['--', '--bail', '-b', '1'],
  ['a', '1', '2.5', '0x10', '-3', '007', '1e3', '99999999999999999999'],
  ['1'],
  ['-1'],
  ['--', '5', 'x'],
  ['--testTimeout', '5'],
  ['--testTimeout=abc'],
  ['--testTimeout', '-5'],
  ['--testTimeout=1.5'],
  ['--testTimeout', '1', '--testTimeout', '2'],
  ['--maxConcurrency', '3'],
  ['--maxWorkers', '1', '--maxWorkers', '2'],
  ['-w', '1', '-w', '2'],
  ['--cacheDirectory', '/tmp/x'],
  ['--cacheDirectory=/tmp/x'],
  ['--cache-directory=/tmp/x'],
  ['--cache-directory', '/tmp/x'],
  ['--bail', 'true'],
  ['--bail', 'false'],
  ['--bail=true'],
  ['--bail=false'],
  ['--no-bail'],
  ['--no-bail', '--bail'],
  ['--bail', '--no-bail'],
  ['--no-bail=true'],
  ['-b=false'],
  ['-b', 'false'],
  ['--no-cache', '--cache=false', 'a', '1', '--', '2', '-x'],
  ['--no-testMatch'],
  ['--no-roots'],
  ['--no-maxWorkers'],
  ['--maxWorkers', '--bail'],
  ['--maxWorkers', '-1'],
  ['--maxWorkers=', 'x'],
  ['--maxWorkers='],
  ['--testMatch='],
  ['--testMatch=', 'a'],
  ['--testMatch', '-x'],
  ['--config=', 'x.js'],
  ['--testRegex', 'a\\.test', 'b\\.spec'],
  ['--testRegex=a'],
  ['--globals', '{"a":1}'],
  ['--globals={"a":1}'],
  ['--haste', '{"a":1}'],
  ['--moduleNameMapper', '{"^a$":"b"}'],
  ['--transform', '{"^.+\\\\.ts$":"ts-jest"}'],
  ['--coverageThreshold', '{"global":{"branches":80}}'],
  ['--testEnvironmentOptions', '{"url":"http://x"}'],
  ['--coverageReporters', 'text', 'lcov'],
  ['--coverageReporters=text'],
  ['--moduleFileExtensions', 'ts', 'js'],
  ['--transformIgnorePatterns', 'node_modules'],
  ['--testPathIgnorePatterns', 'a', 'b'],
  ['--snapshotSerializers', 'x'],
  ['--setupFilesAfterEnv', 'a.ts'],
  ['--unmockedModulePathPatterns', 'x'],
  ['--watchPathIgnorePatterns', 'x'],
  ['--modulePaths', 'a'],
  ['--moduleDirectories', 'node_modules', 'src'],
  ['--modulePathIgnorePatterns', 'a'],
  ['--coveragePathIgnorePatterns', 'a', 'b'],
  ['--preset', 'ts-jest'],
  ['--rootDir', '.'],
  ['--rootDir=./src'],
  ['--root-dir=./src'],
  ['--resolver', './r.js'],
  ['--runner', 'jest-runner'],
  ['--testRunner', 'circus'],
  ['--testSequencer', './s.js'],
  ['--testResultsProcessor', './p.js'],
  ['--prettierPath', 'null'],
  ['--globalSetup', './g.js'],
  ['--globalTeardown', './g.js'],
  ['--filter', './f.js'],
  ['--injectGlobals=false'],
  ['--no-injectGlobals'],
  ['--waitForUnhandledRejections'],
  ['--workerGracefulExitTimeout', '500'],
  ['--testFailureExitCode', '2'],
  ['--testFailureExitCode=2'],
  ['--notify', '--notifyMode', 'failure'],
  ['--notifyMode=success-change'],
  ['--color'],
  ['--colors'],
  ['--no-color'],
  ['--expand'],
  ['-e', 'foo'],
  ['--noStackTrace'],
  ['--logHeapUsage'],
  ['--skipFilter'],
  ['--watchman'],
  ['--no-watchman'],
  ['--all'],
  ['--errorOnDeprecated'],
  ['--detectLeaks'],
  ['--changedFilesWithAncestor'],
  ['--onlyFailures'],
  ['-f'],
  ['--a.b=1'],
  ['--a.b', '2'],
  ['--a.b.c=3', '--a.d=4'],
  ['-a.b=1'],
  ['-a.b', '1'],
  ['--maxWorkers.x=1'],
  ['--globals.foo=bar'],
  ['---bail'],
  ['---'],
  ['----x'],
  ['---=x'],
  ['-'],
  ['--=x'],
  ['-=x'],
  ['--x-=1'],
  ['--foo-bar-baz=1'],
  ['--foo_bar=1'],
  ['--FOO'],
  ['--MaxWorkers', '2'],
  ['--Max-Workers=2'],
  ['--__proto__=1'],
  ['--constructor=1'],
  ['--b'],
  ['--w', '2'],
  ['-bail'],
  ['-bw', '2'],
  ['-wb'],
  ['-ww', '2'],
  ['-i2'],
  ['-b1'],
  ['-t1'],
  ['-t', '1'],
  ['-t', '-1'],
  ['-t', '--bail'],
  ['-t'],
  ['-tt'],
  ['-t='],
  ['-t=', 'foo'],
  ['-ut'],
  ['-tu', 'x'],
  ['-bt', 'x'],
  ['-bt=x'],
  ['-b-'],
  ['-b-x'],
  ['-b/x'],
  ['-5'],
  ['-5', '-b'],
  ['--5'],
  ['--5=1'],
  ['-0'],
  ['-.5'],
  ['--bail', '-5'],
  ['--testTimeout', '-.5'],
  ['--testTimeout', '.5'],
  ['--testTimeout', '5.'],
  ['--testTimeout', '0x10'],
  ['--testTimeout', '1e3'],
  ['--testTimeout', ''],
  ['--testTimeout='],
  ['--cacheDirectory', ''],
  ['--cacheDirectory='],
  ['--cacheDirectory', "'quoted'"],
  ['--cacheDirectory="quoted"'],
  ["--cacheDirectory='quoted'"],
  ['--testMatch="a"', "'b'"],
  ['--testMatch', 'true', 'false'],
  ['--roots', '0x1f', '1e2', '007'],
  ['--coverageProvider', '5'],
  ['--notifyMode', '5'],
  ['--coverageProvider=true'],
  ['--coverageProvider', 'v8', '--coverageProvider', 'babel'],
  ['--coverageProvider', 'v8', '--notifyMode', 'always'],
  ['--notifyMode', 'always', '--coverageProvider', 'x'],
  ['--coverage-provider=x', '--notify-mode=y'],
  ['--collectCoverageFrom', 'a', '--collectCoverageFrom', 'b'],
]

/** Lines that fail, each in a way Jest reports. */
const FAILURE_ROWS: readonly (readonly string[])[] = [
  ['-i', '-w', '2'],
  ['--runInBand', '--maxWorkers=2'],
  ['--runInBand=false', '--maxWorkers=2'],
  ['--no-runInBand', '-w', '2'],
  ['--maxWorkers'],
  ['-w'],
  ['--maxWorkers', '--bail'],
  ['--max-workers'],
  ['--onlyChanged', '--watchAll'],
  ['--lastCommit', '--watchAll'],
  ['--changedFilesWithAncestor', '--watchAll'],
  ['--changedSince', 'main', '--watchAll'],
  ['-o', '--watchAll'],
  ['--onlyFailures', '--watchAll'],
  ['-f', '--watchAll'],
  ['--onlyChanged', '--watchAll=false'],
  ['--findRelatedTests'],
  ['--findRelatedTests', '--bail'],
  ['--findRelatedTests', 'a.ts'],
  ['--findRelatedTests', '--', 'a.ts'],
  ['a.ts', '--findRelatedTests'],
  ['--selectProjects'],
  ['--ignoreProjects'],
  ['--selectProjects', '--bail'],
  ['--selectProjects='],
  ['--ignoreProjects='],
  ['--config', 'foo.txt'],
  ['--config=foo'],
  ['-c', 'jest.config'],
  ['--config', 'jest.config.JS'],
  ['--config', 'a.js', '--config', 'b.json'],
  ['--config', 'a.js', '--config', 'b.txt'],
  ['--config.a=1'],
  ['--config'],
  ['--cacheDirectory'],
  ['--coverageProvider'],
  ['--notifyMode'],
  ['--coverageProvider', 'bogus'],
  ['--coverageProvider=bogus'],
  ['--notifyMode', 'sometimes'],
  ['--coverageProvider', 'a', '--notifyMode', 'b'],
  ['--coverageProvider', 'bogus', '--maxWorkers'],
  ['--testMatch'],
  ['--testMatch', '--bail'],
  ['--roots'],
  ['--reporters'],
  ['--testTimeout'],
  ['--seed'],
  ['-t', '--bail'],
  ['--testNamePattern'],
  ['-c'],
  ['-e', '-w'],
  ['--env'],
  ['--bogus'],
  ['--bogus-flag'],
  ['--bogus-flag=1'],
  ['--bogusFlag'],
  ['--bogus', '--bail'],
  ['--bogus', '--other'],
  ['--bogus', '--other', '--third'],
  ['-x'],
  ['-xyz'],
  ['--testTimout', '5'],
  ['--testTimout=5'],
  ['--maxWorker', '2'],
  ['--coverge'],
  ['--ab'],
  ['--a'],
  ['--abc'],
  ['--A'],
  ['--Bail'],
  ['--BAIL'],
  ['--no-bogus'],
  ['--bogus.x=1'],
  ['--bogus', '1', '--bogus2', '2'],
  ['--testPathPattern=foo'],
  ['--testPathPattern', 'foo'],
  ['--test-path-pattern=foo'],
  ['--testPathPattern'],
  ['--no-testPathPattern'],
  ['--timers=fake'],
  ['--timers', 'real'],
  ['--browser'],
  ['--collectCoverageOnlyFrom', 'a'],
  ['--extraGlobals', 'a'],
  ['--init'],
  ['--moduleLoader', 'x'],
  ['--preprocessorIgnorePatterns', 'x'],
  ['--scriptPreprocessor', 'x'],
  ['--setupTestFrameworkScriptFile', 'x'],
  ['--testPathDirs', 'x'],
  ['--testURL', 'x'],
  ['--testURL=http://x'],
  ['--deprecationEntries'],
  ['--deprecationEntries=1'],
  ['--version=false'],
  ['--version', 'false'],
  ['--no-version'],
  ['--help=false'],
  ['--no-help'],
  ['--h'],
]

/** Forms that real Jest answers with text and exit 0: refused by name, never parsed. */
const REFUSED_ROWS: readonly (readonly string[])[] = [
  ['--help'],
  ['-h'],
  ['help'],
  ['a', 'help'],
  ['--version'],
  ['--bail', '--version'],
  ['--help', '--bogus'],
  ['--version', '--bogus'],
  ['--help', '--maxWorkers'],
  ['-bh'],
  ['--get-yargs-completions'],
  ['--get-yargs-completions', 'x'],
]

/** Flags named like `Object.prototype` properties: real Jest crashes ("l[t].forEach is not a function"). */
const CRASH_ROWS: readonly (readonly string[])[] = [
  ['--constructor=1'],
  ['--constructor'],
  ['--constructor', 'a'],
  ['--constructor.x=1'],
  ['--toString'],
  ['--toString=1'],
  ['--valueOf'],
  ['--hasOwnProperty=1'],
  ['--isPrototypeOf'],
  ['--propertyIsEnumerable'],
  ['--toLocaleString'],
  ['--__defineGetter__'],
  ['--__lookupGetter__=1'],
  ['--no-constructor'],
  ['--constructor', '--constructor'],
  ['--constructor=1', '--bail'],
  ['--constructor=1', '-i', '-w', '2'],
  ['--constructor=1', '--testPathPattern=x'],
  ['--constructor=1', '--bogus'],
]

/** Neighbours of the crash rows that do not crash, and the yargs `increment()` quirk. */
const QUIRK_ROWS: readonly (readonly string[])[] = [
  ['--constructor=1', '--help'],
  ['--constructor=1', '--maxWorkers'],
  ['--constructor=1', '--coverageProvider', 'x'],
  ['-x.constructor=1'],
  ['--a.constructor=1'],
  ['--__proto__'],
  ['--__proto__=1'],
  ['--x=1', '--x=1'],
  ['--x=1', '--x=1', '--x=1'],
  ['--x=2', '--x=1'],
  ['--x=1', '--x=2'],
  ['--x=3', '--x=1'],
  ['--x.y=1', '--x.y=1'],
  ['--testTimeout=1', '--testTimeout=1'],
  ['--testTimeout', '1', '--testTimeout', '1'],
  ['--testTimeout', '2', '--testTimeout', '1'],
  ['--roots=1', '--roots=1'],
  ['--cacheDirectory=1', '--cacheDirectory=1'],
  ['--maxWorkers=1', '--maxWorkers=1'],
  ['--bail=1', '--bail=1'],
  ['--no-x', '--x=1'],
  ['--x', '--x=1'],
]

const UNSUPPORTED_FORM_ROWS: readonly (readonly string[])[] = [
  ['--get-yargs-completions'],
  ['--get-yargs-completions', 'x'],
]

/** A small deterministic PRNG, so a failure names a reproducible line. */
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS: readonly string[] = [
  '--bail',
  '-b',
  '--no-bail',
  '--bail=false',
  '--bail=true',
  '--maxWorkers',
  '--max-workers',
  '--maxWorkers=2',
  '--maxWorkers=50%',
  '-w',
  '-w=3',
  '-i',
  '-ib',
  '-bi',
  '--runInBand',
  '-t',
  '-t=foo',
  '-tfoo',
  '--testNamePattern',
  '--testPathPatterns',
  '--test-path-patterns',
  '--testPathPatterns=a',
  '--testMatch',
  '--testMatch=x',
  '--roots',
  '--config',
  '-c',
  '--config=a.json',
  '--cache',
  '--no-cache',
  '--cache=false',
  '--coverageProvider',
  '--coverageProvider=v8',
  '--notifyMode',
  '--testTimeout',
  '--testTimeout=5',
  '--seed',
  '--listTests',
  '--json',
  '--watchAll',
  '--onlyChanged',
  '-o',
  '--findRelatedTests',
  '--selectProjects',
  '--env',
  '-e',
  '--ci',
  '--no-ci',
  '--globals.a=1',
  '--a.b',
  '--bogus',
  '--bogus-flag',
  '--bogus=1',
  '-x',
  '-',
  '--',
  '---',
  'foo',
  'src/a.test.ts',
  '1',
  '2.5',
  '-1',
  '0x10',
  '007',
  'true',
  'false',
  '50%',
  '',
  '--=',
  '-=x',
  '=',
  '"q"',
  "'q'",
  '-5',
  '--5',
  '--foo=bar=baz',
]

function generated(count: number, seed: number): (readonly string[])[] {
  const random = mulberry32(seed)
  const lines: string[][] = []
  for (let i = 0; i < count; i++) {
    const length = 1 + Math.floor(random() * 5)
    const line: string[] = []
    for (let j = 0; j < length; j++) {
      line.push(TOKENS[Math.floor(random() * TOKENS.length)] ?? '')
    }
    lines.push(line)
  }
  return lines
}

/** A value that suits an option's type, for the per-option rows. */
function sampleValue(name: string): string {
  const option = JEST_CLI_OPTIONS[name]
  if (name === 'config') return 'jest.config.js'
  if (option?.choices !== undefined) return option.choices[0] ?? 'x'
  if (option?.type === 'number') return '5'
  return 'value'
}

/** Command lines for every option: each form a user can write it in. */
function optionRows(): (readonly string[])[] {
  const rows: (readonly string[])[] = []
  for (const [name, option] of Object.entries(JEST_CLI_OPTIONS)) {
    const dashed = name.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    const value = sampleValue(name)
    const names = [name, ...(dashed === name ? [] : [dashed])]
    const aliases = option.alias === undefined ? [] : [option.alias]
    if (option.type === 'boolean') {
      for (const form of names) {
        rows.push([`--${form}`], [`--no-${form}`], [`--${form}=true`], [`--${form}=false`])
        rows.push([`--${form}`, 'false'], [`--${form}`, 'extra'], [`--${form}`, '--bail'])
      }
      for (const alias of aliases) {
        const flag = alias.length === 1 ? `-${alias}` : `--${alias}`
        rows.push([flag], [`${flag}=false`], [flag, 'false'], [flag, 'extra'])
        if (alias.length === 1) rows.push([`-${alias}b`], [`-b${alias}`])
      }
    } else {
      for (const form of names) {
        rows.push([`--${form}`], [`--${form}=${value}`], [`--${form}`, value])
        rows.push([`--${form}=`], [`--${form}`, '--bail'], [`--${form}`, value, value])
        rows.push([`--${form}=${value}`, `--${form}=${value}`], [`--${form}`, '1'])
        if (option.type === 'array') rows.push([`--${form}`, 'a', 'b', 'c'], [`--${form}=a`, 'b'])
      }
      for (const alias of aliases) {
        const flag = alias.length === 1 ? `-${alias}` : `--${alias}`
        rows.push([flag], [flag, value], [`${flag}=${value}`], [`${flag}${value}`])
        rows.push([`-b${alias}`, value], [`${flag}=`], [flag, '--bail'])
      }
    }
  }
  return rows
}

const HAND_WRITTEN = [
  ...F5_ROWS,
  ...YARGS_ROWS,
  ...FAILURE_ROWS,
  ...REFUSED_ROWS,
  ...CRASH_ROWS,
  ...QUIRK_ROWS,
]
const PER_OPTION = optionRows()
const GENERATED = generated(800, 0x30_5_2)
const ALL: readonly (readonly string[])[] = [...HAND_WRITTEN, ...PER_OPTION, ...GENERATED]
const ORACLE: readonly OracleOutcome[] = await runCliOracleParallel(ALL)

function outcomeOf(args: readonly string[]): OracleOutcome {
  const index = ALL.findIndex(
    (line) => line.length === args.length && line.every((arg, i) => arg === args[i]),
  )
  const outcome = ORACLE[index]
  if (outcome === undefined) throw new Error(`not in the corpus: ${JSON.stringify(args)}`)
  return outcome
}

/** What the parser did with a line, as a value to compare. */
function mine(
  args: readonly string[],
): { readonly argv: unknown } | { readonly error: JestCliError } {
  try {
    return { argv: JSON.parse(JSON.stringify(encodeForCompare(parseJestArgv(args)))) }
  } catch (error) {
    if (error instanceof JestCliError) return { error }
    throw error
  }
}

/** What real Jest throws on a flag named like an `Object.prototype` property (yargs `conflicting`). */
const YARGS_CRASH = 'l[t].forEach is not a function'

/** Why the parser's result differs from real Jest's for `args`, or `undefined` when it matches. */
function mismatch(args: readonly string[], oracle: OracleOutcome): string | undefined {
  const result = mine(args)
  if ('argv' in result) {
    if (oracle.argv === undefined)
      return `parsed, but Jest failed: ${oracle.stderr || oracle.threw}`
    try {
      assert.deepStrictEqual(result.argv, oracle.argv)
    } catch {
      return `argv differs:\n  jest: ${JSON.stringify(oracle.argv)}\n  ours: ${JSON.stringify(result.argv)}`
    }
    return undefined
  }
  const { error } = result
  if (oracle.argv !== undefined) return `refused (${error.code}), but Jest parsed it`
  if (oracle.threw === YARGS_CRASH) {
    return error.code === 'JEST_CLI_UNSUPPORTED_FORM'
      ? undefined
      : `Jest crashes (${YARGS_CRASH}), but we threw ${error.code}`
  }
  if (oracle.threw !== undefined) {
    // jest-validate throws; its message is the error's
    return error.message === plain(oracle.threw)
      ? undefined
      : `message differs:\n  jest: ${JSON.stringify(plain(oracle.threw))}\n  ours: ${JSON.stringify(error.message)}`
  }
  if (oracle.exit === 0) {
    // yargs printed help, the version or completions and exited
    return error.code === 'JEST_CLI_UNSUPPORTED' || error.code === 'JEST_CLI_UNSUPPORTED_FORM'
      ? undefined
      : `Jest exits 0, but we threw ${error.code}`
  }
  if (oracle.exit === 1) {
    // yargs prints its usage and the message to stderr, then exits 1
    return plain(oracle.stderr).includes(error.message)
      ? undefined
      : `message not in Jest's stderr:\n  ours: ${JSON.stringify(error.message)}\n  jest: ${JSON.stringify(plain(oracle.stderr).slice(-400))}`
  }
  return `unexpected oracle outcome ${JSON.stringify(oracle).slice(0, 200)}`
}

function mismatches(lines: readonly (readonly string[])[]): string[] {
  const found: string[] = []
  for (const args of lines) {
    const why = mismatch(args, outcomeOf(args))
    if (why !== undefined) found.push(`${JSON.stringify(args)}: ${why}`)
  }
  return found
}

// --- tests -------------------------------------------------------------------------------------

describe('the argv matches real jest-cli', () => {
  it('has a corpus of at least 150 hand-written command lines', () => {
    assert.ok(HAND_WRITTEN.length >= 150, `only ${HAND_WRITTEN.length}`)
  })

  it('parses the F5 rows as buildArgv does', () => {
    assert.deepEqual(mismatches(F5_ROWS), [])
  })

  it('parses greedy arrays, "--", numbers, repeats, negation and odd forms as buildArgv does', () => {
    assert.deepEqual(mismatches(YARGS_ROWS), [])
  })

  it("fails the lines Jest fails, with Jest's text", () => {
    assert.deepEqual(mismatches(FAILURE_ROWS), [])
  })

  it('refuses by name what Jest answers with text and exit 0', () => {
    assert.deepEqual(mismatches(REFUSED_ROWS), [])
    for (const args of REFUSED_ROWS) {
      assert.equal(outcomeOf(args).exit, 0, JSON.stringify(args))
      const result = mine(args)
      assert.ok('error' in result, JSON.stringify(args))
      const form = UNSUPPORTED_FORM_ROWS.some((row) => row.join('\0') === args.join('\0'))
      assert.equal(
        result.error.code,
        form ? 'JEST_CLI_UNSUPPORTED_FORM' : 'JEST_CLI_UNSUPPORTED',
        JSON.stringify(args),
      )
    }
  })

  it('refuses a flag named like an Object property, which crashes real Jest', () => {
    assert.deepEqual(mismatches(CRASH_ROWS), [])
    for (const args of CRASH_ROWS) {
      assert.equal(outcomeOf(args).threw, YARGS_CRASH, JSON.stringify(args))
      const result = mine(args)
      assert.ok('error' in result, JSON.stringify(args))
      assert.equal(result.error.code, 'JEST_CLI_UNSUPPORTED_FORM', JSON.stringify(args))
    }
    assert.deepEqual(mismatches(QUIRK_ROWS), [])
  })

  it("adds a numeric 1 to what the key holds, as yargs-parser's increment() does", () => {
    assert.deepEqual(parseJestArgv(['--x=1', '--x=1']), { _: [], x: 2 })
    assert.deepEqual(parseJestArgv(['--x=2', '--x=1']), { _: [], x: 3 })
    assert.deepEqual(parseJestArgv(['--x=1', '--x=2']), { _: [], x: [1, 2] })
  })

  it('parses every form of every option as buildArgv does', () => {
    assert.ok(PER_OPTION.length >= 105 * 4, `only ${PER_OPTION.length}`)
    assert.deepEqual(mismatches(PER_OPTION), [])
  })

  it('agrees with buildArgv on 800 generated command lines', () => {
    assert.equal(GENERATED.length, 800)
    assert.deepEqual(mismatches(GENERATED), [])
  })

  it('sets the alias and the camelCase key together, and strips the dashed key', () => {
    assert.deepEqual(parseJestArgv(['-b']), { _: [], b: true, bail: true })
    assert.deepEqual(parseJestArgv(['-w', '2']), { _: [], w: '2', maxWorkers: '2' })
    assert.deepEqual(parseJestArgv(['--max-workers=50%']), { _: [], maxWorkers: '50%', w: '50%' })
    assert.deepEqual(parseJestArgv(['--no-cache']), { _: [], cache: false })
    assert.deepEqual(parseJestArgv(['a', '1', '--', '2']), { _: ['a', 1, 2] })
    assert.deepEqual(parseJestArgv(['--testPathPatterns', 'a', 'b']), {
      _: [],
      testPathPatterns: ['a', 'b'],
    })
  })
})

describe("failures are Jest's", () => {
  function failure(args: readonly string[]): JestCliError {
    const result = mine(args)
    assert.ok('error' in result, `${JSON.stringify(args)} parsed`)
    return result.error
  }

  it("throws what jest-cli's check throws, with code JEST_CLI_INVALID", () => {
    const rows: readonly [readonly string[], string][] = [
      [['-i', '-w', '2'], 'Both --runInBand and --maxWorkers were specified, only one is allowed.'],
      [
        ['-o', '--watchAll'],
        'Both --onlyChanged and --watchAll were specified, but cannot be used together. Try the --watch option which reruns only tests related to changed files.',
      ],
      [
        ['-f', '--watchAll'],
        'Both --onlyFailures and --watchAll were specified, only one is allowed.',
      ],
      [
        ['--findRelatedTests'],
        'The --findRelatedTests option requires file paths to be specified.\nExample usage: jest --findRelatedTests ./src/source.js ./src/index.js.',
      ],
      [
        ['--config', 'foo.txt'],
        'The --config option requires a JSON string literal, or a file path with one of these extensions: .js, .ts, .mjs, .mts, .cjs, .cts, .json.\nExample usage: jest --config ./jest.config.js',
      ],
    ]
    for (const [args, message] of rows) {
      const error = failure(args)
      assert.equal(error.code, 'JEST_CLI_INVALID')
      assert.equal(error.message, message)
      assert.ok(plain(outcomeOf(args).stderr).includes(message), JSON.stringify(args))
      assert.equal(outcomeOf(args).exit, 1)
    }
  })

  it("throws yargs' requiresArg and choices messages", () => {
    const missing = failure(['--maxWorkers'])
    assert.equal(missing.code, 'JEST_CLI_INVALID')
    assert.equal(missing.message, 'Not enough arguments following: maxWorkers')
    assert.equal(failure(['-w']).message, 'Not enough arguments following: w')
    assert.equal(
      failure(['--selectProjects']).message,
      'Not enough arguments following: selectProjects',
    )
    const choices = failure(['--coverageProvider', 'bogus'])
    assert.equal(choices.code, 'JEST_CLI_INVALID')
    assert.equal(
      choices.message,
      'Invalid values:\n  Argument: coverageProvider, Given: "bogus", Choices: "babel", "v8"',
    )
    assert.equal(
      failure(['--notifyMode', 'x', '--coverageProvider', 'y']).message,
      'Invalid values:\n  Argument: notifyMode, Given: "x", Choices: "always", "failure", "success", "change", "success-change", "failure-change"\n  Argument: coverageProvider, Given: "y", Choices: "babel", "v8"',
    )
  })

  it('throws jest-validate\'s unrecognized-option text, with its "did you mean"', () => {
    const unknown = failure(['--bogus'])
    assert.equal(unknown.code, 'JEST_CLI_UNRECOGNIZED')
    assert.equal(
      unknown.message,
      '● Unrecognized CLI Parameter:\n\n  Unrecognized option "bogus".\n\n  CLI Options Documentation:\n  https://jestjs.io/docs/cli\n',
    )
    const typo = failure(['--testTimout', '5'])
    assert.equal(typo.code, 'JEST_CLI_UNRECOGNIZED')
    assert.match(typo.message, /Unrecognized option "testTimout"\. Did you mean "testTimeout"\?\n/)
    const several = failure(['--bogus', '--other'])
    assert.equal(
      several.message,
      '● Unrecognized CLI Parameters:\n\n  Following options were not recognized:\n  ["bogus", "other"]\n\n  CLI Options Documentation:\n  https://jestjs.io/docs/cli\n',
    )
    // jest-validate's quirk: `--x=1` is not in the raw arguments as `x`, so it isn't reported
    assert.deepEqual(parseJestArgv(['--bogus-flag=1']), { _: [], bogusFlag: 1 })
  })

  it('throws the deprecation text of every removed option, with code JEST_CLI_DEPRECATED', () => {
    for (const name of [
      'browser',
      'collectCoverageOnlyFrom',
      'extraGlobals',
      'init',
      'moduleLoader',
      'preprocessorIgnorePatterns',
      'scriptPreprocessor',
      'setupTestFrameworkScriptFile',
      'testPathDirs',
      'testPathPattern',
      'testURL',
      'timers',
    ]) {
      const error = failure([`--${name}=x`])
      assert.equal(error.code, 'JEST_CLI_DEPRECATED', name)
      assert.match(error.message, new RegExp(`^${name}:\\n\\n`))
    }
    const error = failure(['--testPathPattern=foo'])
    assert.equal(
      error.message,
      'testPathPattern:\n\n  Option "testPathPattern" was replaced by "--testPathPatterns". "--testPathPatterns" is only available as a command-line option.\n  \n  Please update your configuration.\n\n  CLI Options Documentation:\n  https://jestjs.io/docs/cli\n',
    )
  })

  it('refuses help and version by name, and says what to run', () => {
    for (const args of [['--help'], ['-h'], ['help'], ['--version']]) {
      const error = failure(args)
      assert.equal(error.code, 'JEST_CLI_UNSUPPORTED')
      assert.match(error.message, /use the real jest for --(help|version)/)
    }
    assert.equal(failure(['--get-yargs-completions']).code, 'JEST_CLI_UNSUPPORTED_FORM')
  })
})

describe('the text Jest printed (T11.7 goldens)', () => {
  function golden(fixture: string): { keepLines: RegExp; stderr: string; exitCode: number } {
    const dir = new URL(`../../../harness/fixtures/cli/${fixture}/`, import.meta.url)
    const spec = JSON.parse(readFileSync(new URL('fixture.json', dir), 'utf8')) as {
      run: { argv: { jest: string[] }; keepLines: string }
    }
    const recorded = JSON.parse(readFileSync(new URL('__goldens__/jest.json', dir), 'utf8')) as {
      observed: { stderr: string; exitCode: number }
      runnerVersion: string
    }
    assert.equal(recorded.runnerVersion, '30.5.2')
    return {
      keepLines: new RegExp(spec.run.keepLines),
      stderr: recorded.observed.stderr,
      exitCode: recorded.observed.exitCode,
    }
  }

  function keptLines(message: string, keepLines: RegExp): string {
    return message
      .split('\n')
      .filter((line) => keepLines.test(line))
      .join('\n')
  }

  it('prints --testPathPattern as the recorded Jest 30.5.2 run did', () => {
    const recorded = golden('jest-test-path-pattern')
    const result = mine(['--testPathPattern=foo'])
    assert.ok('error' in result)
    assert.equal(keptLines(result.error.message, recorded.keepLines), recorded.stderr)
    // Jest exits with 1; the caller maps a JestCliError to its usage exit code
    assert.equal(recorded.exitCode, 1)
  })

  it('prints an unknown flag as the recorded Jest 30.5.2 run did', () => {
    const recorded = golden('unknown-flag')
    const result = mine(['--bogus-flag'])
    assert.ok('error' in result)
    assert.equal(keptLines(result.error.message, recorded.keepLines), recorded.stderr)
    assert.equal(recorded.exitCode, 1)
  })
})

describe('the options table', () => {
  const oracle = oracleOptions()
  const supports = new Map<string, number>()
  for (const option of Object.values(JEST_CLI_OPTIONS)) {
    supports.set(option.support, (supports.get(option.support) ?? 0) + 1)
  }

  it("is the table jest-cli ships: the same keys in the same order, and each option's fields", () => {
    assert.deepEqual(Object.keys(JEST_CLI_OPTIONS), Object.keys(oracle))
    assert.equal(Object.keys(oracle).length, 105)
    for (const [name, option] of Object.entries(JEST_CLI_OPTIONS)) {
      const { support: _support, owner: _owner, ...copied } = option
      assert.deepEqual(copied, oracle[name], name)
    }
  })

  it('classifies every option once, and counts the classes', (t) => {
    const counts = Object.fromEntries(supports)
    t.diagnostic(`support classes: ${JSON.stringify(counts)}`)
    assert.deepEqual(counts, { request: 16, config: 57, accepted: 7, warn: 4, refuse: 21 })
    for (const [name, option] of Object.entries(JEST_CLI_OPTIONS)) {
      const needsOwner = option.support === 'warn' || option.support === 'refuse'
      assert.equal(option.owner !== undefined, needsOwner, name)
    }
  })

  it('has the class the task gives each option', () => {
    const named = (support: string): string[] =>
      Object.entries(JEST_CLI_OPTIONS)
        .filter(([, option]) => option.support === support)
        .map(([name]) => name)
        .sort()
    assert.deepEqual(
      named('request'),
      [
        'cache',
        'ci',
        'clearCache',
        'color',
        'colors',
        'config',
        'listTests',
        'maxWorkers',
        'passWithNoTests',
        'runInBand',
        'runTestsByPath',
        'showConfig',
        'testNamePattern',
        'testPathPatterns',
        'updateSnapshot',
        'workerThreads',
      ].sort(),
    )
    assert.deepEqual(named('accepted'), [
      'all',
      'ignoreProjects',
      'selectProjects',
      'skipFilter',
      'testLocationInResults',
      'useStderr',
      'watchman',
    ])
    assert.deepEqual(named('warn'), ['debug', 'logHeapUsage', 'notify', 'notifyMode'].sort())
  })

  it('makes one FlagSpec per option', () => {
    assert.equal(jestFlags.length, 105)
    const bail = jestFlags.find((flag) => flag.name === '--bail')
    assert.deepEqual(
      { ...bail, description: undefined },
      { name: '--bail', short: '-b', takesValue: false, description: undefined },
    )
    const workers = jestFlags.find((flag) => flag.name === '--maxWorkers')
    assert.equal(workers?.short, '-w')
    assert.equal(workers?.takesValue, true)
    assert.equal(jestFlags.find((flag) => flag.name === '--testEnvironment')?.short, '--env')
    assert.equal(jestFlags.find((flag) => flag.name === '--ci')?.short, undefined)
    for (const flag of jestFlags) assert.ok(flag.description.length > 0, flag.name)
  })

  it('is on the Node dialect', () => {
    assert.equal(jestNodeDialect.cli, jestCli)
    assert.equal(jestNodeDialect.flags, jestFlags)
  })
})

describe('diagnostics', () => {
  const REFUSED: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(JEST_CLI_OPTIONS)
      .filter(([, option]) => option.support === 'refuse')
      .map(([name, option]) => [name, option.owner ?? '']),
  )

  /** A command line that gives `name` a value, including what `check` needs to let it through. */
  function lineFor(name: string): string[] {
    const option = JEST_CLI_OPTIONS[name]
    const value = sampleValue(name)
    const extra = name === 'findRelatedTests' ? ['src/a.ts'] : []
    const flag = option?.type === 'boolean' ? [`--${name}`] : [`--${name}`, value]
    return [...flag, ...extra]
  }

  it('gives an error diagnostic for each refused flag, naming the task', () => {
    assert.equal(Object.keys(REFUSED).length, 21)
    for (const [name, owner] of Object.entries(REFUSED)) {
      const { diagnostics } = parseJestCli(lineFor(name))
      assert.deepEqual(
        diagnostics,
        [
          {
            level: 'error',
            code: 'JEST_CLI_UNSUPPORTED',
            key: `--${name}`,
            message: `--${name} is not supported yet (${owner})`,
          },
        ],
        name,
      )
    }
  })

  it('gives the owners the task names', () => {
    const owners: Readonly<Record<string, string>> = {
      watch: 'T9.11',
      watchAll: 'T9.11',
      coverage: 'T8.8',
      collectCoverage: 'T8.8',
      shard: 'T9.6',
      onlyChanged: 'Track 9, no task yet',
      changedSince: 'Track 9, no task yet',
      changedFilesWithAncestor: 'Track 9, no task yet',
      lastCommit: 'Track 9, no task yet',
      findRelatedTests: 'Track 9, no task yet',
      onlyFailures: 'Track 9, no task yet',
      collectTests: 'T11.8',
      json: 'T11.8',
      outputFile: 'T11.8',
      reporters: 'T11.9',
      detectLeaks: 'T2.7',
      projects: 'the --projects flag, no task yet (a config `projects` runs)',
      randomize: 'Track 9, no task yet',
      seed: 'Track 9, no task yet',
      showSeed: 'Track 9, no task yet',
      filter: 'no task yet',
    }
    assert.deepEqual(REFUSED, owners)
  })

  it('gives a warning for each flag it reads but does not apply', () => {
    for (const name of ['debug', 'logHeapUsage', 'notify']) {
      const { diagnostics } = parseJestCli([`--${name}`])
      assert.deepEqual(diagnostics, [
        {
          level: 'warning',
          code: 'JEST_CLI_NOT_APPLIED',
          key: `--${name}`,
          message: `--${name} is read but not applied yet (T9.7)`,
        },
      ])
    }
    assert.equal(parseJestCli(['--notifyMode', 'always']).diagnostics[0]?.key, '--notifyMode')
  })

  it('says nothing for the presentation flags the reporters apply (D54, T9.7)', () => {
    for (const line of [
      ['--verbose'],
      ['--silent'],
      ['--expand'],
      ['-e'],
      ['--noStackTrace'],
      ['--color'],
      ['--colors'],
      ['--no-color'],
    ]) {
      assert.deepEqual(parseJestCli(line).diagnostics, [], line.join(' '))
    }
  })

  it('says nothing for request, config and accepted flags, or for a flag switched off', () => {
    for (const [name, option] of Object.entries(JEST_CLI_OPTIONS)) {
      if (option.support === 'warn' || option.support === 'refuse') continue
      if (name === 'config') continue
      const { diagnostics } = parseJestCli(lineFor(name))
      assert.deepEqual(diagnostics, [], name)
    }
    assert.deepEqual(parseJestCli(['--config', 'jest.config.js']).diagnostics, [])
    for (const line of [['--no-bail'], ['--bail=false'], ['--no-verbose'], ['--watchAll=false']]) {
      assert.deepEqual(parseJestCli(line).diagnostics, [], line.join(' '))
    }
  })

  it("lists several in the table's order, and lets --json and --outputFile shape --listTests", () => {
    const { diagnostics } = parseJestCli([
      '--watch',
      '--shard',
      '1/2',
      '--logHeapUsage',
      '--coverage',
    ])
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.key),
      ['--coverage', '--logHeapUsage', '--shard', '--watch'],
    )
    assert.deepEqual(parseJestCli(['--listTests', '--json']).diagnostics, [])
    assert.deepEqual(
      parseJestCli(['--listTests', '--json', '--outputFile', 'o.json']).diagnostics,
      [],
    )
    assert.equal(parseJestCli(['--json']).diagnostics[0]?.key, '--json')
    assert.equal(parseJestCli(['--outputFile=o.json']).diagnostics[0]?.key, '--outputFile')
  })

  it('returns the argv the config reader takes, whatever the diagnostics say', () => {
    const { argv } = parseJestCli(['--bail', '--testTimeout', '9'])
    assert.deepEqual(argv, { _: [], b: true, bail: true, testTimeout: 9 })
  })
})

describe('the run request', () => {
  const request = (args: readonly string[]) => jestArgvToRunRequest(parseJestArgv(args))
  const base = { mode: 'run', json: false, fileFilters: [], inBand: false } as const

  it('is empty for no flags', () => {
    assert.deepEqual(request([]), base)
  })

  it('makes regex filters of positionals and --testPathPatterns, positionals first', () => {
    assert.deepEqual(request(['src/a', '5']).fileFilters, [
      { kind: 'regex', value: 'src/a' },
      { kind: 'regex', value: '5' },
    ])
    assert.deepEqual(request(['src/a', '--testPathPatterns', 'x', 'y']).fileFilters, [
      { kind: 'regex', value: 'src/a' },
      { kind: 'regex', value: 'x' },
      { kind: 'regex', value: 'y' },
    ])
    assert.deepEqual(request(['--test-path-patterns=z']).fileFilters, [
      { kind: 'regex', value: 'z' },
    ])
  })

  it('makes path filters of positionals with --runTestsByPath', () => {
    assert.deepEqual(
      request(['--runTestsByPath', 'src/a.test.ts', '--testPathPatterns', 'b']).fileFilters,
      [
        { kind: 'path', value: 'src/a.test.ts' },
        { kind: 'regex', value: 'b' },
      ],
    )
    assert.deepEqual(request(['--runTestsByPath=false', 'a']).fileFilters, [
      { kind: 'regex', value: 'a' },
    ])
  })

  it('reads the name pattern, the worker flags and the booleans', () => {
    assert.equal(request(['-t', 'foo bar']).namePattern, 'foo bar')
    assert.equal(request(['--testNamePattern=x']).namePattern, 'x')
    assert.equal(request(['--testNamePattern', '7']).namePattern, '7')
    assert.equal(request(['-w', '4']).maxWorkers, 4)
    assert.equal(request(['--maxWorkers=50%']).maxWorkers, '50%')
    assert.equal(request(['--max-workers', '25%']).maxWorkers, '25%')
    assert.equal(request(['-w', '1', '-w', '3']).maxWorkers, 3)
    assert.equal(request([]).maxWorkers, undefined)
    assert.equal(request(['-i']).inBand, true)
    assert.equal(request(['--runInBand']).inBand, true)
    assert.equal(request(['--no-runInBand']).inBand, false)
    assert.equal(request(['--workerThreads']).workerThreads, true)
    assert.equal(request(['--ci']).ci, true)
    assert.equal(request(['--no-ci']).ci, false)
    assert.equal('ci' in request([]), false)
    assert.equal(request(['-u']).update, true)
    assert.equal(request(['--updateSnapshot']).update, true)
    assert.equal(request(['--no-updateSnapshot']).update, false)
    assert.equal('update' in request([]), false)
    assert.equal(request(['--passWithNoTests']).passWithNoTests, true)
    assert.equal('passWithNoTests' in request([]), false)
    assert.equal(request(['--no-cache']).cache, false)
    assert.equal(request(['--cache']).cache, true)
    assert.equal('cache' in request(['--ci']), false)
    assert.equal(request(['-c', 'jest.config.js']).configPath, 'jest.config.js')
    assert.equal(request(['--config={"a":1}']).configPath, '{"a":1}')
  })

  it('reads --color, --colors and --no-color as the colour request (T9.7)', () => {
    assert.equal(request(['--color']).colour, true)
    assert.equal(request(['--colors']).colour, true)
    assert.equal(request(['--no-color']).colour, false)
    assert.equal(request(['--color=false']).colour, false)
    assert.equal(request(['--no-colors']).colour, false)
    assert.equal('colour' in request([]), false)
    assert.equal('colour' in request(['--ci']), false)
  })

  it('throws for a --maxWorkers that is neither a count nor a percentage', () => {
    assert.throws(
      () => request(['--maxWorkers', 'many']),
      (error: unknown) => error instanceof JestCliError && error.code === 'JEST_CLI_INVALID',
    )
  })

  it('picks the mode', () => {
    assert.equal(request(['--listTests']).mode, 'list-files')
    assert.equal(request(['--listTests']).json, false)
    assert.equal(request(['--listTests', '--json']).json, true)
    assert.equal(request(['--listTests', '--json']).mode, 'list-files')
    assert.equal(request(['--showConfig']).mode, 'show-config')
    assert.equal(request(['--clearCache']).mode, 'clear-cache')
    assert.equal(request(['--listTests=false']).mode, 'run')
    // Jest acts on --showConfig, then --clearCache, then --listTests
    assert.equal(request(['--listTests', '--clearCache', '--showConfig']).mode, 'show-config')
    assert.equal(request(['--listTests', '--clearCache']).mode, 'clear-cache')
    // --json without --listTests is a refused flag, not a request field
    assert.equal(request(['--showConfig', '--json']).json, false)
  })

  it('turns each F5 row into the request it names', () => {
    assert.deepEqual(request(['-i', '-b', '-t', 'foo', 'src', '--ci', '--passWithNoTests']), {
      mode: 'run',
      json: false,
      fileFilters: [{ kind: 'regex', value: 'src' }],
      namePattern: 'foo',
      inBand: true,
      ci: true,
      passWithNoTests: true,
    })
    assert.deepEqual(request(['--listTests', '--json', '-c', 'jest.config.ts', '--no-cache']), {
      mode: 'list-files',
      json: true,
      fileFilters: [],
      inBand: false,
      cache: false,
      configPath: 'jest.config.ts',
    })
  })

  it('leaves --bail, --forceExit and --detectOpenHandles to the config they are keys of (T9.10)', () => {
    // They are in the argv (the reader merges them into the global config, where a run reads them
    // together with the config's own), and the request has no field for them.
    for (const [line, key] of [
      [['--bail'], 'bail'],
      [['-b'], 'bail'],
      [['--forceExit'], 'forceExit'],
      [['--detectOpenHandles'], 'detectOpenHandles'],
    ] as const) {
      assert.equal(parseJestCli([...line]).argv[key], true, line.join(' '))
      assert.deepEqual(request([...line]), request([]), line.join(' '))
    }
  })

  it('is what jestCli.parse and jestCli.toRunRequest give', () => {
    const { argv, diagnostics } = jestCli.parse(['--listTests', '--json'])
    assert.deepEqual(diagnostics, [])
    assert.deepEqual(jestCli.toRunRequest(argv), {
      mode: 'list-files',
      json: true,
      fileFilters: [],
      inBand: false,
    })
  })
})
