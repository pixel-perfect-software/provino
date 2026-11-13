// T1.10 on the built package: what `exports` lets a user import, that the rest is refused, the
// bin, and what a worker loads when it starts. Every check runs the package as a user gets it
// (`dist/`, with no `provino-source` condition), so `pnpm test` builds it first (turbo.json).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { childEnv, runBuilt, trackedProjects } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
  readonly version: string
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly bin: Readonly<Record<string, string>>
  readonly publishConfig: { readonly bin: Readonly<Record<string, string>> }
}

/** Runs `code` as an ES module in the package directory, with no `provino-source` condition. */
function inPackage(code: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: PACKAGE,
    encoding: 'utf8',
    env: childEnv([], env),
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The subpaths a user imports: the ones with a built `import` target. */
const SUBPATHS = Object.entries(manifest.exports)
  .filter(([, conditions]) => conditions.import !== undefined)
  .map(([subpath]) => subpath)

describe('the umbrella exports (T1.10)', () => {
  test('every subpath but /package.json is source, types and import, in that order', () => {
    assert.ok(SUBPATHS.includes('.') && SUBPATHS.includes('./jest'), SUBPATHS.join(', '))
    assert.deepEqual(Object.keys(manifest.exports), [...SUBPATHS, './package.json'])
    for (const subpath of SUBPATHS) {
      assert.deepEqual(
        Object.keys(manifest.exports[subpath] ?? {}),
        ['provino-source', 'types', 'import'],
        subpath,
      )
    }
  })

  test('each built entry point and its declarations are in dist', () => {
    for (const subpath of SUBPATHS) {
      for (const condition of ['types', 'import']) {
        const target = manifest.exports[subpath]?.[condition] ?? ''
        assert.ok(existsSync(join(PACKAGE, target)), `${subpath} ${condition}: ${target}`)
      }
    }
  })

  test('each subpath imports under plain Node and exports what it promises', () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      provino: [
        'ProvinoWorkerApiError',
        'afterAll',
        'afterEach',
        'beforeAll',
        'beforeEach',
        'describe',
        'expect',
        'it',
        'test',
      ],
      'provino/globals': [],
      'provino/config': ['ConfigError', 'formatConfigIssue'],
      'provino/node': ['run'],
      'provino/reporters': ['defaultReporter', 'defineReporter', 'normalizedJsonReporter'],
      'provino/environment': [
        'JsdomEnvironmentError',
        'NodeEnvironmentError',
        'defineEnvironment',
        'jsdomEnvironment',
        'nodeEnvironment',
      ],
      'provino/jest': ['jestDialect', 'jestPolicy'],
    }
    const { status, stdout, stderr } = inPackage(
      `const out = {}
       for (const s of ${JSON.stringify(Object.keys(expected))}) out[s] = Object.keys(await import(s)).sort()
       console.log(JSON.stringify(out))`,
    )
    assert.equal(status, 0, stderr)
    const got = JSON.parse(stdout) as Record<string, string[]>
    for (const [specifier, names] of Object.entries(expected)) {
      assert.deepEqual(got[specifier], [...names].sort(), specifier)
    }
  })

  test('a path outside exports throws ERR_PACKAGE_PATH_NOT_EXPORTED, built or source', () => {
    for (const specifier of [
      'provino/internal/x',
      'provino/dist/shared.js',
      'provino/src/node.ts',
      'provino/worker/main',
    ]) {
      const { status, stdout } = inPackage(
        `try { await import(${JSON.stringify(specifier)}) } catch (e) { console.log(e.code) }`,
      )
      assert.equal(status, 0)
      assert.equal(stdout.trim(), 'ERR_PACKAGE_PATH_NOT_EXPORTED', specifier)
    }
  })
})

