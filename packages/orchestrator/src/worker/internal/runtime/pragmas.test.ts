// The worker's docblock reader against jest-docblock 30.5's own cases (`parse` of `extract`), and
// its 4 KB head read against files whose docblock does and doesn't fit.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { EOL, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { parsePragmas, pragmaValue, readPragmas } from './pragmas.ts'

const parsed = (source: string): Record<string, unknown> => ({ ...parsePragmas(source) })

describe('parsePragmas, as jest-docblock reads a file', () => {
  test('directives, comments, and a bare directive', () => {
    const code =
      `/**${EOL}` +
      ` * Copyright (c) Meta Platforms, Inc. and affiliates.${EOL}` +
      ` * @team foo${EOL}` +
      ` * @css a b${EOL}` +
      ` *${EOL}` +
      ` * And some license here${EOL}` +
      ` * @preserve-whitespace${EOL}` +
      ' */'
    assert.deepEqual(parsed(code), { css: 'a b', 'preserve-whitespace': '', team: 'foo' })
  })

  test('the same directive twice or three times is a list', () => {
    assert.deepEqual(parsed(`/**${EOL} * @x foo${EOL} * @x bar${EOL} * @y${EOL} */`), {
      x: ['foo', 'bar'],
      y: '',
    })
    assert.deepEqual(parsed(`/**${EOL} * @x foo${EOL} * @x bar${EOL} * @x baz${EOL} */`), {
      x: ['foo', 'bar', 'baz'],
    })
  })

  test('a value wrapped over lines is one value', () => {
    const code =
      `/**${EOL}` +
      ` * @class A long declaration of a class${EOL}` +
      ` *        goes here, so we can read it and enjoy${EOL}` +
      ` *${EOL}` +
      ` * @preserve-whitespace${EOL}` +
      ' */'
    assert.deepEqual(parsed(code), {
      class: 'A long declaration of a class goes here, so we can read it and enjoy',
      'preserve-whitespace': '',
    })
  })

  test('line comments are dropped from values, and urls are kept', () => {
    assert.deepEqual(parsed(`/**${EOL} * @team foo${EOL} * // TODO: test${EOL} */`), {
      team: 'foo',
    })
    assert.deepEqual(parsed(`/**${EOL} * @format: everything${EOL}// keep me */`), {
      'format:': 'everything',
    })
    assert.deepEqual(parsed(`/**${EOL} * @see: https://example.com${EOL} */`), {
      'see:': 'https://example.com',
    })
  })

  test('a plain block comment counts, and only the first one', () => {
    assert.deepEqual(parsed(`/*${EOL} * @team foo${EOL}*/${EOL}const x = foo;`), { team: 'foo' })
    // A pragma starts its line: a name in the middle of a comment is text.
    assert.deepEqual(parsed(`/* some comment @team foo */${EOL}const x = foo;`), {})
    assert.deepEqual(parsed(`/**${EOL} * @team foo${EOL}*/${EOL}const x = foo;${EOL}/** @b c */`), {
      team: 'foo',
    })
    assert.deepEqual(parsed('/** @jest-environment jsdom */\ntest()'), {
      'jest-environment': 'jsdom',
    })
  })

  test('no leading comment, or one that is not closed, has none', () => {
    assert.deepEqual(parsed('const x = 1\n/** @a b */'), {})
    assert.deepEqual(parsed('// @a b\n'), {})
    assert.deepEqual(parsed('/** @a b'), {})
    assert.deepEqual(parsed('\n\n  /** @a b */'), { a: 'b' })
    assert.deepEqual(parsed('/**/ @a b'), {})
  })

  test('a lone carriage return inside the comment is not a comment, as in jest-docblock', () => {
    assert.deepEqual(parsed('/** @a b\r@c d */'), {})
  })
})

describe('readPragmas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provino-pragmas-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (name: string, text: string): string => {
    const file = join(dir, name)
    writeFileSync(file, text)
    return file
  }

  test('reads a docblock in the head, and a file with none', () => {
    assert.deepEqual(
      { ...readPragmas(write('a.ts', `/** @x y */\n${'a'.repeat(9000)}`)) },
      {
        x: 'y',
      },
    )
    assert.deepEqual({ ...readPragmas(write('b.ts', `${'a'.repeat(9000)}/** @x y */`)) }, {})
  })

  test('extends past 4 KB for a comment that is open there, or leading whitespace', () => {
    const long = `/**\n${' * filler\n'.repeat(1000)} * @x y\n */\ncode`
    assert.deepEqual({ ...readPragmas(write('c.ts', long)) }, { x: 'y' })
    assert.deepEqual(
      { ...readPragmas(write('d.ts', `${' '.repeat(5000)}/** @x y */`)) },
      { x: 'y' },
    )
  })

  test('a file that cannot be read has none', () => {
    assert.deepEqual({ ...readPragmas(join(dir, 'missing.ts')) }, {})
  })
})

test('pragmaValue takes the last of a repeated pragma', () => {
  assert.equal(pragmaValue({ a: ['1', '2'], b: 'x' }, 'a'), '2')
  assert.equal(pragmaValue({ b: 'x' }, 'b'), 'x')
  assert.equal(pragmaValue({}, 'c'), undefined)
})
