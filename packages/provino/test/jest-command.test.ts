// `provino jest` beyond the exit codes: what it says about flags and config keys it doesn't run
// (gap 9: nothing is silently ignored), the other modes, several projects, and the results cache
// of a filtered run. The bin is a child process, as a script would run it.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { failing, passing, spawnCli } from './support.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-jest-')))
  made.push(dir)
  const all = { 'package.json': '{"type":"commonjs"}\n', ...files }
  for (const [name, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

const CONFIG = JSON.stringify({ testMatch: ['<rootDir>/tests/**/*.test.js'] })
const provino = (args: readonly string[], cwd: string) => spawnCli(['jest', ...args], { cwd })

describe('what provino jest does not run is said, not ignored', () => {
  it('refuses a flag with no backend by name, with the task that builds it', async () => {
    const dir = await tree({ 'jest.config.json': CONFIG, 'tests/a.test.js': passing('a') })
    // A refusal names the flag by its long name, whatever alias was typed.
    for (const [flag, task, named] of [
      ['--coverage', 'T8.8'],
      ['--shard=1/2', 'T9.6'],
      ['--watch', 'T9.11'],
      ['-o', 'Track 9', '--onlyChanged'],
    ] as readonly (readonly [string, string, string?])[]) {
      const ended = await provino([flag], dir)
      assert.equal(ended.code, 1, `${flag}: ${ended.stderr}`)
      assert.match(
        ended.stderr,
        new RegExp(`${named ?? flag.split('=')[0]} is not supported yet \\(${task}`),
      )
      assert.doesNotMatch(ended.stderr, /PASS/, `${flag} ran nothing`)
    }
  })

  it('applies the flags that change how a run looks, and says nothing about them (D54, T9.7)', async () => {
    const dir = await tree({ 'jest.config.json': CONFIG, 'tests/a.test.js': passing('a') })
    for (const flags of [
      ['--verbose'],
      ['--silent'],
      ['--expand'],
      ['--noStackTrace'],
      ['--no-colors'],
    ]) {
      const ended = await provino(flags, dir)
      assert.equal(ended.code, 0, ended.stderr)
      assert.doesNotMatch(ended.stderr, /not applied yet/, flags.join(' '))
      assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
    }
    // --verbose lists the test under its file, as Jest's does.
    const verbose = await provino(['--verbose'], dir)
    assert.match(verbose.stderr, /PASS tests\/a\.test\.js\n {2}✓ a( \(\d+ ms\))?\n\n/)
  })

  it('warns, naming the task, for the flags that still do nothing', async () => {
    const dir = await tree({ 'jest.config.json': CONFIG, 'tests/a.test.js': passing('a') })
    const ended = await provino(
      ['--debug', '--logHeapUsage', '--notify', '--notifyMode', 'always'],
      dir,
    )
    assert.equal(ended.code, 0, ended.stderr)
    for (const flag of ['debug', 'logHeapUsage', 'notify', 'notifyMode']) {
      assert.match(ended.stderr, new RegExp(`--${flag} is read but not applied yet \\(T9\\.7\\)`))
    }
    assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
  })

  it('warns, naming the task, for a config key it reads and does not apply', async () => {
    const config = JSON.stringify({
      testMatch: ['<rootDir>/tests/**/*.test.js'],
      collectCoverage: true,
    })
    const dir = await tree({
      'jest.config.json': config,
      'tests/a.test.js': passing('a'),
      'src/x.js': '',
    })
    const ended = await provino([], dir)
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /collectCoverage/)
    assert.match(ended.stderr, /T8\.8/)
  })

  it('runs several projects (D29), and lists the files of all of them', async () => {
    const dir = await tree({
      'jest.config.json': JSON.stringify({ projects: ['<rootDir>/one', '<rootDir>/two'] }),
      'one/jest.config.json': JSON.stringify({ testMatch: ['<rootDir>/**/*.test.js'] }),
      'one/a.test.js': passing('a'),
      'two/jest.config.json': JSON.stringify({ testMatch: ['<rootDir>/**/*.test.js'] }),
      'two/b.test.js': passing('b'),
    })
    const run = await provino([], dir)
    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stderr, /PASS one\/a\.test\.js|PASS \.\/a\.test\.js/)
    assert.match(run.stderr, /Test Suites: 2 passed, 2 total/)

    const listed = await provino(['--listTests'], dir)
    assert.equal(listed.code, 0, listed.stderr)
    assert.deepEqual(listed.stdout.trim().split('\n').sort(), [
      join(dir, 'one', 'a.test.js'),
      join(dir, 'two', 'b.test.js'),
    ])
  })
})

