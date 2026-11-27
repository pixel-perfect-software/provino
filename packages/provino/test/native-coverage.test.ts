// Native coverage end to end (B28, D212): `provino run --coverage` and the config's `coverage` key on
// a project with no dialect, through the source bin and the built one, with each provider. The
// totals, the files in the reports and the thresholds are held against `provino jest --coverage` on
// an equivalent Jest config (same provider, the same `collectCoverageFrom`).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'provino'
import { nativeProject, runBin, spawnCli } from './support.ts'

const A = `export function add(a: number, b: number): number {
  return a + b
}
export function unused(): string {
  return 'never called'
}
`

const FILES: Readonly<Record<string, string>> = {
  'src/a.ts': A,
  'src/b.ts': 'export const b = (n: number): number => (n > 0 ? n : -n)\n',
  'src/skip.ts': 'export const skip = 1\n',
  'src/gen/g.ts': 'export const generated = 2\n',
  'src/unloaded.ts': 'export function nobody(): number {\n  return 3\n}\n',
  'tests/a.test.ts': `import { add } from '../src/a.ts'
import { b } from '../src/b.ts'
import { skip } from '../src/skip.ts'
import { generated } from '../src/gen/g.ts'
test('adds', () => {
  expect(add(1, 2)).toBe(3)
  expect(b(-2)).toBe(2)
  expect(skip + generated).toBe(3)
})
`,
}

const INCLUDE = ['src/**/*.ts', '!src/skip.ts']
const EXCLUDE = ['src/gen/**']

function nativeConfig(coverage: Readonly<Record<string, unknown>>): string {
  return `export default { include: ['tests/**/*.test.ts'], globals: true, coverage: ${JSON.stringify(coverage)} }\n`
}

function jestConfig(provider: 'v8' | 'babel', directory: string): string {
  return JSON.stringify({
    testMatch: ['**/tests/**/*.test.ts'],
    collectCoverageFrom: [...INCLUDE, ...EXCLUDE.map((glob) => `!${glob}`)],
    coverageProvider: provider,
    coverageReporters: ['lcovonly', 'json-summary'],
    coverageDirectory: directory,
  })
}

interface Summary {
  readonly total: Readonly<Record<string, { readonly total: number; readonly covered: number }>>
  readonly [file: string]: unknown
}

/** The files of an `lcov.info` (`SF:` lines), from the project root, sorted. */
function lcovFiles(text: string, dir: string): readonly string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('SF:'))
    .map((line) => line.slice(3).replace(`${dir}/`, ''))
    .sort()
}

function totals(summary: Summary): unknown {
  return Object.fromEntries(
    Object.entries(summary.total).map(([metric, { total, covered }]) => [metric, [total, covered]]),
  )
}

