// The bin's compile cache (B21d, T3.7): on in `<cwd>/node_modules/.cache/provino/compile`, handed to
// the forked workers for Node's own startup only (no test ever sees `NODE_COMPILE_CACHE`: Jest sets
// none, D7), and off whenever coverage is on.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { outputFree, runBuilt, spawnCli, trackedProjects } from './support.ts'

/** The module, loaded by URL: the type-test project includes this directory but not the package's source. */
const { cachesOff, coverageOn } = (await import(
  new URL('../src/internal/compile-cache.ts', import.meta.url).href
)) as {
  cachesOff(argv: readonly string[]): boolean
  coverageOn(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): boolean
}

const CHILD = fileURLToPath(new URL('compile-cache-child.ts', import.meta.url))
const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Seen {
  readonly status: string
  readonly before: string | null
  readonly after: string | null
  readonly grandchild: string
  /** What `workerStartupEnv` gives the pool for a forked worker's spawn. */
  readonly workerEnv: Readonly<Record<string, string>>
  readonly created: boolean
  readonly tagged: boolean
}

/** One `enableBinCompileCache` call in a fresh process, in a fresh directory. */
function inChild(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): { readonly dir: string; readonly seen: Seen } {
  const result = spawnSync(process.execPath, ['--conditions=provino-source', CHILD, ...args], {
    encoding: 'utf8',
    env: { ...outputFree(), ...env },
    timeout: 60_000,
  })
  assert.equal(result.status, 0, result.stderr)
  return { dir: args[0] ?? '', seen: JSON.parse(result.stdout) as Seen }
}

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-compile-cache-')))
  dirs.push(dir)
  return dir
}

describe('coverageOn', () => {
  it('is on for NODE_V8_COVERAGE and for the coverage flags, in any spelling but =false', () => {
    assert.equal(coverageOn([], {}), false)
    assert.equal(coverageOn(['run', '--config', 'x'], { NODE_V8_COVERAGE: '/tmp/cov' }), true)
    assert.equal(coverageOn(['--coverage'], {}), true)
    assert.equal(coverageOn(['--collectCoverage'], {}), true)
    assert.equal(coverageOn(['--coverage=true'], {}), true)
    assert.equal(coverageOn(['--coverage=false'], {}), false)
    assert.equal(coverageOn([], { NODE_V8_COVERAGE: '' }), false)
    assert.equal(coverageOn(['--coverageProvider', 'v8', '--no-cache'], {}), false)
  })

  it('reads the dashed spelling Jest’s parser accepts: --collect-coverage is --collectCoverage', () => {
    assert.equal(coverageOn(['--collect-coverage'], {}), true)
    assert.equal(coverageOn(['--collect-coverage=true'], {}), true)
    assert.equal(coverageOn(['--collect-coverage=false'], {}), false)
  })
})

describe('cachesOff', () => {
  it('is on for --no-cache, Jest’s --cache=false, and the modes that run nothing', () => {
    assert.equal(cachesOff(['run', '--config', 'x']), false)
    assert.equal(cachesOff(['--no-cache']), true)
    assert.equal(cachesOff(['jest', '--cache=false']), true)
    assert.equal(cachesOff(['jest', '--cache', 'false']), true)
    assert.equal(cachesOff(['jest', '--cache']), false)
    assert.equal(cachesOff(['jest', '--cache=true']), false)
    // The modes that start no run write nothing: --clearCache would find the directory again at exit.
    assert.equal(cachesOff(['jest', '--clearCache']), true)
    assert.equal(cachesOff(['jest', '--showConfig']), true)
    assert.equal(cachesOff(['jest', '--listTests']), false)
  })

  it('reads the dashed spellings Jest’s parser accepts: --clear-cache is --clearCache', () => {
    assert.equal(cachesOff(['jest', '--clear-cache']), true)
    assert.equal(cachesOff(['jest', '--show-config']), true)
    assert.equal(cachesOff(['jest', '--list-tests']), false)
  })
})

