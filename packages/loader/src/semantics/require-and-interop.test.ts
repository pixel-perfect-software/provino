// T2.3, Track 2 F3 rows: `require(esm)`, `__esModule` interop under both `interopDefault`
// policies, and JSON. Each fixture runs through native Node and through Provino's loader.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expectDivergence, expectSame, type Fixture } from '../internal/test-support.ts'

const TRACE = 'const trace = globalThis.__trace\n'

test('require-esm-namespace: require() of an ES module with no default export gives its namespace, evaluated once', async () => {
  await expectSame({
    entry: 'entry.cjs',
    files: {
      'esm.mjs': `${TRACE}trace.push('esm evaluated')
export const a = 1
export function f() { return 'f' }
`,
      'entry.cjs': `const ns = require('./esm.mjs')
exports.result = {
  keys: Object.keys(ns),
  tag: ns[Symbol.toStringTag],
  a: ns.a,
  f: ns.f(),
  hasEsModule: '__esModule' in ns,
  same: require('./esm.mjs') === ns,
}
`,
    },
  })
})

test('require-esm-graph: require() of an ES module that imports another, with a live binding', async () => {
  await expectSame({
    entry: 'entry.cjs',
    files: {
      'counter.mjs': 'export let count = 0\nexport function bump() { count += 1 }\n',
      'esm.mjs': `${TRACE}import { count, bump } from './counter.mjs'
trace.push('esm evaluated ' + count)
export { count, bump }
`,
      'entry.cjs': `const ns = require('./esm.mjs')
const before = ns.count
ns.bump()
exports.result = { before, after: ns.count }
`,
    },
  })
})

test('require-esm-default-export: require() of an ES module with a default export adds __esModule: true', async () => {
  // divergence DV72 (pending): from Node 22.12 the namespace require() returns carries
  // `__esModule: true` when the module has a default export, so a transpiled CommonJS consumer
  // reads `.default` the way it would from a Babel build. Provino's exports object has no such key
  // under `interopDefault: 'node'` (Vitest's module runner hands out the plain namespace).
  const { native } = await expectDivergence(
    {
      entry: 'entry.cjs',
      files: {
        'esm.mjs': "export const a = 1\nexport default 'dflt'\n",
        'entry.cjs': `const ns = require('./esm.mjs')
exports.result = { keys: Object.keys(ns), esModule: ns.__esModule, default: ns.default, a: ns.a }
`,
      },
    },
    { provino: { trace: [], result: { keys: ['a', 'default'], default: 'dflt', a: 1 } } },
  )
  assert.deepEqual(native.result, {
    keys: ['__esModule', 'a', 'default'],
    esModule: true,
    default: 'dflt',
    a: 1,
  })
})

test('require-esm-top-level-await: require() of an ES module whose graph has top-level await throws ERR_REQUIRE_ASYNC_MODULE', async () => {
  // divergence DV73 (pending): the code is Node's; the error is a LoaderError, not an Error, and
  // its text names the module instead of Node's ("require() cannot be used on an ESM graph with
  // top-level await. Use import() instead. …").
  const { native, provino } = await expectDivergence(
    {
      entry: 'entry.cjs',
      files: {
        'tla.mjs': 'export const v = await Promise.resolve(1)\n',
        'via.mjs': "import { v } from './tla.mjs'\nexport const w = v\n",
        'entry.cjs': `const attempt = (specifier) => { try { require(specifier); return 'loaded' } catch (e) { return { name: e.name, code: e.code } } }
exports.result = { direct: attempt('./tla.mjs'), viaImport: attempt('./via.mjs') }
`,
      },
    },
    {
      provino: {
        trace: [],
        result: {
          direct: { name: 'LoaderError', code: 'ERR_REQUIRE_ASYNC_MODULE' },
          viaImport: { name: 'LoaderError', code: 'ERR_REQUIRE_ASYNC_MODULE' },
        },
      },
      native: {
        trace: [],
        result: {
          direct: { name: 'Error', code: 'ERR_REQUIRE_ASYNC_MODULE' },
          viaImport: { name: 'Error', code: 'ERR_REQUIRE_ASYNC_MODULE' },
        },
      },
    },
  )
  assert.equal(native.threw, undefined)
  assert.equal(provino.threw, undefined)
})