describe('the bin', () => {
  const bin = join(PACKAGE, manifest.publishConfig.bin.provino ?? '')

  test('is built, executable and starts with a shebang', () => {
    accessSync(bin, constants.X_OK)
    assert.match(readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/)
  })

  test('--version prints the package version', () => {
    const result = runBuilt(['--version'], { cwd: PACKAGE })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${manifest.version}\n`)
  })

  test('the packed bin is the built one (publishConfig), and the workspace bin stays the source', () => {
    assert.equal(manifest.publishConfig.bin.provino, './dist/cli.js')
    assert.equal(manifest.bin.provino, './src/cli.ts')
  })
})

const project = trackedProjects()

/** A project that runs three files, one of which imports `provino` the way a user does. */
async function builtProject(): Promise<string> {
  const { dir } = await project({
    'package.json': '{"type":"module","jest":{"testMatch":["**/*.test.js"]}}\n',
    'a.test.js': "test('globals', () => { expect(1 + 1).toBe(2) })\n",
    'b.test.js': [
      "import { describe, it, expect } from 'provino'",
      "describe('the entry', () => {",
      "  it('is the worker expect', () => {",
      '    expect([1, { a: 2 }]).toEqual([1, { a: 2 }])',
      "    expect(() => expect.extend({ toBeSeven: (n) => ({ pass: n === 7, message: () => 'no' }) })).not.toThrow()",
      '    expect(7).toBeSeven()',
      '    globalThis.expect(7).toBeSeven()',
      '  })',
      '})',
      '',
    ].join('\n'),
    'c.test.js': "it('also passes', () => { expect('x').toMatch(/x/) })\n",
  })
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(PACKAGE, join(dir, 'node_modules', 'provino'), 'dir')
  return dir
}

describe('the worker-side expect (T7.12)', () => {
  test('imports no transform, resolver, loader, Oxc package or coordinator code', async () => {
    const logs = await mkdtemp(join(tmpdir(), 'provino-loads-'))
    after(() => rm(logs, { recursive: true, force: true }))
    // What `bench:expect-import` imports: the entry, then the runtime it forwards to.
    const runtime = pathToFileURL(join(PACKAGE, 'dist', 'worker', 'jest-runtime.js')).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import('provino'); await import(${JSON.stringify(runtime)})`,
      ],
      {
        cwd: PACKAGE,
        encoding: 'utf8',
        env: childEnv(['load-recorder'], { PROVINO_LOAD_LOG: logs }),
        timeout: 60_000,
      },
    )
    assert.equal(result.status, 0, result.stderr)
    const loaded = readdirSync(logs)
      .flatMap((file) => readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean))
      .map((line) => line.split('\t')[1] ?? '')
    assert.ok(
      loaded.some((url) => url.endsWith('/dist/worker/jest-runtime.js')),
      loaded.join('\n'),
    )
    // The engine is there; the loading stack (`loading.js`, which holds `transform`, `resolver`
    // and `loader`, and the natives and `magic-string` they import) and the coordinator are not.
    assert.ok(loaded.some((url) => url.endsWith('/dist/shared.js')))
    const heavy = loaded.filter((url) =>
      /\/dist\/(?:loading|coordinator)\.js|oxc|magic-string|@jridgewell|oxc-walker|es-module-lexer/.test(
        url,
      ),
    )
    assert.deepEqual(heavy, [])
  })
})

describe('a built worker (T1.10)', () => {
  test('runs a project whose test imports `provino`, and starts with at most 10 files from the package', async () => {
    const dir = await builtProject()
    const logs = await mkdtemp(join(tmpdir(), 'provino-loads-'))
    after(() => rm(logs, { recursive: true, force: true }))
    const run = runBuilt(['jest', '--ci'], {
      cwd: dir,
      preloads: ['load-recorder'],
      env: { PROVINO_LOAD_LOG: logs },
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stderr, /Tests:\s+3 passed, 3 total/)

    const dist = `${join(PACKAGE, 'dist')}/`
    const workers = readdirSync(logs)
      .map((file) => readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean))
      .filter((lines) => lines[0]?.split('\t')[0]?.endsWith('worker/bootstrap.js'))
    assert.ok(workers.length >= 1, 'no worker process was recorded')
    for (const lines of workers) {
      const files = new Set(
        lines
          .map((line) => line.split('\t')[1] ?? '')
          .filter((url) => url.startsWith('file://'))
          .map((url) => fileURLToPath(url))
          .filter((path) => path.startsWith(dist)),
      )
      assert.ok(
        files.size <= 10,
        `a worker loaded ${files.size} files from provino: ${[...files].join(', ')}`,
      )
      // The worker's whole path is there: its entry, the engine, the dialect and the environment.
      for (const wanted of [
        'worker/bootstrap.js',
        'worker/main.js',
        'worker/jest-runtime.js',
        'worker/env-node.js',
      ]) {
        assert.ok(
          [...files].some((path) => path.endsWith(wanted)),
          `${wanted}: ${[...files].join(', ')}`,
        )
      }
    }
  })
})
