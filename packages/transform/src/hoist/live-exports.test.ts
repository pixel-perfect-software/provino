// `export { x }` of an import and `export { a } from` under `in-order` are live: the output goes
// through the module-runner form and runs, so what is checked is what a reader of the exports sees.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HoistPolicy, TransformRecord } from '@provino/types'
import { toModuleRunner } from '../module-runner.ts'
import { hoist } from './test-helpers.ts'
import { blockPolicy, topLevelPolicy } from './test-policies.ts'

/** What each specifier loads to; a module gets the exports as they stand, as a cycle would. */
type Modules = Readonly<Record<string, (exports: object) => object>>

const AsyncFunction = (async () => {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<void>

/** Runs a file's hoisted output in module-runner form and returns its exports object. */
async function run(source: string, policy: HoistPolicy, modules: Modules): Promise<object> {
  const result = hoist(source, policy)
  assert.deepEqual(result.diagnostics, [])
  const output = toModuleRunner('/m.js', {
    code: result.code,
    map: result.map,
  } as unknown as TransformRecord)
  const exports = {}
  const load = async (specifier: string): Promise<object> => {
    const module = modules[specifier]
    assert.ok(module !== undefined, `nothing provides ${specifier}`)
    return module(exports)
  }
  const noop = (): void => {}
  const body = new AsyncFunction(
    '__vite_ssr_import__',
    '__vite_ssr_dynamic_import__',
    '__vite_ssr_exports__',
    '__vite_ssr_exportAll__',
    '__vite_ssr_import_meta__',
    'jest',
    'vi',
    output.code,
  )
  const object = { mock: noop }
  await body(load, load, exports, noop, {}, object, object)
  return exports
}

test('live: export { x } of an imported binding follows the source', async () => {
  const source = { x: 1 }
  const exports = await run(
    "import { x } from './a'\nexport { x }\njest.mock('./m')\n",
    blockPolicy,
    { './a': () => source },
  )
  assert.equal(Reflect.get(exports, 'x'), 1)
  source.x = 2
  assert.equal(Reflect.get(exports, 'x'), 2)
})

test('live: export { x as y } keeps the exported name, and the top-level policy does the same', async () => {
  const source = { x: 1 }
  const exports = await run(
    "import { x } from './a'\nexport { x as y }\nvi.mock('./m')\n",
    topLevelPolicy,
    { './a': () => source },
  )
  source.x = 2
  assert.equal(Reflect.get(exports, 'y'), 2)
})

test('live: a default import exported under a string name reads .default', async () => {
  const source = { default: 1 }
  const exports = await run(
    "import d from './a'\nexport { d as 'a-b' }\njest.mock('./m')\n",
    blockPolicy,
    { './a': () => source },
  )
  source.default = 2
  assert.equal(Reflect.get(exports, 'a-b'), 2)
})

test('live: an export list keeps its local names and loses only the imports', async () => {
  const exports = await run(
    "import { x } from './a'\nconst local = 7\nexport { x, local, local as other }\njest.mock('./m')\n",
    blockPolicy,
    { './a': () => ({ x: 1 }) },
  )
  assert.equal(Reflect.get(exports, 'x'), 1)
  assert.equal(Reflect.get(exports, 'local'), 7)
  assert.equal(Reflect.get(exports, 'other'), 7)
})

test('live: a named re-export under in-order follows the source', async () => {
  const source = { q: 1, default: 2, 'a-b': 3 }
  const exports = await run(
    "jest.mock('./m')\nexport { q as r, default as d, default, 'a-b' as c } from './q'\n",
    blockPolicy,
    { './q': () => source },
  )
  source.q = 10
  source.default = 20
  source['a-b'] = 30
  assert.equal(Reflect.get(exports, 'r'), 10)
  assert.equal(Reflect.get(exports, 'd'), 20)
  assert.equal(Reflect.get(exports, 'default'), 20)
  assert.equal(Reflect.get(exports, 'c'), 30)
})

test('live: a read during a cycle hits the binding not yet set, not a frozen undefined', async () => {
  let duringLoad: unknown
  const exports = await run(
    "jest.mock('./m')\nimport { x } from './a'\nexport { x }\n",
    blockPolicy,
    {
      './a': (partial) => {
        try {
          duringLoad = Reflect.get(partial, 'x')
        } catch (error) {
          duringLoad = error
        }
        return { x: 1 }
      },
    },
  )
  assert.ok(duringLoad instanceof ReferenceError, `read as ${String(duringLoad)}`)
  assert.equal(Reflect.get(exports, 'x'), 1)
})

test('live: the getter sits straight before the await import, and is enumerable', () => {
  const result = hoist("import { x } from './a'\nexport { x }\njest.mock('./m')\n", blockPolicy)
  assert.ok(
    result.code.includes(
      'Object.defineProperty(__vite_ssr_exports__, "x", { enumerable: true, configurable: true, get: () => __provino_import_0__.x });const __provino_import_0__ = await import("./a");',
    ),
    result.code,
  )
  assert.ok(!result.code.includes('export { x }'))
})

test('live: under static a re-export stays as written and an imported export still is a getter', () => {
  const result = hoist(
    "import { x } from './a'\nexport { x }\nexport { q } from './q'\nvi.mock('./m')\n",
    topLevelPolicy,
  )
  assert.ok(result.code.includes("export { q } from './q'"))
  assert.ok(result.code.includes('Object.defineProperty(__vite_ssr_exports__, "x"'))
})
