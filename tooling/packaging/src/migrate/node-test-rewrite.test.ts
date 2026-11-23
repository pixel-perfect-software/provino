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

describe('scope', () => {
  it('leaves a name a nested var, a loop head or a catch parameter declares', () => {
    for (const shadow of [
      "{ var it = api.it }; it('x', { retry: 1 }, () => {})",
      "for (const it of list) { it('x', { retry: 1 }, () => {}) }",
      "try { run() } catch (it) { it('x', { retry: 1 }, () => {}) }",
      "function describe() {}; describe('x', { retry: 1 }, () => {})",
    ]) {
      const source = HEAD + "it('a', () => { " + shadow + ' })\n'
      assert.deepEqual(rewriteNodeTest('a.test.ts', source).refusals, [], shadow)
    }
  })

  it('does not take a parameter default that mentions it for a declaration of it', () => {
    const source = HEAD + "const f = (x = it) => { it('a', { concurrency: true }, () => {}) }\n"
    assert.equal(rewriteNodeTest('a.test.ts', source).refusals.length, 1)
  })

  it('resolves a test context to its own parameter, not an outer one of the same name', () => {
    const out = rewritten(HEAD + "it('a', (t) => { [1].forEach((t) => t.name); t.name })\n")
    assert.match(out, /forEach\(\(t\) => t\.name\); t\.task\.name/)
  })
})

describe('falsy literals and hook options', () => {
  it('drops skip, todo and only with any falsy literal', () => {
    for (const falsy of ['false', 'null', '0', "''"]) {
      const out = rewritten(
        HEAD +
          "it('a', { skip: " +
          falsy +
          ', todo: ' +
          falsy +
          ', only: ' +
          falsy +
          ' }, () => {})\n',
      )
      assert.match(out, /it\('a', \(\) => \{\}\)/, falsy)
    }
  })

  it('refuses a hook option that is not exactly { timeout }, once per site', () => {
    const forms = [
      'before(() => {}, { skip: true })',
      'before(() => {}, { timeout: 5, skip: true })',
      'before(() => {}, opts)',
    ]
    for (const form of forms) {
      const found = refusedAt("import { before } from 'node:test'\n" + form + '\n')
      assert.equal(found.length, 1, form)
    }
  })
})

describe('other ways to reach node:test', () => {
  it('refuses import(), require(), a re-export and a side-effect import, with the line', () => {
    assert.deepEqual(refusedAt("const { it } = await import('node:test')\n"), [
      "MIGRATE_UNSUPPORTED a.test.ts:1 dynamic import('node:test') has no codemod",
    ])
    assert.deepEqual(refusedAt("const { it } = require('node:test')\n"), [
      "MIGRATE_UNSUPPORTED a.test.ts:1 require('node:test') has no codemod",
    ])
    assert.deepEqual(refusedAt("export { it } from 'node:test'\n"), [
      'MIGRATE_UNSUPPORTED a.test.ts:1 re-export from node:test has no codemod',
    ])
    assert.deepEqual(refusedAt("import 'node:test'\n"), [
      'MIGRATE_UNSUPPORTED a.test.ts:1 side-effect import of node:test',
    ])
  })

  it('refuses a type import (written by hand), and a mixed file reports the dynamic site too', () => {
    assert.deepEqual(refusedAt("import type { TestContext } from 'node:test'\n"), [
      'MIGRATE_UNSUPPORTED a.test.ts:1 type import from node:test: write the type by hand',
    ])
    assert.equal(refusedAt(HEAD + "await import('node:test')\n").length, 1)
  })

  it('writes no empty import when only mock was imported and never used', () => {
    const out = rewritten("import { mock } from 'node:test'\nconsole.log(1)\n")
    assert.equal(out, 'console.log(1)\n')
  })
})

describe('hooks called inside a function (B27h2)', () => {
  it('refuses a hook in a helper, with a hand-edit hint, and leaves a top-level and describe hook alone', () => {
    const head = "import { after, before, beforeEach, describe, it } from 'node:test'\n"
    for (const hook of ['before', 'after', 'beforeEach']) {
      const found = refusedAt(head + `function helper() {\n  ${hook}(() => {})\n}\n`)
      assert.equal(found.length, 1, hook)
      assert.match(found[0] ?? '', /a\.test\.ts:3 .*called inside a function.*Hand edit/s)
    }
    const out = rewritten(
      head +
        "after(() => {})\ndescribe('s', () => {\n  before(() => {})\n  it('a', () => {})\n})\n",
    )
    assert.match(out, /^afterAll\(\(\) => \{\}\)$/m)
    assert.match(out, /^ {2}beforeAll\(/m)
  })

  it('turns after inside a test body into onTestFinished, without an unused afterAll import', () => {
    const out = rewritten(
      "import { after, it } from 'node:test'\nit('a', () => {\n  after(() => {})\n})\n",
    )
    assert.equal(
      out,
      "import { it, onTestFinished } from 'provino'\nit('a', () => {\n  onTestFinished(() => {})\n})\n",
    )
  })

  it('also finds one in a helper defined inside a test body, and refuses before there', () => {
    assert.match(
      rewritten(
        "import { after, it } from 'node:test'\nit('a', () => {\n  const f = () => { after(() => {}) }\n  f()\n})\n",
      ),
      /onTestFinished\(/,
    )
    const found = refusedAt(
      "import { before, it } from 'node:test'\nit('a', () => {\n  before(() => {})\n})\n",
    )
    assert.match(found[0] ?? '', /inside a test body has no native meaning/)
  })
})
