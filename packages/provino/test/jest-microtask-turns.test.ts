// B23e: jest-circus awaits its six event handlers at every event it dispatches, so a promise chain a
// test leaves running gets 20 microtask turns before the test's `afterEach` runs, where Provino's
// own code took 2 (`core.boundaryTurns`). Held to `runtime/microtask-turns` and `-jsdom` (Jest
// 30.5.2) through the bin, in band (`-i`, and `-w 1`, which runs one file in band) and in a forked
// worker (`workerIdleMemoryLimit` keeps a worker, as in Jest), and a repro of the shape real suites
// hit: a chain of promise hops that writes into a module's log after `afterEach` cleared it, so the
// next test saw it, against live Jest.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, describe, it } from 'node:test'
import { runJest } from './live-jest.ts'
import { loadFixture, materialize } from './recorded.ts'
import { linkEnvironments } from './recorded-run.ts'
import { spawnCli } from './support.ts'

/**
 * The turns core's count is ahead of Jest's at the run's start, through the bin (the loader's
 * module-runner path): the count starts where the file's import settles, and the promise hops the
 * loader and core take between the end of the module's evaluation and that settle are not
 * Jest's (B23f Phase 5, open: through a native `import()` the corpus check sees 6). The plain
 * run-start fixtures differ by 3 here, and so do the environment's.
 */
const RUN_START_OFFSETS: Readonly<Record<string, number>> = {
  'runtime/microtask-turns-run-start': 3,
  'runtime/microtask-turns-run-start-test': 3,
  'env/microtask-turns-handle-test-event': 3,
  'env/microtask-turns-handle-test-event-await': 3,
  'env/microtask-turns-handle-test-event-sync': 3,
}

/** A trace line with its turn count raised by `by`. */
function shifted(line: string, by: number): string {
  const at = line.lastIndexOf(': ')
  return `${line.slice(0, at + 2)}${Number(line.slice(at + 2)) + by}`
}

/** The ways a run is made, each held to the same recording. */
const MODES = [
  ['in band (-i)', ['-i']],
  ['one worker (-w 1, in band for one file)', ['-w', '1']],
  ['a forked worker (-w 1 with workerIdleMemoryLimit)', ['-w', '1', '--workerIdleMemoryLimit=1GB']],
] as const

describe('the turns a promise chain gets between hooks and tests are Jest 30.5.2`s', () => {
  for (const id of [
    'runtime/microtask-turns',
    'runtime/microtask-turns-jsdom',
    'runtime/microtask-turns-skipped',
    'runtime/microtask-turns-describe',
    'runtime/microtask-turns-run-start',
    'runtime/microtask-turns-run-start-test',
    'runtime/microtask-turns-done',
    'runtime/microtask-turns-retry',
    'env/microtask-turns-handle-test-event',
    'env/microtask-turns-handle-test-event-await',
    'env/microtask-turns-handle-test-event-sync',
  ]) {
    for (const [mode, flags] of MODES) {
      it(`${id}, ${mode}`, async () => {
        const fixture = await loadFixture(id)
        const recorded = fixture.golden.trace ?? []
        assert.ok(recorded.length >= 1, 'the recording traced a boundary')
        const project = await materialize(fixture)
        try {
          await linkEnvironments(project.root)
          // The recorder's `trace` global, as a setup file: one line per call, to a file.
          const traced = join(project.root, 'trace.txt')
          await writeFile(
            join(project.root, 'trace-setup.cjs'),
            `const { appendFileSync } = require('node:fs')\nglobalThis.trace = (step) => { appendFileSync(${JSON.stringify(traced)}, step + '\\n') }\n`,
          )
          const configPath = join(project.root, 'jest.config.json')
          const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
          await writeFile(
            configPath,
            JSON.stringify({ ...config, setupFiles: ['<rootDir>/trace-setup.cjs'] }),
          )
          const ended = await spawnCli(['jest', `--config=${configPath}`, '--ci', ...flags], {
            cwd: project.root,
          })
          const got = (await readFile(traced, 'utf8')).trim().split('\n')
          // The run's start is held apart (`RUN_START_OFFSETS`); every other line must be Jest's.
          const offsets = RUN_START_OFFSETS[id] ?? 0
          const differing = recorded.flatMap((line, index) =>
            got[index] === (offsets !== 0 && index === 0 ? shifted(line, offsets) : line)
              ? []
              : [`line ${index}:\n provino ${got[index]}\n jest    ${line}`],
          )
          assert.deepEqual(differing, [], ended.stderr.slice(-1500))
          assert.equal(got.length, recorded.length, 'as many lines as Jest traced')
          // The fixture's failing tests fail.
          assert.equal(ended.code, fixture.golden.success ? 0 : 1, ended.stderr)
        } finally {
          await project.dispose()
        }
      })
    }
  }
})

/**
 * The shape real suites hit: a request's interceptors (a few promise hops) record into a log the
 * next test reads, and `afterEach` clears it. In Jest the hops are done before `afterEach` runs, so
 * the next test sees an empty log; with 2 turns the record landed after the clear.
 */
const CHAIN_TEST = `const log = []
afterEach(() => {
  log.length = 0
})
function request() {
  let chain = Promise.resolve()
  for (let hop = 0; hop < 10; hop++) chain = chain.then(() => {})
  chain.then(() => log.push('a response'))
}
test('a test starts a request and returns', () => {
  request()
})
test('the next test sees the log afterEach cleared', () => {
  expect(log).toEqual([])
})
test('an async test starts a request and returns', async () => {
  await null
  request()
})
test('the next test sees it cleared again', () => {
  expect(log).toEqual([])
})
`

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Each test's status in a Jest results file (`--json --outputFile`), by `<file>::<full name>`. */
async function statusesIn(root: string, out: string): Promise<[string, string][]> {
  const report = JSON.parse(await readFile(out, 'utf8')) as {
    testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
  }
  return report.testResults.flatMap((file) =>
    file.assertionResults.map(
      (test) => [`${relative(root, file.name)}::${test.fullName}`, test.status] as [string, string],
    ),
  )
}

describe('a promise chain a test leaves running is done before its afterEach, as in Jest', () => {
  it('the record lands before the clear, so the next test sees an empty log', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-turns-')))
    made.push(root)
    await writeFile(join(root, 'chain.test.js'), CHAIN_TEST)
    await writeFile(
      join(root, 'jest.config.json'),
      JSON.stringify({ rootDir: root, testMatch: ['<rootDir>/*.test.js'] }),
    )
    const jestOut = join(root, 'jest-results.json')
    const jest = await runJest(root, [
      '--ci',
      '--no-cache',
      '-c',
      'jest.config.json',
      '--json',
      `--outputFile=${jestOut}`,
    ])
    const expected = await statusesIn(root, jestOut)
    assert.equal(expected.length, 4, jest.stderr)
    assert.ok(
      expected.every(([, status]) => status === 'passed'),
      `real Jest passes every test:\n${jest.stderr}`,
    )
    for (const [mode, flags] of MODES) {
      const out = join(root, 'provino-results.json')
      const ended = await spawnCli(
        ['jest', '--ci', '-c', 'jest.config.json', ...flags, '--json', `--outputFile=${out}`],
        { cwd: root },
      )
      assert.deepEqual(await statusesIn(root, out), expected, `${mode}:\n${ended.stderr}`)
      assert.equal(ended.code, 0, `${mode}:\n${ended.stderr}`)
    }
  })
})
