// `styleFor`: the colours of text written outside a reporter. Jest's chalk 4 follows the terminal
// of the stream it writes to by default (stdout), never stderr's.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { styleFor } from './reporters.ts'

const terminal = { isTTY: true, columns: 80 }
const pipe = { isTTY: false }

describe('styleFor', () => {
  it('colours by the stream it is given: a terminal does, a pipe does not', () => {
    const on = styleFor({ env: {}, stream: terminal, ci: false })
    const off = styleFor({ env: {}, stream: pipe, ci: false })
    assert.notEqual(on.bold('x'), 'x')
    assert.equal(off.bold('x'), 'x')
  })
})
