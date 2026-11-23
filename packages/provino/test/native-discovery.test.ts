// B27d, acceptance row 4: `provino` and `provino run` find a `provino.config.*` with no --config
// (D196's walk up), and a directory with none is a usage error. Trees are written as text (D13).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, it } from 'provino'
import { jestConfigJson, passing, spawnCli } from './support.ts'

const made: string[] = []
afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-discovery-')))
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

/** The config a native project has: no dialect named. */
const NATIVE_CONFIG = "export default { include: ['tests/**/*.test.js'] }\n"
const JEST_CONFIG = "export default { dialect: 'jest', include: ['tests/**/*.test.js'] }\n"

describe('config discovery', () => {
  it('bare provino and provino run find the config in a parent directory', async () => {
    const dir = await tree({
      'provino.config.mjs': JEST_CONFIG,
      'tests/a.test.js': passing('a'),
      'tests/deep/keep.txt': '',
    })
    for (const args of [[], ['run']]) {
      const ended = await spawnCli(args, { cwd: join(dir, 'tests/deep') })
      assert.equal(ended.code, 0, ended.stderr)
      assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
    }
  })

  it('the nearest config of any kind wins: a Jest config below a provino.config (D200)', async () => {
    const dir = await tree({
      'provino.config.mjs': "export default { dialect: 'jest', include: ['nothing/**'] }\n",
      'packages/x/jest.config.json': jestConfigJson(),
      'packages/x/tests/a.test.js': passing('a'),
    })
    const bare = await spawnCli([], { cwd: join(dir, 'packages/x') })
    assert.equal(bare.code, 0, bare.stderr)
    assert.match(bare.stderr, /PASS tests\/a\.test\.js/)
    // `provino run` takes provino's own config only: the nearest one is not that, and it says so.
    const run = await spawnCli(['run'], { cwd: join(dir, 'packages/x') })
    assert.equal(run.code, 2, run.stderr)
    assert.match(run.stderr, /nearest config is a Jest config in .*packages\/x/)
  })

  it('within one directory provino.config wins over a Jest config', async () => {
    const dir = await tree({
      'provino.config.mjs': JEST_CONFIG,
      'jest.config.json': JSON.stringify({ testMatch: ['<rootDir>/nothing/**/*.js'] }),
      'tests/a.test.js': passing('a'),
    })
    const ended = await spawnCli([], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
  })

  it('--config still names the file, and wins over the walk', async () => {
    const dir = await tree({
      'provino.config.mjs': "export default { dialect: 'jest', include: ['nothing/**'] }\n",
      'other.config.mjs': JEST_CONFIG,
      'tests/a.test.js': passing('a'),
    })
    const ended = await spawnCli(['run', '--config', 'other.config.mjs'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
  })

  it('the walk stops at a directory with .git or pnpm-workspace.yaml', async () => {
    for (const marker of ['.git/HEAD', 'pnpm-workspace.yaml']) {
      const dir = await tree({
        'provino.config.mjs': JEST_CONFIG,
        [`inner/${marker}`]: '',
        'inner/pkg/x.txt': '',
      })
      const ended = await spawnCli(['run'], { cwd: join(dir, 'inner/pkg') })
      assert.equal(ended.code, 2, ended.stderr)
      assert.match(
        ended.stderr,
        /found no provino\.config\.\*, Jest config or Vitest config in .*inner\/pkg or a parent directory/,
      )
    }
  })

  it('a directory with no config is a usage error for provino run and for bare provino', async () => {
    const dir = await tree({ 'tests/a.test.js': passing('a') })
    const run = await spawnCli(['run'], { cwd: dir })
    assert.equal(run.code, 2, run.stderr)
    assert.match(run.stderr, /found no provino\.config\.\*, Jest config or Vitest config in/)
    const bare = await spawnCli([], { cwd: dir })
    assert.equal(bare.code, 2, bare.stderr)
    assert.match(bare.stderr, /found no provino\.config\.\*, Jest config or Vitest config/)
  })

  it('a config that names no dialect runs as a native project, with no Jest code asked for', async () => {
    // No test file to run: the project resolves under the neutral policy (no dialect) and ends 0.
    const dir = await tree({ 'provino.config.mjs': NATIVE_CONFIG })
    const ended = await spawnCli(['run', '--passWithNoTests'], { cwd: dir })
    assert.equal(ended.code, 0, ended.stderr)
  })

  it('an unknown key in the config is exit 2, naming the key and the nearest', async () => {
    const dir = await tree({ 'provino.config.mjs': "export default { incude: ['a'] }\n" })
    const ended = await spawnCli(['run'], { cwd: dir })
    assert.equal(ended.code, 2, ended.stderr)
    assert.match(ended.stderr, /unknown config key "incude"; did you mean "include"\?/)
  })
})
