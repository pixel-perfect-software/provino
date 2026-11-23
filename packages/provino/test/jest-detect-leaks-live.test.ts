// `--detectLeaks` beside real Jest 30.5.2 on the same trees (B23d A4 review): `detectLeaks` is a
// project key (`runTest.ts` reads `config.detectLeaks`), and a file found leaking is failed whole by
// `TestScheduler`'s `onFailure`: no failed test is counted for it, `bail` is not checked for it,
// and the totals hold one runtime-error suite.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it } from 'provino'
import { JEST, noColorEnv } from './live-jest.ts'
import { outputFree, spawnCli } from './support.ts'

/** Real Jest in `cwd`, in the environment Provino's own child gets: no agent or colour variable (an agent's shell would make Jest choose its `agent` reporter, which prints no PASS line). */
function runJest(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JEST, ...args], {
      cwd,
      env: outputFree(noColorEnv()),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
}

/** A leak: a function of the file that uses its `require` stays on a shared core module. */
const LEAK = "require('node:fs').__leaked = () => require('node:os')\n"

const made: string[] = []
afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-leaks-')))
  made.push(root)
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}\n')
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

/** The lines of a report that say which files passed and failed, and the totals, sorted. */
function verdicts(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => /^(PASS|FAIL) |^(Test Suites|Tests):/.test(line))
    .sort()
}

describe('detectLeaks is a project key', () => {
  it('checks only the project that asks: its leaking file fails, the other project’s passes', async () => {
    const root = await tree({
      'jest.config.json': JSON.stringify({ projects: ['<rootDir>/a', '<rootDir>/b'] }),
      'a/jest.config.json': JSON.stringify({
        displayName: 'a',
        detectLeaks: true,
        testMatch: ['<rootDir>/*.test.js'],
      }),
      'a/leak.test.js': `${LEAK}test('a', () => {})\n`,
      'b/jest.config.json': JSON.stringify({
        displayName: 'b',
        testMatch: ['<rootDir>/*.test.js'],
      }),
      'b/leak.test.js': `${LEAK}test('b', () => {})\n`,
    })
    const jest = await runJest(root, ['--ci', '-i'])
    const ours = await spawnCli(['jest', '--ci', '-i'], { cwd: root })
    assert.equal(jest.code, 1, jest.stderr)
    assert.equal(ours.code, jest.code, ours.stderr)
    assert.deepEqual(verdicts(ours.stderr), verdicts(jest.stderr), ours.stderr)
    const lines = verdicts(jest.stderr)
    assert.ok(
      lines.some((line) => line.startsWith('PASS')),
      jest.stderr,
    )
    assert.ok(
      lines.some((line) => line.startsWith('FAIL')),
      jest.stderr,
    )
  })
})

describe('a file that leaks', () => {
  /** The leaking file is the larger, so both runners start with it. It fails a test as well. */
  async function project(): Promise<string> {
    return tree({
      'jest.config.json': JSON.stringify({ testMatch: ['<rootDir>/*.test.js'], bail: 1 }),
      'a-leak.test.js': `${LEAK}test('fails too', () => {\n  throw new Error('no')\n})\n${'// padding\n'.repeat(40)}`,
      'b.test.js': "test('b', () => {})\n",
    })
  }

  it('does not trigger --bail with the test it failed: the second file runs, as under Jest', async () => {
    const root = await project()
    const flags = ['--ci', '-w', '1', '--detectLeaks']
    const jest = await runJest(root, flags)
    const ours = await spawnCli(['jest', ...flags], { cwd: root })
    assert.equal(ours.code, jest.code, ours.stderr)
    assert.deepEqual(verdicts(ours.stderr), verdicts(jest.stderr), ours.stderr)
    assert.ok(jest.stderr.includes('PASS ./b.test.js'), jest.stderr)
  })

  it('counts no test and one runtime-error suite in --json, as the totals of Jest do', async () => {
    const root = await project()
    const flags = ['--ci', '-w', '1', '--detectLeaks', '--json']
    const jest = await runJest(root, [...flags, `--outputFile=${join(root, 'jest.json')}`])
    const ours = await spawnCli(['jest', ...flags, `--outputFile=${join(root, 'ours.json')}`], {
      cwd: root,
    })
    assert.equal(ours.code, jest.code, ours.stderr)
    const read = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(root, name), 'utf8')) as Record<string, unknown>
    const totals = (json: Record<string, unknown>): Record<string, unknown> => ({
      numFailedTestSuites: json.numFailedTestSuites,
      numFailedTests: json.numFailedTests,
      numPassedTests: json.numPassedTests,
      numRuntimeErrorTestSuites: json.numRuntimeErrorTestSuites,
      numTotalTests: json.numTotalTests,
      numTotalTestSuites: json.numTotalTestSuites,
    })
    assert.deepEqual(totals(await read('ours.json')), totals(await read('jest.json')))
  })
})
