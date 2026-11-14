// T8.5 end to end: each of the five Jest environment packages the brief names runs a 3-test smoke
// file through the worker, with no source change to the package, and every test has the status
// real Jest 30.5.2 gives it. Under `registry` (realm `context` waits for T2.8). The packages are
// the ones `@provino/dialect-jest` installs for its adapter smoke, linked into the project's
// `node_modules` as pnpm would have put them.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { liveJest, provinoRun, sorted } from './live-jest.ts'
import { loadFixture, materialize } from './recorded.ts'
import { spawnCli } from './support.ts'

const require = createRequire(
  fileURLToPath(new URL('../../dialect-jest/package.json', import.meta.url)),
)

/** `[name in the project, package installed under it, an observation only this environment gives]`. */
const ENVIRONMENTS = [
  ['jest-environment-node', 'jest-environment-node', "typeof process.version === 'string'"],
  [
    'jest-environment-jsdom',
    'jest-environment-jsdom',
    "typeof document.createElement === 'function'",
  ],
  [
    'jest-environment-jsdom',
    'jest-environment-jsdom-29',
    "typeof document.createElement === 'function'",
  ],
  [
    'jest-fixed-jsdom',
    'jest-fixed-jsdom',
    "typeof document === 'object' && typeof Response === 'function'",
  ],
  [
    '@edge-runtime/jest-environment',
    '@edge-runtime/jest-environment',
    "typeof EdgeRuntime === 'string'",
  ],
] as const

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('T8.5: a Jest environment package runs a smoke file through the worker, as in Jest', () => {
  for (const [name, installed, observation] of ENVIRONMENTS) {
    const title = installed === name ? name : `${name} (${installed})`
    it(`${title}`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-env-smoke-')))
      made.push(root)
      await writeFile(join(root, 'package.json'), '{"type":"commonjs"}\n')
      await writeFile(
        join(root, 'jest.config.json'),
        JSON.stringify({
          rootDir: root,
          testEnvironment: name,
          testMatch: ['<rootDir>/*.test.js'],
        }),
      )
      await writeFile(
        join(root, 'smoke.test.js'),
        [
          "test('the global is the test global', () => {",
          '  globalThis.__smoke = 1',
          '  expect(global.__smoke).toBe(1)',
          '})',
          "test('timers run', async () => {",
          '  await new Promise((resolve) => setTimeout(resolve, 1))',
          '})',
          "test('the environment is the one named', () => {",
          `  expect(${observation}).toBe(true)`,
          '})',
          '',
        ].join('\n'),
      )
      // The package under the name the project gives it, and its own dependencies beside it.
      const target = dirname(require.resolve(`${installed}/package.json`))
      await mkdir(dirname(join(root, 'node_modules', name)), { recursive: true })
      await symlink(target, join(root, 'node_modules', name))

      const expected = await liveJest(root)
      assert.equal(expected.size, 3, 'real Jest ran the three tests')
      const got = await provinoRun(root)
      assert.deepEqual(sorted(got.statuses), sorted(expected), got.stderr)
      assert.deepEqual([...got.statuses.values()], ['passed', 'passed', 'passed'], got.stderr)
    })
  }
})

// A custom environment's `handleTestEvent` (T8.5's rest, B23d): the environment in
// `env/handle-test-event*` appends one JSON line per circus event; the lines Provino's mirror of
// circus produces equal the ones Jest 30.5.2 wrote.
describe('handleTestEvent sees the events Jest 30.5.2 gave it', () => {
  for (const id of [
    'env/handle-test-event',
    'env/handle-test-event-only',
    'env/handle-test-event-async',
  ]) {
    it(id, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        // The environment extends `jest-environment-node`, as it resolves from the project.
        const target = dirname(require.resolve('jest-environment-node/package.json'))
        await mkdir(join(project.root, 'node_modules'), { recursive: true })
        await symlink(target, join(project.root, 'node_modules', 'jest-environment-node'))
        const ended = await spawnCli(
          [
            'jest',
            `--config=${join(project.root, 'jest.config.json')}`,
            '--ci',
            '--testLocationInResults',
          ],
          { cwd: project.root },
        )
        const recorded = fixture.golden.observed?.files?.['events.jsonl']
        assert.equal(typeof recorded, 'string', 'the recording has the events')
        const ours = await readFile(join(project.root, 'events.jsonl'), 'utf8')
        const got = ours.trim().split('\n')
        const want = (recorded as string).trim().split('\n')
        const at = got.findIndex((line, index) => line !== want[index])
        assert.equal(
          at,
          -1,
          `line ${at}:\n provino ${got[at]}\n jest    ${want[at]}\n${ended.stderr.slice(-1500)}`,
        )
        assert.equal(got.length, want.length)
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      } finally {
        await project.dispose()
      }
    })
  }
})
