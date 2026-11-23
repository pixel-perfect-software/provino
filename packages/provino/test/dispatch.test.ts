// T11.13: `provino jest`, `provino vitest` and bare `provino` route to the right runner, and no
// `jest` or `vitest` bin is published. Trees are written to $TMPDIR as text (D13).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, it } from 'provino'
import { fileURLToPath } from 'node:url'
import { failing, jestConfigJson, passing, spawnCli } from './support.ts'

const made: string[] = []
afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-dispatch-')))
  made.push(dir)
  for (const [name, text] of Object.entries({
    'package.json': '{"type":"commonjs"}\n',
    ...files,
  })) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

/** `provino <args>` as a child process in `cwd`, as a script would run it. */
async function provino(args: readonly string[], cwd: string) {
  const ended = await spawnCli(args, { cwd })
  assert.equal(ended.signal, null, 'it exited, it was not killed')
  return { code: ended.code, stdout: ended.stdout, stderr: ended.stderr }
}

const JEST_CONFIG = jestConfigJson()
const JEST_PROJECT = {
  'jest.config.json': JEST_CONFIG,
  'tests/a.test.js': passing('a'),
}

describe('provino jest', () => {
  it('runs a Jest project with Jest’s config and exit codes', async () => {
    const dir = await tree(JEST_PROJECT)
    const passed = await provino(['jest'], dir)
    assert.equal(passed.code, 0, passed.stderr)
    assert.match(passed.stderr, /PASS tests\/a\.test\.js/)

    const broken = await tree({ ...JEST_PROJECT, 'tests/b.test.js': failing('b') })
    const failed = await provino(['jest'], broken)
    assert.equal(failed.code, 1, failed.stderr)
    assert.match(failed.stderr, /FAIL tests\/b\.test\.js/)
  })

  it('takes Jest’s flags: -t, a path pattern and --config', async () => {
    const dir = await tree({
      ...JEST_PROJECT,
      'tests/b.test.js': failing('the bad one'),
      'other.config.json': JEST_CONFIG,
    })
    assert.equal((await provino(['jest', 'tests/a'], dir)).code, 0)
    assert.equal((await provino(['jest', '-t', '^a$'], dir)).code, 0, 'b has no test named a')
    // `a\.test`, not `a.test`: a pattern is also tried on the absolute path (below), and the `.`
    // would match the `a/test` of a temp directory whose random name ends in `a`.
    assert.equal(
      (await provino(['jest', '--config', 'other.config.json', 'a\\.test'], dir)).code,
      0,
    )
  })

  it('tries a path pattern on the absolute path too, as Jest does', async () => {
    // The project's directory is named `xa`, so `a.test` matches `.../xa/tests/b.test.js`.
    const parent = await tree({
      'xa/jest.config.json': JEST_CONFIG,
      'xa/tests/a.test.js': passing('a'),
      'xa/tests/b.test.js': failing('the bad one'),
    })
    const dir = join(parent, 'xa')
    const loose = await provino(['jest', 'a.test'], dir)
    assert.equal(loose.code, 1, 'b ran, through the directory name')
    assert.match(loose.stderr, /FAIL tests\/b\.test\.js/)
    const exact = await provino(['jest', 'a\\.test'], dir)
    assert.equal(exact.code, 0, exact.stderr)
    assert.doesNotMatch(exact.stderr, /b\.test\.js/)
  })

  it('runs --watch as Jest does: outside a repository it says so and exits 1 (B23c Phase 8)', async () => {
    const dir = await tree(JEST_PROJECT)
    const ended = await provino(['jest', '--watch'], dir)
    assert.equal(ended.code, 1)
    // runJest.ts L253-L266
    assert.match(ended.stderr, /--watch is not supported without git\/hg, please use --watchAll/)
    assert.doesNotMatch(ended.stderr, /not supported yet/)
  })

  it('exits 2 for a command it does not know', async () => {
    const dir = await tree(JEST_PROJECT)
    const unknown = await provino(['jset'], dir)
    assert.equal(unknown.code, 2)
    assert.match(unknown.stderr, /unknown command "jset"/)
  })
})

const VITEST_PROJECT = {
  'vitest.config.mjs': 'export default { test: { globals: true } }\n',
  'tests/a.test.js': passing('a'),
}

