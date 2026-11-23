import assert from 'node:assert/strict'
import { test } from 'provino'
import { hyperlink, stripControls } from './ansi.ts'
import { WIDE_RANGES } from './vendor/width-table.ts'
import { displayWidth, fitWidth, fitWidthLeft } from './width.ts'

const ESC = String.fromCharCode(27)

test('ASCII takes one column a character', () => {
  assert.equal(displayWidth(''), 0)
  assert.equal(displayWidth('hello world'), 11)
  assert.equal(displayWidth('src/a.test.ts'), 13)
})

test('CJK and Hangul are two columns', () => {
  assert.equal(displayWidth('日本語'), 6)
  assert.equal(displayWidth('한국어'), 6)
  assert.equal(displayWidth('ＡＢ'), 4) // fullwidth Latin
  assert.equal(displayWidth('a日b'), 4)
})

test('emoji with Emoji_Presentation take two, text-default ones take one unless VS16 follows', () => {
  assert.equal(displayWidth('✅'), 2)
  assert.equal(displayWidth('❌'), 2)
  assert.equal(displayWidth('⏩'), 2)
  assert.equal(displayWidth('🐢'), 2)
  assert.equal(displayWidth('❤'), 1)
  assert.equal(displayWidth('❤\u{fe0f}'), 2)
  assert.equal(displayWidth('1\u{fe0f}\u{20e3}'), 2)
  // VS15 asks for the text form.
  assert.equal(displayWidth('✅\u{fe0e}'), 1)
})

test('a ZWJ family, a skin tone and a flag are one cluster of two columns', () => {
  assert.equal(displayWidth('👨‍👩‍👧‍👦'), 2)
  assert.equal(displayWidth('👍🏽'), 2)
  assert.equal(displayWidth('🇸🇪'), 2)
})

test('combining marks, joiners and controls take none', () => {
  assert.equal(displayWidth('é'), 1)
  assert.equal(displayWidth('́'), 0)
  assert.equal(displayWidth('a​b'), 2)
  assert.equal(displayWidth('a\u0007b'), 2)
  assert.equal(displayWidth('日́'), 2)
})

test('SGR and OSC 8 sequences count as zero', () => {
  assert.equal(displayWidth(`${ESC}[31mred${ESC}[39m`), 3)
  assert.equal(displayWidth(hyperlink('file:///a', 'a.ts:1:2')), 8)
  assert.equal(displayWidth(`${ESC}[32m✅${ESC}[39m 日`), 5)
  assert.equal(stripControls(`${ESC}[1mx${ESC}[22m${hyperlink('u', 'y')}`), 'xy')
})

test('fitWidth returns text that fits and cuts the rest with an ellipsis', () => {
  assert.equal(fitWidth('abc', 5), 'abc')
  assert.equal(fitWidth('abcdef', 4), 'abc…')
  assert.equal(fitWidth('abcdef', 1), '…')
  assert.equal(fitWidth('abc', 0), '')
})

test('fitWidth never splits a grapheme', () => {
  assert.equal(fitWidth('日本語', 5), '日本…')
  assert.equal(fitWidth('日本語', 4), '日…')
  assert.equal(fitWidth('a👨‍👩‍👧‍👦b', 3), 'a…')
  assert.equal(fitWidth('aééé', 3), 'aé…')
  for (const columns of [1, 2, 3, 4, 5, 6, 7]) {
    assert.ok(displayWidth(fitWidth('日a👍🏽bé语x', columns)) <= columns)
  }
})

test('fitWidth never splits an escape sequence, and keeps the ones after the cut', () => {
  const text = `${ESC}[31mabcdef${ESC}[39m`
  assert.equal(fitWidth(text, 4), `${ESC}[31mabc…${ESC}[39m`)
  const linked = hyperlink('file:///x', 'abcdef')
  const cut = fitWidth(linked, 3)
  assert.equal(displayWidth(cut), 3)
  assert.equal(stripControls(cut), 'ab…')
  assert.ok(cut.endsWith(`${ESC}]8;;${ESC}\\`))
  assert.equal(fitWidth(`${ESC}[31mabc${ESC}[39m`, 3), `${ESC}[31mabc${ESC}[39m`)
})

test('fitWidthLeft keeps the end', () => {
  assert.equal(fitWidthLeft('src/hooks/use-cart.test.tsx', 40), 'src/hooks/use-cart.test.tsx')
  assert.equal(fitWidthLeft('src/hooks/use-cart.test.tsx', 14), '…cart.test.tsx')
  assert.equal(fitWidthLeft('日本語', 5), '…本語')
  assert.equal(fitWidthLeft('abc', 0), '')
})

test('the width table is sorted, disjoint and made of whole pairs', () => {
  assert.equal(WIDE_RANGES.length % 2, 0)
  let previousHigh = -1
  for (let i = 0; i < WIDE_RANGES.length; i += 2) {
    const low = WIDE_RANGES[i] as number
    const high = WIDE_RANGES[i + 1] as number
    assert.ok(low <= high, `range ${i / 2} is backwards`)
    assert.ok(low > previousHigh + 1, `range ${i / 2} touches or overlaps the one before`)
    previousHigh = high
  }
})
