// B27e, acceptance row 8: a native project loads nothing from Jest or Vitest. The built bin runs a
// project with no dialect (`provino.config.ts`, a test file that imports from `provino`) with
// `load-recorder.ts` preloaded in the coordinator and every worker, over forks and threads, and no
// process loads a file of a banned package or a dialect chunk. A native worker starts with at most
// 10 files from the package, counted as `exports.test.ts` counts. A copy of the built package with
// `import 'pretty-format'` planted in `@provino/api`'s built entry must fail the same check.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { childEnv } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/**
 * Acceptance row 8's names (the manifest's `native` set, `tooling/boundaries/packages.json`):
 * `jest-*`, `@jest/*`, `expect`, `pretty-format`, `chai`, `@vitest/*`, `vite`, `@babel/*`
 * (`jest-snapshot` is a `jest-*`).
 */
const BANNED =
  /(?:^|\/)node_modules\/(?:jest-[^/]+|@jest\/[^/]+|expect|pretty-format|chai|@vitest\/[^/]+|vite|@babel\/[^/]+)\//

/**
 * The dialect chunks of a build in `dist`, found by what they hold, not by what Rolldown named
 * them: the Jest and Vitest runtimes and leaves (`worker/jest-*.js`, `worker/vitest-runtime.js`),
 * and every chunk that defines a dialect's value or its config reader.
 */
function dialectChunks(dist: string): Set<string> {
  const found = new Set<string>()
  for (const dir of ['', 'worker']) {
    for (const name of readdirSync(join(dist, dir)).filter((file) => file.endsWith('.js'))) {
      const path = dir === '' ? name : `${dir}/${name}`
      const source = readFileSync(join(dist, path), 'utf8')
      if (
        /^worker\/(?:jest-|vitest-runtime)/.test(path) ||
        /\bconst (?:jestDialect|vitestDialect|jestNodeDialect|vitestNodeDialect) =/.test(source)
      ) {
        found.add(path)
      }
    }
  }
  return found
}

/** A native project's shape: one config, or `projects` of native sub-configs. */
type Layout = 'single' | 'projects'

/** One process's record: its entry (`argv[1]`) and every `file:` path it loaded. */
interface Recorded {
  readonly entry: string
  readonly files: readonly string[]
}

/**
 * The native project, with `node_modules/provino` linked to `pkg`: one config, or (`projects`) a
 * root config of `projects: ['packages/*']` whose two sub-configs name no dialect either.
 */
function nativeProject(pkg: string, layout: Layout): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-native-load-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    'provino.config.ts': "export default { include: ['tests/**/*.test.ts'] }\n",
    'tests/a.test.ts': [
      "import { describe, expect, fn, it, lazy } from 'provino'",
      "const $ = lazy.let('n', () => 2)",
      "describe('native', () => {",
      "  it('adds', () => { expect($.n + 1).toBe(3) })",
      "  it('mocks', () => { const f = fn(); f(1); expect(f.mock.calls).toEqual([[1]]) })",
      '})',
      '',
    ].join('\n'),
    'tests/b.test.ts':
      "import { test, expect } from 'provino'\ntest('b', () => { expect('x').toMatch(/x/) })\n",
  }
  const laid: Record<string, string> =
    layout === 'single'
      ? files
      : {
          'package.json': files['package.json'] ?? '',
          'provino.config.ts': "export default { projects: ['packages/*'] }\n",
          'packages/one/provino.config.ts': files['provino.config.ts'] ?? '',
          'packages/one/tests/a.test.ts': files['tests/a.test.ts'] ?? '',
          'packages/two/provino.config.ts': files['provino.config.ts'] ?? '',
          'packages/two/tests/b.test.ts': files['tests/b.test.ts'] ?? '',
        }
  for (const [name, text] of Object.entries(laid)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(pkg, join(dir, 'node_modules', 'provino'), 'dir')
  return dir
}

/** Runs `pkg`'s built bin (bare `provino`: the config is found) on a native project and reads what each process loaded. */
function recordedRun(
  pkg: string,
  pool: 'forks' | 'threads',
  layout: Layout = 'single',
): readonly Recorded[] {
  const dir = nativeProject(pkg, layout)
  const logs = mkdtempSync(join(tmpdir(), 'provino-native-loads-'))
  after(() => rmSync(logs, { recursive: true, force: true }))
  const run = spawnSync(process.execPath, [join(pkg, 'dist', 'cli.js'), '--pool', pool], {
    cwd: dir,
    encoding: 'utf8',
    env: childEnv(['load-recorder'], { PROVINO_LOAD_LOG: logs }),
    timeout: 120_000,
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /Tests:\s+3 passed, 3 total/)
  return readdirSync(logs).map((file) => {
    const lines = readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean)
    return {
      entry: lines[0]?.split('\t')[0] ?? '',
      files: lines
        .map((line) => line.split('\t')[1] ?? '')
        .filter((url) => url.startsWith('file:'))
        .map((url) => fileURLToPath(url)),
    }
  })
}

