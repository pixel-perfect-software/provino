// The coordinator's reports (T8.10): the merge adds counters, a file no test loaded joins once, a
// console report writes to the stream it is given (never to `process.stdout`), a file report to the
// directory, and a report that throws is `COVERAGE_REPORT_FAILED`. Byte-for-byte parity with Jest's
// reports is `provino`'s `jest-coverage.test.ts`.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { IstanbulFileCoverageData } from '@provino/types'
import { loadCoverageReporting } from './index.ts'

const reporting = await loadCoverageReporting()

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function fileData(path: string, hits: number): IstanbulFileCoverageData {
  const range = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } }
  return {
    path,
    statementMap: { '0': range },
    fnMap: { '0': { name: 'f', decl: range, loc: range, line: 1 } },
    branchMap: {},
    s: { '0': hits },
    f: { '0': hits },
    b: {},
  }
}

const WATERMARKS = {
  statements: [50, 80],
  branches: [50, 80],
  functions: [50, 80],
  lines: [50, 80],
} as const

test('takes add up; an untested file joins once and never replaces a tested one', () => {
  const aggregate = reporting.createCoverageAggregate()
  aggregate.add({ kind: 'istanbul', workerId: 1, data: { '/p/a.ts': fileData('/p/a.ts', 1) } })
  aggregate.add({ kind: 'istanbul', workerId: 2, data: { '/p/a.ts': fileData('/p/a.ts', 2) } })
  aggregate.addUntested(fileData('/p/a.ts', 0))
  aggregate.addUntested(fileData('/p/b.ts', 0))
  assert.deepEqual(aggregate.map.fileCoverageFor('/p/a.ts').s, { '0': 3 })
  assert.deepEqual(aggregate.map.files().sort(), ['/p/a.ts', '/p/b.ts'])
  assert.equal(aggregate.has('/p/b.ts'), true)
  const totals = reporting.coverageTotals(aggregate.map)
  assert.deepEqual(totals.statements, { total: 2, covered: 1, pct: 50 })
  // No branches: 100%, where Istanbul writes `Unknown`.
  assert.deepEqual(totals.branches, { total: 0, covered: 0, pct: 100 })
})

test('a console report writes to the given stream, a file report to the directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provino-coverage-reports-'))
  dirs.push(dir)
  const map = reporting.createCoverageMap({ '/p/a.ts': fileData('/p/a.ts', 1) })
  let text = ''
  const written = process.stdout.write
  let leaked = ''
  process.stdout.write = ((chunk: string) => {
    leaked += chunk
    return true
  }) as typeof process.stdout.write
  try {
    await reporting.writeCoverageReports(map, {
      reporters: [['text-summary', {}], 'json'],
      directory: dir,
      watermarks: WATERMARKS,
      stdout: { write: (chunk) => (text += chunk) },
      colour: false,
    })
  } finally {
    process.stdout.write = written
  }
  assert.equal(leaked, '')
  assert.match(text, /Statements {3}: 100% \( 1\/1 \)/)
  const final = JSON.parse(await readFile(join(dir, 'coverage-final.json'), 'utf8')) as object
  assert.deepEqual(Object.keys(final), ['/p/a.ts'])
})

test('colour follows the option, by watermark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provino-coverage-reports-'))
  dirs.push(dir)
  let text = ''
  await reporting.writeCoverageReports(
    reporting.createCoverageMap({ '/p/a.ts': fileData('/p/a.ts', 0) }),
    {
      reporters: ['text-summary'],
      directory: dir,
      watermarks: WATERMARKS,
      stdout: { write: (chunk) => (text += chunk) },
      colour: true,
    },
  )
  // 0% is below the low mark: red.
  assert.ok(text.includes('\u001b[31;1mStatements'), text)
})

test('a report that throws is COVERAGE_REPORT_FAILED, with what it threw as the cause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provino-coverage-reports-'))
  dirs.push(dir)
  await assert.rejects(
    reporting.writeCoverageReports(reporting.createCoverageMap({}), {
      reporters: ['no-such-istanbul-report'],
      directory: dir,
      watermarks: WATERMARKS,
      stdout: { write: () => undefined },
      colour: false,
    }),
    (error: unknown) =>
      (error as { code?: unknown }).code === 'COVERAGE_REPORT_FAILED' &&
      (error as { cause?: unknown }).cause instanceof Error,
  )
})

test('a source that is not on disk: the remap keeps its text, and the html report reads it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provino-coverage-'))
  dirs.push(dir)
  const original = '/virtual/generated/orig.ts'
  const text = 'export const x = 1 + 1\n'
  const generated = {
    ...fileData('/virtual/generated/out.js', 1),
    inputSourceMap: {
      version: 3,
      sources: [original],
      sourcesContent: [text],
      names: [],
      mappings: 'AAAA,UAAU',
    },
  } as IstanbulFileCoverageData
  const remapped = await reporting.remapCoverage(
    reporting.createCoverageMap({ '/virtual/generated/out.js': generated }),
  )
  assert.deepEqual(remapped.map.files(), [original])
  assert.deepEqual(remapped.sources, { [original]: text })
  const options = {
    reporters: ['html'],
    directory: dir,
    watermarks: WATERMARKS,
    stdout: { write: () => undefined },
    colour: false,
  }
  // Without the text the html report looks on disk and prints the lookup error in the page.
  await reporting.writeCoverageReports(remapped.map, options)
  assert.match(await readFile(join(dir, 'orig.ts.html'), 'utf8'), /Unable to lookup source/)
  await reporting.writeCoverageReports(remapped.map, { ...options, sources: remapped.sources })
  const page = await readFile(join(dir, 'orig.ts.html'), 'utf8')
  assert.match(page, /export const x = 1 \+ 1/)
  assert.doesNotMatch(page, /Unable to lookup source/)
})
