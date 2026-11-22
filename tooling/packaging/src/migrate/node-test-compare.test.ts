// The pure half of row 12: the baseline from node:test's events, Provino's report, and the diff.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  diffRecords,
  formatDifference,
  isEmptyDifference,
  type ReporterLine,
  recordsFromProvino,
  recordsFromReporter,
  type TestRecord,
} from './node-test-compare.ts'

const PACKAGE = '/pkg'

function line(name: string, nesting: number, over: Partial<ReporterLine> = {}): ReporterLine {
  return {
    pass: true,
    nesting,
    name,
    file: `${PACKAGE}/src/a.test.ts`,
    suite: false,
    skip: false,
    todo: false,
    ...over,
  }
}

describe('the baseline from node:test events', () => {
  it('joins the title path with " > " and reads skip and todo', () => {
    const records = recordsFromReporter(
      [
        line('one', 1),
        line('two', 1, { skip: true }),
        line('three', 2, { todo: true }),
        line('inner', 1, { suite: true }),
        line('suite', 0, { suite: true }),
        line('top', 0),
      ],
      PACKAGE,
    )
    assert.deepEqual(records, [
      { file: 'src/a.test.ts', name: 'suite > one', status: 'pass' },
      { file: 'src/a.test.ts', name: 'suite > two', status: 'skip' },
      { file: 'src/a.test.ts', name: 'suite > inner > three', status: 'todo' },
      { file: 'src/a.test.ts', name: 'top', status: 'pass' },
    ])
  })

  it('a failing suite with no failing child is a failure of its own (a throwing hook)', () => {
    const records = recordsFromReporter(
      [line('t', 1), line('suite', 0, { suite: true, pass: false })],
      PACKAGE,
    )
    assert.deepEqual(records, [
      { file: 'src/a.test.ts', name: 'suite > t', status: 'pass' },
      { file: 'src/a.test.ts', name: 'suite', status: 'fail' },
    ])
  })

  it("carries a suite's skip and todo down to the tests node:test reports under it", () => {
    const records = recordsFromReporter(
      [line('c', 1), line('s', 0, { suite: true, todo: true })],
      PACKAGE,
    )
    assert.deepEqual(records, [{ file: 'src/a.test.ts', name: 's > c', status: 'todo' }])
  })

  it('a skipped suite node:test lists no tests under stays one suite record', () => {
    const records = recordsFromReporter([line('s', 0, { suite: true, skip: true })], PACKAGE)
    assert.deepEqual(records, [{ file: 'src/a.test.ts', name: 's', status: 'skip', suite: true }])
  })

  it('drops a line with no file', () => {
    assert.deepEqual(recordsFromReporter([line('x', 0, { file: '' })], PACKAGE), [])
  })
})

describe("Provino's report", () => {
  const report = (status: string): unknown => ({
    files: [
      { file: 'src/a.test.ts', status: 'passed', tests: [{ id: { path: ['s', 'x'] }, status }] },
    ],
  })

  it("maps its statuses to node:test's", () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['passed', 'pass'],
      ['failed', 'fail'],
      ['skipped', 'skip'],
      ['todo', 'todo'],
    ]
    for (const [provino, node] of pairs) {
      assert.deepEqual(recordsFromProvino(report(provino)), [
        { file: 'src/a.test.ts', name: 's > x', status: node },
      ])
    }
  })

  it('refuses a crashed file and a status it cannot compare', () => {
    assert.throws(
      () => recordsFromProvino({ files: [{ file: 'a', status: 'crashed', tests: [] }] }),
      {
        code: 'MIGRATE_RUN',
      },
    )
    assert.throws(() => recordsFromProvino(report('notRun')), { code: 'MIGRATE_RUN' })
    assert.throws(() => recordsFromProvino({}), { code: 'MIGRATE_RUN' })
  })
})

describe('the diff', () => {
  const base: TestRecord[] = [
    { file: 'a', name: 'x', status: 'pass' },
    { file: 'a', name: 'y', status: 'skip' },
    { file: 'a', name: 'y', status: 'skip' },
  ]

  it('is empty for the same tests in another order', () => {
    assert.ok(isEmptyDifference(diffRecords(base, [...base].reverse())))
  })

  it('fails on a missing test, an extra test and a status change', () => {
    const missing = diffRecords(base, base.slice(1))
    assert.deepEqual(missing.missing, [{ file: 'a', name: 'x', status: 'pass' }])
    const extra = diffRecords(base, [...base, { file: 'a', name: 'z', status: 'pass' }])
    assert.deepEqual(extra.extra, [{ file: 'a', name: 'z', status: 'pass' }])
    const changed = diffRecords(base, [{ file: 'a', name: 'x', status: 'fail' }, ...base.slice(1)])
    assert.deepEqual(changed.changed, [{ file: 'a', name: 'x', before: 'pass', after: 'fail' }])
    assert.deepEqual(changed.missing, [])
    assert.deepEqual(changed.extra, [])
    assert.match(formatDifference(changed), /changed {2}a: x \(pass -> fail\)/)
  })

  it('counts a repeated title: losing one of two is a difference', () => {
    assert.equal(isEmptyDifference(diffRecords(base, base.slice(0, 2))), false)
  })

  it('a skipped suite matches the skipped tests Provino lists under it, and only those', () => {
    const before: TestRecord[] = [{ file: 'a', name: 's', status: 'skip', suite: true }]
    const skipped: TestRecord[] = [
      { file: 'a', name: 's > c1', status: 'skip' },
      { file: 'a', name: 's > c2', status: 'skip' },
    ]
    assert.ok(isEmptyDifference(diffRecords(before, skipped)))
    assert.ok(isEmptyDifference(diffRecords(before, [])))
    const ran = diffRecords(before, [{ file: 'a', name: 's > c1', status: 'pass' }])
    assert.deepEqual(ran.extra, [{ file: 'a', name: 's > c1', status: 'pass' }])
  })
})
