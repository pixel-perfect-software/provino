// T2.3, Track 2 F3 rows: live bindings, ESM and CJS cycles, top-level await in a leaf and in a
// cycle. Each fixture runs through native Node and through Provino's loader and the observations
// are diffed (`../internal/test-support.ts`). A divergence pins what Provino does and names its id.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expectDivergence, expectSame } from '../internal/test-support.ts'

const TRACE = 'const trace = globalThis.__trace\n'

test('live-binding-let: an exported let that a function bumps shows through every import form, and a default export is a snapshot', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'counter.mjs':
        'export let count = 0\nexport function bump() { count += 1 }\nexport { count as total }\nexport default count\n',
      'reexport.mjs':
        "export { count as viaReexport } from './counter.mjs'\nexport * from './counter.mjs'\n",
      'entry.mjs': `${TRACE}import def, { count, total, bump } from './counter.mjs'
import * as ns from './counter.mjs'
import { viaReexport, bump as bumpAgain } from './reexport.mjs'
import * as star from './reexport.mjs'
const read = () => ({ count, total, ns: ns.count, nsTotal: ns.total, def, viaReexport, star: star.count })
trace.push(read())
bump()
trace.push(read())
bumpAgain()
export const result = read()
`,
    },
  })
})

test('esm-cycle-tdz-and-hoisted-function: a cycle sees a const in its temporal dead zone and a function declaration already initialised', async () => {
  await expectSame({
    entry: 'a.mjs',
    files: {
      'a.mjs': `${TRACE}import { b, readA } from './b.mjs'
export const a = 'a'
export function hoisted() { return 'hoisted-a' }
trace.push('a evaluated, b=' + b + ', readA=' + readA())
export const result = trace.length
`,
      'b.mjs': `${TRACE}import { a, hoisted } from './a.mjs'
export const b = 'b'
let seen
try { seen = a } catch (e) { seen = e.name + ': ' + e.message }
trace.push('b sees a: ' + seen + '; hoisted: ' + hoisted())
export function readA() { return a }
`,
    },
  })
})

test('esm-cycle-evaluation-order: the dependency of a cycle evaluates first, whichever module the entry imports', async () => {
  const files = {
    'a.mjs': `${TRACE}import './b.mjs'\ntrace.push('a')\n`,
    'b.mjs': `${TRACE}import './c.mjs'\ntrace.push('b')\n`,
    'c.mjs': `${TRACE}import './a.mjs'\ntrace.push('c')\n`,
    'from-a.mjs': "import './a.mjs'\nexport const result = 'from a'\n",
    'from-b.mjs': "import './b.mjs'\nexport const result = 'from b'\n",
  }
  await expectSame({ entry: 'from-a.mjs', files })
  await expectSame({ entry: 'from-b.mjs', files })
})

test('esm-cycle-namespace-keys-in-tdz: Object.keys on a namespace whose binding is not initialised throws', async () => {
  // divergence DV71 (pending): Node's namespace reads each binding to learn whether the key is
  // enumerable, so Object.keys throws a ReferenceError while a binding is in its temporal dead
  // zone; the runner's exports object is getters over the bindings, and Object.keys lists the
  // names without calling them.
  const fixture = {
    entry: 'a.mjs',
    files: {
      'a.mjs': `${TRACE}import './b.mjs'\nexport const a = 'a'\nexport const result = trace[0]\n`,
      'b.mjs': `${TRACE}import * as ns from './a.mjs'
const probe = (f) => { try { return { ok: f() } } catch (e) { return { threw: e.name } } }
trace.push({
  has: 'a' in ns,
  keys: probe(() => Object.keys(ns)),
  read: probe(() => ns.a),
})
`,
    },
  } as const
  const { native } = await expectDivergence(fixture, {
    provino: {
      trace: [{ has: true, keys: { ok: ['a', 'result'] }, read: { threw: 'ReferenceError' } }],
      result: { has: true, keys: { ok: ['a', 'result'] }, read: { threw: 'ReferenceError' } },
    },
  })
  // Native Node: the same in every way but `keys`.
  assert.deepEqual(native.result, {
    has: true,
    keys: { threw: 'ReferenceError' },
    read: { threw: 'ReferenceError' },
  })
})

