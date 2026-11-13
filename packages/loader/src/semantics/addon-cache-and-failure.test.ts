// T2.3, Track 2 F3 rows: a shared `.node` addon, `require.cache`, and re-evaluation after a
// failure. Each fixture runs through native Node and through Provino's loader and is diffed.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createLoaderFor,
  expectDivergence,
  expectSame,
  findInstalledAddon,
  runBoth,
  writeTree,
} from '../internal/test-support.ts'

const TRACE = 'const trace = globalThis.__trace\n'

test('addon-shared: a .node addon is one object for every module and every file registry', async (t) => {
  // An addon that is already installed (oxc-parser's binding), never compiled. `process.dlopen`
  // cannot load an addon twice, so the loader never evaluates one per registry: it is required
  // once per worker and shared, which is what Node's own cache does for a `require` twice.
  const addon = findInstalledAddon()
  if (addon === null) {
    t.skip('no @oxc-parser/binding-* package is installed for this platform')
    return
  }
  const requireAddon = `module.exports = require(${JSON.stringify(addon)})\n`
  const files = {
    'a.cjs': requireAddon,
    'b.cjs': requireAddon,
    'entry.cjs': `const a = require('./a.cjs')
const b = require('./b.cjs')
exports.result = {
  sameAcrossModules: a === b,
  sameAsDirect: require(${JSON.stringify(addon)}) === a,
  exports: Object.keys(a).sort(),
  parseSync: typeof a.parseSync,
}
`,
  }
  const { provino } = await expectSame({ entry: 'entry.cjs', files })
  assert.equal((provino.result as { sameAcrossModules: boolean }).sameAcrossModules, true)

  // Two files of a worker: two registries, each evaluating its own copy of a.cjs, one addon, and it
  // is the very object Node's own cache holds.
  const root = writeTree({ ...files, 'entry.test.ts': '' })
  const loader = createLoaderFor(root, 'node')
  const open = () => loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  const first = open()
  const second = open()
  try {
    const fromFirst = first.require(join(root, 'a.cjs'))
    const fromSecond = second.require(join(root, 'a.cjs'))
    assert.equal(fromFirst, fromSecond)
    assert.equal(fromFirst, createRequire(import.meta.url)(addon))
    assert.equal(first.require(addon), fromFirst)
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('require-cache-user-module: a user module is not an entry of require.cache, and delete does not evaluate it again', async () => {
  // divergence DV79 (pending): `require.cache` is Node's own cache, which the registry never reads
  // or writes, so a module the registry loaded is not in it and deleting an entry changes nothing.
  // Node's is a live view of what `require` loaded; Jest's is a read-only Proxy over its registry.
  // Which one a dialect gets is a `ModulePolicy` key (D7), proposed as a decision.
  const { native } = await expectDivergence(
    {
      entry: 'entry.cjs',
      files: {
        'x.cjs': `${TRACE}trace.push('x evaluated')\nmodule.exports = {}\n`,
        'entry.cjs': `const id = require.resolve('./x.cjs')
const before = id in require.cache
const first = require('./x.cjs')
const entry = require.cache[id]
delete require.cache[id]
const second = require('./x.cjs')
exports.result = {
  before,
  after: id in require.cache,
  entry: entry === undefined ? 'undefined' : { exports: entry.exports === first, loaded: entry.loaded },
  reevaluated: second !== first,
}
`,
      },
    },
    {
      provino: {
        trace: ['x evaluated'],
        result: { before: false, after: false, entry: 'undefined', reevaluated: false },
      },
    },
  )
  assert.deepEqual(native, {
    trace: ['x evaluated', 'x evaluated'],
    result: {
      before: false,
      after: true,
      entry: { exports: true, loaded: true },
      reevaluated: true,
    },
  })
})

test('failed-cjs-module-evaluates-again: a CommonJS module that threw is evaluated again by the next require', async () => {
  await expectSame({
    entry: 'entry.cjs',
    files: {
      'flaky.cjs': `${TRACE}const attempt = trace.filter((x) => x === 'flaky evaluated').length + 1
trace.push('flaky evaluated')
exports.partial = 'set before the throw'
if (attempt === 1) throw new Error('first')
module.exports = { attempt, partial: exports.partial }
`,
      'entry.cjs': `let first
try { require('./flaky.cjs') } catch (e) { first = { name: e.name, message: e.message } }
const id = require.resolve('./flaky.cjs')
const cachedAfterFailure = id in require.cache
const second = require('./flaky.cjs')
exports.result = { first, cachedAfterFailure, second, third: require('./flaky.cjs') === second }
`,
    },
  })
})

test('failed-esm-module-keeps-its-error: an ES module that threw is not evaluated again, and every import rejects with the same error', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'bad.mjs': "globalThis.__trace.push('bad evaluated')\nthrow new Error('boom')\n",
      'importer.mjs': "import './bad.mjs'\nglobalThis.__trace.push('importer evaluated')\n",
      'entry.mjs': `const errors = []
for (const specifier of ['./bad.mjs', './bad.mjs', './importer.mjs', './importer.mjs']) {
  try { await import(specifier) } catch (e) { errors.push(e) }
}
export const result = {
  count: errors.length,
  allSame: errors.every((e) => e === errors[0]),
  message: errors[0].message,
}
`,
    },
  })
})

test('failed-esm-entry: an entry whose dependency throws fails with that error, named and coded as Node has it', async () => {
  const both = await runBoth({
    entry: 'entry.mjs',
    files: {
      'bad.mjs': "throw new TypeError('bad dependency')\n",
      'entry.mjs': "import './bad.mjs'\nexport const result = 'unreachable'\n",
    },
  })
  assert.deepEqual(both.provino, both.native)
  assert.equal(both.provino.threw?.name, 'TypeError')
})
