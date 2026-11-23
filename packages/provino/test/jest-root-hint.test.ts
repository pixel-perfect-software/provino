// `provino jest` at a root with no Jest config, over directories that have their own: one line on
// stderr before the run names them and `--projects`. Jest prints nothing there (an improvement,
// DIVERGENCES), so no recording holds this and no golden contains the line. The bin runs as a child
// process in a temp tree: a root `package.json` with no `jest` key, which Jest reads as `{}`.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, it } from 'provino'
import { spawnCli, withoutNodeNoise } from './support.ts'

const made: string[] = []
afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

const PASSING = "test('passes', () => {})\n"

/** A temp tree of `files` (path to text) and its real path. */
async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-root-hint-')))
  made.push(root)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

/** A monorepo: no Jest config at the root, two packages with one each (a file, a `package.json` key). */
const MONOREPO: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "monorepo" }\n',
  'apps/client/jest.config.json': '{}\n',
  'apps/client/a.test.js': PASSING,
  // A deeper file under the same config names `apps/client` once.
  'apps/client/src/deep/b.test.js': PASSING,
  'packages/ui/package.json': '{ "jest": {} }\n',
  'packages/ui/c.test.js': PASSING,
  // No config of its own: the root's (none) covers it, so it is not named.
  'packages/plain/d.test.js': PASSING,
  // A config with no test file below it is not named: nothing of it is in the run.
  'packages/idle/jest.config.json': '{}\n',
}

const HINT =
  'provino: no Jest config here; 2 directories below have one (apps/client, packages/ui). Run with --projects <dirs> to use them.'

/** The hint lines in what a run wrote to stderr. */
function hintLines(stderr: string): string[] {
  return withoutNodeNoise(stderr)
    .split('\n')
    .filter((line) => line.startsWith('provino: no Jest config here'))
}

describe('provino jest with no Jest config at the root', () => {
  it('prints one line before the run, naming the directories below that have a config', async () => {
    const cwd = await tree(MONOREPO)
    const ended = await spawnCli(['jest', '--ci'], { cwd })
    assert.equal(ended.code, 0, ended.stderr)
    assert.deepEqual(hintLines(ended.stderr), [HINT])
    const text = withoutNodeNoise(ended.stderr)
    assert.ok(
      text.indexOf(HINT) < text.indexOf('PASS'),
      `the line comes before the first file's result:\n${text}`,
    )
    assert.equal(ended.stdout, '', 'stdout is untouched')
  })

  it('says "one directory" for one, and lists at most five, then …', async () => {
    const one = await tree({
      'package.json': '{}\n',
      'only/jest.config.json': '{}\n',
      'only/a.test.js': PASSING,
    })
    const ended = await spawnCli(['jest', '--ci'], { cwd: one })
    assert.deepEqual(hintLines(ended.stderr), [
      'provino: no Jest config here; 1 directory below has one (only). Run with --projects <dirs> to use them.',
    ])

    const files: Record<string, string> = { 'package.json': '{}\n' }
    for (const name of ['g', 'f', 'e', 'd', 'c', 'b', 'a']) {
      files[`p/${name}/jest.config.json`] = '{}\n'
      files[`p/${name}/x.test.js`] = PASSING
    }
    const seven = await spawnCli(['jest', '--ci'], { cwd: await tree(files) })
    assert.deepEqual(hintLines(seven.stderr), [
      'provino: no Jest config here; 7 directories below have one (p/a, p/b, p/c, p/d, p/e, …). Run with --projects <dirs> to use them.',
    ])
  })

  it('says nothing under --json, --listTests, --showConfig, --collectTests or --debug', async () => {
    const cwd = await tree(MONOREPO)
    for (const args of [
      ['--json'],
      ['--json', '--outputFile=out.json'],
      ['--listTests'],
      ['--listTests', '--json'],
      ['--showConfig'],
      ['--collectTests'],
      ['--debug'],
    ]) {
      const ended = await spawnCli(['jest', '--ci', ...args], { cwd })
      assert.deepEqual(hintLines(ended.stderr), [], `provino jest ${args.join(' ')}: stderr`)
      assert.ok(!ended.stdout.includes('no Jest config here'), `${args.join(' ')}: stdout`)
    }
  })

  it('says nothing when the run reads a config: the root has one, or --config or --projects names it', async () => {
    const withRoot = await tree({ ...MONOREPO, 'jest.config.json': '{}\n' })
    assert.deepEqual(hintLines((await spawnCli(['jest', '--ci'], { cwd: withRoot })).stderr), [])

    const withKey = await tree({ ...MONOREPO, 'package.json': '{ "jest": {} }\n' })
    assert.deepEqual(hintLines((await spawnCli(['jest', '--ci'], { cwd: withKey })).stderr), [])

    const named = await tree(MONOREPO)
    const config = await spawnCli(['jest', '--ci', '--config=apps/client/jest.config.json'], {
      cwd: named,
    })
    assert.deepEqual(hintLines(config.stderr), [])
    const projects = await spawnCli(['jest', '--ci', '--projects', 'apps/client', 'packages/ui'], {
      cwd: named,
    })
    assert.equal(projects.code, 0, projects.stderr)
    assert.deepEqual(hintLines(projects.stderr), [])
  })

  it('says nothing when no directory below has a config', async () => {
    const cwd = await tree({
      'package.json': '{}\n',
      'src/a.test.js': PASSING,
      'src/nested/b.test.js': PASSING,
      'idle/jest.config.json': '{}\n',
    })
    const ended = await spawnCli(['jest', '--ci'], { cwd })
    assert.equal(ended.code, 0, ended.stderr)
    assert.deepEqual(hintLines(ended.stderr), [])
  })
})
