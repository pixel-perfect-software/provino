import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRegion } from './region.ts'
import { displayWidth } from './width.ts'

const ESC = String.fromCharCode(27)
const up = (n: number) => `${ESC}[${n}F`
const down = (n: number) => `${ESC}[${n}E`
const erase = `${ESC}[0J`
const line = `${ESC}[2K`

test('the first render draws the footer whole', () => {
  const region = createRegion(80)
  assert.equal(region.render([], ['status', 'one']), 'status\none\n')
  assert.equal(region.height(), 2)
})

test('an unchanged footer writes nothing', () => {
  const region = createRegion(80)
  region.render([], ['status', 'one'])
  assert.equal(region.render([], ['status', 'one']), '')
})

test('only the changed lines are rewritten, the rest stepped over', () => {
  const region = createRegion(80)
  region.render([], ['a', 'b', 'c', 'd'])
  assert.equal(
    region.render([], ['a', 'B', 'c', 'd']),
    `${up(4)}${down(1)}${line}B${down(1)}${down(2)}`,
  )
  assert.equal(
    region.render([], ['A', 'B', 'c', 'D']),
    `${up(4)}${line}A${down(1)}${down(2)}${line}D${down(1)}`,
  )
})

test('lines that scroll make a full redraw: up, erase down, scrolled lines, footer', () => {
  const region = createRegion(80)
  region.render([], ['status', 'one'])
  assert.equal(
    region.render(['done 1', 'done 2'], ['status', 'one']),
    `${up(2)}${erase}done 1\ndone 2\nstatus\none\n`,
  )
})

test('a footer whose height changes is redrawn whole', () => {
  const region = createRegion(80)
  region.render([], ['status', 'one'])
  assert.equal(region.render([], ['status', 'one', 'two']), `${up(2)}${erase}status\none\ntwo\n`)
  assert.equal(region.render([], ['status']), `${up(3)}${erase}status\n`)
})

test('every footer line is cut to columns - 1, scrolled lines are not', () => {
  const region = createRegion(10)
  const out = region.render(
    ['a long scrolled line that stays whole'],
    ['0123456789abc', '日本語日本語日本語'],
  )
  const rows = out.split('\n')
  assert.equal(rows[0], 'a long scrolled line that stays whole')
  assert.equal(rows[1], '01234567…')
  assert.ok(displayWidth(rows[2] as string) <= 9)
  assert.ok(displayWidth(rows[1] as string) <= 9)
})

test('erase clears the footer once', () => {
  const region = createRegion(80)
  assert.equal(region.erase(), '')
  region.render([], ['a', 'b'])
  assert.equal(region.erase(), `${up(2)}${erase}`)
  assert.equal(region.erase(), '')
  assert.equal(region.height(), 0)
})

test('a resize redraws the footer whole, at the new width', () => {
  const region = createRegion(80)
  region.render([], ['abcdefghij'])
  region.resize(6)
  assert.equal(region.render([], ['abcdefghij']), `${up(1)}${erase}abcd…\n`)
})
