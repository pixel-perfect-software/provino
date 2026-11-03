import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { buildGraph, GRAPH, GRAPH_SIZE, simulate } from './generators/graph.ts'
import { BIG_RECORD_COUNT } from './generators/isolate-heavy.ts'
import type { Flavour, GeneratedFile } from './generators/render.ts'
import { code, scratch } from './internal/test-helpers.ts'
import {
  buildSuite,
  expectedTests,
  PACKAGE_DIR,
  parseSuiteName,
  planRunner,
  type SuiteSpec,
  toSubjectSpec,
  writeSuite,
} from './suites.ts'

function suite(name: string): SuiteSpec {
  return parseSuiteName(name)
}

function file(files: readonly GeneratedFile[], path: string): string {
  const found = files.find((candidate) => candidate.path === path)
  assert.ok(found, `${path} was not generated`)
  return found.contents
}

function under(files: readonly GeneratedFile[], prefix: string): GeneratedFile[] {
  return files.filter((candidate) => candidate.path.startsWith(prefix))
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

// A test file is its header (imports and mocks), which differs by flavour, then the `describe`
// block, which must be the same bytes in both.
function body(source: string): string {
  return source.slice(source.indexOf('describe('))
}

test('suite names parse to a shape and an expected test count', () => {
  assert.deepEqual(suite('app-500'), { name: 'app-500', kind: 'app', files: 500, testsPerFile: 8 })
  assert.deepEqual(suite('mock-heavy-500'), {
    name: 'mock-heavy-500',
    kind: 'mock-heavy',
    files: 500,
    testsPerFile: 4,
  })
  assert.deepEqual(suite('isolate-heavy'), {
    name: 'isolate-heavy',
    kind: 'isolate-heavy',
    files: 30,
    testsPerFile: 3,
  })
  assert.equal(expectedTests(suite('app-500')), 4000)
  assert.equal(expectedTests(suite('mock-heavy-500')), 2000)
  assert.equal(expectedTests(suite('isolate-heavy')), 90)
  assert.equal(suite('app-9999').files, 9999)
  assert.equal(suite('mock-heavy-9999').files, 9999)
})

test('names that are not a suite are rejected with a stable code', () => {
  for (const name of [
    '',
    'app',
    'app-',
    'app-0',
    'app-05',
    'app-10000',
    'mock-heavy-10000',
    'app-1.5',
    'app--1',
    'App-5',
    'mock-heavy',
    'isolate-heavy-3',
    'jsdom-5',
    'app-5 ',
  ]) {
    assert.throws(() => parseSuiteName(name), code('BENCH_UNKNOWN_SUITE'), JSON.stringify(name))
  }
})

test('generation is deterministic: building twice gives identical bytes', () => {
  for (const name of ['app-3', 'mock-heavy-3', 'isolate-heavy']) {
    const first = buildSuite(suite(name))
    const second = buildSuite(suite(name))
    assert.equal(first.length, second.length)
    for (const [index, generated] of first.entries()) {
      assert.equal(generated.path, second[index]?.path)
      assert.ok(
        generated.contents === second[index]?.contents,
        `${name}: ${generated.path} differs`,
      )
    }
  }
})

test('writing a suite twice leaves every file untouched the second time', async (t) => {
  const root = await scratch(t, 'bench-suite-')
  const spec = suite('app-3')
  const first = await writeSuite(spec, root)
  assert.equal(first.unchanged, 0)
  assert.equal(first.removed, 0)
  const probe = join(root, 'app-3', 'jest', 'tests', 'app-0001.test.js')
  const before = await stat(probe)
  const bytes = await readFile(probe)
  const second = await writeSuite(spec, root)
  assert.equal(second.written, 0)
  assert.equal(second.removed, 0)
  assert.equal(second.unchanged, first.written)
  assert.equal((await stat(probe)).mtimeMs, before.mtimeMs)
  assert.ok((await readFile(probe)).equals(bytes))
})

test('regenerating repairs edited files, removes stale ones, and leaves .cache alone', async (t) => {
  const root = await scratch(t, 'bench-suite-')
  const spec = suite('app-3')
  await writeSuite(spec, root)
  const dir = join(root, 'app-3')
  const edited = join(dir, 'vitest', 'tests', 'app-0000.test.js')
  const original = await readFile(edited, 'utf8')
  await writeFile(edited, 'broken\n')
  const stale = join(dir, 'jest', 'tests', 'app-0099.test.js')
  await writeFile(stale, 'stale\n')
  await mkdir(join(dir, '.cache', 'jest'), { recursive: true })
  await writeFile(join(dir, '.cache', 'jest', 'entry'), 'cached\n')
  const old = new Date('2020-01-01T00:00:00Z')
  await utimes(join(dir, 'jest', 'setup.js'), old, old)

  const summary = await writeSuite(spec, root)
  assert.equal(summary.written, 1)
  assert.equal(summary.removed, 1)
  assert.equal(await readFile(edited, 'utf8'), original)
  assert.equal(existsSync(stale), false)
  assert.equal(await readFile(join(dir, '.cache', 'jest', 'entry'), 'utf8'), 'cached\n')
  assert.equal((await stat(join(dir, 'jest', 'setup.js'))).mtime.getTime(), old.getTime())
})

test('the two flavours are one model: same files, same test bodies, different module syntax', () => {
  for (const name of ['app-3', 'mock-heavy-3', 'isolate-heavy']) {
    const files = buildSuite(suite(name))
    const jestTests = under(files, 'jest/tests/')
    const vitestTests = under(files, 'vitest/tests/')
    assert.ok(jestTests.length > 0)
    assert.deepEqual(
      jestTests.map((f) => f.path.replace('jest/', '')),
      vitestTests.map((f) => f.path.replace('vitest/', '')),
    )
    for (const [index, test] of jestTests.entries()) {
      const twin = vitestTests[index]
      assert.ok(twin)
      assert.ok(body(test.contents) === body(twin.contents), `${test.path}: bodies differ`)
      assert.match(test.contents, /require\(/)
      assert.doesNotMatch(test.contents, /^import /m)
      assert.match(twin.contents, /^import /m)
      assert.doesNotMatch(twin.contents, /require\(/)
    }
    // the same source files exist in both trees, apart from the config
    const sources = (dir: string): string[] =>
      under(files, `${dir}/src/`).map((f) => f.path.slice(dir.length))
    assert.deepEqual(sources('jest'), sources('vitest'))
  }
})

test('every suite ships the configs, with Jest’s setup hook spelled setupFilesAfterEnv', () => {
  const files = buildSuite(suite('app-2'))
  const jestConfig = JSON.parse(file(files, 'jest/jest.config.json'))
  assert.equal(jestConfig.testEnvironment, 'node')
  assert.deepEqual(jestConfig.setupFilesAfterEnv, ['<rootDir>/setup.js'])
  assert.equal(jestConfig.cacheDirectory, '<rootDir>/../.cache/jest')
  assert.equal('setupFilesAfterEach' in jestConfig, false)
  const vitestConfig = file(files, 'vitest/vitest.config.ts')
  assert.match(vitestConfig, /^export default \{/)
  assert.match(vitestConfig, /globals: true/)
  assert.match(vitestConfig, /setupFiles: \['\.\/setup\.js'\]/)
  assert.match(vitestConfig, /cacheDir: '\.\.\/\.cache\/vite'/)
  assert.doesNotMatch(vitestConfig, /import /)
  assert.equal(file(files, 'jest/provino.config.ts'), "export default { dialect: 'jest' }\n")
  assert.equal(JSON.parse(file(files, 'jest/package.json')).type, 'commonjs')
  assert.equal(JSON.parse(file(files, 'vitest/package.json')).type, 'module')
  assert.equal(file(files, 'jest/setup.js'), file(files, 'vitest/setup.js'))
  assert.match(file(files, 'jest/setup.js'), /expect\.extend\(\{\n {2}toBeWithinRange/)
})

test('app-N has N files of exactly 8 tests, over a 24-module graph', () => {
  const files = buildSuite(suite('app-3'))
  for (const flavour of ['jest', 'vitest']) {
    const tests = under(files, `${flavour}/tests/`)
    assert.equal(tests.length, 3)
    for (const generated of tests) {
      assert.equal(countMatches(generated.contents, /^\s+test\(/gm), 8, generated.path)
    }
    assert.equal(under(files, `${flavour}/src/graph/`).length, 24)
  }
  assert.equal(file(files, 'jest/tests/app-0000.test.js').includes('toBeWithinRange('), true)
})

test('mock-heavy-N mocks 3 graph modules per file with factories, using each flavour’s API', () => {
  const files = buildSuite(suite('mock-heavy-3'))
  const mockFactory = (tool: string): RegExp =>
    new RegExp(
      `^${tool}\\.mock\\('\\.\\./src/graph/(m\\d\\d)\\.js', \\(\\) => \\(\\{ name: '\\1', compute: ${tool}\\.fn\\(\\(\\) => \\d+\\) \\}\\)\\)$`,
      'gm',
    )
  for (const [flavour, tool] of [
    ['jest', 'jest'],
    ['vitest', 'vi'],
  ] as const) {
    const tests = under(files, `${flavour}/tests/`)
    assert.equal(tests.length, 3)
    for (const generated of tests) {
      assert.equal(countMatches(generated.contents, mockFactory(tool)), 3, generated.path)
      assert.equal(countMatches(generated.contents, new RegExp(`${tool}\\.mock\\(`, 'g')), 3)
      assert.equal(countMatches(generated.contents, /^\s+test\(/gm), 4)
      assert.doesNotMatch(generated.contents, /automock|importActual|requireActual/)
    }
    assert.equal(under(files, `${flavour}/src/consumers/`).length, 8)
  }
})

test('a mock-heavy mock is never a direct import of its consumer, so it applies transitively', () => {
  const files = buildSuite(suite('mock-heavy-8'))
  for (const generated of under(files, 'jest/tests/')) {
    const consumer = /src\/consumers\/(c\d)\.js/.exec(generated.contents)?.[1]
    assert.ok(consumer)
    const consumerSource = file(files, `jest/src/consumers/${consumer}.js`)
    const mocked = [
      ...generated.contents.matchAll(/^jest\.mock\('\.\.\/src\/graph\/(m\d\d)\.js'/gm),
    ]
    assert.equal(mocked.length, 3)
    for (const match of mocked) assert.ok(!consumerSource.includes(`${match[1]}.js`))
  }
})

test('isolate-heavy has 30 files that each import one module of about 2 MB', () => {
  const files = buildSuite(suite('isolate-heavy'))
  for (const flavour of ['jest', 'vitest']) {
    const tests = under(files, `${flavour}/tests/`)
    assert.equal(tests.length, 30)
    for (const generated of tests) {
      assert.equal(countMatches(generated.contents, /^\s+test\(/gm), 3)
      assert.equal(countMatches(generated.contents, /\.\.\/src\/big\.js/g), 1)
    }
    const bytes = Buffer.byteLength(file(files, `${flavour}/src/big.js`))
    assert.ok(bytes > 1_900_000 && bytes < 2_200_000, `big module is ${bytes} bytes`)
  }
  assert.equal(countMatches(file(files, 'jest/src/big.js'), /^ {2}\{ id: /gm), BIG_RECORD_COUNT)
})

test('the generated graph computes what the model says, in both flavours and any timezone', async (t) => {
  // The suite is written under a temp dir with a node_modules symlink to this package's, so the
  // generated modules can resolve zod, date-fns and lodash. Only the modules are loaded here;
  // no test runner starts.
  const root = await scratch(t, 'bench-suite-')
  await symlink(join(PACKAGE_DIR, 'node_modules'), join(root, 'node_modules'))
  const spec = suite('app-2')
  await writeSuite(spec, join(root, 'suites'))
  const dir = join(root, 'suites', 'app-2')

  const cjs = createRequire(join(dir, 'jest', 'package.json'))
  const loaded: Record<
    Flavour,
    (name: string) => Promise<{ compute(n: number, memo?: Map<string, number>): number }>
  > = {
    cjs: async (name) => cjs(`./src/graph/${name}.js`),
    esm: async (name) =>
      import(pathToFileURL(join(dir, 'vitest', 'src', 'graph', `${name}.js`)).href),
  }
  const originalTz = process.env.TZ
  t.after(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })
  for (const tz of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
    process.env.TZ = tz
    for (const flavour of ['cjs', 'esm'] as const) {
      for (const node of GRAPH) {
        const module = await loaded[flavour](node.name)
        for (const n of [0, 1, 7, 40]) {
          const memo = new Map<string, number>()
          const expected = simulate([node.index], n)
          assert.equal(
            module.compute(n, memo),
            expected.total,
            `${flavour} ${node.name} n=${n} ${tz}`,
          )
          assert.equal(memo.size, expected.visited)
        }
      }
    }
  }
})

test('the graph has 24 modules, each depending only on lower ones, built from all three libraries', () => {
  assert.equal(GRAPH.length, GRAPH_SIZE)
  assert.equal(GRAPH_SIZE, 24)
  assert.deepEqual(buildGraph(), GRAPH)
  assert.deepEqual(new Set(GRAPH.map((node) => node.kind)), new Set(['zod', 'date', 'collection']))
  for (const node of GRAPH) {
    assert.ok(
      node.deps.every((dep) => dep < node.index),
      `${node.name} depends on a higher module`,
    )
    if (node.index > 0) assert.ok(node.deps.includes(node.index - 1))
    assert.ok(node.weight >= 1 && node.weight <= 9)
  }
  // every module reaches all the ones below it, so the top one runs all 24
  assert.equal(simulate([23], 1).visited, 24)
  // a mock cuts off what is only reachable through it
  const mocked = simulate([23], 1, new Map([[22, 5]]))
  assert.ok(mocked.visited < 24)
  assert.ok((mocked.calls.get(22) ?? 0) > 0)
  assert.equal(simulate([0], 4).total, (GRAPH[0]?.weight ?? 0) * 4)
})

test('the runner plans carry the commands, caches and compile-cache env from the brief', () => {
  const spec = suite('app-5')
  const jest = planRunner(spec, 'jest')
  assert.equal(jest.argv[0], process.execPath)
  assert.ok(jest.argv[1]?.endsWith('jest.js'))
  assert.deepEqual(jest.argv.slice(2), ['--ci', '--config', 'jest.config.json'])
  assert.ok(jest.cwd.endsWith('/.suites/app-5/jest'))
  assert.ok(jest.env.NODE_COMPILE_CACHE?.endsWith('/.suites/app-5/.cache/node-jest'))
  assert.deepEqual(
    jest.caches.map((cache) => [cache.kind, cache.path.split('.suites/app-5/')[1]]),
    [
      ['jest', '.cache/jest'],
      ['node-compile', '.cache/node-jest'],
    ],
  )
  assert.equal(
    jest.command,
    'cd packages/bench/.suites/app-5/jest && NODE_COMPILE_CACHE=../.cache/node-jest node ../../../node_modules/jest/bin/jest.js --ci --config jest.config.json',
  )
  assert.equal(jest.configPath, 'packages/bench/.suites/app-5/jest/jest.config.json')

  const vitest = planRunner(spec, 'vitest', { extraArgs: ['--reporter=json'] })
  assert.ok(vitest.cwd.endsWith('/.suites/app-5/vitest'))
  assert.deepEqual(vitest.argv.slice(2), ['run', '--config', 'vitest.config.ts', '--reporter=json'])
  assert.deepEqual(
    vitest.caches.map((cache) => cache.kind),
    ['vite', 'node-compile'],
  )
  assert.ok(vitest.env.NODE_COMPILE_CACHE?.endsWith('/.cache/node-vitest'))
})

test('runners resolve to real bin scripts, not .bin shims', () => {
  for (const runner of ['jest', 'vitest'] as const) {
    const plan = planRunner(suite('app-1'), runner)
    const bin = plan.argv[1] ?? ''
    assert.match(plan.version, /^\d+\.\d+\.\d+/)
    assert.ok(existsSync(bin), bin)
    assert.ok(!bin.includes('/.bin/'))
  }
  assert.equal(planRunner(suite('app-1'), 'jest').version, '30.5.2')
  assert.equal(planRunner(suite('app-1'), 'vitest').version, '5.0.5')
})

test('a plan follows the paths it is given', () => {
  const paths = { repoRoot: '/r/repo', suitesRoot: '/r/repo/out/suites', resultsDir: '/r/results' }
  const plan = planRunner(suite('app-5'), 'vitest', { paths })
  assert.equal(plan.cwd, '/r/repo/out/suites/app-5/vitest')
  assert.equal(plan.configPath, 'out/suites/app-5/vitest/vitest.config.ts')
  assert.ok(plan.command.startsWith('cd out/suites/app-5/vitest && '))
  assert.deepEqual(
    plan.caches.map((cache) => cache.path),
    ['/r/repo/out/suites/app-5/.cache/vite', '/r/repo/out/suites/app-5/.cache/node-vitest'],
  )
})

test('a planned runner becomes a subject at the runner default isolation', () => {
  const plan = planRunner(suite('app-5'), 'jest')
  const spec = toSubjectSpec(plan)
  assert.deepEqual(spec.subject, {
    runner: 'jest',
    version: plan.version,
    isolation: 'runner-default',
    command: plan.command,
    configPath: plan.configPath,
  })
  assert.equal(spec.argv, plan.argv)
  assert.equal(spec.cwd, plan.cwd)
  assert.equal(spec.caches, plan.caches)
})