describe('provino vitest', () => {
  it('runs a Vitest project once with Vitest’s exit codes (B25g, T11.16)', async () => {
    const dir = await tree(VITEST_PROJECT)
    const passed = await provino(['vitest', 'run'], dir)
    assert.equal(passed.code, 0, passed.stderr)
    // A bare `vitest` runs once too (D175).
    assert.equal((await provino(['vitest'], dir)).code, 0)

    const broken = await tree({ ...VITEST_PROJECT, 'tests/b.test.js': failing('b') })
    assert.equal((await provino(['vitest', 'run'], broken)).code, 1)
    // A filter is a substring of the path, as Vitest's.
    assert.equal((await provino(['vitest', 'run', 'a.test'], broken)).code, 0)
  })

  it('refuses watch mode by name and ends 1, as Vitest ends on any error (D175)', async () => {
    const dir = await tree(VITEST_PROJECT)
    const watch = await provino(['vitest', 'watch'], dir)
    assert.equal(watch.code, 1)
    assert.match(watch.stderr, /vitest watch is not supported \(D175/)
  })
})

describe('bare provino', () => {
  it('runs a provino.config.* as provino run does', async () => {
    const dir = await tree({
      'provino.config.mjs': "export default { dialect: 'jest', include: ['tests/**/*.test.js'] }\n",
      'tests/a.test.js': passing('a'),
    })
    const result = await provino([], dir)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /PASS tests\/a\.test\.js/)
  })

  it('runs a Jest project when the directory has a Jest config, and passes its flags on', async () => {
    const dir = await tree({ ...JEST_PROJECT, 'tests/b.test.js': failing('b') })
    assert.equal((await provino([], dir)).code, 1)
    assert.equal((await provino(['-t', '^a$'], dir)).code, 0)
    assert.equal((await provino(['--dialect', 'jest', 'tests/a'], dir)).code, 0)
  })

  it('finds Jest’s config in package.json only with a jest key', async () => {
    const withKey = await tree({
      'package.json': JSON.stringify({
        type: 'commonjs',
        jest: { testMatch: ['<rootDir>/tests/**/*.test.js'] },
      }),
      'tests/a.test.js': passing('a'),
    })
    assert.equal((await provino([], withKey)).code, 0)

    const without = await tree({ 'tests/a.test.js': passing('a') })
    const result = await provino([], without)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /found no provino\.config\.\*, Jest config or Vitest config/)
  })

  it('stops when a directory has both a Jest and a Vitest config, unless --dialect says which', async () => {
    const dir = await tree({ ...JEST_PROJECT, 'vitest.config.ts': 'export default {}\n' })
    const both = await provino([], dir)
    assert.equal(both.code, 2)
    assert.match(both.stderr, /both a Jest config and a Vitest config/)
    assert.match(both.stderr, /--dialect jest or --dialect vitest/)

    assert.equal((await provino(['--dialect=jest'], dir)).code, 0)
    // Vitest's own config: no globals, so the Jest-style test file fails to load.
    const vitest = await provino(['--dialect', 'vitest'], dir)
    assert.equal(vitest.code, 1, vitest.stderr)
    assert.match(vitest.stderr, /test is not defined/)
    const bad = await provino(['--dialect', 'mocha'], dir)
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--dialect must be jest or vitest/)
  })

  it('runs a Vitest project as provino vitest does (B25g)', async () => {
    const dir = await tree(VITEST_PROJECT)
    const result = await provino([], dir)
    assert.equal(result.code, 0, result.stderr)
    const broken = await tree({ ...VITEST_PROJECT, 'tests/b.test.js': failing('b') })
    assert.equal((await provino([], broken)).code, 1)
  })

  it('finds a Vitest project in a vite.config.* that has a test key (B25c), and not in one without', async () => {
    const withTest = await tree({
      'vite.config.mjs': 'export default { test: { globals: true } }\n',
    })
    // Run as a Vitest project, which has no test file: Vitest's text and exit code.
    const found = await provino([], withTest)
    assert.equal(found.code, 1)
    assert.match(found.stderr, /No test files found, exiting with code 1/)

    const plain = await tree({ 'vite.config.mjs': 'export default { server: {} }\n' })
    const none = await provino([], plain)
    assert.equal(none.code, 2)
    assert.match(none.stderr, /found no provino\.config\.\*, Jest config or Vitest config/)

    // A Jest config settles it: the Vite config is not even read.
    const jestWithVite = await tree({
      ...JEST_PROJECT,
      'vite.config.mjs': 'export default { test: {} }\n',
    })
    assert.equal((await provino([], jestWithVite)).code, 0)

    // A vitest.config.* beside a Jest config is still the clash.
    const both = await tree({ ...JEST_PROJECT, 'vitest.config.mjs': 'export default {}\n' })
    assert.match((await provino([], both)).stderr, /both a Jest config and a Vitest config/)
  })

  it('a vite.config.* that does not load never breaks detection (B25c)', async () => {
    const broken = 'export default { test: \n'
    // Next to a Jest project it is ignored: the project runs.
    const jest = await tree({ ...JEST_PROJECT, 'vite.config.ts': broken })
    assert.equal((await provino([], jest)).code, 0)
    // Alone it is no evidence of Vitest: the usual "found no config" usage error, no stack.
    const alone = await tree({ 'vite.config.ts': broken })
    const result = await provino([], alone)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /found no provino\.config\.\*, Jest config or Vitest config/)
    assert.doesNotMatch(result.stderr, /\n\s+at /)
  })
})

describe('no jest or vitest bin is published', () => {
  it('declares a provino bin only, in every package', async () => {
    const packages = fileURLToPath(new URL('../../', import.meta.url))
    const bins: string[] = []
    for (const name of await readdir(packages)) {
      const manifest = JSON.parse(await readFile(join(packages, name, 'package.json'), 'utf8')) as {
        bin?: string | Record<string, string>
      }
      if (typeof manifest.bin === 'string') bins.push(name)
      else bins.push(...Object.keys(manifest.bin ?? {}))
    }
    assert.ok(bins.includes('provino'))
    assert.ok(!bins.includes('jest') && !bins.includes('vitest'), `bins: ${bins.join(', ')}`)
  })
})
