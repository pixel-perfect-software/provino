// T8.5 end to end: each of the five Jest environment packages the brief names runs a 3-test smoke
// file through the worker, with no source change to the package, and every test has the status
// real Jest 30.5.2 gives it. Under `registry` (realm `context` waits for T2.8). The packages are
// the ones `@provino/dialect-jest` installs for its adapter smoke, linked into the project's
// `node_modules` as pnpm would have put them.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { liveJest, provinoRun, sorted } from './live-jest.ts'

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
