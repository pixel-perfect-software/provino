// B27g2: the facts `dogfood.ts` shares, and the proof that no test file of a migrated package is lost
// between the two runners. The completeness test runs the built bin (turbo builds `provino` first,
// `tooling/packaging/turbo.json`; with no build it fails, it does not skip) with a name filter that
// matches no test, so every file Provino discovers is imported and reported as skipped, none runs.
// B27h3: it is one test per package, and each listing runs with a temp dir of its own that must be
// empty afterwards: a test file does no work when it is imported (`.claude/rules/tests.md`).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'provino'
import {
  bootstrapFiles,
  isIncludedTestFile,
  migratedDirs,
  RUNNER_BIN,
  TEST_ROOTS,
  TEST_RUNNER,
  testScript,
} from './dogfood.ts'
import { scratchDir } from './test-support.ts'
import { ROOT } from './workspace.ts'

const BIN = join(ROOT, RUNNER_BIN)

/**
 * Discovery runs at once. Every package's run starts its own workers, so launching all of them
 * together on a busy runner leaves an idle worker unable to stop in time (a run error).
 */
const DISCOVERY_LANES = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)))

/**
 * Runs each task once one of `limit` lanes is free, and hands the lane to the next waiting task as
 * a task ends. The packages' tests start together (each has its own deadline: a package that is slow
 * to list fails alone); this keeps at most `limit` listings in flight, as the pool did.
 */
function lanes(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let busy = 0
  const waiting: (() => void)[] = []
  return async (task) => {
    if (busy >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    else busy++
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next === undefined) busy--
      else next()
    }
  }
}

const inLane = lanes(DISCOVERY_LANES)

/** Every `*.test.ts` under a migrated package's include roots, relative to the package, sorted. */
function testFilesOf(packageDir: string): string[] {
  return TEST_ROOTS.filter((root) => existsSync(join(packageDir, root)))
    .flatMap((root) =>
      readdirSync(join(packageDir, root), { recursive: true, encoding: 'utf8' })
        .map((entry) => `${root}/${entry.split('\\').join('/')}`)
        .filter((path) => !path.includes('/node_modules/')),
    )
    .filter(isIncludedTestFile)
    .sort()
}

/**
 * The built bin over the package with a name filter nothing matches; what it exited with and wrote,
 * and what it left in the temp dir. The listing gets a temp dir of its own (`TMPDIR`, `TMP` and
 * `TEMP`), empty, and the report goes elsewhere: a test file that makes a temp dir when it is only
 * imported (module scope, a `describe` body) leaves it there, since no test runs to remove it. The
 * runner itself writes nothing there (measured over every package, B27h3), so nothing is excluded.
 */
function listDiscovered(packageDir: string): Promise<{
  status: number | null
  signal: NodeJS.Signals | null
  stderr: string
  report: string
  left: string[]
}> {
  const report = join(scratchDir('listing'), 'report.json')
  const tmp = scratchDir('listing-tmp')
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN, 'run', '--reporter', 'json', '--outputFile', report, '-t', 'NO TEST HAS THIS NAME'],
      {
        cwd: packageDir,
        timeout: 120_000,
        env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.stdout.resume()
    child.on('error', reject)
    child.on('close', (status, signal) =>
      resolve({ status, signal, stderr, report, left: readdirSync(tmp).sort() }),
    )
  })
}

/** At most this much of a failed sub-run's report goes into an assertion message. */
const MAX_DETAIL = 4096

interface ReportedError {
  name?: string
  message?: string
  stack?: string
  userFrame?: string
}

function describeError(where: string, error: ReportedError): string {
  const stack = (error.stack ?? '').split('\n').slice(0, 4).join('\n')
  const frame = error.userFrame === undefined ? '' : ` (${error.userFrame})`
  return `${where}: ${error.name ?? 'Error'}: ${error.message ?? ''}${frame}${stack === '' ? '' : `\n${stack}`}`
}

/**
 * What a sub-run's JSON report says went wrong, for an assertion message: the run's own errors
 * and every file's load or collection error, capped. A missing or unreadable report says so.
 */
function reportProblems(report: string): string {
  if (!existsSync(report)) return '(no report was written)'
  let parsed: { runErrors?: ReportedError[]; files?: { file: string; fileError?: ReportedError }[] }
  try {
    parsed = JSON.parse(readFileSync(report, 'utf8'))
  } catch (cause) {
    return `(the report is not JSON: ${String(cause)})`
  }
  const lines = (parsed.runErrors ?? []).map((error) => describeError('run error', error))
  for (const entry of parsed.files ?? []) {
    if (entry.fileError !== undefined) lines.push(describeError(entry.file, entry.fileError))
  }
  return lines.length === 0 ? '(the report holds no error)' : lines.join('\n').slice(0, MAX_DETAIL)
}

/** The text a failed sub-run puts into its assertion message. */
function failureDetail(ran: { stderr: string; report: string }): string {
  return `${ran.stderr}\nreport: ${reportProblems(ran.report)}`
}

