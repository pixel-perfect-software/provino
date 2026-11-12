// B20 (T3.13): our module-runner transform against oracle A (oxc's, as ASTs) and oracle B (run in a
// stub linker) on the scoping corpus. The big corpora (fuzz, excalidraw) are `bench:runner-diff`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXEMPTIONS } from './runner-exemptions.ts'
import { compareOutputs, execute, judge, oracleA, ours } from './runner-oracle.ts'
import { generateScopingPrograms, SCOPING_CASES } from './scoping-corpus.ts'

const GENERATED = generateScopingPrograms(1000, 1)

function check(cases: readonly { id: string; source: string }[]): {
  unexplained: string[]
  exempt: Set<string>
  errors: number
} {
  const unexplained: string[] = []
  const exempt = new Set<string>()
  let errors = 0
  for (const { id, source } of cases) {
    const filename = `/${id}.js`
    const expected = oracleA(filename, source)
    const actual = ours(filename, source)
    if (expected.error !== null) errors++
    const verdict = judge(filename, source, expected, actual)
    if (verdict.reason !== null) unexplained.push(`${id}: ${verdict.reason}`)
    if (verdict.exemption !== null) exempt.add(verdict.exemption)
  }
  return { unexplained, exempt, errors }
}

test('every hand-written scoping case is AST-equal to oracle A, or exempt by name', () => {
  const { unexplained, exempt } = check(SCOPING_CASES)
  assert.deepEqual(unexplained, [])
  assert.ok(exempt.has('mixed-default-namespace-import'), 'a case covers the mixed-import entry')
})

test('generated scoping programs are AST-equal to oracle A, and most are valid programs', () => {
  const { unexplained, errors } = check(GENERATED)
  assert.deepEqual(unexplained.slice(0, 5), [])
  assert.ok(errors < GENERATED.length * 0.5, `${errors} of ${GENERATED.length} programs error`)
})

test('every exemption is listed with a reason', () => {
  for (const entry of EXEMPTIONS) assert.ok(entry.reason.length > 20, entry.id)
})

test('the scoping corpus runs alike in the stub linker (oracle B)', async () => {
  const unexplained: string[] = []
  for (const { id, source } of [...SCOPING_CASES, ...GENERATED.slice(0, 300)]) {
    const filename = `/${id}.js`
    const expected = oracleA(filename, source)
    const actual = ours(filename, source)
    if (expected.code === null || actual.code === null) continue
    if (judge(filename, source, expected, actual).exemption !== null) continue
    const [left, right] = await Promise.all([execute(expected.code), execute(actual.code)])
    try {
      assert.deepEqual(right, left)
    } catch {
      unexplained.push(id)
    }
  }
  assert.deepEqual(unexplained, [])
})

test('the check can fail: planted bugs are caught', () => {
  const source = [
    "import { a } from 'm1'",
    "import { b } from 'm2'",
    'export const f = (a) => a',
    'export const g = () => b',
    '',
  ].join('\n')
  const expected = oracleA('/p.js', source)
  const real = ours('/p.js', source)
  assert.equal(compareOutputs('/p.js', expected, real), null)
  const code = real.code as string
  // A wrong scope rule: the shadowing parameter is rewritten too.
  const scope = { ...real, code: code.replace('(a) => a', '(a) => __vite_ssr_import_0__.a') }
  assert.match(compareOutputs('/p.js', expected, scope) ?? '', /AST differs/)
  // Swapped import order.
  const lines = code.split('\n')
  const first = lines.findIndex((line) => line.includes('__vite_ssr_import_0__ = await'))
  const second = lines.findIndex((line) => line.includes('__vite_ssr_import_1__ = await'))
  const swappedLines = [...lines]
  swappedLines[first] = lines[second] as string
  swappedLines[second] = lines[first] as string
  const swapped = { ...real, code: swappedLines.join('\n') }
  assert.match(compareOutputs('/p.js', expected, swapped) ?? '', /AST differs/)
})
