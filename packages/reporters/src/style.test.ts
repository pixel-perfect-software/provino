import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createStyle, ESC } from './style.ts'

describe('createStyle', () => {
  test('with colour off every style returns its text as given', () => {
    const style = createStyle(false)
    for (const paint of [
      style.bold,
      style.dim,
      style.red,
      style.green,
      style.yellow,
      style.magenta,
    ]) {
      assert.equal(paint('text'), 'text')
    }
    assert.equal(style.badge('PASS', 'green'), 'PASS')
  })

  test('with colour on a style wraps its text in an SGR sequence and its reset', () => {
    const style = createStyle(true)
    assert.equal(style.red('x'), `${ESC}[31mx${ESC}[39m`)
    assert.equal(style.bold('x'), `${ESC}[1mx${ESC}[22m`)
    assert.equal(style.dim('x'), `${ESC}[2mx${ESC}[22m`)
  })

  test('leaves empty text empty', () => {
    assert.equal(createStyle(true).red(''), '')
  })

  test('styles nest: an inner reset opens the outer style again', () => {
    const style = createStyle(true)
    const nested = style.red(`a${style.green('b')}c`)
    assert.equal(nested, `${ESC}[31ma${ESC}[32mb${ESC}[39m${ESC}[31mc${ESC}[39m`)
  })

  // The expected strings are what chalk 4.1.2 (Jest's) returns at level 1 for the same calls: it
  // closes the style before each line break and opens it again after (chalk's `applyStyle`).
  test('multi-line text is closed and reopened around each line break, as chalk 4 does', () => {
    const style = createStyle(true)
    assert.equal(style.red('a\nb'), `${ESC}[31ma${ESC}[39m\n${ESC}[31mb${ESC}[39m`)
    assert.equal(
      style.red('a\n\nb'),
      `${ESC}[31ma${ESC}[39m\n${ESC}[31m${ESC}[39m\n${ESC}[31mb${ESC}[39m`,
    )
  })

  test('a CRLF keeps its carriage return after the close code, as chalk 4 does', () => {
    assert.equal(createStyle(true).red('a\r\nb'), `${ESC}[31ma${ESC}[39m\r\n${ESC}[31mb${ESC}[39m`)
  })

  test('bold over red on two lines is chalk’s `bold.red` (Jest’s FAIL_COLOR, a threshold failure)', () => {
    const style = createStyle(true)
    assert.equal(
      style.bold(style.red('Jest: one\nJest: two')),
      `${ESC}[1m${ESC}[31mJest: one${ESC}[39m${ESC}[22m\n${ESC}[1m${ESC}[31mJest: two${ESC}[39m${ESC}[22m`,
    )
  })

  test('an inner style on two lines and an outer one around it: reopened, then split by line', () => {
    const style = createStyle(true)
    assert.equal(
      style.red(`a${style.green('b\nc')}d`),
      `${ESC}[31ma${ESC}[32mb${ESC}[39m${ESC}[31m${ESC}[39m\n${ESC}[31m${ESC}[32mc${ESC}[39m${ESC}[31md${ESC}[39m`,
    )
  })

  test('a badge is the word on an inverse, bold block of its colour, as Jest’s PASS and FAIL', () => {
    const badge = createStyle(true).badge('PASS', 'green')
    assert.ok(
      badge.includes(`${ESC}[7m`) && badge.includes(`${ESC}[1m`) && badge.includes(`${ESC}[32m`),
    )
    assert.ok(badge.includes(' PASS '))
    assert.ok(badge.startsWith(`${ESC}[0m`) && badge.endsWith(`${ESC}[0m`))
  })
})
