import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createStringTable,
  failureText,
  MAX_FAILURE_TEXT,
  plainText,
  type ReportData,
  roundMs,
  serializeData,
  TRUNCATED,
} from './data.ts'

const EMPTY: ReportData = {
  version: 1,
  title: 'project',
  startedAt: '2026-11-19T12:00:00.000Z',
  durationMs: 10,
  reason: 'passed',
  workers: 0,
  strings: [],
  files: [],
  tests: [],
  failures: [],
  fileErrors: [],
  runErrors: [],
  omitted: 0,
}

describe('the string table', () => {
  it('gives a text one id however often it is seen, in the order texts first came', () => {
    const table = createStringTable()
    assert.equal(table.intern('src/a.test.ts'), 0)
    assert.equal(table.intern('adds'), 1)
    assert.equal(table.intern('src/a.test.ts'), 0)
    assert.equal(table.intern(''), 2)
    assert.equal(table.intern('adds'), 1)
    assert.deepEqual(table.strings, ['src/a.test.ts', 'adds', ''])
  })
})

describe('the data as JSON in the page', () => {
  it('round trips: what the page parses is what the reporter built', () => {
    const data: ReportData = {
      ...EMPTY,
      strings: ['a.test.ts', 'adds', '', 'proj'],
      files: [[0, 1, 12.5, 2, 0, 13, -1, 3]],
      tests: [[0, [1], 1, 0.4]],
      failures: [[0, 'Error: nope\n  at a.test.ts:1:1']],
      fileErrors: [[0, 'boom']],
      runErrors: ['late'],
      snapshots: { total: 3, matched: 1, unmatched: 1, added: 1, updated: 0, unchecked: 0 },
    }
    assert.deepEqual(JSON.parse(serializeData(data)), data)
  })

  it('escapes `<`, U+2028 and U+2029, so no text can end the script or open a comment', () => {
    const hostile = '</script><script>alert(1)</script><!--     -->'
    const json = serializeData({ ...EMPTY, strings: [hostile], title: hostile })
    assert.equal(json.includes('<'), false)
    assert.equal(json.includes('</script'), false)
    assert.equal(json.includes(' '), false)
    assert.equal(json.includes(' '), false)
    assert.match(json, /\\u003c\/script>/)
    // The escapes are the same characters to `JSON.parse`.
    const parsed = JSON.parse(json) as ReportData
    assert.deepEqual(parsed.strings, [hostile])
    assert.equal(parsed.title, hostile)
  })

  it('writes a lone surrogate as an escape, so the page is well-formed text', () => {
    const json = serializeData({ ...EMPTY, strings: ['\ud800 and \udc00'] })
    assert.equal(json.includes('\ud800'), false)
    assert.deepEqual((JSON.parse(json) as ReportData).strings, ['\ud800 and \udc00'])
  })
})

describe('the text of a failure', () => {
  const error = {
    name: 'Error',
    message: 'expect(received).toBe(expected)',
    stack: [
      'Error: expect(received).toBe(expected)',
      '    at Object.<anonymous> (/project/src/a.test.ts:3:15)',
      '    at run (/project/node_modules/lib/run.js:1:1)',
      '    at node:internal/process/task_queues:1:1',
    ].join('\n'),
  }

  it('is the message and the user’s frames, with the run’s root left out of every path', () => {
    assert.equal(
      failureText([error], '/project'),
      'expect(received).toBe(expected)\n  at Object.<anonymous> (src/a.test.ts:3:15)',
    )
    assert.equal(failureText([error], '/project/'), failureText([error], '/project'))
    // Another directory that ends the same way is not the root.
    assert.match(
      failureText([{ ...error, message: 'see /other/project/src/b.ts' }], '/project'),
      /^see \/other\/project\/src\/b\.ts/,
    )
  })

  it('leaves out the real path of a root that is a symlink too, as frames print it', () => {
    // macOS: the run's root is `/var/folders/…`, a frame holds `/private/var/folders/…`.
    const frames = {
      name: 'Error',
      message: 'boom',
      stack: [
        'Error: boom',
        '    at a (/private/var/folders/x/proj/src/a.test.ts:1:1)',
        '    at b (/var/folders/x/proj/src/b.test.ts:2:2)',
      ].join('\n'),
    }
    const roots = ['/var/folders/x/proj', '/private/var/folders/x/proj']
    assert.equal(
      failureText([frames], roots),
      'boom\n  at a (src/a.test.ts:1:1)\n  at b (src/b.test.ts:2:2)',
    )
    // With the root alone the real path stays: that was the leak.
    assert.match(failureText([frames], roots[0] as string), /\/private\/var\/folders\/x\/proj\/src/)
  })

  it('drops colour codes and control characters, and keeps tabs and newlines', () => {
    assert.equal(
      plainText('\u001b[31mred\u001b[0m\tand\r\nmore\u0000\u0007\u001b]8;;x\u0007'),
      'red\tand\nmore',
    )
    assert.equal(
      failureText([{ name: 'Error', message: '\u001b[32m+ ok\u001b[39m' }], '/project'),
      '+ ok',
    )
  })

  it('is cut at 16 KB, marked, and never splits a surrogate pair', () => {
    const long = failureText([{ name: 'Error', message: 'x'.repeat(MAX_FAILURE_TEXT * 2) }], '/')
    assert.equal(long.length, MAX_FAILURE_TEXT)
    assert.ok(long.endsWith(TRUNCATED))
    // A pair that straddles the cut is dropped whole.
    const message = `${'x'.repeat(MAX_FAILURE_TEXT - TRUNCATED.length - 1)}😀${'y'.repeat(100)}`
    const cut = failureText([{ name: 'Error', message }], '/')
    assert.ok(cut.length <= MAX_FAILURE_TEXT)
    assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])/)
    // Text at the limit is kept whole.
    const exact = 'z'.repeat(MAX_FAILURE_TEXT)
    assert.equal(failureText([{ name: 'Error', message: exact }], '/'), exact)
  })

  it('names the cause and each of several errors', () => {
    const text = failureText(
      [{ name: 'Error', message: 'outer', cause: { name: 'TypeError', message: 'inner' } }],
      '/project',
    )
    assert.equal(text, 'outer\n\nCaused by:\n  TypeError: inner')
  })
})

describe('milliseconds', () => {
  it('are kept to one decimal', () => {
    assert.equal(roundMs(1.2345), 1.2)
    assert.equal(roundMs(12), 12)
    assert.equal(roundMs(0.04), 0)
  })
})
