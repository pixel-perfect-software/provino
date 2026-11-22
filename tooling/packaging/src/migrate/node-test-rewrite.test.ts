// The node:test -> provino rewrite: each form it rewrites, each it refuses (with file:line), and
// that running it twice changes nothing.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rewriteNodeTest } from './node-test-rewrite.ts'

const HEAD = "import { describe, it } from 'node:test'\n"

function rewritten(source: string): string {
  const result = rewriteNodeTest('a.test.ts', source)
  assert.deepEqual(result.refusals, [])
  return result.text
}

function refusedAt(source: string): string[] {
  const result = rewriteNodeTest('a.test.ts', source)
  assert.equal(result.changed, false)
  assert.equal(result.text, source, 'a refused file is returned unchanged')
  return result.refusals.map((r) => r.code + ' ' + r.file + ':' + r.line + ' ' + r.message)
}

describe('the import', () => {
  it('moves to provino, keeping the assert import and sorting the names', () => {
    const out = rewritten(
      "import assert from 'node:assert/strict'\nimport { it, describe } from 'node:test'\nit('a', () => {})\n",
    )
    assert.equal(
      out,
      "import assert from 'node:assert/strict'\nimport { describe, it } from 'provino'\nit('a', () => {})\n",
    )
  })

  it('turns a default import into the named test', () => {
    assert.match(
      rewritten("import test from 'node:test'\ntest('a', () => {})\n"),
      /^import \{ test \} from 'provino'/,
    )
  })

  it('renames before and after, and an alias keeps its local name', () => {
    const out = rewritten(
      "import { before, after as teardown } from 'node:test'\nbefore(() => {})\nteardown(() => {})\n",
    )
    assert.equal(
      out,
      "import { afterAll as teardown, beforeAll } from 'provino'\nbeforeAll(() => {})\nteardown(() => {})\n",
    )
  })

  it('leaves a file with no node:test import alone', () => {
    const source = "import { it } from 'provino'\nit('a', () => {})\n"
    assert.deepEqual(rewriteNodeTest('a.test.ts', source), {
      text: source,
      changed: false,
      refusals: [],
    })
  })

  it('is idempotent', () => {
    const once = rewritten(
      HEAD + "describe('s', () => { it('a', { skip: true }, (t) => { t.after(() => {}) }) })\n",
    )
    const again = rewriteNodeTest('a.test.ts', once)
    assert.equal(again.changed, false)
    assert.equal(again.text, once)
  })

  it('refuses a file that already imports provino, and a namespace import', () => {
    assert.deepEqual(refusedAt("import * as t from 'node:test'\n"), [
      'MIGRATE_UNSUPPORTED a.test.ts:1 namespace import of node:test',
    ])
    assert.equal(
      refusedAt("import { it } from 'node:test'\nimport { fn } from 'provino'\n").length,
      1,
    )
  })
})

