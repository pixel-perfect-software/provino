import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { Test, TestResult } from '@jest/test-result'
import { parseSidecar } from '../sidecar.ts'
import JestSidecarReporter from './jest.ts'

let dir = ''
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'provino-jest-sidecar-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** What Jest hands `onTestResult`: only the fields the reporter reads are real. */
function result(testFilePath: string, console?: TestResult['console']): TestResult {
  const partial: Pick<TestResult, 'testFilePath' | 'console'> =
    console === undefined ? { testFilePath } : { testFilePath, console }
  return partial as TestResult
}

const TEST = {} as Test

test('writes each buffered console call with its level, its stream and the file', async () => {
  const outputFile = path.join(dir, 'levels.jsonl')
  const reporter = new JestSidecarReporter({}, { outputFile })
  reporter.onTestResult(
    TEST,
    result('/work/a.test.ts', [
      { type: 'log', message: 'one', origin: 'at a.test.ts:1:1' },
      { type: 'info', message: 'two', origin: '' },
      { type: 'warn', message: 'three', origin: '' },
      { type: 'error', message: 'four\nfive', origin: '' },
      { type: 'debug', message: 'six', origin: '' },
    ]),
  )
  reporter.onTestResult(TEST, result('/work/b.test.ts', [{ type: 'log', message: '', origin: '' }]))
  assert.deepEqual(parseSidecar(await readFile(outputFile, 'utf8')), [
    { file: '/work/a.test.ts', stream: 'stdout', level: 'log', text: 'one' },
    { file: '/work/a.test.ts', stream: 'stdout', level: 'info', text: 'two' },
    { file: '/work/a.test.ts', stream: 'stderr', level: 'warn', text: 'three' },
    { file: '/work/a.test.ts', stream: 'stderr', level: 'error', text: 'four\nfive' },
    { file: '/work/a.test.ts', stream: 'stdout', level: 'debug', text: 'six' },
    { file: '/work/b.test.ts', stream: 'stdout', level: 'log', text: '' },
  ])
})

test('a file with no console (Jest leaves it undefined) writes nothing, and the file starts empty', async () => {
  const outputFile = path.join(dir, 'empty.jsonl')
  const reporter = new JestSidecarReporter({}, { outputFile })
  reporter.onTestResult(TEST, result('/work/a.test.ts'))
  assert.equal(await readFile(outputFile, 'utf8'), '')
  assert.equal(reporter.getLastError(), undefined)
})

test('assert goes to stderr and count to stdout, as Node’s Console writes them', async () => {
  const outputFile = path.join(dir, 'streams.jsonl')
  const reporter = new JestSidecarReporter({}, { outputFile })
  reporter.onTestResult(
    TEST,
    result('/work/a.test.ts', [
      { type: 'assert', message: 'a', origin: '' },
      { type: 'count', message: 'c: 1', origin: '' },
    ]),
  )
  const streams = parseSidecar(await readFile(outputFile, 'utf8')).map((entry) => entry.stream)
  assert.deepEqual(streams, ['stderr', 'stdout'])
})

test('without an outputFile it writes the file in PROVINO_SIDECAR_OUT, and with neither it throws', async () => {
  const outputFile = path.join(dir, 'env.jsonl')
  const saved = process.env.PROVINO_SIDECAR_OUT
  try {
    process.env.PROVINO_SIDECAR_OUT = outputFile
    const reporter = new JestSidecarReporter({})
    reporter.onTestResult(
      TEST,
      result('/work/a.test.ts', [{ type: 'log', message: 'x', origin: '' }]),
    )
    assert.equal(parseSidecar(await readFile(outputFile, 'utf8')).length, 1)
    delete process.env.PROVINO_SIDECAR_OUT
    assert.throws(() => new JestSidecarReporter({}), /PROVINO_SIDECAR_OUT/)
  } finally {
    if (saved === undefined) delete process.env.PROVINO_SIDECAR_OUT
    else process.env.PROVINO_SIDECAR_OUT = saved
  }
})
