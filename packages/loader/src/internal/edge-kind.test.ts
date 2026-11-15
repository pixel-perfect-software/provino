// `ModulePolicy.edgeResolveKind`: which kind an edge resolves as, by the importer's format.
// Recorded from Jest 30.5.2 by `env/conditions-import-*` (`provino`'s `jest-conditions.test.ts`).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { ModulePolicy } from '@provino/types'
import { createEdgeKindState, type EdgeKindOptions, edgeKind, runsAsEsm } from './edge-kind.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-edge-kind-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function options(
  edgeResolveKind: ModulePolicy['edgeResolveKind'],
  esmExtensions?: readonly string[],
): EdgeKindOptions {
  return { policy: { edgeResolveKind }, ...(esmExtensions === undefined ? {} : { esmExtensions }) }
}

test('as-written: every edge keeps its own kind', () => {
  const state = createEdgeKindState(options('as-written'), true)
  for (const kind of ['import', 'require', 'dynamic-import', 'import-meta-resolve'] as const) {
    assert.equal(edgeKind(state, '/p/a.ts', kind), kind)
    assert.equal(edgeKind(state, '/p/a.mjs', kind), kind)
  }
})

test('importer-format: a CommonJS-run module resolves every edge as require', () => {
  const root = tree({ 'package.json': '{}\n', 'a.ts': '', 'b.js': '', 'c.cjs': '' })
  const state = createEdgeKindState(options('importer-format'), true)
  for (const file of ['a.ts', 'b.js', 'c.cjs']) {
    for (const kind of ['import', 'require', 'dynamic-import'] as const) {
      assert.equal(edgeKind(state, join(root, file), kind), 'require', `${file} ${kind}`)
    }
  }
})

test('importer-format: an ES-module-run module resolves every edge as import', () => {
  const root = tree({
    'esm/package.json': '{"type":"module"}\n',
    'esm/deep/b.js': '',
    'esm/c.cjs': '',
    'a.mjs': '',
    'd.ts': '',
    'package.json': '{"type":"commonjs"}\n',
  })
  const state = createEdgeKindState(options('importer-format', ['.ts']), true)
  for (const file of ['esm/deep/b.js', 'a.mjs', 'd.ts']) {
    assert.equal(runsAsEsm(state, join(root, file)), true, file)
    assert.equal(edgeKind(state, join(root, file), 'require'), 'import', file)
  }
  // `.cjs` is CommonJS whatever its package says.
  assert.equal(edgeKind(state, join(root, 'esm/c.cjs'), 'import'), 'require')
})

test('importer-format: the nearest package.json decides a .js file, and a broken one is CommonJS', () => {
  const root = tree({
    'package.json': '{"type":"module"}\n',
    'inner/package.json': '{"name":"inner"}\n',
    'inner/a.js': '',
    'broken/package.json': '{ not json',
    'broken/b.js': '',
    'c.js': '',
  })
  const state = createEdgeKindState(options('importer-format'), true)
  assert.equal(runsAsEsm(state, join(root, 'inner/a.js')), false)
  assert.equal(runsAsEsm(state, join(root, 'broken/b.js')), false)
  assert.equal(runsAsEsm(state, join(root, 'c.js')), true)
})

test('importer-format without vm modules: every module is CommonJS, as Jest has it', () => {
  const root = tree({ 'package.json': '{"type":"module"}\n', 'a.js': '', 'b.mjs': '', 'c.ts': '' })
  const state = createEdgeKindState(options('importer-format', ['.ts']), false)
  for (const file of ['a.js', 'b.mjs', 'c.ts']) {
    assert.equal(edgeKind(state, join(root, file), 'import'), 'require', file)
  }
})

test('import.meta.resolve keeps its own kind under importer-format', () => {
  const state = createEdgeKindState(options('importer-format'), true)
  assert.equal(edgeKind(state, '/p/a.ts', 'import-meta-resolve'), 'import-meta-resolve')
})
