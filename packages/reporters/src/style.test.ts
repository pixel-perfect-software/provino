import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createStyle } from './style.ts'

const ESC = String.fromCharCode(27)

describe('createStyle', () => {
  test('with colour off every style returns its text as given', () => {
    const style = createStyle(false)
    assert.equal(style.enabled, false)
    for (const paint of [
      style.bold,
      style.dim,
      style.red,
      style.green,
      style.yellow,
      style.cyan,
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

  test('a badge is the word on an inverse, bold block of its colour, as Jest’s PASS and FAIL', () => {
    const badge = createStyle(true).badge('PASS', 'green')
    assert.ok(
      badge.includes(`${ESC}[7m`) && badge.includes(`${ESC}[1m`) && badge.includes(`${ESC}[32m`),
    )
    assert.ok(badge.includes(' PASS '))
    assert.ok(badge.startsWith(`${ESC}[0m`) && badge.endsWith(`${ESC}[0m`))
  })
})
