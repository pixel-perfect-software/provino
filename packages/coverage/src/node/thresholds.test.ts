// T8.11: `checkThresholds` against Jest 30.5.2's own `CoverageReporter._checkThreshold`, run
// in-process on the same maps, groups and directory. Every case's messages and their order must be
// equal; the cases cover each way a file joins a group. The goldens (`coverage/threshold-*`) hold
// the bin to the same lines. The policy here is the Jest dialect's coverage slice written out (the
// neutral package imports no dialect); the equality with Jest's text is what the oracle proves.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { CoverageReporter } from '@jest/reporters'
import type { CoverageThresholdGroup, IstanbulFileCoverageData } from '@provino/types'
import libCoverage from 'istanbul-lib-coverage'
import { CoverageError } from '../errors.ts'
import { checkThresholds, type ThresholdPolicy } from './thresholds.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-thresholds-')))
const previousCwd = process.cwd()
process.chdir(root)
after(() => {
  process.chdir(previousCwd)
  rmSync(root, { recursive: true, force: true })
})

const policy: ThresholdPolicy = {
  thresholdGrouping: 'every-match',
  globThresholdScope: 'per-file',
  thresholdMessages: {
    belowMinimum:
      'Jest: Coverage for {metric} ({actual}%) does not meet "{name}" threshold ({threshold}%)',
    aboveMaximumUncovered:
      'Jest: Uncovered count for {metric} ({actual}) exceeds {name} threshold ({threshold})',
    notFound: 'Jest: Coverage data for {path} was not found.',
  },
}

/** A file of `statements` statements (the first `covered` hit), one function and a two-way branch. */
function fileData(
  path: string,
  statements: number,
  covered: number,
  options: { fnHit?: boolean; branch?: readonly [number, number] } = {},
): IstanbulFileCoverageData {
  const at = (line: number) => ({
    start: { line, column: 0 },
    end: { line, column: 10 },
  })
  return {
    path,
    statementMap: Object.fromEntries(Array.from({ length: statements }, (_, i) => [i, at(i + 1)])),
    fnMap: { '0': { name: 'f', decl: at(1), loc: at(1), line: 1 } },
    branchMap: {
      '0': { type: 'if', loc: at(1), locations: [at(1), at(2)], line: 1 },
    },
    s: Object.fromEntries(Array.from({ length: statements }, (_, i) => [i, i < covered ? 1 : 0])),
    f: { '0': options.fnHit === false ? 0 : 1 },
    b: { '0': [...(options.branch ?? [1, 1])] },
  }
}

const paths = {
  a: join(root, 'src', 'a.ts'),
  b: join(root, 'src', 'b.ts'),
  c: join(root, 'src', 'deep', 'c.ts'),
  d: join(root, 'lib', 'd.ts'),
  hidden: join(root, 'src', '.hidden', 'h.ts'),
}
for (const path of Object.values(paths)) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

const data = [
  fileData(paths.a, 10, 9),
  fileData(paths.b, 10, 4, { fnHit: false, branch: [1, 0] }),
  fileData(paths.c, 4, 4),
  fileData(paths.d, 10, 10),
  fileData(paths.hidden, 2, 0),
]

function mapOf(files: readonly IstanbulFileCoverageData[]): libCoverage.CoverageMap {
  return libCoverage.createCoverageMap(
    Object.fromEntries(files.map((f) => [f.path, f])) as unknown as libCoverage.CoverageMapData,
  )
}

/** What Jest's `_checkThreshold` reports: it logs the joined lines and keeps them as its error. */
function jestErrors(
  map: libCoverage.CoverageMap,
  groups: readonly CoverageThresholdGroup[],
): string[] {
  const coverageThreshold = Object.fromEntries(
    groups.map(({ name, ...metrics }) => [name, metrics]),
  )
  const reporter = new CoverageReporter({ coverageThreshold } as never, {} as never)
  reporter.log = () => {}
  ;(reporter as unknown as { _checkThreshold(map: unknown): void })._checkThreshold(map)
  return reporter.getLastError()?.message.split('\n') ?? []
}

