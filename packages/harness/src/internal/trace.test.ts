import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError, type HarnessErrorCode } from '../errors.ts'
import { assertTraceFromOneFile, parseTrace, readTrace } from './trace.ts'

function rejects(code: HarnessErrorCode, ...mentions: string[]): (error: unknown) => boolean {
  return (error) =>
    error instanceof HarnessError &&
    error.code === code &&
    mentions.every((text) => error.message.includes(text))
}

test('a trace is its lines, without the newline that ends the last one', () => {
  assert.deepEqual(parseTrace(''), [])
  assert.deepEqual(parseTrace('a\n'), ['a'])
  assert.deepEqual(parseTrace('file start\nA body\nfile end\n'), [
    'file start',
    'A body',
    'file end',
  ])
})

test('an empty step in the middle or at the end is a step; text without a final newline is kept', () => {
  assert.deepEqual(parseTrace('a\n\nb\n'), ['a', '', 'b'])
  assert.deepEqual(parseTrace('a\n\n'), ['a', ''])
  assert.deepEqual(parseTrace('\n'), [''])
  assert.deepEqual(parseTrace('a\nb'), ['a', 'b'])
})

test('readTrace reads the file, and a file nobody wrote is no trace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-trace-'))
  try {
    const file = path.join(dir, 'trace.txt')
    assert.deepEqual(await readTrace(file), [])
    await writeFile(file, 'test L1\nafterAll L1 #2\n')
    assert.deepEqual(await readTrace(file), ['test L1', 'afterAll L1 #2'])
    await assert.rejects(readTrace(dir), (error: unknown) => !(error instanceof HarnessError))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a trace from one test file is fine, and so is no trace from many', () => {
  assertTraceFromOneFile(['a', 'b'], ['a.test.ts'], 'f (jest)')
  assertTraceFromOneFile([], ['a.test.ts', 'b.test.ts'], 'f (jest)')
  assertTraceFromOneFile([], [], 'f (jest)')
})

test('the message counts steps in the singular too', () => {
  assert.throws(
    () => assertTraceFromOneFile(['a'], ['a.test.ts', 'b.test.ts'], 'f (jest)'),
    rejects('HARNESS_TRACE_MULTIPLE_FILES', '1 step but'),
  )
})

test('steps from two or more test files are HARNESS_TRACE_MULTIPLE_FILES and name the files', () => {
  assert.throws(
    () => assertTraceFromOneFile(['a', 'b'], ['a.test.ts', 'b.jest.test.ts'], 'area/x (jest)'),
    rejects(
      'HARNESS_TRACE_MULTIPLE_FILES',
      'area/x (jest)',
      '2 steps',
      '2 test files',
      'a.test.ts',
      'b.jest.test.ts',
    ),
  )
})
