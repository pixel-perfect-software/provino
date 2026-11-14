// T8.8: the coverage filter against what Jest 30.5.2 does with a file: `@jest/transform`'s
// `shouldInstrument`, and then `babel-plugin-istanbul` 8.0.0 (which `_instrumentFile` runs with
// `cwd: rootDir, exclude: []`, so `test-exclude` skips a file outside the root or under
// node_modules). A file is instrumented when both agree; the filter must say the same, in-process.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { shouldInstrument } from '@jest/transform'
import type { SerializedCoverageConfig } from '@provino/types'
import { createCoverageFilter } from './filter.ts'

const nodeRequire = createRequire(import.meta.url)
const babel = nodeRequire('@babel/core') as {
  transformSync(code: string, options: Record<string, unknown>): unknown
}
const plugin: unknown = (nodeRequire('babel-plugin-istanbul') as { default?: unknown }).default

const ROOT = '/virtual/project'

/** Whether babel-plugin-istanbul instruments a file with Jest's options. */
function babelInstruments(filename: string): boolean {
  let covered = false
  babel.transformSync('const a = 1\n', {
    babelrc: false,
    configFile: false,
    filename,
    sourceType: 'module',
    plugins: [
      [
        plugin,
        {
          cwd: ROOT,
          exclude: [],
          extension: false,
          useInlineSourceMaps: false,
          onCover: () => {
            covered = true
          },
        },
      ],
    ],
  })
  return covered
}

const CONFIG: SerializedCoverageConfig = {
  provider: 'istanbul',
  globalRoot: ROOT,
  projectRoot: ROOT,
  include: [],
  includeRoot: true,
  force: [],
  testFiles: ['**/__tests__/**/*.?([mc])[jt]s?(x)', '**/?(*.)+(spec|test).?([mc])[jt]s?(x)'],
  testRegex: [],
  testIgnorePatterns: ['/node_modules/'],
  excludePatterns: ['/node_modules/'],
  excludePaths: [`${ROOT}/setup.ts`],
}

/** Jest's project config for the same settings. */
function jestConfig(config: SerializedCoverageConfig): Parameters<typeof shouldInstrument>[2] {
  return {
    rootDir: config.projectRoot,
    forceCoverageMatch: config.force,
    testPathIgnorePatterns: config.testIgnorePatterns,
    testRegex: config.testRegex,
    testMatch: config.testFiles,
    coveragePathIgnorePatterns: config.excludePatterns,
    globalSetup: undefined,
    globalTeardown: undefined,
    setupFiles: config.excludePaths,
    setupFilesAfterEnv: [],
    // Only what `shouldInstrument` reads is set.
  } as unknown as Parameters<typeof shouldInstrument>[2]
}

function jestInstruments(config: SerializedCoverageConfig, path: string): boolean {
  return (
    shouldInstrument(
      path,
      {
        collectCoverage: true,
        collectCoverageFrom: [...config.include],
        coverageProvider: 'babel',
        globalRootDir: config.globalRoot,
      },
      jestConfig(config),
    ) && babelInstruments(path)
  )
}

const PATHS: readonly [name: string, path: string][] = [
  ['a source file', `${ROOT}/src/a.ts`],
  ['a test file', `${ROOT}/src/a.test.ts`],
  ['a setup file', `${ROOT}/setup.ts`],
  ['a mock', `${ROOT}/src/__mocks__/a.ts`],
  ['a JSON file', `${ROOT}/data.json`],
  ['a sibling outside the root', '/virtual/shared/x.ts'],
  ['a file in node_modules', `${ROOT}/node_modules/dep/index.js`],
  ['a nested node_modules file', `${ROOT}/packages/a/node_modules/dep/index.js`],
]

for (const [name, config] of [
  ['no include globs', CONFIG],
  ['include globs', { ...CONFIG, include: ['src/**/*.ts', '!**/*.d.ts'] }],
  ['force globs', { ...CONFIG, force: ['**/node_modules/dep/**', '**/shared/**'] }],
] as const) {
  const filter = createCoverageFilter(config)
  test(`the filter agrees with Jest on every path (${name})`, () => {
    for (const [what, path] of PATHS) {
      assert.equal(filter(path), jestInstruments(config, path), `${what}: ${path}`)
    }
  })
}

test('a file outside the root, and one under node_modules, are not instrumented', () => {
  const filter = createCoverageFilter(CONFIG)
  assert.equal(filter(`${ROOT}/src/a.ts`), true)
  assert.equal(filter('/virtual/shared/x.ts'), false)
  assert.equal(filter(`${ROOT}/node_modules/dep/index.js`), false)
  // Forced, and still left alone: the gate follows `shouldInstrument`, as Jest's does.
  const forced = createCoverageFilter({ ...CONFIG, force: ['**/shared/**', '**/node_modules/**'] })
  assert.equal(forced('/virtual/shared/x.ts'), false)
  assert.equal(forced(`${ROOT}/node_modules/dep/index.js`), false)
})

test('the V8 provider leaves out a file outside the global root, as Jest does', () => {
  const v8 = { ...CONFIG, provider: 'v8' } as const
  const filter = createCoverageFilter(v8)
  assert.equal(filter('/virtual/shared/x.ts'), false)
  assert.equal(filter(`${ROOT}/src/a.ts`), true)
  // No `node_modules` step: V8 keeps what `shouldInstrument` passes under the root.
  const forced = createCoverageFilter({ ...v8, force: ['**/shared/**'] })
  assert.equal(forced('/virtual/shared/x.ts'), false)
  // The prefix is raw, with no separator added: a sibling directory that shares it passes.
  assert.equal(filter(`${ROOT}-linked/src/a.ts`), true)
  // Jest's V8 collector: the same prefix, then `shouldInstrument`.
  for (const [, path] of PATHS) {
    const expected =
      path.startsWith(v8.globalRoot) &&
      shouldInstrument(
        path,
        {
          collectCoverage: true,
          collectCoverageFrom: [],
          coverageProvider: 'v8',
          globalRootDir: v8.globalRoot,
        },
        jestConfig(v8),
      )
    assert.equal(filter(path), expected, path)
  }
})

test('several projects: the globs are relative to the global root, Istanbul keeps to the project', () => {
  const config: SerializedCoverageConfig = {
    ...CONFIG,
    globalRoot: ROOT,
    projectRoot: `${ROOT}/packages/a`,
    include: ['packages/a/src/**'],
  }
  const filter = createCoverageFilter(config)
  const inside = `${ROOT}/packages/a/src/x.ts`
  const sibling = `${ROOT}/packages/b/src/x.ts`
  assert.equal(filter(inside), true)
  assert.equal(filter(sibling), false)
  assert.equal(jestInstruments(config, inside), true)
  assert.equal(jestInstruments(config, sibling), false)
  // Istanbul's check is the project's: a file of the root outside the project is left alone.
  const outsideProject = createCoverageFilter({ ...config, include: ['packages/b/src/**'] })
  assert.equal(outsideProject(sibling), false)
  // V8's is the global root's, so the same file counts there.
  const v8 = createCoverageFilter({ ...config, provider: 'v8', include: ['packages/b/src/**'] })
  assert.equal(v8(sibling), true)
})
