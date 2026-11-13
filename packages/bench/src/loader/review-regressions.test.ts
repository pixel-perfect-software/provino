// B13c's pre-merge review: one regression test per finding in the loader, each written before its
// fix and seen failing against the code it fixes.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  at,
  fileWithMocks,
  JESTISH,
  loaderFor,
  VITESTISH,
  writeTree,
} from './test-support.ts'

const g = globalThis as { __count?: number; __fail?: boolean; __order?: string[] }

test('a CommonJS file that uses import() still loads as CommonJS (review Blocker 1)', () => {
  const root = writeTree({
    'later.js': 'module.exports = 1\n',
    'cjs.js':
      "const fs = require('node:fs')\nmodule.exports = { load: () => import('./later.js'), fs: typeof fs }\n",
    'entry.test.ts': '',
  })
  const files = loaderFor(root).createFileRegistry(join(root, 'entry.test.ts'), {
    tier: 'registry',
  })
  const cjs = files.require<{ load: unknown; fs: string }>('./cjs.js', at(root, 'a.js'))
  assert.equal(cjs.fs, 'object')
  assert.equal(typeof cjs.load, 'function')
})

test('under awaitFactory, an ES module imported by import() binds the awaited mock, not a Promise (review Blocker 2)', async () => {
  const root = writeTree({
    'a.ts': "export const x = 'real'\n",
    'b.ts': "import { x } from './a.ts'\nexport const y = x\n",
    'entry.test.ts': '',
  })
  const file = join(root, 'entry.test.ts')
  const { files } = fileWithMocks(loaderFor(root, { policy: VITESTISH, hoist: null }), file, {
    policy: VITESTISH,
  })
  files.registerMock('./a.ts', null, { kind: 'factory', factory: () => ({ x: 'mock' }) })
  const b = await files.import<{ y: string }>('./b.ts', at(root, 'a.test.ts'))
  assert.equal(b.y, 'mock')
  // A synchronous load can't wait for the factory, and says so instead of binding a Promise.
  const { files: sync } = fileWithMocks(loaderFor(root, { policy: VITESTISH, hoist: null }), file, {
    policy: VITESTISH,
  })
  sync.registerMock('./a.ts', null, { kind: 'factory', factory: () => ({ x: 'mock' }) })
  assert.throws(() => sync.require('./b.ts', at(root, 'a.cjs')), {
    code: 'ERR_REQUIRE_ASYNC_MODULE',
    message: /'\.\/a\.ts'.*synchronously.*its mock is asynchronous/,
  })
})

test('a module served a factory mock is never transformed: an ESM and a CommonJS test (review High 3)', async () => {
  const root = writeTree({
    'styles.css': '.a { color: red; }\n',
    'comp.ts': "import styles from './styles.css'\nexport const s = styles\n",
    'entry.test.ts':
      "mocker.mock('./styles.css', () => ({ a: 'mocked' }))\nimport { s } from './comp.ts'\nexport const out = s\n",
    'cjs.test.cjs':
      "mocker.mock('./styles.css', () => ({ a: 'mocked' }))\nmodule.exports = require('./styles.css')\n",
    'real.test.ts': "import { s } from './comp.ts'\nexport const out = s\n",
  })
  const esm = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts')).files
  const loaded = await esm.import<{ out: { a: string } }>(join(root, 'entry.test.ts'))
  assert.deepEqual(loaded.out, { a: 'mocked' })
  const cjs = fileWithMocks(loaderFor(root), join(root, 'cjs.test.cjs')).files
  assert.deepEqual(cjs.require(join(root, 'cjs.test.cjs')), { a: 'mocked' })
  // Not mocked, the file that can't be transformed fails when its import runs.
  const real = fileWithMocks(loaderFor(root), join(root, 'real.test.ts')).files
  await assert.rejects(real.import(join(root, 'real.test.ts')), {
    code: 'TRANSFORM_UNSUPPORTED_FILE',
  })
})

