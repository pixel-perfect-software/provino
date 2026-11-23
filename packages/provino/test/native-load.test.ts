// B27e, acceptance row 8: a native project loads nothing from Jest or Vitest. The built bin runs a
// project with no dialect (`provino.config.ts`, a test file that imports from `provino`) with
// `load-recorder.ts` preloaded in the coordinator and every worker, over forks and threads, and no
// process loads a file of a banned package or a dialect chunk. A native worker starts with at most
// 10 files from the package, counted as `exports.test.ts` counts. Each half has a failing control:
// a copy of the built package with `import 'jest-junit'` (B27f: `pretty-format` is no longer
// `provino`'s to resolve) planted in `@provino/api`'s built entry,
// and one whose bin imports the Jest dialect's chunk.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, test } from 'provino'
import { fileURLToPath } from 'node:url'
import { ADD_ON_DISTS, builtSources, chunkFiles, moduleRequests } from './dist.ts'
import {
  type LoadLog,
  linkProvino,
  makeProject,
  packageCopy,
  readLoadLogs,
  runBuilt,
  whenFileEnds,
} from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/** The boundaries manifest, whose `bannedPackageSets.native` is acceptance rows 8 and 9's list. */
const MANIFEST = join(PACKAGE, '..', '..', 'tooling', 'boundaries', 'packages.json')

/** The manifest's `native` ban list (`jest-*`, `@jest/*`, `expect`, …) as a test of a loaded path. */
function bannedPaths(): RegExp {
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    readonly bannedPackageSets?: { readonly native?: readonly string[] }
  }
  const names = parsed.bannedPackageSets?.native ?? []
  assert.ok(names.length > 0, `${MANIFEST} has no bannedPackageSets.native`)
  const alternatives = names.map((name) =>
    name
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
      .join('[^/]+'),
  )
  return new RegExp(`(?:^|/)node_modules/(?:${alternatives.join('|')})/`)
}

const BANNED = bannedPaths()

/** What the test file of the native project declares: three tests, all passing. */
const TESTS = 3

/** The native project's own files, as `single` (one config) or `projects` lays them out. */
const NATIVE_FILES = {
  config: "export default { include: ['tests/**/*.test.ts'] }\n",
  a: [
    "import { describe, expect, fn, it, lazy } from 'provino'",
    "const $ = lazy.let('n', () => 2)",
    "describe('native', () => {",
    "  it('adds', () => { expect($.n + 1).toBe(3) })",
    "  it('mocks', () => { const f = fn(); f(1); expect(f.mock.calls).toEqual([[1]]) })",
    '})',
    '',
  ].join('\n'),
  b: "import { test, expect } from 'provino'\ntest('b', () => { expect('x').toMatch(/x/) })\n",
}

/** A native project's shape: one config, or `projects` of native sub-configs. */
type Layout = 'single' | 'projects'

/**
 * The dialect chunks of a build in `dist`, found by what they hold, not by what Rolldown named
 * them: the Jest and Vitest runtimes and leaves (`worker/jest-*.js`, `worker/vitest-runtime.js`),
 * every chunk that defines a dialect's value or its config reader (a `$N` suffix allowed, which
 * Rolldown adds when two modules of a chunk share a name), and the facades that import only those.
 */
const dialectChunks = memoize((dist: string): ReadonlySet<string> => {
  const sources = builtSources(dist)
  const found = chunkFiles(
    sources,
    /\bconst (?:jestDialect|vitestDialect|jestNodeDialect|vitestNodeDialect)(?:\$\d+)? =/,
  )
  for (const [path, source] of sources) {
    if (/^worker\/(?:jest-|vitest-runtime)/.test(path)) found.add(path)
    // Since B27f (D187) the dialects are add-ons: a chunk that imports one is dialect code too
    // (`provino jest`'s and `provino vitest`'s commands, `provino/jest`, `provino/vitest`).
    const requests = moduleRequests(path, source)
    if (
      requests.some(({ specifier }) => /^@provino\/dialect-(?:jest|vitest)(?:\/|$)/.test(specifier))
    )
      found.add(path)
  }
  return found
})

/** `fn` with one result per argument, so a test that asks again reads the first run. */
function memoize<Value>(fn: (key: string) => Value): (key: string) => Value {
  const seen = new Map<string, Value>()
  return (key) => {
    if (!seen.has(key)) seen.set(key, fn(key))
    return seen.get(key) as Value
  }
}

