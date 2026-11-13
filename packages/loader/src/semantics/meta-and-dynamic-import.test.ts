// T2.3, Track 2 F3 rows: `import.meta` and `import()` (from ES modules and from CommonJS), each
// run through native Node and through Provino's loader and diffed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expectDivergence, expectSame, runBoth, TRACE } from '../internal/test-support.ts'

test('import-meta-fields: url, filename, dirname and resolve() of a module, and one object per module', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'sibling.mjs': 'export const meta = import.meta\nexport const x = 1\n',
      'node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        exports: { import: './esm.mjs', require: './cjs.cjs' },
      }),
      'node_modules/pkg/esm.mjs': 'export default "esm"\n',
      'node_modules/pkg/cjs.cjs': 'module.exports = "cjs"\n',
      'nested/entry-meta.mjs': 'export default import.meta\n',
      'entry.mjs': `import { meta as siblingMeta } from './sibling.mjs'
import nested from './nested/entry-meta.mjs'
const attempt = (f) => { try { return { ok: f() } } catch (e) { return { threw: e.code ?? e.name } } }
const m = import.meta
export const result = {
  url: m.url,
  filename: m.filename,
  dirname: m.dirname,
  resolve: typeof m.resolve,
  sameObject: m === import.meta,
  distinctPerModule: m !== siblingMeta && siblingMeta !== nested,
  siblingUrl: siblingMeta.url,
  nestedDirname: nested.dirname,
  nestedResolveUp: nested.resolve('../sibling.mjs'),
  rel: m.resolve('./sibling.mjs'),
  package: m.resolve('pkg'),
  builtin: m.resolve('node:fs'),
  bareBuiltin: m.resolve('fs'),
  missingPackage: attempt(() => m.resolve('nope-package')),
}
`,
    },
  })
})

test('import-meta-prototype: import.meta has no prototype', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'entry.mjs':
        'export const result = { proto: Object.getPrototypeOf(import.meta), tag: Object.prototype.toString.call(import.meta) }\n',
    },
  })
})

test('import-meta-resolve-missing-relative-file: a relative or absolute specifier is answered without looking for the file', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'entry.mjs': `const m = import.meta
export const result = {
  relative: m.resolve('./nope.mjs'),
  up: m.resolve('../nope.mjs'),
  absolute: m.resolve('/nope/abs.mjs'),
  url: m.resolve('file:///nope/url.mjs'),
}
`,
    },
  })
})

test('import-meta-resolve-extensionless: a bare relative name is not completed by Node, and is by the resolver', async () => {
  // divergence DV74 (pending): Node resolves './sibling' to the URL it names, with no extension;
  // Provino resolves it as its resolver does (`extensions`), as a Jest or Vite resolver would.
  const { native } = await expectDivergence(
    {
      entry: 'entry.mjs',
      files: {
        'sibling.mjs': 'export const x = 1\n',
        'entry.mjs': "export const result = import.meta.resolve('./sibling')\n",
      },
    },
    { provino: { trace: [], result: 'file://<root>/sibling.mjs' } },
  )
  assert.equal(native.result, 'file://<root>/sibling')
})

test('import-meta-main-non-entry: import.meta.main is false in the entry and in a module it imports', async () => {
  // Node added import.meta.main in 24.2; before it the property is undefined. Provino defines it
  // everywhere, and a test file is never the main module (F3). The native child imports the entry
  // from its own script, so there too neither module is main: `node entry.mjs` would make the
  // entry's `true`, which is the part of DV78 this harness can't observe.
  const both = await runBoth({
    entry: 'entry.mjs',
    files: {
      'sibling.mjs': 'export const main = import.meta.main\n',
      'entry.mjs':
        "import { main } from './sibling.mjs'\nexport const result = { main, entry: import.meta.main }\n",
    },
  })
  assert.deepEqual(both.provino.result, { main: false, entry: false })
  const native = (both.native.result as { main?: boolean }).main
  if (native === undefined) {
    // divergence DV78 (pending): a Node without import.meta.main (22.15) has no such property.
    assert.deepEqual(both.native.result, {})
  } else {
    assert.deepEqual(both.provino, both.native)
  }
})

