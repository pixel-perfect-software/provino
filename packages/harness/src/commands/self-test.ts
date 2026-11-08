// `provino-harness self-test` (Track 12 T12.6, T12.16): the sample under real Jest and Vitest, the
// recording checked against them, the calibrated parity, and optionally Provino as a subject.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConsoleEntry, NormalizedRun } from '@provino/types'
import { type DiffOptions, diffRuns, type ParityReport } from '../diff.ts'
import { HarnessError } from '../errors.ts'
import { parseExclusions } from '../exclusions.ts'
import { type Fixture, type FixtureRunner, readFixture } from '../fixture.ts'
import { serializeGolden, toGolden } from '../golden.ts'
import type { SelfTestCommand } from '../internal/cli-args.ts'
import { convertRunnerJson } from '../internal/convert-runner.ts'
import { errorMessage } from '../internal/guards.ts'
import { assertNoPathLeak } from '../internal/recording.ts'
import {
  jestConfig,
  runnerEnv,
  TRACE_ENV,
  traceSetupSource,
  vitestConfigSource,
} from '../internal/runner-config.ts'
import {
  coverageProblems,
  EXCLUSIONS_FILE,
  EXPECTED_CRASH,
  PATH_PLACEHOLDERS,
  RECORDED_DIR,
  recordedEnv,
  rewritePaths,
  SAMPLE_DIR,
  SAMPLE_SUITE,
  sampleCopy,
  sampleRunProblems,
  writeSampleCopy,
} from '../internal/sample.ts'
import { lineDiff } from '../internal/text-diff.ts'
import { parseNormalizedRun } from '../parse-normalized-run.ts'
import {
  PACKAGE_DIR,
  type RecordPaths,
  recordPaths,
  removeWorkDir,
  TRANSFORMER_PATH,
  WORK_ROOT,
  workDirs,
} from '../record.ts'
import { runSubject, type SubjectResult, type SubjectRunner } from '../run-subject.ts'
import { parseSidecar } from '../sidecar.ts'
import { type CommandIo, failureText, writeJson } from './io.ts'

/**
 * The sample's calibration rules: the spike's 3 and `div/runner-made-error-frame`, which Tyler
 * added at B15 (D30 covers all four: no expiry, `--calibration` only). A deliberate tripwire: a
 * rule added to or dropped from `exclusions.json` fails the self-test until this number changes
 * too, so a change to D30's rule set is never made in passing.
 */
const SAMPLE_RULES = 4

/** The rebuilt corpus's bar (Ground rules): at least the spike's 63 tests and 16 file keys. */
const MIN_TESTS = 63
const MIN_FILES = 16

/** The calibrated comparison (Track 12 F3): matcher mode, console on, the sample's rules. */
const CALIBRATED: Omit<DiffOptions, 'exclusions'> = {
  messageMode: 'matcher',
  compareConsole: true,
  compareTrace: false,
}

/**
 * What `self-test` asserts the sidecars wrote for `console.test.ts` (T12.4), as `stream/level: text`
 * lines (Vitest gives no level). Jest buffers per file, in call order, after-hooks in declaration
 * order; Vitest attributes each write to its test, and runs same-level after-hooks in reverse
 * (`sequence.hooks: 'stack'`), with the `beforeAll` output on the file.
 */
const CONSOLE_FILE = 'console.test.ts'
const BEFORE_ALL = 'log: beforeAll: output outside any test'
const EVERY_LEVEL = [
  'log: log line 1',
  'info: info line',
  'warn: warn line',
  'error: error line',
  'debug: debug line',
]
const MULTI_LINE = ['log: first', 'log: second', 'log: third']
const AFTER_EACH = ['log: afterEach one', 'log: afterEach two']

/** One sample run: the subject's result and the directories it ran in. */
interface SampleRun {
  readonly result: SubjectResult
  readonly paths: RecordPaths
  readonly testFiles: readonly string[]
}

/** One line of the verdict. */
interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail?: string
}

function check(name: string, problems: readonly string[]): Check {
  return problems.length === 0
    ? { name, ok: true }
    : { name, ok: false, detail: problems.join('\n') }
}

