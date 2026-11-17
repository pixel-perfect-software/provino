import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { copyFlat } from '../model/bound.ts'
import { cleanText, oneLine } from './sanitize.ts'

describe('a name or a message on one line', () => {
  test('newlines and tabs become one space a run; text with none is returned as it is', () => {
    assert.equal(oneLine('a\nb\t\tc\n\nd'), 'a b c d')
    assert.equal(oneLine('plain text'), 'plain text')
    assert.equal(oneLine('two  spaces stay'), 'two  spaces stay')
  })

  test('control characters and escape sequences are dropped, as cleanText drops them', () => {
    const dirty = 'first\r\nsecond \u001b[2J\u001b[1;1H gone\u0007'
    assert.equal(oneLine(dirty), 'first second  gone')
    assert.equal(cleanText(dirty, false), 'first\nsecond  gone')
  })
})

describe('a copy of a string', () => {
  test('is equal to its source, whatever it holds', () => {
    for (const text of ['', 'abc', 'naïve — 日本語 🟩', 'x'.repeat(2000)]) {
      assert.equal(copyFlat(text), text)
    }
  })
})