describe('migratedDirs', () => {
  it('reads the root it is given: directories with a config and a package.json, sorted', () => {
    const root = scratchDir('dogfood', {
      'packages/a/package.json': '{}',
      'packages/a/provino.config.ts': '',
      'packages/b/package.json': '{}',
      'tooling/c/package.json': '{}',
      'tooling/c/provino.config.ts': '',
      'packages/d/provino.config.ts': '',
    })
    assert.deepEqual(migratedDirs(root), ['packages/a', 'tooling/c'])
  })
})

describe('a failed sub-run explains itself', () => {
  it("puts the report's run errors and file errors into the message", () => {
    const report = join(scratchDir('dogfood-report'), 'report.json')
    writeFileSync(
      report,
      JSON.stringify({
        runErrors: [
          { name: 'Error', message: 'worker died', stack: 'Error: worker died\n  at a\n  at b' },
        ],
        files: [
          { file: 'src/ok.test.ts' },
          {
            file: 'src/bad.test.ts',
            fileError: { name: 'SyntaxError', message: 'planted load failure' },
          },
        ],
      }),
    )
    const detail = failureDetail({ stderr: 'some stderr', report })
    assert.match(detail, /some stderr/)
    assert.match(detail, /run error: Error: worker died/)
    assert.match(detail, /at a/)
    assert.match(detail, /src\/bad\.test\.ts: SyntaxError: planted load failure/)
    assert.doesNotMatch(detail, /ok\.test/)
  })

  it('caps the report and says when there is none', () => {
    const dir = scratchDir('dogfood-report-cap')
    const report = join(dir, 'report.json')
    writeFileSync(report, JSON.stringify({ runErrors: [{ message: 'x'.repeat(20_000) }] }))
    assert.ok(reportProblems(report).length <= 4096)
    assert.equal(reportProblems(join(dir, 'missing.json')), '(no report was written)')
  })

  it('a real failing sub-run names its load error', async () => {
    assert.ok(existsSync(BIN), `${BIN} is missing: run pnpm build`)
    const root = scratchDir('dogfood-failing', {
      'provino.config.ts': 'export default {}\n',
      'src/boom.test.ts': "throw new Error('planted load failure')\n",
    })
    const ran = await listDiscovered(root)
    assert.notEqual(ran.status, 0)
    assert.match(failureDetail(ran), /planted load failure/)
  })
})

describe('testScript', () => {
  it("is the runner alone, or the runner and node --test over the package's bootstrap files", () => {
    const root = scratchDir('dogfood-script', {
      'tooling/provino/bootstrap.json': JSON.stringify({
        files: { 'packages/a/src/x.test.ts': 'why', 'packages/a/src/y.test.ts': 'why' },
      }),
    })
    assert.equal(testScript(root, 'packages/b'), TEST_RUNNER)
    assert.equal(
      testScript(root, 'packages/a'),
      `${TEST_RUNNER} && node --test --conditions=provino-source src/x.test.ts src/y.test.ts`,
    )
  })

  it('names the one runner bin', () => {
    assert.ok(TEST_RUNNER.includes(RUNNER_BIN))
  })
})

// One test per package, each with its own deadline, and the packages are read when the file loads (a
// directory listing: cheap, and the one thing the test names come from). They start together;
// `inLane` keeps at most DISCOVERY_LANES listings running.
describe.concurrent('every test file of a migrated package runs on exactly one runner', () => {
  const staying = bootstrapFiles(ROOT)
  const dirs = migratedDirs(ROOT)

  it('there is a migrated package', () => {
    assert.ok(dirs.length > 0, 'no migrated package found')
  })

  for (const dir of dirs) {
    it(`${dir}: what Provino discovers is every test file minus the bootstrap set, each file has tests, and importing them leaves no temp dir`, async () => {
      assert.ok(existsSync(BIN), `${BIN} is missing: run pnpm build`)
      const packageDir = join(ROOT, dir)
      const own = staying
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1))
      const expected = testFilesOf(packageDir).filter((file) => !own.includes(file))
      assert.ok(expected.length > 0, `${dir}: no test file is left for Provino`)

      const ran = await inLane(() => listDiscovered(packageDir))
      // Exit 0 is "every test skipped"; a crash, a timeout or a signal is none of the three.
      assert.equal(
        ran.signal,
        null,
        `${dir}: ended by ${String(ran.signal)}: ${failureDetail(ran)}`,
      )
      assert.equal(ran.status, 0, `${dir}: exit ${String(ran.status)}: ${failureDetail(ran)}`)
      assert.ok(existsSync(ran.report), `${dir}: the run wrote no report: ${ran.stderr}`)
      assert.equal(
        ran.left.length,
        0,
        `${dir}: importing its test files left ${ran.left.length} entr${ran.left.length === 1 ? 'y' : 'ies'} in the temp dir (${ran.left.join(', ')}): a test file does no work when it is imported, so a temp dir made at module scope or in a describe body belongs in the first test that needs it or in a beforeAll (.claude/rules/tests.md); grep the package for the name's prefix`,
      )
      const parsed = JSON.parse(readFileSync(ran.report, 'utf8')) as {
        files: { file: string; tests: unknown[] }[]
      }
      assert.deepEqual(
        parsed.files.map((entry) => entry.file).sort(),
        expected,
        `${dir}: Provino's files differ`,
      )
      for (const entry of parsed.files) {
        assert.ok(entry.tests.length > 0, `${dir}: ${entry.file} registered no test`)
      }
    })
  }
})