function provinoConfigSource(): string {
  return [
    '// Written by provino-harness self-test: the Jest dialect over the sample copy.',
    'export default {',
    "  dialect: 'jest',",
    "  include: ['**/*.test.ts'],",
    '}',
    '',
  ].join('\n')
}

/**
 * The runner's own arguments. Jest and Vitest run with `-u` in a fresh copy, so the snapshot files
 * are the ones each writes against an empty snapshot directory (Track 12 R2): under `CI=1` alone a
 * missing snapshot fails and no file is left. Vitest refuses `.only` under CI unless told to allow
 * it. Provino keeps no results cache between runs.
 */
async function prepareRunner(
  runner: SubjectRunner,
  fixture: Fixture,
  workDir: string,
  outDir: string,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  const setupFile = path.join(outDir, 'trace-setup.ts')
  await writeFile(setupFile, traceSetupSource())
  const env = runnerEnv(process.env, {
    ...fixture.manifest.env,
    [TRACE_ENV]: path.join(outDir, 'trace.txt'),
  })
  const options = fixture.manifest.jestEsm === true ? { jestEsm: true as const } : {}
  if (runner === 'jest') {
    const configFile = path.join(outDir, 'jest.config.json')
    const config = jestConfig(workDir, TRANSFORMER_PATH, setupFile, options)
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`)
    return { argv: ['--ci', '-u', '--config', configFile], env }
  }
  if (runner === 'vitest') {
    const configFile = path.join(workDir, 'vitest.config.ts')
    await writeFile(configFile, vitestConfigSource(workDir, setupFile, 'vitest', options))
    return { argv: ['run', '--config', configFile, '-u', '--allowOnly'], env }
  }
  const configFile = path.join(workDir, 'provino.config.ts')
  await writeFile(configFile, provinoConfigSource())
  return { argv: ['run', '--config', configFile, '--no-cache'], env }
}

/** Runs the sample under one runner in a fresh copy, which is removed afterwards unless kept. */
async function runSample(
  fixture: Fixture,
  runner: SubjectRunner,
  keep: boolean,
  io: CommandIo,
): Promise<SampleRun> {
  const { files, testFiles } = sampleCopy(fixture, runner === 'vitest' ? 'vitest' : 'jest')
  await mkdir(WORK_ROOT, { recursive: true })
  const workDir = await mkdtemp(path.join(WORK_ROOT, `self-test-${runner}-`))
  if (!keep) workDirs.track(workDir)
  try {
    await writeSampleCopy(fixture, files, workDir)
    const paths = await recordPaths(workDir)
    const outDir = path.join(workDir, '.harness-out')
    await mkdir(outDir)
    const { argv, env } = await prepareRunner(runner, fixture, workDir, outDir)
    const result = await runSubject({
      runner,
      cwd: workDir,
      rootDir: paths.realWorkDir,
      extraRoots: [paths.workDir],
      argv,
      env,
      suite: SAMPLE_SUITE,
      outDir,
      from: PACKAGE_DIR,
    })
    if (keep) io.err(`kept ${workDir}\n`)
    return { result, paths, testFiles }
  } finally {
    if (!keep) {
      // A cleanup that fails must not replace the error that made it necessary; the exit hook
      // tries again.
      await removeWorkDir(workDir).catch(() => undefined)
    }
  }
}

function recordedPath(name: string): string {
  return path.join(SAMPLE_DIR, RECORDED_DIR, name)
}

/** JSON as the recordings keep it: 2-space, a trailing newline. */
function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** The recorded form of a run: its raw files with paths rewritten, and their conversion. */
interface Recording {
  readonly raw: string
  readonly console: string
  readonly normalized: NormalizedRun
}

/**
 * The run as it is committed. The runner's JSON is pretty-printed and its paths rewritten
 * (`rewritePaths`), and so is the sidecar; the normalized run is the conversion of those rewritten
 * files with `/__root__` as the root. Nothing may still name this machine.
 */
function recordingOf(runner: FixtureRunner, run: SampleRun): Recording {
  const { result, paths } = run
  const raw = rewritePaths(pretty(JSON.parse(result.raw)), paths)
  const sidecar = rewritePaths(result.sidecar ?? '', paths)
  const options = {
    rootDir: PATH_PLACEHOLDERS.root,
    suite: SAMPLE_SUITE,
    runnerVersion: result.runnerVersion,
    env: recordedEnv(runner, result.runnerVersion),
    snapshotFiles: result.run.snapshots?.files ?? [],
    console: parseSidecar(sidecar, `${runner}.console.jsonl`),
  }
  const normalized = convertRunnerJson(runner, raw, `${runner}.raw.json`, options)
  const forbidden = Object.values(paths)
  for (const [name, text] of [
    ['raw', raw],
    ['console', sidecar],
    ['normalized', pretty(normalized)],
  ] as const) {
    assertNoPathLeak(text, forbidden, `the recorded ${runner} ${name}`)
  }
  return { raw, console: sidecar, normalized }
}

async function writeRecording(runner: FixtureRunner, recording: Recording): Promise<void> {
  await mkdir(path.join(SAMPLE_DIR, RECORDED_DIR), { recursive: true })
  await writeFile(recordedPath(`${runner}.raw.json`), recording.raw)
  await writeFile(recordedPath(`${runner}.console.jsonl`), recording.console)
  await writeFile(recordedPath(`${runner}.normalized.json`), pretty(recording.normalized))
}

/**
 * T12.3's link to the runners: the golden of the fresh run equals the golden of the committed
 * normalized file. A golden drops what changes between runs and machines.
 */
async function recordingProblems(runner: FixtureRunner, run: NormalizedRun): Promise<string[]> {
  let committed: string
  try {
    committed = await readFile(recordedPath(`${runner}.normalized.json`), 'utf8')
  } catch (error) {
    return [`no committed recording (${errorMessage(error)}): run self-test --write-recorded`]
  }
  const expected = serializeGolden(
    toGolden(parseNormalizedRun(committed, recordedPath(`${runner}.normalized.json`))),
  )
  const actual = serializeGolden(toGolden(run))
  return expected === actual
    ? []
    : [`the committed recording no longer matches ${runner}:\n${lineDiff(expected, actual)}`]
}

/** An expected line, `level: text`, as a run shows it: with its level (Jest) or without (Vitest). */
function expectedLine(line: string, withLevel: boolean): string {
  const at = line.indexOf(': ')
  const level = line.slice(0, at)
  const stream = level === 'warn' || level === 'error' ? 'stderr' : 'stdout'
  return `${stream}${withLevel ? `/${level}` : ''}: ${line.slice(at + 2)}`
}

/** T12.4: the sample's console file came through each sidecar, per file (Jest), per test (Vitest). */
function consoleProblems(runner: FixtureRunner, run: NormalizedRun): string[] {
  const file = run.files.find((f) => f.file === CONSOLE_FILE)
  if (file === undefined) return [`${CONSOLE_FILE} is not in the run`]
  const shown = (entries: readonly ConsoleEntry[] | undefined): string[] =>
    (entries ?? []).map(
      (e) => `${e.stream}${e.level === undefined ? '' : `/${e.level}`}: ${e.text}`,
    )
  const problems: string[] = []
  // Jest's buffer keeps call order. Vitest buffers each stream on its own and reports a test's
  // stdout before its stderr, so only the order within each stream is defined there.
  const ordered = (lines: readonly string[]): string[] =>
    runner === 'jest'
      ? [...lines]
      : [
          ...lines.filter((line) => line.startsWith('stdout')),
          ...lines.filter((line) => line.startsWith('stderr')),
        ]
  const expectLines = (
    what: string,
    entries: readonly ConsoleEntry[] | undefined,
    expected: readonly string[],
  ): void => {
    const actual = ordered(shown(entries))
    const want = ordered(expected.map((line) => expectedLine(line, runner === 'jest')))
    if (actual.join('\n') !== want.join('\n')) {
      problems.push(
        `${what}:\n  expected ${JSON.stringify(want)}\n  got      ${JSON.stringify(actual)}`,
      )
    }
  }
  if (runner === 'jest') {
    if (file.tests.some((test) => test.console !== undefined)) {
      problems.push('Jest attributes console output to files only, but a test has some')
    }
    expectLines('the file', file.console, [
      BEFORE_ALL,
      ...EVERY_LEVEL,
      ...AFTER_EACH,
      ...MULTI_LINE,
      ...AFTER_EACH,
      ...AFTER_EACH,
    ])
    return problems
  }
  const test = (title: string) =>
    file.tests.find((t) => t.id.path.at(-1) === title && t.id.dupIndex === 0)?.console
  const afterEach = AFTER_EACH.toReversed()
  expectLines('the file', file.console, [BEFORE_ALL])
  expectLines('logs at every level', test('logs at every level'), [...EVERY_LEVEL, ...afterEach])
  expectLines('splits a multi-line write', test('splits a multi-line write into lines'), [
    ...MULTI_LINE,
    ...afterEach,
  ])
  expectLines('logs nothing itself', test('logs nothing itself'), afterEach)
  return problems
}

/** T12.6's bars on the calibrated comparison of Jest (reference) and Vitest (candidate). */
function calibrationProblems(
  report: ParityReport,
  ruleIds: readonly string[],
  runs: { readonly jest: NormalizedRun; readonly vitest: NormalizedRun },
): string[] {
  const problems: string[] = []
  for (const [name, value] of [
    ['status parity', report.statusParity],
    ['message parity', report.messageParity],
    ['snapshot byte parity', report.snapshotByteParity],
  ] as const) {
    if (value !== 1) problems.push(`${name} is ${value}, not 1`)
  }
  if (!report.suitePass) problems.push('the runs disagree on a file status')
  if (report.diffs.length > 0) {
    problems.push(
      `${report.diffs.length} diffs no rule explains:\n${report.diffs.map((d) => `  ${d.kind} ${d.key}: ${JSON.stringify(d.ref)} / ${JSON.stringify(d.cand)}`).join('\n')}`,
    )
  }
  if (report.expiredExclusions.length > 0) {
    problems.push(`expired rules: ${report.expiredExclusions.map((e) => e.id).join(', ')}`)
  }
  const used = new Set(report.excluded.map((d) => d.ruleId))
  for (const id of ruleIds) {
    if (!used.has(id)) problems.push(`the rule ${id} matched no diff, so it is dead`)
  }
  if (ruleIds.length !== SAMPLE_RULES) {
    problems.push(`the sample has ${ruleIds.length} rules, not ${SAMPLE_RULES}`)
  }
  for (const [runner, run] of Object.entries(runs)) {
    const tests = run.files.reduce((sum, f) => sum + f.tests.length, 0)
    if (tests < MIN_TESTS) problems.push(`${runner} ran ${tests} tests, fewer than ${MIN_TESTS}`)
    if (run.files.length < MIN_FILES) {
      problems.push(`${runner} reported ${run.files.length} files, fewer than ${MIN_FILES}`)
    }
    const crashed = run.files.filter((f) => f.status === 'crashed').map((f) => f.file)
    if (crashed.join() !== EXPECTED_CRASH.file) {
      problems.push(
        `${runner} crashed ${JSON.stringify(crashed)}, not exactly ${EXPECTED_CRASH.file}`,
      )
    }
  }
  return problems
}

/**
 * T12.16: Provino on the sample's Jest copy, as a subject. It passes when Provino ran to the end
 * (exit 0 or 1: a failing test is a result) and wrote a valid `normalized-json`; the report is
 * written to `out`. No parity bar until B17 (DECISIONS D30), and no number is printed, because CI
 * logs are public.
 */
async function provinoCheck(
  fixture: Fixture,
  jest: NormalizedRun,
  command: SelfTestCommand,
  today: string,
  io: CommandIo,
  run: SampleRunner,
): Promise<Check> {
  const sample = await tryRun(run, fixture, 'provino', command, io)
  if (sample instanceof HarnessError) {
    return check(PROVINO_CHECK, [failureText(sample)])
  }
  const { exitCode, process: proc } = sample.result
  if (exitCode !== 0 && exitCode !== 1) {
    return check(PROVINO_CHECK, [
      `provino exited ${exitCode ?? proc.signal}. Output tail:\n${proc.output}`,
    ])
  }
  // Provino may crash files the reference runs: that is parity, which has no bar yet. Only a run
  // that doesn't cover the sample's files fails here.
  const problems = coverageProblems(sample.result.run, sample.testFiles)
  if (problems.length > 0) return check(PROVINO_CHECK, problems)
  const report = diffRuns(
    jest,
    sample.result.run,
    { messageMode: 'exact', compareConsole: true, compareTrace: false, exclusions: [] },
    today,
  )
  if (command.out !== undefined) await writeJson(command.out, report)
  return { name: PROVINO_CHECK, ok: true }
}

const PROVINO_CHECK = 'provino:jest ran the sample and wrote a valid normalized-json'

/**
 * Runs the sample under one runner. `selfTestCommand` takes one, so a test can stand in for the
 * real runners.
 * @internal
 */
export type SampleRunner = (
  fixture: Fixture,
  runner: SubjectRunner,
  keep: boolean,
  io: CommandIo,
) => Promise<SampleRun>

/**
 * A runner's run of the sample: the run, or a harness error (it failed to start, timed out, wrote
 * no JSON), which becomes that check's FAIL line instead of ending the command. Any other error is
 * a bug and is thrown.
 */
async function tryRun(
  run: SampleRunner,
  fixture: Fixture,
  runner: SubjectRunner,
  command: SelfTestCommand,
  io: CommandIo,
): Promise<SampleRun | HarnessError> {
  try {
    return await run(fixture, runner, command.keepWorkDir, io)
  } catch (error) {
    if (error instanceof HarnessError) return error
    throw error
  }
}

/**
 * Runs the self-test and prints one line per check: `ok` or `FAIL` and, for a failure of the
 * Jest-and-Vitest checks, what failed. Exit 0 when every check passes, else 1.
 * @internal
 */
export async function selfTestCommand(
  command: SelfTestCommand,
  io: CommandIo,
  runSampleWith: SampleRunner = runSample,
): Promise<number> {
  const today = command.today ?? new Date().toISOString().slice(0, 10)
  const fixture = await readFixture(SAMPLE_DIR)
  const exclusionsPath = path.join(SAMPLE_DIR, EXCLUSIONS_FILE)
  const exclusions = parseExclusions(await readFile(exclusionsPath, 'utf8'), exclusionsPath, {
    today,
    calibration: true,
  })

  const checks: Check[] = []
  const runs: Partial<Record<FixtureRunner, NormalizedRun>> = {}
  for (const runner of ['jest', 'vitest'] as const) {
    const sample = await tryRun(runSampleWith, fixture, runner, command, io)
    if (sample instanceof HarnessError) {
      checks.push(check(`${runner} ran the whole sample`, [failureText(sample)]))
      continue
    }
    const { run } = sample.result
    runs[runner] = run
    checks.push(
      check(
        `${runner} ran the whole sample`,
        sampleRunProblems(run, sample.testFiles).map((problem) => problem.message),
      ),
    )
    if (command.writeRecorded) {
      const recording = recordingOf(runner, sample)
      await writeRecording(runner, recording)
      const same =
        serializeGolden(toGolden(recording.normalized)) === serializeGolden(toGolden(run))
      checks.push(
        check(
          `${runner}'s recording converts as the run did`,
          same ? [] : ['rewriting the paths changed the conversion'],
        ),
      )
    } else {
      checks.push(
        check(
          `${runner} still matches sample/${RECORDED_DIR}`,
          await recordingProblems(runner, run),
        ),
      )
    }
    checks.push(check(`${runner}'s sidecar wrote ${CONSOLE_FILE}`, consoleProblems(runner, run)))
  }
  const { jest, vitest } = runs
  const calibrated = `calibrated parity is 100% with exactly the ${SAMPLE_RULES} sample rules`
  if (jest === undefined || vitest === undefined) {
    checks.push(check(calibrated, ['not compared: a runner did not run']))
  } else {
    const report = diffRuns(jest, vitest, { ...CALIBRATED, exclusions }, today)
    const ruleIds = exclusions.map((rule) => rule.id)
    checks.push(check(calibrated, calibrationProblems(report, ruleIds, { jest, vitest })))
  }

  if (command.candidate === 'provino') {
    checks.push(
      jest === undefined
        ? check(PROVINO_CHECK, ['not run: Jest, its reference, did not run'])
        : await provinoCheck(fixture, jest, command, today, io, runSampleWith),
    )
  }

  for (const result of checks) {
    io.out(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}\n`)
    if (!result.ok && result.detail !== undefined) {
      io.out(`${result.detail.replace(/^/gm, '     ')}\n`)
    }
  }
  return checks.every((result) => result.ok) ? 0 : 1
}