// A CommonJS module flagged as an ES module two ways (non-enumerable, as `Object.defineProperty`
// writes it, and enumerable, as `exports.__esModule = true` does), a plain one and a function.
const INTEROP_FILES = {
  'flagged.cjs': `Object.defineProperty(exports, '__esModule', { value: true })
exports.default = 'the-default'
exports.named = 'n'
`,
  'flagged-enumerable.cjs': `exports.__esModule = true
exports.default = 'the-default'
exports.named = 'n'
`,
  'plain.cjs': "module.exports = { named: 'n', other: 2 }\n",
  'fn.cjs': "module.exports = function f() { return 1 }\nmodule.exports.extra = 'e'\n",
}

test('interop-node-default-import: import x from a CommonJS module is module.exports, __esModule or not', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      ...INTEROP_FILES,
      'entry.mjs': `import flagged from './flagged.cjs'
import enumerable from './flagged-enumerable.cjs'
import plain from './plain.cjs'
import fn from './fn.cjs'
export const result = {
  flagged: Object.keys(flagged),
  flaggedDefault: flagged.default,
  enumerable: Object.keys(enumerable),
  plain,
  fn: [typeof fn, fn.extra, fn()],
}
`,
    },
  })
})

test('interop-node-namespace-of-flagged-cjs: import * as ns of a flagged CommonJS module', async () => {
  // divergence DV75 (pending): Node's scanner names `__esModule` in the namespace, flagged by
  // Object.defineProperty or not; Provino's namespace lists the exports object's enumerable keys,
  // and a non-enumerable `__esModule` is not one.
  const fixture: Fixture = {
    entry: 'entry.mjs',
    files: {
      ...INTEROP_FILES,
      'entry.mjs': `import * as flagged from './flagged.cjs'
import * as enumerable from './flagged-enumerable.cjs'
import flaggedDefault from './flagged.cjs'
import enumerableDefault from './flagged-enumerable.cjs'
const shape = (ns, def) => ({
  tag: ns[Symbol.toStringTag],
  proto: Object.getPrototypeOf(ns),
  esModule: '__esModule' in ns,
  named: ns.named,
  defaultIsModuleExports: ns.default === def,
})
export const result = { flagged: shape(flagged, flaggedDefault), enumerable: shape(enumerable, enumerableDefault) }
`,
    },
  }
  const expectedShape = {
    tag: 'Module',
    proto: null,
    named: 'n',
    defaultIsModuleExports: true,
  }
  const { native } = await expectDivergence(fixture, {
    provino: {
      trace: [],
      result: {
        flagged: { ...expectedShape, esModule: false },
        enumerable: { ...expectedShape, esModule: true },
      },
    },
  })
  assert.deepEqual(native.result, {
    flagged: { ...expectedShape, esModule: true },
    enumerable: { ...expectedShape, esModule: true },
  })
})

