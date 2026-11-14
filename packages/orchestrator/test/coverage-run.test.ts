// T8.10 in the coordinator: a run whose project collects Istanbul coverage ends with the merged map
// in `RunSummary.coverage`, counted across files, with the files no test loaded at zero (their
// initial coverage through the project's own transform), and moved back to the TypeScript sources.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResolvedProject } from '@provino/config'
import type { SerializedCoverageConfig } from '@provino/types'
import { run, runtimeProject, trackedProjects } from './support.ts'

const project = trackedProjects()

const FILES = {
  'src/pricing.ts': [
    'export function price(quantity: number): number {',
    '  return quantity * 2',
    '}',
    'export function discount(total: number): number {',
    '  return total * 0.9',
    '}',
    '',
  ].join('\n'),
  'src/untested.ts': [
    'export const never = (flag: boolean): string => (flag ? "yes" : "no")',
    '',
  ].join('\n'),
  'src/ignored.ts': ['/* istanbul ignore file */', 'export const x: number = 1', ''].join('\n'),
  'a.test.ts': [
    "import { price } from './src/pricing.ts'",
    "test('prices', () => { expect(price(2)).toBe(4) })",
    '',
  ].join('\n'),
  'b.test.ts': [
    "import { price } from './src/pricing.ts'",
    "test('prices again', () => { expect(price(3)).toBe(6) })",
    '',
  ].join('\n'),
}

function withCoverage(dir: string, include: readonly string[]): ResolvedProject {
  const base = runtimeProject(dir, { include: ['**/*.test.ts'] })
  const coverage: SerializedCoverageConfig = {
    provider: 'istanbul',
    globalRoot: dir,
    projectRoot: dir,
    include,
    includeRoot: true,
    force: [],
    testFiles: ['**/*.test.ts'],
    testRegex: [],
    testIgnorePatterns: [],
    excludePatterns: ['/node_modules/'],
    excludePaths: [],
  }
  return { ...base, config: { ...base.config, coverage } }
}

describe('a run with Istanbul coverage', () => {
  it('sums every file, adds the untested ones at zero, and reports the sources', async () => {
    const p = await project(FILES)
    const notices: string[] = []
    const { summary } = await run(withCoverage(p.dir, ['src/**/*.ts']), {
      pool: { kind: 'inline' },
      coverage: {
        onUntested: { start: () => notices.push('start'), end: () => notices.push('end') },
      },
    })
    assert.equal(summary.reason, 'passed')
    const coverage = summary.coverage
    assert.ok(coverage !== undefined)
    assert.deepEqual(Object.keys(coverage.map).sort(), [
      p.path('src/pricing.ts'),
      p.path('src/untested.ts'),
    ])
    const pricing = coverage.map[p.path('src/pricing.ts')]
    // `price` ran in both files; `discount` never.
    assert.deepEqual(Object.values(pricing?.f ?? {}), [2, 0])
    // Remapped to the TypeScript lines: each statement on the line it was written on.
    assert.deepEqual(
      Object.values(pricing?.statementMap ?? {}).map((range) => range.start.line),
      [2, 5],
    )
    const untested = coverage.map[p.path('src/untested.ts')]
    assert.deepEqual(Object.values(untested?.s ?? {}), [0, 0])
    assert.equal(coverage.totals.functions.total, 3)
    assert.equal(coverage.totals.functions.covered, 1)
    assert.deepEqual(notices, ['start', 'end'])
    assert.equal(coverage.untestedFailures, undefined)
  })

  it('with no include globs, only the files the tests loaded count and nothing is crawled', async () => {
    const p = await project(FILES)
    const notices: string[] = []
    const { summary } = await run(withCoverage(p.dir, []), {
      pool: { kind: 'inline' },
      coverage: { onUntested: { start: () => notices.push('start'), end: () => {} } },
    })
    assert.deepEqual(Object.keys(summary.coverage?.map ?? {}), [p.path('src/pricing.ts')])
    assert.deepEqual(notices, [])
  })

  it('an untested file that does not transform is a failure of its own, and the run goes on', async () => {
    const p = await project({ ...FILES, 'src/broken.ts': 'export const = ;\n' })
    const { summary } = await run(withCoverage(p.dir, ['src/**/*.ts']), {
      pool: { kind: 'inline' },
    })
    assert.equal(summary.reason, 'passed')
    const failures = summary.coverage?.untestedFailures ?? []
    assert.deepEqual(
      failures.map((failure) => failure.path),
      [p.path('src/broken.ts')],
    )
    assert.equal(failures[0]?.error.code, 'LOADER_TRANSFORM_FAILED')
    assert.ok(summary.coverage?.map[p.path('src/untested.ts')] !== undefined)
  })

  it('a project without coverage has none in its summary', async () => {
    const p = await project(FILES)
    const { summary } = await run(runtimeProject(p.dir, { include: ['**/*.test.ts'] }), {
      pool: { kind: 'inline' },
    })
    assert.equal('coverage' in summary, false)
  })
})
