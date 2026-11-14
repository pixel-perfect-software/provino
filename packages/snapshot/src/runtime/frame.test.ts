// `topFrame` (B23d B1): the frame an inline snapshot is written at. The ordinary forms are held to
// stack-utils' `parseLine`, which Jest's `getTopFrame` parses with; the two forms it mis-reads
// (a path with ` (` in it, and `async` before a bare location) are read right here.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, test } from 'node:test'
import { topFrame } from './frame.ts'

const harness = createRequire(new URL('../../../harness/package.json', import.meta.url))
const messageUtil = createRequire(
  createRequire(harness.resolve('jest/package.json')).resolve('jest-message-util/package.json'),
)
const StackUtils = messageUtil('stack-utils') as new (options: {
  cwd: string
}) => {
  parseLine(line: string): { file?: string; line?: number; column?: number } | null
}
const stackUtils = new StackUtils({ cwd: 'something which does not exist' })

/** `topFrame` of a one-line stack. */
const frame = (line: string) => topFrame(`Error\n${line}`)

describe('topFrame', () => {
  const ordinary = [
    '    at Object.<anonymous> (/Users/x/proj/a.test.ts:3:4)',
    '    at /Users/x/proj/a.test.ts:3:4',
    '    at async fn (/Users/x/proj/a.test.ts:12:30)',
    '    at new Widget (/Users/x/proj/a.test.ts:7:9)',
    '    at Object.toBe [as toBe] (/Users/x/proj/a.test.ts:5:6)',
    '    at fn (file:///Users/x/proj/a.test.ts:3:4)',
    '    at file:///Users/x/proj/a.test.ts:3:4',
    '    at <anonymous> (/Users/x/proj/a.test.ts:3:4)',
  ]

  for (const line of ordinary) {
    test(`reads ${line.trim()} as stack-utils does`, () => {
      const expected = stackUtils.parseLine(line.trim())
      const got = frame(line)
      assert.ok(expected?.file !== undefined && got !== undefined)
      assert.equal(got.file.replace(/^file:\/\//, ''), expected.file.replace(/^file:\/\//, ''))
      assert.equal(got.line, expected.line)
      assert.equal(got.column, expected.column)
    })
  }

  test('a path with a space and a parenthesis, in the bare form, is the whole path', () => {
    assert.deepEqual(frame('    at /Users/x/My Project (1)/a.test.ts:3:4'), {
      file: '/Users/x/My Project (1)/a.test.ts',
      line: 3,
      column: 4,
    })
  })

  test('the same path in the named form', () => {
    assert.deepEqual(frame('    at fn (/Users/x/My Project (1)/a.test.ts:3:4)'), {
      file: '/Users/x/My Project (1)/a.test.ts',
      line: 3,
      column: 4,
    })
  })

  test('`async` before a bare location is not part of the file', () => {
    assert.deepEqual(frame('    at async /a/b.ts:3:4'), { file: '/a/b.ts', line: 3, column: 4 })
    assert.deepEqual(frame('    at async file:///a/b.ts:3:4'), {
      file: '/a/b.ts',
      line: 3,
      column: 4,
    })
  })

  test('frames in node_modules and node: are passed over, and a stack with none is undefined', () => {
    const stack = [
      'Error',
      '    at x (/p/node_modules/lib/index.js:1:1)',
      '    at node:internal/process/task_queues:105:5',
      '    at async Promise.all (index 0)',
      '    at fn (/p/a.test.ts:9:9)',
    ].join('\n')
    assert.deepEqual(topFrame(stack), { file: '/p/a.test.ts', line: 9, column: 9 })
    assert.equal(
      topFrame('Error: x\n    at node:fs:1:1\n    at async Promise.all (index 0)'),
      undefined,
    )
  })
})
