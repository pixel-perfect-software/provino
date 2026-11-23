// `NODE_ENV` under `provino jest` (B23e, compat). `jest-cli/bin/jest.js` (30.5.2) runs
// `if (process.env.NODE_ENV == null) process.env.NODE_ENV = 'test'` before anything else, so a test
// sees `test` unless the environment already says something (an empty string included: `== null`),
// and `jest.replaceProperty(process.env, 'NODE_ENV', 'development')`, which needs the property to
// exist, works. Without it a project's tests saw no `NODE_ENV` at all.
//
// `cli/node-env-{default,set,empty}` are recorded from real Jest 30.5.2: two test files each (the
// recorder's `maxWorkers: 2`, so Jest uses two workers), whose titles hold what each file saw as it
// loaded and inside a test, and the results file the run wrote. The recorder drops any `NODE_ENV` it
// inherits and `replayEnv` does the same, so the bin starts with none unless a fixture's `env` sets
// one. Each fixture is held to its golden in every way a test file can run: in forks (the
// fixture's `maxWorkers: 2`), threads, one worker (`-w 1`) and in the bin's own process (`-i`).
// The bare `provino` command, which runs a Jest project the same way, is held to the same golden.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, it } from 'provino'
import { loadFixture, materialize } from './recorded.ts'
import { describeRecorded, replayEnv, WORK } from './recorded-run.ts'
import { spawnCli } from './support.ts'

const GROUP = 'cli/node-env-'
const IDS = ['cli/node-env-default', 'cli/node-env-set', 'cli/node-env-empty'] as const

const MODES = [
  ['in forks (two workers)', []],
  ['in threads (two workers)', ['--workerThreads']],
  ['in one worker (-w 1)', ['-w', '1']],
  ['in band (-i), in the bin’s own process', ['-i']],
] as const

for (const [mode, argv] of MODES) {
  describeRecorded(
    `NODE_ENV ${mode}, against Jest 30.5.2`,
    GROUP,
    [
      [IDS[0], 'unset: a file sees test, and replaceProperty finds NODE_ENV and restores it'],
      [IDS[1], 'production stays production in both files'],
      [IDS[2], 'an empty string stays empty (jest-cli tests == null)'],
    ],
    { run: { argv } },
  )
}

describe('NODE_ENV under the bare provino command, against Jest 30.5.2', () => {
  for (const [form, args] of [
    ['found from the working directory', []],
    ['--dialect jest', ['--dialect', 'jest']],
  ] as const) {
    for (const id of IDS) {
      it(`${id}, ${form}: the tests see what Jest's tests saw`, async () => {
        const fixture = await loadFixture(id)
        const project = await materialize(fixture, { parent: WORK })
        try {
          const outputFile = '.harness-out/jest.json'
          await mkdir(join(project.root, '.harness-out'), { recursive: true })
          const ended = await spawnCli(
            [...args, '--ci', '--json', `--outputFile=${outputFile}`, '-w', '2'],
            { cwd: project.root, baseEnv: replayEnv(fixture.manifest, project.root) },
          )
          const results = JSON.parse(await readFile(join(project.root, outputFile), 'utf8')) as {
            testResults: {
              name: string
              assertionResults: { fullName: string; status: string }[]
            }[]
          }
          const seen = results.testResults
            .flatMap((file) =>
              file.assertionResults.map(
                (test) => `${relative(project.root, file.name)}::${test.fullName} ${test.status}`,
              ),
            )
            .toSorted()
          const recorded = fixture.golden.files
            .flatMap((file) =>
              (file.tests ?? []).map(
                (test) => `${file.file}::${test.id.path.join(' ')} ${test.status}`,
              ),
            )
            .toSorted()
          assert.ok(recorded.length > 0)
          assert.deepEqual(seen, recorded, ended.stderr)
          assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        } finally {
          await project.dispose()
        }
      })
    }
  }
})