describe('enableBinCompileCache (a process of its own each)', () => {
  it('turns Node’s compile cache on in the project and offers its directory to the workers, without touching process.env', async () => {
    const cwd = await scratch()
    const { seen } = inChild([cwd, 'run', '--config', 'x'])
    const expected = join(cwd, 'node_modules', '.cache', 'provino', 'compile')
    assert.equal(seen.status, 'enabled')
    assert.equal(seen.before, null)
    assert.equal(seen.after, null, 'the variable is not written: a test must not see it')
    assert.equal(seen.grandchild, '', 'a process a test starts has none either')
    assert.deepEqual(seen.workerEnv, { NODE_COMPILE_CACHE: expected })
    assert.equal(seen.created, true)
    assert.equal(seen.tagged, true, 'the directory carries Provino’s CACHEDIR.TAG')
  })

  it('does nothing under coverage: no cache, no variable, no directory', async () => {
    for (const [args, env] of [
      [['--coverage'], {}],
      [['--collectCoverage=true'], {}],
      [['run'], { NODE_V8_COVERAGE: join(tmpdir(), 'provino-cov') }],
    ] as const) {
      const cwd = await scratch()
      const { seen } = inChild([cwd, ...args], env)
      assert.equal(seen.status, 'disabled', JSON.stringify(args))
      assert.equal(seen.after, null)
      assert.equal(seen.grandchild, '')
      assert.deepEqual(seen.workerEnv, {})
      assert.equal(seen.created, false)
    }
  })

  it('does nothing under --no-cache, the flag that says no cache is read or written', async () => {
    const cwd = await scratch()
    const { seen } = inChild([cwd, 'run', '--no-cache'])
    assert.equal(seen.status, 'disabled')
    assert.equal(seen.after, null)
    assert.equal(seen.created, false)
  })

  it('leaves a NODE_COMPILE_CACHE the user already set alone', async () => {
    const cwd = await scratch()
    const theirs = join(await scratch(), 'theirs')
    const { seen } = inChild([cwd], { NODE_COMPILE_CACHE: theirs })
    assert.equal(seen.after, theirs)
    assert.equal(seen.grandchild, theirs)
    assert.deepEqual(seen.workerEnv, {}, 'their variable reaches the workers as it is, and stays')
    assert.equal(seen.created, false, 'nothing is written in the project')
  })

  it('respects NODE_DISABLE_COMPILE_CACHE', async () => {
    const cwd = await scratch()
    const { seen } = inChild([cwd], { NODE_DISABLE_COMPILE_CACHE: '1' })
    assert.equal(seen.status, 'disabled')
    assert.equal(seen.after, null)
  })
})

describe('the compile cache and the tests the bin runs (D7: Jest sets no such variable)', () => {
  const makeProject = trackedProjects()

  /** A test file that reads the variable itself, and through a process it starts. */
  const sees = (expected: string | undefined): string =>
    [
      "const { execFileSync } = require('node:child_process')",
      "test('sees the compile cache variable as the user left it', () => {",
      `  const expected = ${JSON.stringify(expected)}`,
      '  expect(process.env.NODE_COMPILE_CACHE).toBe(expected)',
      "  const child = execFileSync(process.execPath, ['-p', 'String(process.env.NODE_COMPILE_CACHE)'], { encoding: 'utf8' })",
      '  expect(child.trim()).toBe(String(expected))',
      '})',
      '',
    ].join('\n')

  for (const pool of ['forks', 'inline'] as const) {
    it(`the built bin, --pool ${pool}: no variable in the test, and Node's cache holds entries`, async () => {
      const project = await makeProject({ 'tests/env.test.js': sees(undefined) })
      const ran = runBuilt(['run', '--config', project.config, '--pool', pool], {
        cwd: project.dir,
      })
      assert.equal(ran.status, 0, ran.stderr)
      const dir = join(project.dir, 'node_modules', '.cache', 'provino', 'compile')
      // Node's own layout under our directory is not ours to count: Node 26 keeps the bin's
      // portable cache and the forks' `NODE_COMPILE_CACHE` cache in two directories (the portable
      // one has no uid suffix), Node 24 in one. What matters is that Node cached chunks there.
      const cached = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readdirSync(join(dir, entry.name)).length)
      assert.ok(
        cached.some((entries) => entries > 0),
        'the compiled chunks were cached',
      )
    })

    it(`--pool ${pool}: a test sees no NODE_COMPILE_CACHE, and the cache directory is still written`, async () => {
      const project = await makeProject({ 'tests/env.test.js': sees(undefined) })
      const ended = await spawnCli(['run', '--config', project.config, '--pool', pool], {
        cwd: project.dir,
      })
      assert.equal(ended.code, 0, ended.stderr)
      assert.match(ended.stderr, /PASS tests\/env\.test\.js/)
      const dir = join(project.dir, 'node_modules', '.cache', 'provino', 'compile')
      assert.equal(existsSync(dir), true, 'the cache is on')
      assert.equal(existsSync(join(dir, 'CACHEDIR.TAG')), true)
    })

    it(`--pool ${pool}: a NODE_COMPILE_CACHE the user set stays, in the test too, and nothing is written in the project`, async () => {
      const theirs = join(await scratch(), 'theirs')
      const project = await makeProject({ 'tests/env.test.js': sees(theirs) })
      const ended = await spawnCli(['run', '--config', project.config, '--pool', pool], {
        cwd: project.dir,
        env: { NODE_COMPILE_CACHE: theirs },
      })
      assert.equal(ended.code, 0, ended.stderr)
      assert.equal(
        existsSync(join(project.dir, 'node_modules', '.cache', 'provino', 'compile')),
        false,
      )
    })
  }
})
