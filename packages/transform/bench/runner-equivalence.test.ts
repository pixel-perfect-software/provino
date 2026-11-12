// B20 (T3.13): our module-runner transform against oracle A (oxc's, as ASTs) and oracle B (run in a
// stub linker) on the scoping corpus. The big corpora (fuzz, excalidraw) are `bench:runner-diff`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXEMPTIONS } from './runner-exemptions.ts'
import {
  compareExecutions,
  compareOutputs,
  execute,
  judge,
  oracleA,
  ours,
} from './runner-oracle.ts'
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

test('generated scoping programs are unique and AST-equal to oracle A, and few are errors', () => {
  assert.equal(new Set(GENERATED.map(({ source }) => source)).size, GENERATED.length)
  const { unexplained, errors } = check(GENERATED)
  assert.deepEqual(unexplained.slice(0, 5), [])
  // About 5% redeclare an import binding on purpose (measured 59 of 1,000, 272 of 5,000): the
  // error path stays covered, and the other programs are valid ones that exercise the rewrite.
  assert.ok(errors > 0, 'no program takes the error path')
  assert.ok(errors < GENERATED.length * 0.08, `${errors} of ${GENERATED.length} programs error`)
})

test('every exemption is listed with a reason', () => {
  for (const entry of EXEMPTIONS) assert.ok(entry.reason.length > 20, entry.id)
})

test('the scoping corpus runs alike in the stub linker (oracle B)', async () => {
  const unexplained: string[] = []
  let checked = 0
  for (const { id, source } of [...SCOPING_CASES, ...GENERATED.slice(0, 300)]) {
    const filename = `/${id}.js`
    const expected = oracleA(filename, source)
    const actual = ours(filename, source)
    if (expected.code === null || actual.code === null) continue
    if (judge(filename, source, expected, actual).exemption !== null) continue
    const [left, right] = await Promise.all([execute(expected.code), execute(actual.code)])
    const verdict = compareExecutions(left, right)
    if (verdict === 'notRunnable') continue
    checked++
    if (verdict === 'differ') unexplained.push(id)
  }
  assert.deepEqual(unexplained, [])
  assert.ok(checked > 500, `only ${checked} programs ran in the stub linker`)
})

// A shadowed name that is not the import. The mixed-import exemption reads every identifier named
// like the default import as one marker on oracle A's side, bindings included, so a file that
// shadows `d` fails the relaxed comparison (a right rewrite and a wrong one alike) and the AST
// cannot judge it. No corpus file does, so this runs one and asserts what it exports.
const SHADOWED_DEFAULT = [
  "import d, * as n from 'x'",
  'function f(d) { return d }',
  'export const a = f(1)',
  'export const b = (() => { let d = 2; return d })()',
  'export const c = (() => { try { throw 3 } catch (d) { return d } })()',
  'export const e = { d: 4 }.d',
  'export const g = d === n.default',
  'export const h = ((d = 5) => d)()',
  'export const i = (() => { class d {} ; return typeof d })()',
  'export const j = { d }.d === n.default',
  'export const k = (function d() { return typeof d })()',
  'label: { break label }',
  '',
].join('\n')

test('a name that shadows a mixed default import is not rewritten (run, not compared)', async () => {
  const real = ours('/shadow.js', SHADOWED_DEFAULT).code as string
  const run = await execute(real)
  assert.deepEqual(run, {
    compiled: true,
    log: ['import x'],
    exports: {
      a: '1',
      b: '2',
      c: '3',
      e: '4',
      g: 'true',
      h: '5',
      i: 'function',
      j: 'true',
      k: 'function',
    },
    error: null,
  })
  // Planted: the parameter's `return d` rewritten as the default import. The exports show it.
  const planted = real.replace(
    'function f(d) { return d }',
    'function f(d) { return __vite_ssr_import_0__.default }',
  )
  assert.notEqual(planted, real, 'the plant found nothing to rewrite')
  const wrong = await execute(planted)
  assert.notEqual(wrong.exports.a, '1')
  assert.equal(compareExecutions(run, wrong), 'differ')
})

test('an execution that failed to compile is not a run, and one side compiling is a difference', () => {
  const failed = {
    compiled: false,
    log: [],
    exports: {},
    error: 'SyntaxError: Invalid or unexpected token',
  }
  const ran = { compiled: true, log: [], exports: {}, error: null }
  assert.equal(compareExecutions(failed, failed), 'notRunnable')
  assert.equal(compareExecutions(failed, { ...failed, error: 'SyntaxError: other' }), 'differ')
  assert.equal(compareExecutions(failed, ran), 'differ')
  assert.equal(compareExecutions(ran, ran), 'equal')
})

test('both outputs must parse for a comparison to count', () => {
  const source = 'export const x = 1\n'
  const expected = oracleA('/p.js', source)
  const real = ours('/p.js', source)
  assert.equal(compareOutputs('/p.js', expected, real), null)
  const broken = { ...expected, code: 'export const x = (' }
  assert.match(compareOutputs('/p.js', broken, real) ?? '', /^oracle A's output does not parse/)
  assert.match(
    compareOutputs('/p.js', expected, { ...real, code: 'const = ;' }) ?? '',
    /^our output does not parse/,
  )
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
