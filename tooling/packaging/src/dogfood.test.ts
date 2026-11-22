// B27g2: the facts `dogfood.ts` shares, and the proof that no test file of a migrated package is lost
// between the two runners. The completeness test runs the built bin (turbo builds `provino` first,
// `tooling/packaging/turbo.json`; with no build it fails, it does not skip) with a name filter that
// matches no test, so every file Provino discovers is imported and reported as skipped, none runs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
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

/** The built bin over the package with a name filter nothing matches; what it exited with and wrote. */
function listDiscovered(packageDir: string): Promise<{
  status: number | null
  signal: NodeJS.Signals | null
  stderr: string
  report: string
}> {
  const report = join(scratchDir('listing'), 'report.json')
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [BIN, 'run', '--reporter', 'json', '--outputFile', report, '-t', 'NO TEST HAS THIS NAME'],
      { cwd: packageDir, timeout: 120_000 },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.stdout.resume()
    child.on('error', reject)
    child.on('close', (status, signal) => resolve({ status, signal, stderr, report }))
  })
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

describe('every test file of a migrated package runs on exactly one runner', () => {
  it('what Provino discovers is every test file minus the bootstrap set, and each file has tests', async () => {
    assert.ok(existsSync(BIN), `${BIN} is missing: run pnpm build`)
    const staying = bootstrapFiles(ROOT)
    const dirs = migratedDirs(ROOT)
    assert.ok(dirs.length > 0, 'no migrated package found')
    await Promise.all(
      dirs.map(async (dir) => {
        const packageDir = join(ROOT, dir)
        const own = staying
          .filter((file) => file.startsWith(`${dir}/`))
          .map((file) => file.slice(dir.length + 1))
        const expected = testFilesOf(packageDir).filter((file) => !own.includes(file))
        assert.ok(expected.length > 0, `${dir}: no test file is left for Provino`)

        const ran = await listDiscovered(packageDir)
        // Exit 0 is "every test skipped"; a crash, a timeout or a signal is none of the three.
        assert.equal(ran.signal, null, `${dir}: ended by ${String(ran.signal)}: ${ran.stderr}`)
        assert.equal(ran.status, 0, `${dir}: exit ${String(ran.status)}: ${ran.stderr}`)
        assert.ok(existsSync(ran.report), `${dir}: the run wrote no report: ${ran.stderr}`)
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
      }),
    )
  })
})
