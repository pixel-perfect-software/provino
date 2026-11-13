// The bin's compile cache (B21d, T3.7): on in `<cwd>/node_modules/.cache/provino/compile`, inherited
// by the workers through `NODE_COMPILE_CACHE`, and off whenever coverage is on.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { outputFree } from './support.ts'

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
  it('turns Node’s compile cache on in the project, and gives its workers the directory', async () => {
    const cwd = await scratch()
    const { seen } = inChild([cwd, 'run', '--config', 'x'])
    const expected = join(cwd, 'node_modules', '.cache', 'provino', 'compile')
    assert.equal(seen.status, 'enabled')
    assert.equal(seen.before, null)
    assert.equal(seen.after, expected)
    assert.equal(seen.grandchild, expected, 'a process the bin starts inherits the directory')
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
    assert.equal(seen.created, false, 'nothing is written in the project')
  })

  it('respects NODE_DISABLE_COMPILE_CACHE', async () => {
    const cwd = await scratch()
    const { seen } = inChild([cwd], { NODE_DISABLE_COMPILE_CACHE: '1' })
    assert.equal(seen.status, 'disabled')
    assert.equal(seen.after, null)
  })
})
