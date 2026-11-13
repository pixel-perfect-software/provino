// T6.2: `test/lazy.test-d.ts` must compile with 0 errors (`pnpm test:types`, both compilers), and each of
// its `@ts-expect-error` directives must fire for the reason it states: with the directives removed,
// the compiler must report that directive's code and message on the next line, on TS 7.0.2 and 5.9.3,
// and nothing else.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMPILERS } from './support/tsc.ts'
import {
  checkTypeErrors,
  compareDiagnostics,
  parseDirectives,
  stripDirectives,
} from './support/type-check.ts'

const source = readFileSync(fileURLToPath(new URL('./lazy.test-d.ts', import.meta.url)), 'utf8')

describe('lazy.test-d.ts directives', () => {
  test('has at least 20 directives, each with a code and a substring', () => {
    const directives = parseDirectives(source)
    assert.ok(directives.length >= 20, `${directives.length} directives`)
    for (const directive of directives) {
      assert.match(directive.code, /^TS\d+$/)
      assert.ok(
        directive.text.length >= 8,
        `line ${directive.line}: "${directive.text}" is too short to prove a reason`,
      )
    }
  })

  for (const compiler of COMPILERS) {
    test(`each removed directive fails with its code and text on ${compiler}`, () => {
      assert.deepEqual(checkTypeErrors(compiler, source), [])
    })
  }

  test('a directive with a wrong substring is reported', () => {
    const [first] = parseDirectives(source)
    assert.ok(first !== undefined)
    const planted = source
      .split('\n')
      .map((line, index) =>
        index + 1 === first.line ? line.replace(first.text, 'a message nothing says') : line,
      )
      .join('\n')
    const problems = checkTypeErrors('typescript', planted)
    assert.equal(problems.length, 2, problems.join('\n'))
    assert.match(
      problems[0] ?? '',
      new RegExp(`line ${first.line}: expected ${first.code} containing "a message nothing says"`),
    )
  })

  test('a directive with no error behind it is reported', () => {
    const problems = compareDiagnostics([{ line: 1, code: 'TS2322', text: 'not assignable' }], [])
    assert.deepEqual(problems, [
      'line 1: expected TS2322 containing "not assignable" on the next line, got no error',
    ])
  })

  test('an error no directive covers is reported', () => {
    const problems = compareDiagnostics(
      [],
      [{ file: 'x.ts', line: 3, column: 1, code: 'TS2339', message: 'Property does not exist' }],
    )
    assert.deepEqual(problems, ['line 3: unexpected TS2339 Property does not exist'])
  })

  test('a bare @ts-expect-error is refused', () => {
    assert.throws(() => parseDirectives('// @ts-expect-error\nfoo()'), /must name its error code/)
  })

  test('stripping keeps every line number', () => {
    const stripped = stripDirectives(source)
    assert.equal(stripped.split('\n').length, source.split('\n').length)
    assert.doesNotMatch(stripped, /^\s*\/\/ @ts-expect-error/m)
  })
})