/** What a run loaded that row 8 forbids: banned packages' files and dialect chunks of `pkg`. */
function forbidden(pkg: string, processes: readonly Recorded[]): string[] {
  const dist = join(pkg, 'dist') + sep
  const chunks = dialectChunks(join(pkg, 'dist'))
  const out = new Set<string>()
  for (const { files } of processes) {
    for (const path of files) {
      const posixPath = path.split(sep).join('/')
      if (BANNED.test(posixPath)) out.add(posixPath)
      if (path.startsWith(dist) && chunks.has(path.slice(dist.length).split(sep).join('/'))) {
        out.add(`dialect chunk: ${path.slice(dist.length)}`)
      }
    }
  }
  return [...out].sort()
}

describe('a native run loads nothing from Jest or Vitest (B27e, row 8)', () => {
  test('the dialect chunks are found in the build', () => {
    const chunks = dialectChunks(join(PACKAGE, 'dist'))
    for (const wanted of ['worker/jest-runtime.js', 'worker/vitest-runtime.js']) {
      assert.ok(chunks.has(wanted), `${wanted}: ${[...chunks].join(', ')}`)
    }
    // The coordinator's own chunk holds no dialect value (`jest-node`, `vitest-dialect` in umbrella.ts).
    assert.ok(!chunks.has('coordinator.js'), [...chunks].join(', '))
    assert.ok(!chunks.has('shared.js'), [...chunks].join(', '))
  })

  for (const pool of ['forks', 'threads'] as const) {
    test(`--pool ${pool}: no banned package or dialect chunk in the coordinator or any worker`, () => {
      const processes = recordedRun(PACKAGE, pool)
      assert.ok(
        processes.some(({ entry }) => entry.endsWith(`dist${sep}cli.js`)),
        'the coordinator was not recorded',
      )
      // Threads run in the coordinator's process: its record holds the workers' loads too.
      assert.ok(
        processes.some(({ files }) => files.some((path) => path.endsWith(`worker${sep}api.js`))),
        'no process loaded the native runtime (worker/api.js)',
      )
      assert.deepEqual(forbidden(PACKAGE, processes), [])
    })
  }

  test("projects: ['packages/*'] of native sub-configs loads no dialect either", () => {
    assert.deepEqual(forbidden(PACKAGE, recordedRun(PACKAGE, 'forks', 'projects')), [])
  })

  test('a native worker starts with at most 10 files from the package', () => {
    const dist = join(PACKAGE, 'dist') + sep
    const workers = recordedRun(PACKAGE, 'forks').filter(({ entry }) =>
      entry.endsWith(`worker${sep}bootstrap.js`),
    )
    assert.ok(workers.length >= 1, 'no worker process was recorded')
    for (const { files } of workers) {
      const own = new Set(files.filter((path) => path.startsWith(dist)))
      assert.ok(own.size <= 10, `a native worker loaded ${own.size} files: ${[...own].join(', ')}`)
      for (const wanted of [
        'worker/bootstrap.js',
        'worker/main.js',
        'worker/api.js',
        'worker/expect-table.js',
      ]) {
        assert.ok(
          [...own].some((path) => path.endsWith(wanted.split('/').join(sep))),
          `${wanted}: ${[...own].join(', ')}`,
        )
      }
    }
  })

  test("a planted import 'pretty-format' in @provino/api's built entry fails the check", () => {
    // A copy of the built package: `dist` and `package.json`, with the package's own
    // `node_modules` linked, so the externals resolve as they do for the real one.
    const copy = mkdtempSync(join(tmpdir(), 'provino-planted-'))
    after(() => rmSync(copy, { recursive: true, force: true }))
    cpSync(join(PACKAGE, 'dist'), join(copy, 'dist'), { recursive: true })
    cpSync(join(PACKAGE, 'package.json'), join(copy, 'package.json'))
    symlinkSync(join(PACKAGE, 'node_modules'), join(copy, 'node_modules'), 'dir')
    const api = join(copy, 'dist', 'worker', 'api.js')
    writeFileSync(api, `import 'pretty-format'\n${readFileSync(api, 'utf8')}`)
    const found = forbidden(copy, recordedRun(copy, 'forks'))
    assert.ok(
      found.some((path) => /\/node_modules\/pretty-format\//.test(path)),
      `the plant was not caught: ${found.join(', ')}`,
    )
  })
})