test('cjs-cycle-partial-exports: a CommonJS cycle sees the partial module.exports, and a replaced module.exports is not seen by the earlier require', async () => {
  await expectSame({
    entry: 'entry.cjs',
    files: {
      'a.cjs': `${TRACE}exports.early = 'a-early'
const b = require('./b.cjs')
exports.late = 'a-late'
trace.push({ aSeesB: b })
`,
      'b.cjs': `${TRACE}const a = require('./a.cjs')
trace.push({ bSeesA: { ...a } })
exports.fromB = 'b'
`,
      'c.cjs': `${TRACE}exports.early = 'c-early'
const d = require('./d.cjs')
module.exports = { replaced: true }
trace.push({ cSeesD: d })
`,
      'd.cjs': `${TRACE}const c = require('./c.cjs')
trace.push({ dSeesC: { ...c } })
exports.heldC = c
`,
      'entry.cjs': `const a = require('./a.cjs')
const c = require('./c.cjs')
const d = require('./d.cjs')
exports.result = { a, c, d: { heldEarly: d.heldC.early, heldIsCurrent: d.heldC === c } }
`,
    },
  })
})

test('tla-leaf: a module with top-level await in a leaf delays its importers, in order', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'leaf.mjs': `${TRACE}trace.push('leaf start')
export const v = await Promise.resolve(7)
trace.push('leaf end')
`,
      'mid.mjs': `${TRACE}import { v } from './leaf.mjs'
trace.push('mid ' + v)
export const doubled = v * 2
`,
      'entry.mjs': `${TRACE}import { doubled } from './mid.mjs'
trace.push('entry ' + doubled)
export const result = doubled
`,
    },
  })
})

test('tla-leaf-sibling-order: a sibling with no top-level await runs while the leaf awaits', async () => {
  // divergence DV70 (pending): the spec starts every dependency in order and runs those with no
  // await to completion while an async one waits. The runner's wrapper awaits each import in turn.
  await expectDivergence(
    {
      entry: 'entry.mjs',
      files: {
        'leaf.mjs': `${TRACE}trace.push('leaf start')
export const v = await Promise.resolve(7)
trace.push('leaf end')
`,
        'sibling.mjs': `${TRACE}trace.push('sibling')\n`,
        'entry.mjs': `${TRACE}import { v } from './leaf.mjs'
import './sibling.mjs'
trace.push('entry ' + v)
export const result = v
`,
      },
    },
    {
      provino: { trace: ['leaf start', 'leaf end', 'sibling', 'entry 7'], result: 7 },
      native: { trace: ['leaf start', 'sibling', 'leaf end', 'entry 7'], result: 7 },
    },
  )
})

test('tla-in-cycle: top-level await in a module of a cycle, entered from either side', async () => {
  const files = {
    'a.mjs': `${TRACE}import { b } from './b.mjs'
export const a = 'a'
await Promise.resolve()
trace.push('a done, b=' + b)
`,
    'b.mjs': `${TRACE}import { a } from './a.mjs'
export const b = 'b'
let seen
try { seen = a } catch (e) { seen = e.name }
trace.push('b start, a: ' + seen)
`,
    'c.mjs': `${TRACE}import { d } from './d.mjs'
export const c = 'c'
trace.push('c done, d=' + d)
`,
    'd.mjs': `${TRACE}import { c } from './c.mjs'
export const d = 'd'
await Promise.resolve()
let seen
try { seen = c } catch (e) { seen = e.name }
trace.push('d done, c: ' + seen)
`,
    'from-a.mjs': "import './a.mjs'\nexport const result = 'a'\n",
    'from-b.mjs': "import './b.mjs'\nexport const result = 'b'\n",
    'from-c.mjs': "import './c.mjs'\nexport const result = 'c'\n",
    'from-d.mjs': "import './d.mjs'\nexport const result = 'd'\n",
  }
  for (const entry of ['from-a.mjs', 'from-b.mjs', 'from-c.mjs', 'from-d.mjs']) {
    await expectSame({ entry, files })
  }
})
