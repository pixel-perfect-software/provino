// T8.11 through the bin: `provino jest` with `coverageThreshold`, against what real Jest 30.5.2
// printed for the same project (`coverage/threshold-*`): the `Jest: ...` lines on stderr in Jest's
// order and words (a glob group names each file, `<root>` the work directory), and the exit code.
// `--json`'s `success` is false for a missed threshold, as Jest's reporter error makes it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { JEST } from './live-jest.ts'
import { type Json, observedText } from './mask.ts'
import { loadFixture, materialize } from './recorded.ts'
import { outputFree, spawnCli } from './support.ts'

/** The recorder's environment: no colour, so the failure lines carry no escape codes. */
const RECORDER_ENV = { CI: '1', NO_COLOR: '1', COLUMNS: '', GITHUB_ACTIONS: '' }

const disposers: (() => Promise<void>)[] = []
after(async () => {
  await Promise.all(disposers.map((dispose) => dispose()))
})

async function provinoOn(id: string, extra: readonly string[] = []) {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  disposers.push(project.dispose)
  const { root } = project
  await mkdir(join(root, '.harness-out'), { recursive: true })
  const outputFile = join(root, '.harness-out', 'jest.json')
  const ended = await spawnCli(
    [
      'jest',
      `--config=${join(root, 'jest.config.json')}`,
      '--ci',
      '--json',
      `--outputFile=${outputFile}`,
      ...(fixture.manifest.run?.argv?.jest ?? []),
      ...extra,
    ],
    { cwd: root, env: RECORDER_ENV },
  )
  const lines = observedText(ended.stderr, { roots: [root] })
    .split('\n')
    .filter((line) => line.startsWith('Jest: '))
    .join('\n')
  // Jest writes no results file when it found no test file; `success` is then unread.
  const json = existsSync(outputFile)
    ? (JSON.parse(await readFile(outputFile, 'utf8')) as Record<string, Json>)
    : undefined
  return {
    fixture,
    root,
    code: ended.code,
    lines,
    success: json?.success,
    stdout: ended.stdout,
    stderr: ended.stderr,
  }
}

/** The harness's transformer, which strips types for real Jest as the recorder does. */
const TRANSFORMER = fileURLToPath(new URL('../../harness/src/jest-transform.ts', import.meta.url))

