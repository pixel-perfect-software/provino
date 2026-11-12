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
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const RECORDER = fileURLToPath(new URL('./load-recorder.ts', import.meta.url))
const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
  readonly version: string
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly publishConfig: { readonly bin: Readonly<Record<string, string>> }
}

/** Runs `code` as an ES module in the package directory, with no `provino-source` condition. */
function inPackage(code: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: PACKAGE,
    encoding: 'utf8',
    env: { ...process.env, ...env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' },
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const SUBPATHS = ['.', './globals', './config', './node', './reporters', './environment', './jest']

describe('the umbrella exports (T1.10)', () => {
  test('lists the six public subpaths beside /node, and /package.json', () => {
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
    const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${manifest.version}\n`)
  })

  test('the packed bin is the built one (publishConfig), and the workspace bin stays the source', () => {
    assert.equal(manifest.publishConfig.bin.provino, './dist/cli.js')
    const workspace = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
      readonly bin: Readonly<Record<string, string>>
    }
    assert.equal(workspace.bin.provino, './src/cli.ts')
  })
})

/** A project that runs three files, one of which imports `provino` the way a user does. */
function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-built-')))
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(PACKAGE, join(dir, 'node_modules', 'provino'), 'dir')
  writeFileSync(
    join(dir, 'package.json'),
    '{"type":"module","jest":{"testMatch":["**/*.test.js"]}}\n',
  )
  writeFileSync(join(dir, 'a.test.js'), "test('globals', () => { expect(1 + 1).toBe(2) })\n")
  writeFileSync(
    join(dir, 'b.test.js'),
    [
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
  )
  writeFileSync(join(dir, 'c.test.js'), "it('also passes', () => { expect('x').toMatch(/x/) })\n")
  return dir
}

describe('a built worker (T1.10)', () => {
  const bin = join(PACKAGE, 'dist', 'cli.js')

  test('runs a project whose test imports `provino`, and starts with at most 10 files from the package', () => {
    const dir = project()
    const logs = mkdtempSync(join(tmpdir(), 'provino-loads-'))
    const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --import=${RECORDER}`.trim()
    const run = spawnSync(process.execPath, [bin, 'jest', '--ci'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PROVINO_LOAD_LOG: logs, NODE_OPTIONS: nodeOptions },
      timeout: 120_000,
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
          .filter((path) => path.startsWith(dist) || path.startsWith(`${PACKAGE}dist/`)),
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