test('an async scratch load is its own: a module loaded beside it is evaluated once (review High 4)', async () => {
  const root = writeTree({
    'b.ts': 'export function f(): number { return 1 }\n',
    'c.ts':
      'const g = globalThis as { __count?: number }\ng.__count = (g.__count ?? 0) + 1\nexport const c = g.__count\n',
    'entry.test.ts': '',
  })
  g.__count = 0
  try {
    const file = join(root, 'entry.test.ts')
    const { files } = fileWithMocks(loaderFor(root, { policy: VITESTISH, hoist: null }), file, {
      policy: VITESTISH,
    })
    files.registerMock('./b.ts', null, { kind: 'automock', spy: false })
    const from = at(root, 'a.test.ts')
    const [, first] = await Promise.all([
      files.import('./b.ts', from),
      files.import<{ c: number }>('./c.ts', from),
    ])
    const second = await files.import<{ c: number }>('./c.ts', from)
    assert.equal(g.__count, 1, 'c ran once')
    assert.equal(first, second, 'one instance')
  } finally {
    Reflect.deleteProperty(globalThis, '__count')
  }
})

test('two automocked modules that import each other terminate (review High 5)', () => {
  const root = writeTree({
    'a.ts': "import { b } from './b.ts'\nexport function a(): string { return 'a' + b() }\n",
    'b.ts': "import { a } from './a.ts'\nexport function b(): string { return 'b' + typeof a }\n",
    'entry.test.ts': '',
  })
  const automock = { ...JESTISH, automock: true }
  const { files } = fileWithMocks(
    loaderFor(root, { policy: automock }),
    join(root, 'entry.test.ts'),
    {
      policy: automock,
    },
  )
  const a = files.require<{ a: () => unknown }>('./a.ts', at(root, 'x.cjs'))
  assert.equal(typeof a.a, 'function')
  assert.equal(a.a(), undefined, 'an automock')
})

test('a late dependency with top-level await works when its module is reached by a static import (review Medium 6)', async () => {
  const root = writeTree({
    'x.ts': 'await Promise.resolve()\nexport const v = 1\n',
    'm.ts': 'export const m = 1\n',
    'h.ts':
      "mocker.mock('./m.ts', () => ({ m: 2 }))\nimport { v } from './x.ts'\nimport { m } from './m.ts'\nexport const hv = v + m\n",
    'entry.test.ts': "import { hv } from './h.ts'\nexport const out = hv\n",
    'tla.test.ts': "import { hv } from './h.ts'\nawait Promise.resolve()\nexport const out = hv\n",
  })
  for (const test of ['entry.test.ts', 'tla.test.ts']) {
    const file = join(root, test)
    const { files } = fileWithMocks(loaderFor(root), file)
    assert.equal((await files.import<{ out: number }>(file)).out, 3, test)
  }
  // Through require there is no waiting, and the error says what was loaded synchronously.
  const { files } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
  assert.throws(() => files.require('./h.ts', at(root, 'a.cjs')), {
    code: 'ERR_REQUIRE_ASYNC_MODULE',
    message: /x\.ts can't be loaded synchronously: its graph has top-level await/,
  })
})

test('a CommonJS module whose evaluation threw is forgotten, so the next require runs it again (review Medium 7)', () => {
  const root = writeTree({
    'dep.cjs':
      "if (globalThis.__fail) throw new Error('dep failed')\nmodule.exports = 'real dep'\n",
    'user.cjs': "module.exports = require('./dep.cjs')\n",
    'esm.ts':
      "if ((globalThis as { __fail?: boolean }).__fail) throw new Error('esm failed')\nexport const ok = 1\n",
    'entry.test.ts': '',
  })
  g.__fail = true
  try {
    const { files } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
    const from = at(root, 'a.cjs')
    assert.throws(() => files.require('./user.cjs', from), { message: 'dep failed' })
    assert.throws(() => files.require('./esm.ts', from), { message: 'esm failed' })
    g.__fail = false
    // Node and Jest drop a CommonJS module that threw; an ES module keeps its error.
    assert.equal(files.require('./user.cjs', from), 'real dep')
    assert.throws(() => files.require('./esm.ts', from), { message: 'esm failed' })
    // With the dependency mocked after the throw, the importer evaluates again and sees the mock.
    g.__fail = true
    const { files: mocked } = fileWithMocks(loaderFor(root), join(root, 'entry.test.ts'))
    assert.throws(() => mocked.require('./user.cjs', from), { message: 'dep failed' })
    mocked.registerMock('./dep.cjs', null, { kind: 'factory', factory: () => 'mocked dep' })
    assert.equal(mocked.require('./user.cjs', from), 'mocked dep')
  } finally {
    Reflect.deleteProperty(globalThis, '__fail')
  }
})