test('interop-babel-esModule: under babel interop an __esModule CommonJS module is its own namespace and import x is exports.default', async () => {
  // divergence DV77 (pending): `interopDefault: 'babel'` is Jest's (Babel's _interopRequireDefault
  // and _interopRequireWildcard), not Node's: it honours __esModule, so `import x` is
  // `exports.default` and `import * as ns` is the exports object itself, not a `Module` namespace.
  // Native Node is the reference for `interopDefault: 'node'` (the tests above).
  const files = {
    ...INTEROP_FILES,
    'entry.mjs': `import flagged from './flagged.cjs'
import * as flaggedNs from './flagged.cjs'
import enumerable from './flagged-enumerable.cjs'
import plain from './plain.cjs'
import * as plainNs from './plain.cjs'
const shape = (ns) => ({ tag: ns[Symbol.toStringTag], keys: Object.keys(ns), isNullProto: Object.getPrototypeOf(ns) === null })
export const result = {
  flagged,
  flaggedNs: shape(flaggedNs),
  enumerable,
  plain,
  plainNs: shape(plainNs),
}
`,
  }
  const { native } = await expectDivergence(
    { entry: 'entry.mjs', files, interop: 'babel' },
    {
      provino: {
        trace: [],
        result: {
          flagged: 'the-default',
          flaggedNs: { keys: ['default', 'named'], isNullProto: false },
          enumerable: 'the-default',
          plain: { named: 'n', other: 2 },
          plainNs: { keys: ['default', 'named', 'other'], isNullProto: true },
        },
      },
    },
  )
  // Node: the default is module.exports whatever it carries, and a namespace is a `Module`.
  const nativeResult = native.result as {
    flagged: unknown
    flaggedNs: { tag: string }
    enumerable: unknown
    plain: unknown
  }
  assert.deepEqual(Object.keys(nativeResult.flagged as object), ['default', 'named'])
  assert.deepEqual(Object.keys(nativeResult.enumerable as object), [
    '__esModule',
    'default',
    'named',
  ])
  assert.deepEqual(nativeResult.plain, { named: 'n', other: 2 })
  assert.equal(nativeResult.flaggedNs.tag, 'Module')
})

test('interop-babel-without-esModule: under babel interop a CommonJS module without __esModule imports as Node does', async () => {
  // What the two interops agree on: no `__esModule`, so `import x` is module.exports and the
  // detected names (`named`) and `default` are on the namespace. (Its shape differs: DV75, DV77.)
  const base = {
    files: {
      'plain.cjs': "exports.named = 'n'\nexports.other = 2\n",
      'entry.mjs': `import plain from './plain.cjs'
import * as ns from './plain.cjs'
export const result = { plain, named: ns.named, defaultIsPlain: ns.default === plain, hasDefault: 'default' in ns }
`,
    },
    entry: 'entry.mjs',
  } as const
  await expectSame({ ...base, interop: 'babel' })
  await expectSame({ ...base, interop: 'node' })
})

test('json-require-and-import: a JSON module is parsed once, and import gives { default }', async () => {
  await expectSame({
    entry: 'entry.mjs',
    files: {
      'data.json': '{"a":1,"b":[1,2]}',
      'cjs.cjs': "module.exports = require('./data.json')\n",
      'entry.mjs': `import data from './data.json' with { type: 'json' }
import * as ns from './data.json' with { type: 'json' }
import fromCjs from './cjs.cjs'
const dynamic = await import('./data.json', { with: { type: 'json' } })
export const result = {
  data,
  nsKeys: Object.keys(ns),
  tag: ns[Symbol.toStringTag],
  sameAsDynamic: dynamic.default === data,
  sameAsRequire: fromCjs === data,
}
`,
    },
  })
})

test('json-require-twice: require() of a JSON file gives the same object', async () => {
  await expectSame({
    entry: 'entry.cjs',
    files: {
      'data.json': '{"a":1}',
      'entry.cjs': `const first = require('./data.json')
first.mutated = true
exports.result = { same: require('./data.json') === first, mutated: require('./data.json').mutated }
`,
    },
  })
})

test('json-invalid: a JSON file that does not parse throws a SyntaxError', async () => {
  await expectSame(
    {
      entry: 'entry.cjs',
      files: {
        'bad.json': '{ "a": ',
        'entry.cjs': `try { require('./bad.json') } catch (e) { exports.result = { name: e.name } }\n`,
      },
    },
    { messages: false },
  )
})

test('json-import-without-attribute: Node needs `with { type: "json" }`, Provino does not', async () => {
  // divergence DV76 (pending): Node refuses `import data from './data.json'` with
  // ERR_IMPORT_ATTRIBUTE_MISSING. Jest and Vitest accept it, and so does Provino.
  const { native } = await expectDivergence(
    {
      entry: 'entry.mjs',
      files: {
        'data.json': '{"a":1}',
        'entry.mjs': "import data from './data.json'\nexport const result = data\n",
      },
    },
    { provino: { trace: [], result: { a: 1 } } },
  )
  assert.equal(native.threw?.code, 'ERR_IMPORT_ATTRIBUTE_MISSING')
})
