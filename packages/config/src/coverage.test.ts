// The top-level `coverage` key (B28, D212): parsed and checked, its defaults applied, and each
// project's worker-side coverage config built from it.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { ProvinoConfigInput } from '@provino/types'
import { afterAll, beforeAll, describe, test } from 'provino'
import { withCoverage } from './coverage.ts'
import { makeTempDir, rejectsWith, type TempDir } from './internal/test-support.ts'
import { resolveProjects } from './projects.ts'

const ENVIRONMENTS = { node: { module: 'file:///env/node.mjs', export: 'nodeEnvironment' } }

let temp: TempDir
let configPath: string
beforeAll(async () => {
  temp = await makeTempDir()
  configPath = join(temp.dir, 'provino.config.mjs')
})
afterAll(() => temp.dispose())

function resolveInput(input: ProvinoConfigInput) {
  return resolveProjects(input, { configPath, dialects: [], environments: ENVIRONMENTS, ci: false })
}

describe('the coverage key', () => {
  test('is off by default, with the speed defaults applied', async () => {
    const { coverage, projects } = await resolveInput({})
    assert.equal(coverage.enabled, false)
    assert.equal(coverage.provider, 'v8')
    assert.deepEqual(coverage.include, [])
    assert.deepEqual(coverage.exclude, ['**/node_modules/**'])
    assert.deepEqual(coverage.reporters, [
      ['text', {}],
      ['lcovonly', {}],
    ])
    assert.equal(coverage.directory, join(temp.dir, 'coverage'))
    assert.deepEqual(coverage.thresholds, [])
    assert.equal(projects[0]?.config.coverage, undefined)
  })

  test('takes every key, with the directory made absolute against the run root', async () => {
    const { coverage } = await resolveInput({
      coverage: {
        enabled: true,
        provider: 'istanbul',
        include: ['src/**/*.ts', '!src/skip.ts'],
        exclude: ['src/gen/**'],
        reporters: ['json-summary', ['lcov', { projectRoot: 'x' }]],
        directory: 'out/cov',
        thresholds: { global: { lines: 80, branches: -3 }, 'src/a.ts': { statements: 100 } },
      },
    })
    assert.equal(coverage.enabled, true)
    assert.equal(coverage.provider, 'istanbul')
    assert.deepEqual(coverage.include, ['src/**/*.ts', '!src/skip.ts'])
    assert.deepEqual(coverage.exclude, ['src/gen/**'])
    assert.deepEqual(coverage.reporters, [
      ['json-summary', {}],
      ['lcov', { projectRoot: 'x' }],
    ])
    assert.equal(coverage.directory, join(temp.dir, 'out', 'cov'))
    assert.deepEqual(coverage.thresholds, [
      { name: 'global', lines: 80, branches: -3 },
      { name: 'src/a.ts', statements: 100 },
    ])
  })

  test('is resolved against the run root when the config has projects', async () => {
    await temp.write('sub/one/.keep', '')
    const { coverage, root } = await resolveInput({
      root: 'sub',
      projects: [{ name: 'one', root: 'sub/one' }],
      coverage: { directory: 'reports' },
    })
    assert.equal(root, join(temp.dir, 'sub'))
    assert.equal(coverage.directory, join(temp.dir, 'sub', 'reports'))
  })

  test('a bad value is CONFIG_INVALID, naming the key', async () => {
    const bad: readonly [unknown, RegExp][] = [
      [{ enabled: 'yes' }, /"enabled" must be a boolean/],
      [{ provider: 'babel' }, /"provider" must be "v8" or "istanbul"/],
      [{ include: 'src' }, /"include" must be an array of strings/],
      [{ exclude: [1] }, /"exclude" must be an array of strings/],
      [{ reporters: ['nope'] }, /"reporters" must be an array of reporter names/],
      [{ reporters: [['text']] }, /"reporters" must be an array of reporter names/],
      [{ directory: 3 }, /"directory" must be a string/],
      [{ thresholds: [] }, /"thresholds" must be an object/],
      [{ thresholds: { global: 80 } }, /coverage\.thresholds\.global/],
      [{ thresholds: { global: { lines: '80' } } }, /coverage\.thresholds\.global\.lines/],
    ]
    for (const [coverage, message] of bad) {
      const error = await rejectsWith(
        resolveInput({ coverage } as unknown as ProvinoConfigInput),
        'CONFIG_INVALID',
      )
      assert.match(error.message, message)
    }
    await rejectsWith(
      resolveInput({ coverage: 1 } as unknown as ProvinoConfigInput),
      'CONFIG_INVALID',
    )
  })

  test('an unknown key is CONFIG_UNKNOWN_KEY with the nearest key', async () => {
    const error = await rejectsWith(
      resolveInput({ coverage: { reporter: ['text'] } } as unknown as ProvinoConfigInput),
      'CONFIG_UNKNOWN_KEY',
    )
    assert.match(error.message, /did you mean "reporters"\?/)
    const metric = await rejectsWith(
      resolveInput({
        coverage: { thresholds: { global: { line: 1 } } },
      } as unknown as ProvinoConfigInput),
      'CONFIG_UNKNOWN_KEY',
    )
    assert.match(metric.message, /did you mean "lines"\?/)
  })

  test('inside a project it belongs to the top-level config only', async () => {
    const error = await rejectsWith(
      resolveInput({
        projects: [{ name: 'one', coverage: { enabled: true } } as unknown as ProvinoConfigInput],
      }),
      'CONFIG_UNKNOWN_KEY',
    )
    assert.match(error.message, /belongs to the top-level config only/)
  })
})

describe('withCoverage', () => {
  test('tells every project to collect, with strings and arrays only', async () => {
    const setup = await temp.write('setup.ts', '')
    const { projects, coverage, root } = await resolveInput({
      include: ['src/**/*.test.ts', '!src/skip.test.ts'],
      setupFiles: [setup],
      coverage: { include: ['src/**/*.ts'], exclude: ['src/gen/**'] },
    })
    const runRoot = root ?? temp.dir
    const [project] = withCoverage(projects, coverage, runRoot, configPath)
    const serialized = project?.config.coverage
    assert.ok(serialized)
    assert.equal(serialized.provider, 'v8')
    assert.equal(serialized.globalRoot, temp.dir)
    assert.equal(serialized.projectRoot, projects[0]?.rootDir)
    assert.deepEqual(serialized.include, ['src/**/*.ts'])
    assert.equal(serialized.includeRoot, true)
    assert.deepEqual(serialized.excludeGlobs, ['src/gen/**'])
    assert.deepEqual(serialized.testFiles, [
      join(temp.dir, 'src/**/*.test.ts'),
      `!${join(temp.dir, 'src/skip.test.ts')}`,
    ])
    assert.deepEqual(serialized.excludePaths, [configPath, setup])
    for (const empty of [
      serialized.force,
      serialized.testRegex,
      serialized.testIgnorePatterns,
      serialized.excludePatterns,
    ]) {
      assert.deepEqual(empty, [])
    }
    assert.doesNotThrow(() => structuredClone(project?.config))
    assert.equal(projects[0]?.config.coverage, undefined, 'the input project is left alone')
  })
})