describe('the other modes', () => {
  it('--listTests --json --outputFile writes the list to the file, as Jest does', async () => {
    const dir = await tree({ 'jest.config.json': CONFIG, 'tests/a.test.js': passing('a') })
    const ended = await provino(['--listTests', '--json', '--outputFile=out/list.json'], dir)
    assert.equal(ended.code, 0, ended.stderr)
    assert.equal(ended.stdout, '')
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'out', 'list.json'), 'utf8')), [
      join(dir, 'tests', 'a.test.js'),
    ])
  })

  it('--runTestsByPath runs the named files only', async () => {
    const dir = await tree({
      'jest.config.json': CONFIG,
      'tests/ok.test.js': passing('ok'),
      'tests/bad.test.js': failing('bad'),
    })
    const named = await provino(['--runTestsByPath', 'tests/ok.test.js'], dir)
    assert.equal(named.code, 0, named.stderr)
    assert.match(named.stderr, /PASS tests\/ok\.test\.js/)
    assert.doesNotMatch(named.stderr, /bad\.test\.js/)
  })

  it('--showConfig prints the global config and the projects', async () => {
    const dir = await tree({ 'jest.config.json': CONFIG, 'tests/a.test.js': passing('a') })
    const ended = await provino(['--showConfig'], dir)
    assert.equal(ended.code, 0, ended.stderr)
    const shown = JSON.parse(ended.stdout) as {
      version: string
      globalConfig: { rootDir: string }
      configs: { rootDir: string; testMatch: string[] }[]
    }
    assert.equal(shown.version, '30.5.2')
    assert.equal(shown.configs.length, 1)
    assert.deepEqual(shown.configs[0]?.testMatch, [`${dir}/tests/**/*.test.js`])
    assert.ok(!existsSync(join(dir, 'node_modules', '.cache', 'provino')), 'it ran nothing')
  })

  it('--clearCache removes the results cache and says where', async () => {
    const dir = await tree({ 'jest.config.json': CONFIG, 'tests/a.test.js': passing('a') })
    assert.equal((await provino([], dir)).code, 0)
    const cache = join(dir, 'node_modules', '.cache', 'provino')
    assert.ok(existsSync(cache), 'a run leaves its results history')
    const cleared = await provino(['--clearCache'], dir)
    assert.equal(cleared.code, 0, cleared.stderr)
    assert.match(cleared.stdout, new RegExp(`Cleared ${cache}`))
    assert.ok(!existsSync(cache))
  })

  it('--listTests and --clearCache work for a project whose environment class is not a working one', async () => {
    // A custom environment class (run through the Jest adapter, T8.5): listing the files and
    // clearing the cache start no worker and must not depend on it (jsdom projects are most of
    // the R6 corpus, and U2's check is their `--listTests`). This one has no `setup`, so a run fails.
    const dir = await tree({
      'jest.config.json': JSON.stringify({
        testMatch: ['<rootDir>/tests/**/*.test.js'],
        testEnvironment: '<rootDir>/env.cjs',
      }),
      'env.cjs': 'module.exports = class Env {}\n',
      'tests/a.test.js': passing('a'),
    })
    const listed = await provino(['--listTests'], dir)
    assert.equal(listed.code, 0, listed.stderr)
    assert.deepEqual(listed.stdout.trim().split('\n'), [join(dir, 'tests', 'a.test.js')])

    const cleared = await provino(['--clearCache'], dir)
    assert.equal(cleared.code, 0, cleared.stderr)

    const run = await provino([], dir)
    assert.equal(run.code, 1, 'a run fails: the class has no setup()')
    assert.doesNotMatch(run.stderr, /unknown environment/)
  })

  it('--no-cache neither reads nor writes the results history', async () => {
    const dir = await tree({ 'jest.config.json': CONFIG, 'tests/a.test.js': passing('a') })
    assert.equal((await provino(['--no-cache'], dir)).code, 0)
    assert.ok(!existsSync(join(dir, 'node_modules', '.cache', 'provino', 'results.json')))
  })
})

describe('a filtered run', () => {
  it('keeps the results history of the files it did not run', async () => {
    const dir = await tree({
      'jest.config.json': CONFIG,
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
    })
    assert.equal((await provino([], dir)).code, 0)
    const results = join(dir, 'node_modules', '.cache', 'provino', 'results.json')
    const files = (): string[] => {
      const parsed = JSON.parse(readFileSync(results, 'utf8')) as {
        projects: Record<string, Record<string, unknown>>
      }
      return Object.values(parsed.projects)
        .flatMap((project) => Object.keys(project))
        .sort()
    }
    assert.deepEqual(files(), ['tests/a.test.js', 'tests/b.test.js'])

    assert.equal((await provino(['tests/a'], dir)).code, 0)
    assert.deepEqual(files(), ['tests/a.test.js', 'tests/b.test.js'], 'b keeps its history')
  })
})
