// Row 12's machinery: the baseline from node --test's reporter, Provino's report, the diff, and the
// whole rewrite -> verify flow on a generated package (the Provino side is a stand-in runner that
// writes a report: Provino cannot run a native project before B27e wires its matcher table).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { rewritePackage, testFlags, testGlobs, verifyPackage } from './node-test-migrate.ts'
import {
  diffRecords,
  formatDifference,
  isEmptyDifference,
  type ReporterLine,
  recordsFromProvino,
  recordsFromReporter,
  type TestRecord,
} from './node-test-verify.ts'

const PACKAGE = '/pkg'

function line(name: string, nesting: number, over: Partial<ReporterLine> = {}): ReporterLine {
  return {
    pass: true,
    nesting,
    name,
    file: PACKAGE + '/src/a.test.ts',
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
    assert.match(formatDifference(changed), /changed {2}a: x \(pass -> fail\)/)
  })

  it('counts a repeated title: losing one of two is a difference', () => {
    assert.equal(isEmptyDifference(diffRecords(base, base.slice(0, 2))), false)
  })
})

describe('the test script', () => {
  it('takes the quoted globs and the load flags, not the test selection flags', () => {
    const script =
      'node --test --conditions=provino-source --test-shard=1/2 "src/**/*.test.ts" "test/**/*.test.ts"'
    assert.deepEqual(testGlobs(script), ['src/**/*.test.ts', 'test/**/*.test.ts'])
    assert.deepEqual(testFlags(script), ['--conditions=provino-source'])
  })
})

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixturePackage(
  files: Readonly<Record<string, string>>,
): Promise<{ root: string; pkg: string; cache: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-migrate-test-')))
  made.push(root)
  const all = {
    'pkg/package.json': JSON.stringify({
      name: 'fixture',
      type: 'module',
      scripts: { test: 'node --test "src/**/*.test.ts"' },
    }),
    ...Object.fromEntries(Object.entries(files).map(([name, text]) => ['pkg/' + name, text])),
  }
  for (const [name, text] of Object.entries(all)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), text)
  }
  return { root, pkg: join(root, 'pkg'), cache: join(root, 'cache') }
}

/** A runner that writes the report it is told to (the \`--outputFile\` after \`--reporter json\`). */
function fakeRunner(report: unknown): string {
  return (
    "import { writeFileSync } from 'node:fs'\n" +
    "const at = process.argv.indexOf('--outputFile')\n" +
    "writeFileSync(process.argv[at + 1] ?? '', " +
    JSON.stringify(JSON.stringify(report)) +
    ')\n'
  )
}

const SOURCE = [
  "import assert from 'node:assert/strict'",
  "import { describe, it } from 'node:test'",
  "describe('suite', () => {",
  "  it('passes', () => { assert.ok(true) })",
  "  it('skipped', { skip: true }, () => {})",
  "  it('fails', () => { assert.equal(1, 2) })",
  '})',
  '',
].join('\n')

function provinoReport(statuses: Record<string, string>): unknown {
  return {
    files: [
      {
        file: 'src/a.test.ts',
        status: 'failed',
        tests: Object.entries(statuses).map(([name, status]) => ({
          id: { path: ['suite', name] },
          status,
        })),
      },
    ],
  }
}

describe('rewrite then verify, on a generated package', () => {
  it('records what node:test reported, rewrites, and verifies a matching run', async () => {
    const { root, pkg, cache } = await fixturePackage({ 'src/a.test.ts': SOURCE })
    const report = await rewritePackage({ packageDir: pkg, root, cacheDir: cache, dryRun: false })
    assert.deepEqual(report.rewritten, ['src/a.test.ts'])
    assert.equal(report.baselineTests, 3)
    assert.match(await readFile(join(pkg, 'src/a.test.ts'), 'utf8'), /from 'provino'/)

    const runner = join(root, 'runner.ts')
    await writeFile(
      runner,
      fakeRunner(provinoReport({ passes: 'passed', skipped: 'skipped', fails: 'failed' })),
    )
    const verified = await verifyPackage({
      packageDir: pkg,
      root,
      cacheDir: cache,
      runner,
      config: undefined,
    })
    assert.equal(verified.tests, 3)
    assert.ok(isEmptyDifference(verified.difference), formatDifference(verified.difference))
  })

  it('verify fails on a missing test, an extra test and a changed status', async () => {
    const { root, pkg, cache } = await fixturePackage({ 'src/a.test.ts': SOURCE })
    await rewritePackage({ packageDir: pkg, root, cacheDir: cache, dryRun: false })
    const runner = join(root, 'runner.ts')
    await writeFile(
      runner,
      fakeRunner(provinoReport({ passes: 'failed', extra: 'passed', fails: 'failed' })),
    )
    const { difference } = await verifyPackage({
      packageDir: pkg,
      root,
      cacheDir: cache,
      runner,
      config: undefined,
    })
    assert.deepEqual(
      difference.missing.map((r) => r.name),
      ['suite > skipped'],
    )
    assert.deepEqual(
      difference.extra.map((r) => r.name),
      ['suite > extra'],
    )
    assert.deepEqual(
      difference.changed.map((r) => r.name),
      ['suite > passes'],
    )
  })

  it('writes nothing when a site is refused, and says where', async () => {
    const refused = SOURCE + "describe('later', async () => {})\n"
    const { root, pkg, cache } = await fixturePackage({ 'src/a.test.ts': refused })
    const report = await rewritePackage({ packageDir: pkg, root, cacheDir: cache, dryRun: false })
    assert.deepEqual(report.rewritten, [])
    assert.deepEqual(
      report.refusals.map((r) => r.line),
      [8],
    )
    assert.equal(await readFile(join(pkg, 'src/a.test.ts'), 'utf8'), refused)
    await assert.rejects(
      verifyPackage({ packageDir: pkg, root, cacheDir: cache, runner: 'x.ts', config: undefined }),
      {
        code: 'MIGRATE_NO_BASELINE',
      },
    )
  })

  it('a dry run writes neither files nor a baseline, and a second rewrite is a no-op', async () => {
    const { root, pkg, cache } = await fixturePackage({ 'src/a.test.ts': SOURCE })
    const dry = await rewritePackage({ packageDir: pkg, root, cacheDir: cache, dryRun: true })
    assert.equal(dry.candidates, 1)
    assert.equal(await readFile(join(pkg, 'src/a.test.ts'), 'utf8'), SOURCE)
    await rewritePackage({ packageDir: pkg, root, cacheDir: cache, dryRun: false })
    const first = await readFile(join(pkg, 'src/a.test.ts'), 'utf8')
    const again = await rewritePackage({ packageDir: pkg, root, cacheDir: cache, dryRun: false })
    assert.deepEqual(again.rewritten, [])
    assert.equal(await readFile(join(pkg, 'src/a.test.ts'), 'utf8'), first)
    // The baseline survives the second run: it still has the three tests.
    const runner = join(root, 'runner.ts')
    await writeFile(
      runner,
      fakeRunner(provinoReport({ passes: 'passed', skipped: 'skipped', fails: 'failed' })),
    )
    const verified = await verifyPackage({
      packageDir: pkg,
      root,
      cacheDir: cache,
      runner,
      config: undefined,
    })
    assert.equal(verified.tests, 3)
  })
})
