import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ESC } from '../style.ts'
import { attribute, clean, content, write, writeParent } from './xml.ts'

describe('clean', () => {
  test('returns text with nothing to take out as it is', () => {
    for (const text of ['', 'plain', 'tab\tand\nlines\r\n', 'é ✓ <&> "quoted"', '\u{1F600}']) {
      assert.equal(clean(text), text, JSON.stringify(text))
    }
  })

  test('takes out ANSI sequences, 8-bit CSI ones, and the characters XML 1.0 forbids', () => {
    assert.equal(clean(`${ESC}[31mred${ESC}[39m`), 'red')
    assert.equal(clean('\u009B31mred'), 'red')
    assert.equal(
      clean('bell\u0007 nul\u0000 vt\u000B ff\u000C unit\u001F end￾￿'),
      'bell nul vt ff unit end',
    )
  })
})

describe('escaping', () => {
  test('escapes what XML needs, in text and in an attribute', () => {
    assert.equal(content('a < b & c > d "q"'), 'a &lt; b &amp; c &gt; d "q"')
    assert.equal(attribute('a "b" & <c>\n\r\t'), 'a &quot;b&quot; &amp; &lt;c&gt;&#10;&#13;&#9;')
  })
})

describe('write', () => {
  test('indents children, closes an empty element on itself and keeps text on one line', () => {
    const element = {
      name: 'a',
      attributes: { x: 1, y: undefined },
      children: [{ name: 'b' }, { name: 'c', text: 'hi <there>' }],
    }
    assert.equal(write(element), '<a x="1">\n  <b/>\n  <c>hi &lt;there&gt;</c>\n</a>')
  })

  test('writeParent joins children that are already written, as write does', () => {
    const children = [{ name: 'b' }, { name: 'c', text: 'x' }]
    const parent = { name: 'a', attributes: { x: 1 } }
    assert.equal(
      writeParent(
        parent,
        children.map((child) => write(child, 1)),
      ),
      write({ ...parent, children }),
    )
    assert.equal(writeParent(parent, []), write(parent))
  })
})