describe('options', () => {
  it('{ skip: true } and a reason string become .skip', () => {
    assert.match(
      rewritten(HEAD + "it('a', { skip: true }, () => {})\n"),
      /it\.skip\('a', \(\) => \{\}\)/,
    )
    assert.match(
      rewritten(HEAD + "it('a', { skip: 'why' }, () => {})\n"),
      /it\.skip\('a', \(\) => \{\}\)/,
    )
  })

  it('{ skip: false } is dropped', () => {
    assert.match(
      rewritten(HEAD + "it('a', { skip: false }, () => {})\n"),
      /it\('a', \(\) => \{\}\)/,
    )
  })

  it('{ skip: condition } becomes .skipIf(condition)', () => {
    const out = rewritten(HEAD + "it('a', { skip: process.platform === 'win32' }, () => {})\n")
    assert.match(out, /it\.skipIf\(process\.platform === 'win32'\)\('a', \(\) => \{\}\)/)
  })

  it('{ todo } and { only } become .todo and .only, on a describe too', () => {
    assert.match(rewritten(HEAD + "it('a', { todo: true })\n"), /it\.todo\('a'\)/)
    assert.match(
      rewritten(HEAD + "describe('a', { only: true }, () => {})\n"),
      /describe\.only\('a', \(\) => \{\}\)/,
    )
  })

  it('{ timeout } stays as the options argument, beside a modifier that goes', () => {
    const out = rewritten(HEAD + "it('a', { skip: true, timeout: 50 }, () => {})\n")
    assert.match(out, /it\.skip\('a', \{ timeout: 50 \}, \(\) => \{\}\)/)
    assert.match(
      rewritten(HEAD + "it('a', { timeout: 50 }, async () => {})\n"),
      /it\('a', \{ timeout: 50 \}, async/,
    )
  })

  it("a hook's { timeout } becomes the timeout argument", () => {
    const out = rewritten(
      "import { after } from 'node:test'\nafter(async () => {}, { timeout: 500 })\n",
    )
    assert.match(out, /afterAll\(async \(\) => \{\}, 500\)/)
  })

  it('refuses the options with no native form, each at its line', () => {
    assert.deepEqual(refusedAt(HEAD + "it('a', { concurrency: true }, () => {})\n"), [
      'MIGRATE_UNSUPPORTED a.test.ts:2 option concurrency has no native equivalent',
    ])
    assert.equal(refusedAt(HEAD + "it('a', { skip: true, todo: true }, () => {})\n").length, 1)
    assert.equal(refusedAt(HEAD + "it('a', { todo: cond }, () => {})\n").length, 1)
    assert.equal(refusedAt(HEAD + "it.skip('a', { todo: true }, () => {})\n").length, 1)
    assert.equal(refusedAt(HEAD + "it('a', opts, () => {})\n").length, 1)
  })
})

describe('the test context', () => {
  it('t.after becomes onTestFinished, imported', () => {
    const out = rewritten(HEAD + "it('a', (t) => { t.after(() => {}) })\n")
    assert.match(out, /import \{ describe, it, onTestFinished \} from 'provino'/)
    assert.match(out, /\(t\) => \{ onTestFinished\(\(\) => \{\}\) \}/)
  })

  it('t.name becomes t.task.name; t.skip and t.signal stay', () => {
    const out = rewritten(HEAD + "it('a', (ctx) => { ctx.skip(); use(ctx.signal, ctx.name) })\n")
    assert.match(out, /ctx\.skip\(\); use\(ctx\.signal, ctx\.task\.name\)/)
  })

  it('works in beforeEach and afterEach, and a shadowing parameter is left alone', () => {
    const out = rewritten(
      "import { beforeEach, it } from 'node:test'\nbeforeEach((t) => { t.after(() => {}) })\nit('a', (t) => { [1].map((t) => t.name) })\n",
    )
    assert.match(out, /beforeEach\(\(t\) => \{ onTestFinished/)
    assert.match(out, /map\(\(t\) => t\.name\)/)
  })

  it('refuses members the native context has no form of', () => {
    for (const member of ['test', 'plan', 'diagnostic', 'mock', 'todo', 'fullName']) {
      const found = refusedAt(HEAD + "it('a', (t) => { t." + member + "('x') })\n")
      assert.deepEqual(found, [
        'MIGRATE_UNSUPPORTED a.test.ts:2 t.' + member + ' has no native equivalent',
      ])
    }
    assert.equal(refusedAt(HEAD + "it('a', (t) => { t.after(() => {}, { signal }) })\n").length, 1)
    assert.equal(refusedAt(HEAD + "it('a', (t, done) => { done() })\n").length, 1)
    assert.equal(refusedAt(HEAD + "it('a', ({ name }) => { })\n").length, 1)
  })
})

describe('refusals', () => {
  it('names mock, async describe, suite parameters and cleanup-returning hooks', () => {
    assert.deepEqual(
      refusedAt("import { it, mock } from 'node:test'\nit('a', () => { mock.fn() })\n"),
      [
        'MIGRATE_UNSUPPORTED a.test.ts:2 node:test mock (mock.fn, mock.method, mock.timers) has no codemod',
      ],
    )
    assert.deepEqual(refusedAt(HEAD + "describe('a', async () => {})\n"), [
      'MIGRATE_UNSUPPORTED a.test.ts:2 async describe callback',
    ])
    assert.equal(refusedAt(HEAD + "describe('a', (s) => {})\n").length, 1)
    assert.equal(
      refusedAt("import { beforeEach } from 'node:test'\nbeforeEach(() => () => {})\n")[0],
      'MIGRATE_UNSUPPORTED a.test.ts:2 hook returns a function (a node:test hook cleanup is not run by provino)',
    )
  })

  it('names a test that returns a non-promise value', () => {
    assert.deepEqual(refusedAt(HEAD + "it('a', () => 5)\n"), [
      'MIGRATE_UNSUPPORTED a.test.ts:2 test returns a non-promise value (provino fails it)',
    ])
  })

  it('refuses an export with no native equivalent, and a before used as a value', () => {
    assert.equal(refusedAt("import { run } from 'node:test'\n").length, 1)
    assert.equal(refusedAt("import { before } from 'node:test'\nuse(before)\n").length, 1)
  })

  it('reports every site, in source order, with file:line', () => {
    const result = rewriteNodeTest(
      'x.test.ts',
      HEAD + "describe('a', async () => {})\nit('b', { concurrency: 2 }, () => {})\n",
    )
    assert.deepEqual(
      result.refusals.map((r) => r.line),
      [2, 3],
    )
  })

  it('does not take a local describe or it for the imported one', () => {
    const source = HEAD + "it('a', () => { const { it } = api; it('x', { retry: 2 }, () => {}) })\n"
    assert.equal(rewriteNodeTest('a.test.ts', source).refusals.length, 0)
  })

  it('throws MIGRATE_PARSE for source that does not parse', () => {
    assert.throws(() => rewriteNodeTest('a.test.ts', "import { it } from 'node:test'\nit(("), {
      code: 'MIGRATE_PARSE',
    })
  })
})