interface Ended {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** What the failure lines look like on stdout and stderr: the lines Jest's reporter prints. */
function thresholdLines(text: string): string[] {
  return text.split('\n').filter((line) => line.includes('Jest: '))
}

/**
 * A fixture's project with its `coverageThreshold` replaced (and `extra` config merged in), run by
 * real Jest 30.5.2 and by Provino with the same flags and environment: the oracle for the cases a
 * recording can't hold (a path under the work directory, colour, a flag).
 */
async function bothOn(
  id: string,
  options: {
    readonly thresholds?: (root: string) => Record<string, Record<string, number>>
    /** Config keys merged over the fixture's. */
    readonly config?: Readonly<Record<string, unknown>>
    readonly args?: readonly string[]
    readonly env?: Readonly<Record<string, string>>
  },
): Promise<{ readonly jest: Ended; readonly provino: Ended; readonly root: string }> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  disposers.push(project.dispose)
  const { root } = project
  const config = JSON.parse(await readFile(join(root, 'jest.config.json'), 'utf8')) as Record<
    string,
    unknown
  >
  Object.assign(config, options.config)
  if (options.thresholds !== undefined) config.coverageThreshold = options.thresholds(root)
  await writeFile(join(root, 'jest.config.json'), JSON.stringify(config, null, 2))
  await writeFile(
    join(root, 'jest.live.config.json'),
    JSON.stringify({
      ...config,
      transform: { '\\.[cm]?ts$': [TRANSFORMER, { jestEsm: true }] },
      cacheDirectory: join(root, '.jest-cache'),
      watchman: false,
    }),
  )
  const env = { CI: '1', ...options.env }
  const args = ['--ci', '--json', `--outputFile=${join(root, 'out.json')}`, ...(options.args ?? [])]
  const jest = await new Promise<Ended>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [JEST, `--config=${join(root, 'jest.live.config.json')}`, ...args],
      { cwd: root, env: { ...outputFree(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
  const provino = await spawnCli(['jest', `--config=${join(root, 'jest.config.json')}`, ...args], {
    cwd: root,
    env,
  })
  return { jest, provino, root }
}

describe('provino jest --coverage checks coverageThreshold as Jest 30.5.2 does (coverage/threshold-*)', () => {
  for (const [id, what] of [
    ['threshold-global', 'every metric under a global threshold, in Jest metric order'],
    ['threshold-path-glob', 'a path group on its total, a glob group file by file, and global'],
    [
      'threshold-overlap',
      'a file two groups name counts for each: the glob group reports its miss',
    ],
    ['threshold-negative', 'a negative threshold caps the uncovered count'],
    ['threshold-not-found', 'a path and a glob that name no covered file'],
    ['threshold-pass', 'thresholds that are met: exit 0, nothing on stderr'],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const ran = await provinoOn(`coverage/${id}`)
      const golden = ran.fixture.golden.observed
      assert.equal(ran.code, golden?.exitCode, ran.stderr)
      assert.equal(ran.lines, golden?.stderr)
      assert.equal(ran.success, golden?.exitCode === 0, '--json success')
    })
  }

  it('--passWithNoTests with no test file still writes the reports and checks the thresholds (threshold-no-tests)', async () => {
    // runJest.ts L338-L352: the scheduler runs on an empty list, so CoverageReporter's
    // `onRunComplete` writes the reports of an empty map and checks `coverageThreshold` over it.
    // Only a group that names a path or a glob misses (`global` reads `Unknown`, which meets
    // nothing and fails nothing), and the run exits 1 though the flag says no tests is a pass.
    const ran = await provinoOn('coverage/threshold-no-tests')
    const { observed } = ran.fixture.golden
    const keep = ran.fixture.manifest.run?.keepLines
    assert.equal(ran.code, observed?.exitCode, ran.stderr)
    assert.equal(observedText(ran.stdout, { roots: [ran.root], keepLines: keep }), observed?.stdout)
    assert.equal(observedText(ran.stderr, { roots: [ran.root], keepLines: keep }), observed?.stderr)
    assert.equal(
      await readFile(join(ran.root, 'coverage', 'coverage-summary.json'), 'utf8'),
      observed?.files?.['coverage/coverage-summary.json'],
    )
    assert.equal(ran.success, false, '--json success')
  })

  it('without --passWithNoTests a run with no test file ends first: no report, no threshold check (threshold-no-tests-no-flag)', async () => {
    const ran = await provinoOn('coverage/threshold-no-tests-no-flag')
    const { observed } = ran.fixture.golden
    const keep = ran.fixture.manifest.run?.keepLines
    assert.equal(ran.code, observed?.exitCode, ran.stderr)
    assert.equal(observedText(ran.stdout, { roots: [ran.root], keepLines: keep }), observed?.stdout)
    assert.equal(observedText(ran.stderr, { roots: [ran.root], keepLines: keep }), observed?.stderr)
    assert.equal(existsSync(join(ran.root, 'coverage', 'coverage-summary.json')), false)
  })

  it('a missed threshold fails the run that passed every test, and its lines are on stderr, not stdout', async () => {
    const ran = await provinoOn('coverage/threshold-global')
    assert.equal(ran.code, 1)
    assert.match(ran.stderr, /Jest: Coverage for statements \(60%\) does not meet "global"/)
    assert.equal(thresholdLines(ran.stdout).length, 0, `nothing of it on stdout:\n${ran.stdout}`)
  })
})

// Each case runs real Jest 30.5.2 beside Provino on one tree, with the same flags and environment.
describe('provino jest --coverage: what a recording can’t hold, against a live Jest 30.5.2', () => {
  it('colour: a failure that spans lines is closed and reopened around each line, as chalk does', async () => {
    // threshold-global misses all four metrics: one `FAIL_COLOR` text of four lines.
    const { jest, provino } = await bothOn('coverage/threshold-global', {
      env: { FORCE_COLOR: '1' },
    })
    const expected = thresholdLines(jest.stderr)
    assert.equal(expected.length, 4, jest.stderr)
    assert.deepEqual(thresholdLines(provino.stderr), expected)
    assert.equal(provino.code, jest.code)
    // Every line is its own bold, red run (not one run over the whole text).
    for (const line of expected) {
      assert.ok(line.startsWith('\u001b[1m\u001b[31mJest: '), JSON.stringify(line))
      assert.ok(line.endsWith('\u001b[39m\u001b[22m'), JSON.stringify(line))
    }
    assert.equal(thresholdLines(provino.stdout).length, 0)
    assert.equal(thresholdLines(jest.stdout).length, 0)
  })

  it('a report that fails to write is printed, and the thresholds are still checked after it', async () => {
    // `onRunComplete` catches what the reports throw, prints it, and runs `_checkThreshold` anyway.
    const { jest, provino, root } = await bothOn('coverage/threshold-global', {
      config: { coverageReporters: ['no-such-reporter'] },
    })
    const inRoot = (text: string) => observedText(text, { roots: [root] })
    const expected = thresholdLines(inRoot(jest.stderr))
    assert.equal(expected.length, 4, jest.stderr)
    assert.match(jest.stderr, /Failed to write coverage reports/)
    assert.match(provino.stderr, /Failed to write coverage reports/)
    assert.deepEqual(thresholdLines(inRoot(provino.stderr)), expected)
    assert.equal(provino.code, jest.code, provino.stderr)
  })

  // The threshold hook is not tied to a provider (T8.12): the v8 map, converted to Istanbul data
  // in the coordinator, is what `checkThresholds` reads, as Jest's `_checkThreshold` reads the map
  // `_getCoverageResult` made under either provider.
  it('coverageProvider v8: a missed threshold fails the run, as Jest’s does', async () => {
    const { jest, provino, root } = await bothOn('coverage/threshold-global', {
      config: { coverageProvider: 'v8' },
    })
    const inRoot = (text: string) => observedText(text, { roots: [root] })
    const expected = thresholdLines(inRoot(jest.stderr))
    assert.equal(jest.code, 1, jest.stderr)
    assert.ok(expected.length > 0, jest.stderr)
    assert.deepEqual(thresholdLines(inRoot(provino.stderr)), expected)
    assert.equal(provino.code, jest.code, provino.stderr)
    assert.equal(thresholdLines(provino.stdout).length, 0)
  })

  it('coverageProvider v8 with --passWithNoTests and no test file: the empty map is reported and its thresholds checked, as Jest’s are', async () => {
    // threshold-no-tests under the v8 provider: Jest's CoverageReporter runs on the empty list as
    // it does under babel, so the path and glob groups find no data and the run exits 1.
    const fixture = await loadFixture('coverage/threshold-no-tests')
    const keepLines = fixture.manifest.run?.keepLines
    const { jest, provino, root } = await bothOn('coverage/threshold-no-tests', {
      config: { coverageProvider: 'v8' },
      args: fixture.manifest.run?.argv?.jest ?? [],
    })
    const kept = (text: string) => observedText(text, { roots: [root], keepLines })
    assert.equal(jest.code, 1, jest.stderr)
    assert.equal(thresholdLines(kept(jest.stderr)).length, 2, jest.stderr)
    assert.match(kept(jest.stdout), /^=+ Coverage summary/, jest.stdout)
    assert.equal(kept(provino.stderr), kept(jest.stderr))
    assert.equal(kept(provino.stdout), kept(jest.stdout))
    assert.equal(provino.code, jest.code, provino.stderr)
  })

  const cases: readonly {
    readonly name: string
    readonly thresholds?: (root: string) => Record<string, Record<string, number>>
    readonly args?: readonly string[]
    /** What the case is built to show, so a case can't pass by checking nothing. */
    readonly lines: number
  }[] = [
    {
      name: 'a threshold of 0 is met by a file with no coverage',
      thresholds: () => ({
        global: { statements: 0, branches: 0, lines: 0, functions: 0 },
        './src/deep/': { statements: 0 },
      }),
      lines: 0,
    },
    {
      name: '--coverage=false collects nothing, so no threshold is checked',
      args: ['--coverage=false'],
      lines: 0,
    },
    {
      name: 'a key with no trailing slash',
      thresholds: () => ({ './src/deep': { statements: 100 }, './src/g': { statements: 100 } }),
      lines: 1,
    },
    {
      name: 'a key that names one file',
      thresholds: () => ({ './src/grade.ts': { statements: 100 } }),
      lines: 1,
    },
    {
      name: 'an absolute path key (with its trailing separator) and an absolute glob key',
      thresholds: (root) => ({
        [`${join(root, 'src', 'deep')}${sep}`]: { statements: 100 },
        [join(root, 'src', '**', 'grade.ts')]: { statements: 100 },
      }),
      lines: 1,
    },
  ]
  for (const { name, thresholds, args, lines } of cases) {
    it(`${name}: the same lines and exit code as Jest`, async () => {
      const { jest, provino, root } = await bothOn('coverage/threshold-global', {
        ...(thresholds === undefined ? {} : { thresholds }),
        ...(args === undefined ? {} : { args }),
      })
      const inRoot = (text: string) => observedText(text, { roots: [root] })
      const expected = thresholdLines(inRoot(jest.stderr))
      assert.equal(expected.length, lines, jest.stderr)
      assert.deepEqual(thresholdLines(inRoot(provino.stderr)), expected)
      assert.equal(provino.code, jest.code, provino.stderr)
      assert.equal(thresholdLines(provino.stdout).length, 0)
    })
  }
})
