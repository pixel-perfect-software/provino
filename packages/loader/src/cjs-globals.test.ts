// An ES module under `ModulePolicy.injectCjsGlobals` gets the CommonJS names its source uses:
// `require`, `module`, `__filename` and `__dirname`. A file that checks `require.main === module`
// (an entry point bundled to CommonJS) must load as an import, where the check is false.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, test } from 'provino'
import { loaderOptionsFor } from './internal/test-support.ts'
import { createLoader } from './loader.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function setup(files: Readonly<Record<string, string>>, policy = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-cjs-globals-')))
  roots.push(root)
  for (const [path, content] of Object.entries({ 'a.test.ts': '', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const loader = createLoader(loaderOptionsFor(root, { policy }))
  return {
    root,
    registry: loader.createFileRegistry(join(root, 'a.test.ts'), { tier: 'registry' }),
  }
}

test('an ES module that checks require.main === module loads as an import', async () => {
  const { root, registry } = setup({
    'entry.ts':
      "export const ran: string[] = []\nexport const main = (): void => { ran.push('main') }\nif (require.main === module) main()\n",
  })
  const entry = await registry.import<{ ran: string[] }>(join(root, 'entry.ts'))
  assert.deepEqual(entry.ran, [])
})

test('module is an object with the file as its id and filename, empty exports and not loaded', async () => {
  const { root, registry } = setup({
    'shape.ts':
      'export const seen = { type: typeof module, id: module.id, filename: module.filename, exports: module.exports, loaded: module.loaded }\n',
  })
  const { seen } = await registry.import<{ seen: unknown }>(join(root, 'shape.ts'))
  const path = join(root, 'shape.ts')
  assert.deepEqual(seen, {
    type: 'object',
    id: path,
    filename: path,
    exports: {},
    loaded: false,
  })
})

test('a module of its own naming module shadows the binding', async () => {
  const { root, registry } = setup({
    'own.ts': "const module = { id: 'mine' }\nexport const id: string = module.id\n",
  })
  assert.equal((await registry.import<{ id: string }>(join(root, 'own.ts'))).id, 'mine')
})

test('an ES module that feature-detects module takes the CommonJS branch and keeps its ES exports', async () => {
  const { root, registry } = setup({
    'detect.ts':
      "export const api = { v: 1 }\nexport const took: string[] = []\nif (typeof module !== 'undefined' && module.exports) {\n  module.exports = api\n  took.push('cjs')\n} else {\n  took.push('global')\n}\n",
  })
  const ns = await registry.import<{ api: { v: number }; took: string[] }>(join(root, 'detect.ts'))
  assert.deepEqual(ns.took, ['cjs'])
  assert.deepEqual(Object.keys(ns).sort(), ['api', 'took'])
  assert.deepEqual(ns.api, { v: 1 })
})

test('with injectCjsGlobals off, module is not defined', async () => {
  const { root, registry } = setup(
    { 'off.ts': 'export const seen: string = typeof module\n' },
    { injectCjsGlobals: false },
  )
  assert.equal((await registry.import<{ seen: string }>(join(root, 'off.ts'))).seen, 'undefined')
})
