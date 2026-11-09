// T11.13: `provino jest`, `provino vitest` and bare `provino` route to the right runner, and no
// `jest` or `vitest` bin is published. Trees are written to $TMPDIR as text (D13).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { failing, passing, spawnCli } from './support.ts'

const made: string[] = []
after(async () => {
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

const JEST_CONFIG = JSON.stringify({ testMatch: ['<rootDir>/tests/**/*.test.js'] })
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

  it('refuses a flag it can’t run yet by name, with Jest’s usage exit code', async () => {
    const dir = await tree(JEST_PROJECT)
    const refused = await provino(['jest', '--watch'], dir)
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /--watch is not supported yet \(T9\.11\)/)
    assert.equal(refused.stdout, '')
  })

  it('exits 2 for a command it does not know', async () => {
    const dir = await tree(JEST_PROJECT)
    const unknown = await provino(['jset'], dir)
    assert.equal(unknown.code, 2)
    assert.match(unknown.stderr, /unknown command "jset"/)
  })
})

describe('provino vitest', () => {
  it('is refused until the Vitest dialect has a parser (T11.16)', async () => {
    const dir = await tree(JEST_PROJECT)
    const result = await provino(['vitest', 'run'], dir)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /provino vitest is not available yet/)
    assert.match(result.stderr, /T11\.16/)
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
    const vitest = await provino(['--dialect', 'vitest'], dir)
    assert.equal(vitest.code, 2)
    assert.match(vitest.stderr, /provino vitest is not available yet/)
    const bad = await provino(['--dialect', 'mocha'], dir)
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /--dialect must be jest or vitest/)
  })

  it('names a Vitest project it can’t run yet', async () => {
    const dir = await tree({ 'vitest.config.ts': 'export default {}\n' })
    const result = await provino([], dir)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Vitest project/)
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