describe('provino run --coverage', () => {
  for (const [provider, jestProvider] of [
    ['v8', 'v8'],
    ['istanbul', 'babel'],
  ] as const) {
    for (const bin of ['source', 'built'] as const) {
      test(`writes the reports the config names, equal to provino jest (${provider}, ${bin} bin)`, async () => {
        const dir = await nativeProject(
          {
            ...FILES,
            'jest.config.json': jestConfig(jestProvider, 'jest-coverage'),
          },
          nativeConfig({
            provider,
            include: INCLUDE,
            exclude: EXCLUDE,
            reporters: ['lcovonly', 'json-summary', 'text'],
          }),
        )
        const args = ['run', '--config', 'provino.config.mjs', '--maxWorkers', '1', '--coverage']
        const ran = await runBin(bin, args, { cwd: dir })
        assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`)
        assert.match(ran.stdout, /File\s+\|\s+% Stmts/)

        const summary = JSON.parse(
          await readFile(join(dir, 'coverage', 'coverage-summary.json'), 'utf8'),
        ) as Summary
        const lcov = await readFile(join(dir, 'coverage', 'lcov.info'), 'utf8')
        // The untested file counts (it is in the include globs); the excluded ones don't.
        const files = lcovFiles(lcov, dir)
        assert.deepEqual(files, ['src/a.ts', 'src/b.ts', 'src/unloaded.ts'])
        for (const absent of ['src/skip.ts', 'src/gen/g.ts']) {
          assert.equal(lcov.includes(absent), false, absent)
          assert.equal(JSON.stringify(summary).includes(absent), false, absent)
        }

        const jestArgs = ['jest', '--config', 'jest.config.json', '--ci', '--coverage']
        const jest = await runBin(bin, jestArgs, { cwd: dir })
        assert.equal(jest.status, 0, `${jest.stdout}\n${jest.stderr}`)
        const jestSummary = JSON.parse(
          await readFile(join(dir, 'jest-coverage', 'coverage-summary.json'), 'utf8'),
        ) as Summary
        const jestLcov = await readFile(join(dir, 'jest-coverage', 'lcov.info'), 'utf8')
        assert.deepEqual(files, lcovFiles(jestLcov, dir))
        assert.deepEqual(totals(summary), totals(jestSummary))
      })
    }
  }

  test('a run without coverage writes no report', async () => {
    const dir = await nativeProject(FILES, nativeConfig({ include: INCLUDE }))
    const ran = await spawnCli(['run', '--config', 'provino.config.mjs', '--maxWorkers', '1'], {
      cwd: dir,
    })
    assert.equal(ran.code, 0, `${ran.stdout}\n${ran.stderr}`)
    assert.equal(existsSync(join(dir, 'coverage')), false)
  })

  test('coverage.enabled collects without the flag, with the same totals as the flag', async () => {
    const config = { include: INCLUDE, exclude: EXCLUDE, reporters: ['json-summary'] }
    const flagged = await nativeProject(FILES, nativeConfig(config))
    const configured = await nativeProject(FILES, nativeConfig({ ...config, enabled: true }))
    const args = ['run', '--config', 'provino.config.mjs', '--maxWorkers', '1']
    const first = await spawnCli([...args, '--coverage'], { cwd: flagged })
    // Twice: the second run starts on the caches the first filled (the bin's compile cache is on
    // when only the config asks for coverage), and must still count every function.
    const warmup = await spawnCli(args, { cwd: configured })
    const second = await spawnCli(args, { cwd: configured })
    assert.equal(first.code, 0, first.stderr)
    assert.equal(warmup.code, 0, warmup.stderr)
    assert.equal(second.code, 0, second.stderr)
    const read = async (dir: string): Promise<Summary> =>
      JSON.parse(await readFile(join(dir, 'coverage', 'coverage-summary.json'), 'utf8')) as Summary
    assert.deepEqual(totals(await read(configured)), totals(await read(flagged)))
  })

  test('a missed threshold fails the run and says which', async () => {
    const dir = await nativeProject(
      FILES,
      nativeConfig({
        include: INCLUDE,
        exclude: EXCLUDE,
        reporters: ['json-summary'],
        thresholds: { global: { statements: 100 } },
      }),
    )
    const ran = await spawnCli(
      ['run', '--config', 'provino.config.mjs', '--maxWorkers', '1', '--coverage'],
      { cwd: dir },
    )
    assert.equal(ran.code, 1, `${ran.stdout}\n${ran.stderr}`)
    assert.match(
      ran.stderr,
      /Coverage for statements \(.*%\) does not meet "global" threshold \(100%\)/,
    )
  })

  test('the directory key moves the reports', async () => {
    const dir = await nativeProject(
      FILES,
      nativeConfig({ include: INCLUDE, reporters: ['lcovonly'], directory: 'out/reports' }),
    )
    const ran = await spawnCli(
      ['run', '--config', 'provino.config.mjs', '--maxWorkers', '1', '--coverage'],
      { cwd: dir },
    )
    assert.equal(ran.code, 0, ran.stderr)
    assert.equal(existsSync(join(dir, 'out', 'reports', 'lcov.info')), true)
    assert.equal(existsSync(join(dir, 'coverage')), false)
  })
})
