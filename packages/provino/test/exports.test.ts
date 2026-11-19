// T1.10 on the built package: what `exports` lets a user import, that the rest is refused, the
// bin, and what a worker loads when it starts. Every check runs the package as a user gets it
// (`dist/`, with no `provino-source` condition), so `pnpm test` builds it first (turbo.json).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { childEnv, runBuilt, trackedProjects } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
  readonly version: string
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly bin: Readonly<Record<string, string>>
  readonly publishConfig: { readonly bin: Readonly<Record<string, string>> }
}

/** Runs `code` as an ES module (or CommonJS) in the package directory, with no `provino-source` condition. */
function inPackage(
  code: string,
  env: NodeJS.ProcessEnv = {},
  inputType: 'module' | 'commonjs' = 'module',
) {
  const result = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', code], {
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

/** What each subpath of `SUBPATHS` exports, by the specifier a user imports it with. */
const EXPORTED_NAMES: Readonly<Record<string, readonly string[]>> = {
  provino: [
    'LazyError',
    'ProvinoWorkerApiError',
    'afterAll',
    'afterEach',
    'beforeAll',
    'beforeEach',
    'describe',
    'evaluatedLazies',
    'expect',
    'includeContext',
    'includeExamples',
    'it',
    'itBehavesLike',
    'lazy',
    'sharedContext',
    'sharedExamples',
    'test',
  ],
  'provino/globals': [],
  'provino/config': ['ConfigError', 'formatConfigIssue'],
  'provino/node': ['run'],
  'provino/reporters': [
    'AGENT_VARIABLES',
    'agentReporter',
    'createStyle',
    'defaultReporter',
    'defineReporter',
    'detectOutput',
    'dotReporter',
    'githubActionsReporter',
    'jsonReporter',
    'junitReporter',
    'normalizedJsonReporter',
    'verboseReporter',
  ],
  'provino/environment': [
    'JsdomEnvironmentError',
    'NodeEnvironmentError',
    'defineEnvironment',
    'jsdomEnvironment',
    'nodeEnvironment',
  ],
  'provino/jest': ['jestDialect', 'jestPolicy'],
}

/**
 * Loads every specifier of `EXPORTED_NAMES` in a child with `loadExpr` (an expression over the
 * specifier `s`) and checks each one's export names against the table, which names every subpath.
 */
function assertExports(loadExpr: string, inputType: 'module' | 'commonjs'): void {
  assert.deepEqual(
    Object.keys(EXPORTED_NAMES).toSorted(),
    SUBPATHS.map((subpath) => `provino${subpath.slice(1)}`).toSorted(),
    'the table names every subpath a user imports',
  )
  const { status, stdout, stderr } = inPackage(
    `const out = {}
     for (const s of ${JSON.stringify(Object.keys(EXPORTED_NAMES))}) out[s] = Object.keys(${loadExpr}).sort()
     console.log(JSON.stringify(out))`,
    {},
    inputType,
  )
  assert.equal(status, 0, stderr)
  const got = JSON.parse(stdout) as Record<string, string[]>
  for (const [specifier, names] of Object.entries(EXPORTED_NAMES)) {
    assert.deepEqual(got[specifier], [...names].sort(), specifier)
  }
}

describe('the umbrella exports (T1.10)', () => {
  test('every subpath but /package.json is source, types, import and default, in that order', () => {
    assert.ok(SUBPATHS.includes('.') && SUBPATHS.includes('./jest'), SUBPATHS.join(', '))
    assert.deepEqual(Object.keys(manifest.exports), [...SUBPATHS, './package.json'])
    for (const subpath of SUBPATHS) {
      const conditions = manifest.exports[subpath] ?? {}
      assert.deepEqual(
        Object.keys(conditions),
        ['provino-source', 'types', 'import', 'default'],
        subpath,
      )
      // `default` is the same file, so a lookup under CommonJS conditions finds it: a test file Jest
      // runs as CommonJS resolves `import 'provino'` under `require` (`module.edgeResolveKind`).
      assert.equal(conditions.default, conditions.import, subpath)
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
    assertExports('await import(s)', 'module')
  })

  test('each subpath loads with require() under plain Node: no entry has top-level await', () => {
    // `default` sends a CommonJS lookup to the ES module, which Node loads with `require(esm)`; a
    // top-level await anywhere in an entry's graph would throw ERR_REQUIRE_ASYNC_MODULE here.
    assertExports('require(s)', 'commonjs')
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

describe("`import 'provino'` alone", () => {
  test('statically imports no engine chunk: dist/index.js reaches only the lazy-api leaf', () => {
    const source = readFileSync(join(PACKAGE, 'dist', 'index.js'), 'utf8')
    const imports = [...source.matchAll(/^import [^\n]*? from "([^"]+)"/gm)].map((m) => m[1])
    assert.deepEqual(imports, ['./lazy-api.js'])
    assert.doesNotMatch(source, /import\(/)
  })

  test('loads dist/index.js and the lazy-api leaf, not shared.js, loading.js or the coordinator', async () => {
    const logs = await mkdtemp(join(tmpdir(), 'provino-loads-'))
    after(() => rm(logs, { recursive: true, force: true }))
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('provino')"],
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
      .filter((url) => url.includes('/dist/'))
    assert.ok(
      loaded.some((url) => url.endsWith('/dist/index.js')),
      loaded.join('\n'),
    )
    assert.deepEqual(
      loaded.filter(
        (url) => /\/dist\/(?:shared|loading|coordinator)\.js/.test(url) || isWatchFile(url),
      ),
      [],
    )
  })
})

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

/** Every built file (the chunks, the entries and the worker's), by path relative to `dist/`. */
function builtSources(): Map<string, string> {
  const dist = join(PACKAGE, 'dist')
  const sources = new Map<string, string>()
  for (const dir of ['', 'worker']) {
    for (const file of readdirSync(join(dist, dir)).filter((name) => name.endsWith('.js'))) {
      const path = dir === '' ? file : `${dir}/${file}`
      sources.set(path, readFileSync(join(dist, path), 'utf8'))
    }
  }
  return sources
}

/** The built files `source` (at `from`) imports with a static `import`/`export … from`, multiline included. */
function staticImports(from: string, source: string): string[] {
  const targets = [
    ...source.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["'](\.{1,2}\/[^"']+)["']/g),
  ].map((match) => match[1] ?? '')
  return targets.map((target) => posix.normalize(posix.join(posix.dirname(from), target)))
}

/** The built files `source` reaches with a dynamic `import("./…")`. */
function dynamicImports(from: string, source: string): string[] {
  return [...source.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)].map((match) =>
    posix.normalize(posix.join(posix.dirname(from), match[1] ?? '')),
  )
}

/**
 * The built files that are watch mode, found by what they hold, not by what Rolldown named them:
 * the files with Jest's watch loop (`startJestWatch`) or Node's file watcher (`watch` imported from
 * `node:fs`), then any file that imports only files already in the set (the driver's stub).
 */
function watchFiles(sources: ReadonlyMap<string, string>): Set<string> {
  const found = new Set<string>()
  for (const [path, source] of sources) {
    if (
      /\bfunction startJestWatch\b|\bstartJestWatch\s*=/.test(source) ||
      /\bimport\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*["']node:fs["']/.test(source)
    ) {
      found.add(path)
    }
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const [path, source] of sources) {
      const imports = staticImports(path, source)
      if (!found.has(path) && imports.length > 0 && imports.every((file) => found.has(file))) {
        found.add(path)
        grew = true
      }
    }
  }
  return found
}

/** Whether a loaded URL is one of the built watch files (found by content). */
const isWatchFile = (url: string): boolean => {
  const dist = `${join(PACKAGE, 'dist')}/`
  const path = url.startsWith('file://') ? fileURLToPath(url) : url
  return path.startsWith(dist) && watchFiles(builtSources()).has(path.slice(dist.length))
}

describe('watch mode is its own chunk (B23f)', () => {
  test('the loop and the file watcher are in built files of their own', () => {
    const watch = watchFiles(builtSources())
    assert.ok(watch.size >= 1 && watch.size <= 3, [...watch].join(', '))
    assert.ok(!watch.has('cli.js') && !watch.has('index.js'), [...watch].join(', '))
    assert.ok(![...watch].some((file) => file.startsWith('worker/')), [...watch].join(', '))
  })

  test('no file outside it imports one of its files statically, in the bin, a chunk or a worker', () => {
    const sources = builtSources()
    const watch = watchFiles(sources)
    for (const [path, source] of sources) {
      if (watch.has(path)) continue
      assert.deepEqual(
        staticImports(path, source).filter((file) => watch.has(file)),
        [],
        path,
      )
    }
  })

  test('exactly one dynamic import reaches it, and it is in a file the bin loads', () => {
    const sources = builtSources()
    const watch = watchFiles(sources)
    const reaching = [...sources]
      .filter(([path]) => !watch.has(path))
      .flatMap(([path, source]) =>
        dynamicImports(path, source)
          .filter((file) => watch.has(file))
          .map(() => path),
      )
    assert.equal(reaching.length, 1, reaching.join(', '))
    // The bin's graph without watch mode: `cli.js` and what it imports, statically or dynamically
    // (the light bin imports the rest of itself dynamically), however many hops.
    const bin = new Set(['cli.js'])
    for (const file of bin) {
      const source = sources.get(file) ?? ''
      for (const next of [...staticImports(file, source), ...dynamicImports(file, source)]) {
        if (!watch.has(next)) bin.add(next)
      }
    }
    assert.ok(bin.has(reaching[0] ?? ''), `${reaching[0]} is not reached from the bin`)
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
    // A run without --watch, in the bin and in every worker, loads no watch chunk (B23f).
    const everything = readdirSync(logs).flatMap((file) =>
      readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean),
    )
    assert.deepEqual(everything.map((line) => line.split('\t')[1] ?? '').filter(isWatchFile), [])
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

describe('the coordinator without coverage (T1.10, T7.12)', () => {
  /** The `@provino/coverage` source files the coordinator process of a source run loaded. */
  async function coverageLoaded(args: readonly string[]): Promise<readonly string[]> {
    const dir = await builtProject()
    const logs = await mkdtemp(join(tmpdir(), 'provino-loads-'))
    after(() => rm(logs, { recursive: true, force: true }))
    const bin = join(PACKAGE, 'src', 'cli.ts')
    const result = spawnSync(
      process.execPath,
      ['--conditions=provino-source', bin, 'jest', '--ci', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        env: childEnv(['load-recorder'], { PROVINO_LOAD_LOG: logs }),
        timeout: 120_000,
      },
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    return readdirSync(logs)
      .flatMap((file) => readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean))
      .map((line) => line.split('\t'))
      .filter(([main]) => main === bin)
      .map(([, url]) => url ?? '')
      .filter((url) => url.includes('/packages/coverage/src/'))
  }

  test('a run with coverage off loads no module of @provino/coverage (its /node entry included)', async () => {
    assert.deepEqual(await coverageLoaded([]), [])
  })

  test('a run with --coverage loads @provino/coverage/node (the control)', async () => {
    const loaded = await coverageLoaded(['--coverage', '--coverageReporters=text-summary'])
    assert.ok(
      loaded.some((url) => url.endsWith('/packages/coverage/src/node/index.ts')),
      loaded.join('\n'),
    )
  })
})

/**
 * The built files of the `provino` reporter (B26), found by what they hold: the file that defines
 * `provinoReporter`, then any file that imports only files already in the set (the dynamic
 * import's facade).
 */
function liveFiles(sources: ReadonlyMap<string, string>): Set<string> {
  return chunkFiles(sources, /\bfunction provinoReporter\(/)
}

/** The HTML report's built files (B26 Phase 5): the file that defines `htmlReporter`, and its facade. */
function htmlFiles(sources: ReadonlyMap<string, string>): Set<string> {
  return chunkFiles(sources, /\bfunction htmlReporter\(/)
}

/** The files that define something `defines` finds, then any file that imports only files already in the set. */
function chunkFiles(sources: ReadonlyMap<string, string>, defines: RegExp): Set<string> {
  const found = new Set<string>()
  for (const [path, source] of sources) {
    if (defines.test(source)) found.add(path)
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const [path, source] of sources) {
      const imports = staticImports(path, source)
      if (!found.has(path) && imports.length > 0 && imports.every((file) => found.has(file))) {
        found.add(path)
        grew = true
      }
    }
  }
  return found
}

/** The `provino` reporter's files and the HTML report's among `loaded` URLs. */
function reporterChunksIn(loaded: readonly string[]): { live: string[]; html: string[] } {
  const dist = `${join(PACKAGE, 'dist')}/`
  const sources = builtSources()
  const live = liveFiles(sources)
  const html = htmlFiles(sources)
  const paths = loaded
    .filter((url) => url.startsWith('file://'))
    .map((url) => fileURLToPath(url))
    .filter((path) => path.startsWith(dist))
    .map((path) => path.slice(dist.length))
  return {
    live: paths.filter((path) => live.has(path)),
    html: paths.filter((path) => html.has(path)),
  }
}

describe('the provino reporter is its own chunk (B26)', () => {
  test('no file outside it imports one of its files statically; one dynamic import reaches it', () => {
    const sources = builtSources()
    const live = liveFiles(sources)
    assert.ok(live.size >= 1 && live.size <= 2, [...live].join(', '))
    assert.ok(![...live].some((file) => file.startsWith('worker/')), [...live].join(', '))
    const reaching: string[] = []
    for (const [path, source] of sources) {
      if (live.has(path)) continue
      assert.deepEqual(
        staticImports(path, source).filter((file) => live.has(file)),
        [],
        path,
      )
      if (dynamicImports(path, source).some((file) => live.has(file))) reaching.push(path)
    }
    assert.deepEqual(reaching, ['coordinator.js'])
  })

  test('--reporter agent loads neither chunk anywhere; provino loads live and html loads html, in the coordinator only, never the other', async () => {
    const dir = await builtProject()
    writeFileSync(
      join(dir, 'provino.config.mjs'),
      "export default { dialect: 'jest', testMatch: ['**/*.test.js'] }\n",
    )
    for (const [reporter, wantLive, wantHtml] of [
      ['agent', false, false],
      ['provino', true, false],
      ['html', false, true],
    ] as const) {
      const logs = await mkdtemp(join(tmpdir(), 'provino-loads-'))
      after(() => rm(logs, { recursive: true, force: true }))
      const run = runBuilt(
        ['run', '--config', 'provino.config.mjs', '--reporter', reporter, '--no-cache'],
        { cwd: dir, preloads: ['load-recorder'], env: { PROVINO_LOAD_LOG: logs } },
      )
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
      let workers = 0
      let coordinatorLive = 0
      let coordinatorHtml = 0
      for (const file of readdirSync(logs)) {
        const lines = readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean)
        const found = reporterChunksIn(lines.map((line) => line.split('\t')[1] ?? ''))
        if (lines[0]?.split('\t')[0]?.endsWith('worker/bootstrap.js')) {
          workers++
          assert.deepEqual(found.live, [], `a worker loaded ${found.live.join(', ')}`)
          assert.deepEqual(found.html, [], `a worker loaded ${found.html.join(', ')}`)
        } else {
          coordinatorLive += found.live.length
          coordinatorHtml += found.html.length
        }
      }
      assert.ok(workers >= 1, 'no worker process was recorded')
      if (wantLive) assert.ok(coordinatorLive >= 1, 'the coordinator loaded no live chunk')
      else assert.equal(coordinatorLive, 0, `--reporter ${reporter} loaded the live chunk`)
      if (wantHtml) assert.ok(coordinatorHtml >= 1, 'the coordinator loaded no html chunk')
      else assert.equal(coordinatorHtml, 0, `--reporter ${reporter} loaded the html chunk`)
    }
  })
})

describe('the html reporter is its own chunk, and its page runs from the build (B26 Phase 5)', () => {
  test('no file outside it imports one of its files statically; one dynamic import reaches it', () => {
    const sources = builtSources()
    const html = htmlFiles(sources)
    const live = liveFiles(sources)
    assert.ok(html.size >= 1 && html.size <= 2, [...html].join(', '))
    assert.ok(![...html].some((file) => file.startsWith('worker/')), [...html].join(', '))
    assert.deepEqual(
      [...html].filter((file) => live.has(file)),
      [],
      'html and live are separate chunks',
    )
    const reaching: string[] = []
    for (const [path, source] of sources) {
      if (html.has(path)) continue
      assert.deepEqual(
        staticImports(path, source).filter((file) => html.has(file)),
        [],
        path,
      )
      if (dynamicImports(path, source).some((file) => html.has(file))) reaching.push(path)
    }
    assert.deepEqual(reaching, ['coordinator.js'])
  })

  test('the page the built bin writes is one file whose script closes over nothing', async () => {
    const dir = await builtProject()
    writeFileSync(
      join(dir, 'provino.config.mjs'),
      "export default { dialect: 'jest', testMatch: ['**/*.test.js'] }\n",
    )
    writeFileSync(
      join(dir, 'd.test.js'),
      "test('a failure', () => { expect(1).toBe(2) })\ntest.skip('skipped', () => {})\n",
    )
    const out = join(dir, 'report', 'index.html')
    const run = runBuilt(
      [
        'run',
        '--config',
        'provino.config.mjs',
        '--reporter',
        'html',
        '--outputFile',
        out,
        '--no-cache',
      ],
      { cwd: dir },
    )
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`)
    assert.equal(run.stdout, '')
    const page = readFileSync(out, 'utf8')
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
    const json = /<script type="application\/json" id="provino-data">([\s\S]*?)<\/script>/.exec(
      page,
    )?.[1]
    assert.ok(script !== undefined && json !== undefined)
    // One file that makes no request: the document, apart from the run's own text (a failure's
    // message may hold a `//` or a URL).
    const markup = page.replace(json, '')
    assert.doesNotMatch(markup, /https?:/i)
    assert.equal(markup.includes('//'), false)
    assert.doesNotMatch(markup, /<(?:link|img|iframe|object|embed|base)\b|\s(?:src|href)\s*=/i)
    const hash = createHash('sha256').update(script).digest('base64')
    assert.ok(page.includes(`script-src 'sha256-${hash}'`), 'the CSP names the script it holds')
    // The script runs where nothing but its own parameter exists: a DOM that answers every call
    // with itself, and the listeners it is given called once each (the tabs' clicks build the
    // other three views). A name it closed over in the source, which the build may have moved or
    // renamed, would be a ReferenceError here.
    const listeners: ((event: unknown) => void)[] = []
    const dom: unknown = new Proxy(() => {}, {
      get(_target, key) {
        if (key === Symbol.toPrimitive) return () => ''
        if (key === Symbol.iterator) return function* () {}
        if (key === 'addEventListener') {
          return (_type: string, listener: (event: unknown) => void) => listeners.push(listener)
        }
        return dom
      },
      apply: () => dom,
      construct: () => dom as object,
      set: () => true,
    })
    const document = {
      getElementById: (id: string) => (id === 'provino-data' ? { textContent: json } : dom),
      createElement: () => dom,
      createElementNS: () => dom,
    }
    runInNewContext(script, { document, setTimeout: () => 0, clearTimeout: () => {} })
    assert.ok(listeners.length >= 4, `the page registered ${listeners.length} listeners`)
    for (const listener of listeners) listener(dom)
  })
})
