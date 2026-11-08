import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { SnapshotError } from './errors.ts'
import { checkSnapHeader, evaluateSnapFile, keyToTestName, serializeSnapFile } from './snap-file.ts'
import {
  addExtraLineBreaks,
  escapeBacktickString,
  normalizeNewlines,
  removeExtraLineBreaks,
} from './text.ts'

const HEADER = '// Test Snapshot v1, https://example.test'

describe('text', () => {
  test('escapes backticks, backslashes and a dollar before a brace', () => {
    const open = '$' + '{'
    assert.equal(escapeBacktickString(`a\`b\\c${open}d}`), `a\\\`b\\\\c\\${open}d}`)
  })

  test('pads and unpads a multi-line snapshot, leaving a single line alone', () => {
    assert.equal(addExtraLineBreaks('a\nb'), '\na\nb\n')
    assert.equal(addExtraLineBreaks('ab'), 'ab')
    assert.equal(removeExtraLineBreaks('\na\nb\n'), 'a\nb')
    assert.equal(removeExtraLineBreaks('\n\n'), '\n\n', 'two characters are not padding')
    assert.equal(
      removeExtraLineBreaks('  a\n'),
      '  a\n',
      'only a snapshot that starts with a break',
    )
  })

  test('turns CRLF and CR into LF', () => {
    assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd')
  })
})

describe('the .snap file', () => {
  test('is written in natural order with blank lines between entries', () => {
    const text = serializeSnapFile({ 'b 10': '1', 'b 2': '2', 'a 1': '3' }, HEADER)
    assert.equal(
      text,
      `${HEADER}\n\nexports[\`a 1\`] = \`3\`;\n\nexports[\`b 2\`] = \`2\`;\n\nexports[\`b 10\`] = \`1\`;\n`,
    )
  })

  test('is read back by running it, with the escapes undone', () => {
    const data = {
      'a 1': `back\`tick \\ and $${'{'}dollar}`,
      'b 1': '\nmulti\nline\n',
    }
    const read = evaluateSnapFile(serializeSnapFile(data, HEADER))
    assert.deepEqual({ ...read }, data)
  })

  test('a file that throws gives what it had exported, and a garbage file gives nothing', () => {
    assert.deepEqual(
      { ...evaluateSnapFile('exports[`a 1`] = `1`;\nthrow new Error("x")') },
      { 'a 1': '1' },
    )
    assert.deepEqual({ ...evaluateSnapFile('this is not javascript') }, {})
  })

  test('the header check names what is wrong', () => {
    assert.equal(checkSnapHeader(`${HEADER}\n\n`, HEADER), null)
    assert.match(checkSnapHeader('exports[`a 1`] = `1`;\n', HEADER) ?? '', /no snapshot header/)
    assert.match(
      checkSnapHeader('// Other Snapshot v1, https://x\n', HEADER) ?? '',
      /header is "\/\/ Other Snapshot v1, https:\/\/x"/,
    )
  })

  test('a key goes back to the test name it was made from', () => {
    assert.equal(keyToTestName('a b: hint 12'), 'a b: hint')
    assert.throws(
      () => keyToTestName('no count'),
      (error) => error instanceof SnapshotError && error.code === 'SNAPSHOT_BAD_KEY',
    )
  })
})