test('dynamic-import-from-esm: import() returns a promise, evaluates its target once, and gives one namespace', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'dyn.mjs': `${TRACE}trace.push('dyn evaluated')
export default 'd'
export const n = 1
`,
      'entry.mjs': `${TRACE}trace.push('before')
const pending = import('./dyn.mjs')
trace.push('is a promise: ' + (pending instanceof Promise))
const ns = await pending
trace.push('after ' + ns.default + ns.n)
const again = await import('./dyn.mjs')
const computed = './dyn' + '.mjs'
export const result = { same: ns === again, sameComputed: ns === (await import(computed)), keys: Object.keys(ns) }
`,
    },
  })
})

test('dynamic-import-missing-module: import() of a module that is not there rejects with ERR_MODULE_NOT_FOUND', async () => {
  await expectSame(
    {
      entry: 'entry.mjs',
      files: {
        'entry.mjs': `export const result = await Promise.all([
  import('./nope.mjs').catch((e) => ({ name: e.name, code: e.code })),
  import('nope-package').catch((e) => ({ name: e.name, code: e.code })),
])
`,
      },
    },
    // The text names the specifier or the resolved path, whichever the runtime's resolver reports.
    { messages: false },
  )
})

test('dynamic-import-from-cjs: a CommonJS file can import() an ES module and a CommonJS one', async () => {
  await expectSame({
    entry: 'entry.cjs',
    files: {
      'dyn.mjs': `${TRACE}trace.push('dyn evaluated')
export default 'd'
export const n = 1
`,
      'other.cjs': "exports.named = 'n'\n",
      'entry.cjs': `const trace = globalThis.__trace
trace.push('before')
const load = (specifier) => import(specifier)
exports.result = (async () => {
  const ns = await import('./dyn.mjs')
  trace.push('after ' + ns.default + ns.n)
  const other = await load('./other.cjs')
  return { keys: Object.keys(ns), other: other.named, otherDefault: other.default.named }
})()
trace.push('sync end')
`,
    },
  })
})

test('dynamic-import-of-cjs-named-exports: a CommonJS module imported by name, and as default', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'c.cjs': "exports.named = 1\nexports.other = function other() { return 'o' }\n",
      'fn.cjs': "module.exports = function fn() { return 'f' }\nmodule.exports.extra = 'e'\n",
      'entry.mjs': `const c = await import('./c.cjs')
const fn = await import('./fn.cjs')
export const result = {
  tag: c[Symbol.toStringTag],
  hasNamed: 'named' in c,
  named: c.named,
  other: c.other(),
  defaultNamed: c.default.named,
  hasDefault: 'default' in c,
  fnDefault: fn.default(),
  fnExtra: fn.extra,
  fnDefaultExtra: fn.default.extra,
}
`,
    },
  })
})

test('dynamic-import-of-cjs-names-node-cannot-see: only the names Node finds in the source are on the namespace', async () => {
  // divergence DV75 (pending): Node names a CommonJS namespace's exports by scanning its source
  // (cjs-module-lexer), so `Object.assign(module.exports, …)` and a computed key are not there.
  // Provino reads the exports object, so every own enumerable key is.
  const { native } = await expectDivergence(
    {
      entry: 'entry.mjs',
      files: {
        'c.cjs': `exports.detected = 1
Object.assign(module.exports, { assigned: 2 })
module.exports['com' + 'puted'] = 3
`,
        'entry.mjs': `const c = await import('./c.cjs')
export const result = {
  detected: 'detected' in c,
  assigned: 'assigned' in c,
  computed: 'computed' in c,
  viaDefault: Object.keys(c.default).sort(),
}
`,
      },
    },
    {
      provino: {
        trace: [],
        result: {
          detected: true,
          assigned: true,
          computed: true,
          viaDefault: ['assigned', 'computed', 'detected'],
        },
      },
    },
  )
  assert.deepEqual(native.result, {
    detected: true,
    assigned: false,
    computed: false,
    viaDefault: ['assigned', 'computed', 'detected'],
  })
})

test('dynamic-import-cjs-module-exports-name: the namespace of a CommonJS module has a "module.exports" name from Node 23', async () => {
  const both = await runBoth({
    entry: 'entry.mjs',
    files: {
      'c.cjs': 'module.exports = { named: 1 }\n',
      'entry.mjs': `const c = await import('./c.cjs')
export const result = { has: 'module.exports' in c, same: c['module.exports'] === c.default }
`,
    },
  })
  assert.deepEqual(both.provino.result, { has: false, same: false })
  if ((both.native.result as { has: boolean }).has) {
    // divergence DV75 (pending): Node 24 names the exports object `module.exports`; 22.15 doesn't.
    assert.deepEqual(both.native.result, { has: true, same: true })
  } else {
    assert.deepEqual(both.provino, both.native)
  }
})