/** The native project laid out as `layout`, with `node_modules/provino` linked to `pkg`. */
async function nativeProject(pkg: string, layout: Layout): Promise<string> {
  const files =
    layout === 'single'
      ? { 'tests/a.test.ts': NATIVE_FILES.a, 'tests/b.test.ts': NATIVE_FILES.b }
      : {
          'packages/one/provino.config.ts': NATIVE_FILES.config,
          'packages/one/tests/a.test.ts': NATIVE_FILES.a,
          'packages/two/provino.config.ts': NATIVE_FILES.config,
          'packages/two/tests/b.test.ts': NATIVE_FILES.b,
        }
  const project = await makeProject(
    { 'package.json': '{"type":"module"}\n', ...files },
    layout === 'single' ? NATIVE_FILES.config : "export default { projects: ['packages/*'] }\n",
  )
  whenFileEnds(project.cleanup)
  // Bare `provino` finds the config by name; makeProject writes `provino.config.mjs`.
  linkProvino(project.dir, pkg)
  return project.dir
}

/** Runs `pkg`'s built bin (bare `provino`: the config is found) on a native project and reads what each process loaded. */
const recordedRun = memoize((key: string): Promise<readonly LoadLog[]> => {
  const [pkg = '', pool = 'forks', layout = 'single'] = key.split('|')
  return (async () => {
    const dir = await nativeProject(pkg, layout as Layout)
    const logs = mkdtempSync(join(tmpdir(), 'provino-native-loads-'))
    whenFileEnds(() => rmSync(logs, { recursive: true, force: true }))
    const run = runBuilt(['--pool', pool], {
      cwd: dir,
      bin: join(pkg, 'dist', 'cli.js'),
      preloads: ['load-recorder'],
      env: { PROVINO_LOAD_LOG: logs },
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stderr, new RegExp(`Tests:\\s+${TESTS} passed, ${TESTS} total`))
    return readLoadLogs(logs)
  })()
})

/** The run of `pkg` with `pool` and `layout` (one per combination for the whole file). */
const runOf = (pkg: string, pool: 'forks' | 'threads', layout: Layout = 'single') =>
  recordedRun([pkg, pool, layout].join('|'))

/** The `file:` paths a process loaded. */
const pathsOf = ({ urls }: LoadLog): readonly string[] =>
  urls.filter((url) => url.startsWith('file:')).map((url) => fileURLToPath(url))

/** What a run loaded that row 8 forbids: banned packages' files and dialect chunks of `pkg`. */
function forbidden(pkg: string, processes: readonly LoadLog[]): string[] {
  const dist = join(pkg, 'dist') + sep
  const chunks = dialectChunks(join(pkg, 'dist'))
  const out = new Set<string>()
  for (const log of processes) {
    for (const path of pathsOf(log)) {
      const posixPath = path.split(sep).join('/')
      if (BANNED.test(posixPath)) out.add(posixPath)
      for (const addOn of Object.values(ADD_ON_DISTS))
        if (path.startsWith(addOn + sep)) out.add(`add-on file: ${posixPath}`)
      if (path.startsWith(dist) && chunks.has(path.slice(dist.length).split(sep).join('/'))) {
        out.add(`dialect chunk: ${path.slice(dist.length).split(sep).join('/')}`)
      }
    }
  }
  return [...out].sort()
}

/** The worker-only files of `pkg`'s `dist` the processes loaded: `worker/*` but the behaviours leaf, `internal/*`, `lazy-api.js`. */
function workerOnly(pkg: string, processes: readonly LoadLog[]): string[] {
  const dist = join(pkg, 'dist') + sep
  const out = new Set<string>()
  for (const log of processes) {
    for (const path of pathsOf(log)) {
      if (!path.startsWith(dist)) continue
      const file = path.slice(dist.length).split(sep).join('/')
      if (/^(?:worker\/(?!policy-behaviours\.js$)|internal\/|lazy-api\.js$)/.test(file))
        out.add(file)
    }
  }
  return [...out].sort()
}

/** A copy of the built package (`dist`, `package.json`, its `node_modules` linked) with `plant` prepended to `file`. */
function plantedCopy(file: string, plant: string): string {
  const copy = packageCopy()
  const path = join(copy, 'dist', file)
  const source = readFileSync(path, 'utf8')
  // After a shebang line, which must stay first.
  const at = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0
  writeFileSync(path, `${source.slice(0, at)}${plant}\n${source.slice(at)}`)
  return copy
}

describe('a native run loads nothing from Jest or Vitest (B27e, row 8)', () => {
  test('the ban list is the manifest native set, every family in it', () => {
    for (const path of [
      'node_modules/jest-util/x.js',
      'node_modules/@jest/get-type/x.js',
      'node_modules/expect/x.js',
      'node_modules/pretty-format/x.js',
      'node_modules/chai/x.js',
      'node_modules/@vitest/expect/x.js',
      'node_modules/vite/x.js',
      'node_modules/@babel/core/x.js',
    ]) {
      assert.match(path, BANNED)
    }
    assert.doesNotMatch('node_modules/expect-type/x.js', BANNED)
  })

  test('the dialect chunks are found in the build', () => {
    const chunks = dialectChunks(join(PACKAGE, 'dist'))
    // The chunks that import an add-on (B27f, D187): the two commands and the two re-exports.
    for (const wanted of ['jest.js', 'vitest.js', 'jest-node.js', 'vitest-node.js']) {
      assert.ok(chunks.has(wanted), `${wanted}: ${[...chunks].join(', ')}`)
    }
    // The coordinator's own chunk holds no dialect value, and no chunk inlines one: each is its
    // add-on's, whose own build defines it (the control).
    assert.ok(!chunks.has('coordinator.js'), [...chunks].join(', '))
    assert.ok(!chunks.has('shared.js'), [...chunks].join(', '))
    for (const [path, source] of builtSources(join(PACKAGE, 'dist')))
      assert.doesNotMatch(source, /\bconst (?:jestDialect|vitestDialect)(?:\$\d+)? =/, path)
    for (const dist of Object.values(ADD_ON_DISTS)) assert.ok(dialectChunks(dist).size > 0, dist)
  })

  for (const pool of ['forks', 'threads'] as const) {
    test(`--pool ${pool}: no banned package or dialect chunk in the coordinator or any worker`, async () => {
      const processes = await runOf(PACKAGE, pool)
      assert.ok(
        processes.some(({ main }) => main.endsWith(`dist${sep}cli.js`)),
        'the coordinator was not recorded',
      )
      // Threads run in the coordinator's process: its record holds the workers' loads too.
      assert.ok(
        processes.some((log) => pathsOf(log).some((path) => path.endsWith(`worker${sep}api.js`))),
        'no process loaded the native runtime (worker/api.js)',
      )
      assert.deepEqual(forbidden(PACKAGE, processes), [])
    })
  }

  test("projects: ['packages/*'] of native sub-configs loads no dialect either", async () => {
    assert.deepEqual(forbidden(PACKAGE, await runOf(PACKAGE, 'forks', 'projects')), [])
  })

  test('a native worker starts with at most 10 files from the package', async () => {
    const dist = join(PACKAGE, 'dist') + sep
    const workers = (await runOf(PACKAGE, 'forks')).filter(({ main }) =>
      main.endsWith(`worker${sep}bootstrap.js`),
    )
    assert.ok(workers.length >= 1, 'no worker process was recorded')
    for (const log of workers) {
      const own = new Set(pathsOf(log).filter((path) => path.startsWith(dist)))
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

  test("the coordinator of a native run loads none of the worker's own files", async () => {
    // B27f's design round: the engine the add-ons import (`internal/*`) must not pull worker-only
    // code into what the coordinator loads. Its files are the bin's, `coordinator.js`, `shared.js`,
    // `loading.js` and the behaviours leaf; never `worker/main.js`, the native runtime or `internal/*`.
    const coordinators = (await runOf(PACKAGE, 'forks')).filter(({ main }) =>
      main.endsWith(`dist${sep}cli.js`),
    )
    assert.equal(coordinators.length, 1)
    assert.deepEqual(workerOnly(PACKAGE, coordinators), [])
    // The control: a bin that imports the worker's entry is caught.
    const copy = plantedCopy('cli.js', "import './worker/main.js'")
    const planted = (await runOf(copy, 'forks')).filter(({ main }) =>
      main.endsWith(`dist${sep}cli.js`),
    )
    assert.ok(workerOnly(copy, planted).includes('worker/main.js'), 'the plant was not caught')
  })

  test("a planted import 'jest-junit' in @provino/api's built entry is caught", async () => {
    // `jest-junit` (a dev dependency here): since B27f no runtime dependency of `provino` is on the
    // list, so the plant names one its linked `node_modules` still resolves.
    const copy = plantedCopy(join('worker', 'api.js'), "import 'jest-junit'")
    const found = forbidden(copy, await runOf(copy, 'forks'))
    assert.ok(
      found.some((path) => /\/node_modules\/jest-junit\//.test(path)),
      `the plant was not caught: ${found.join(', ')}`,
    )
  })

  test("a planted import of the Jest dialect's chunk in the bin is caught as a dialect chunk", async () => {
    // In the bin's entry, not `coordinator.js`: `jest-node.js` imports `coordinator.js`, so a
    // static import there is a cycle that fails the run before anything is recorded.
    const copy = plantedCopy('cli.js', "import './jest-node.js'")
    const found = forbidden(copy, await runOf(copy, 'forks'))
    assert.ok(
      found.includes('dialect chunk: jest-node.js'),
      `the plant was not caught: ${found.join(', ')}`,
    )
  })
})