const cases: readonly {
  name: string
  files?: readonly IstanbulFileCoverageData[]
  groups: readonly CoverageThresholdGroup[]
  /** A guard that the case reports what it is meant to (Jest's own count). */
  lines?: number
}[] = [
  { name: 'global met', groups: [{ name: 'global', statements: 50, lines: 50 }], lines: 0 },
  {
    name: 'global missed on every metric, in Jest metric order',
    groups: [{ name: 'global', functions: 100, lines: 100, branches: 100, statements: 100 }],
    lines: 4,
  },
  {
    name: 'global negative caps the uncovered count',
    groups: [{ name: 'global', statements: -3, functions: -1, branches: -1 }],
  },
  { name: 'a negative that is met', groups: [{ name: 'global', statements: -100 }], lines: 0 },
  {
    name: 'a path group takes its files; global takes the rest',
    groups: [
      { name: 'global', statements: 99 },
      { name: './src/deep', statements: 100 },
      { name: 'src/', statements: 80 },
    ],
  },
  {
    name: 'a trailing separator is kept, a bare prefix is a prefix',
    groups: [
      { name: './src/deep/', statements: 100 },
      { name: './src/a', statements: 95 },
    ],
  },
  {
    name: 'a glob group is checked file by file',
    groups: [{ name: './src/**/*.ts', statements: 85 }],
  },
  {
    name: 'a file in a path group and a glob group counts for both',
    groups: [
      { name: './src', statements: 95 },
      { name: './src/*.ts', statements: 95 },
      { name: 'global', statements: 100 },
    ],
  },
  {
    name: 'global with every file claimed covers every file',
    groups: [
      { name: 'global', statements: 100 },
      { name: './src', statements: 0 },
      { name: './lib', statements: 0 },
    ],
  },
  { name: 'a path no file matches is not found', groups: [{ name: './nowhere', lines: 10 }] },
  { name: 'a glob no file matches is not found', groups: [{ name: './src/**/*.js', lines: 10 }] },
  {
    name: 'dotfiles are not matched by a glob',
    groups: [{ name: './src/**/*.ts', statements: 100 }],
  },
  {
    name: 'no coverage data: global is skipped, a path is not found',
    files: [],
    groups: [
      { name: 'global', statements: 100 },
      { name: './src', statements: 100 },
    ],
  },
  { name: 'metrics the group leaves out are not checked', groups: [{ name: './lib' }], lines: 0 },
  {
    name: 'a threshold of 0 is checked and never missed, also where a file has no coverage',
    groups: [
      { name: 'global', statements: 0, branches: 0, lines: 0, functions: 0 },
      { name: './src/.hidden', statements: 0 },
    ],
    lines: 0,
  },
  {
    name: 'a key with no trailing slash is a prefix of the path, not a directory',
    groups: [
      { name: './src', statements: 100 },
      { name: './s', statements: 100 },
    ],
  },
  {
    name: 'a key that names one file covers that file alone',
    groups: [
      { name: './src/a.ts', statements: 95 },
      { name: 'global', statements: 100 },
    ],
  },
  {
    name: 'an absolute path key and an absolute glob key',
    groups: [
      { name: join(root, 'src', 'deep'), statements: 100 },
      { name: join(root, 'src', '**', '*.ts'), statements: 85 },
    ],
  },
  {
    name: 'a glob written with a backslash reads it as a separator (windowsPathsNoEscape)',
    groups: [{ name: './src/\\*.ts', statements: 95 }],
  },
]

for (const { name, files = data, groups, lines } of cases) {
  test(`${name}: equal to Jest's _checkThreshold`, () => {
    const map = mapOf(files)
    const expected = jestErrors(map, groups)
    if (lines !== undefined) assert.equal(expected.length, lines, 'the case itself')
    assert.deepEqual(checkThresholds(map, groups, policy, { cwd: root }), expected)
  })
}

test('the failures use the policy messages', () => {
  const messages = {
    belowMinimum: 'low {metric} {actual} {threshold} {name}',
    aboveMaximumUncovered: 'high {metric} {actual} {threshold} {name}',
    notFound: 'missing {path}',
  }
  const errors = checkThresholds(
    mapOf(data),
    [
      { name: 'global', statements: 100 },
      { name: './none', lines: 1 },
    ],
    { ...policy, thresholdMessages: messages },
    { cwd: root },
  )
  assert.deepEqual(errors, ['low statements 75 100 global', 'missing ./none'])
})

test("a policy whose grouping is not Jest's is refused", () => {
  assert.throws(
    () =>
      checkThresholds(
        mapOf(data),
        [{ name: 'global', lines: 1 }],
        { ...policy, thresholdGrouping: 'all-files' },
        { cwd: root },
      ),
    (error: unknown) => error instanceof CoverageError && error.code === 'COVERAGE_NOT_IMPLEMENTED',
  )
})
