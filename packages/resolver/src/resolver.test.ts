import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { ModuleMapper, ResolveContext } from '@provino/types'
import { createResolver } from './resolver.ts'

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']
const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Writes a file tree into a fresh temp dir and returns its real path. */
function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-resolver-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function context(importer: string, kind: ResolveContext['kind'] = 'import'): ResolveContext {
  return { importer, kind, conditions: ['node'] }
}

test('tsconfig paths, project references and .js → .ts resolve together', () => {
  // A solution-style root tsconfig points at a project that isn't auto-discovered by name, so
  // the paths only apply if `references` is followed.
  const root = writeTree({
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    'tsconfig.app.json': JSON.stringify({
      compilerOptions: { paths: { '@lib/*': ['./app/src/lib/*'] } },
      include: ['app/src'],
    }),
    'app/src/main.ts': "import { util } from '@lib/util.js'\nimport Comp from './comp.js'\n",
    'app/src/lib/util.ts': 'export const util = 1\n',
    'app/src/comp.tsx': 'export default function Comp() { return null }\n',
    'scripts/outside.ts': '',
  })
  const resolver = createResolver({ root, mappers: [], extensions: EXTENSIONS })
  const importer = join(root, 'app/src/main.ts')

  const util = resolver.resolve('@lib/util.js', context(importer))
  assert.equal(util.type, 'file')
  assert.equal(util.type === 'file' && util.path, join(root, 'app/src/lib/util.ts'))
  const comp = resolver.resolve('./comp.js', context(importer))
  assert.equal(comp.type === 'file' && comp.path, join(root, 'app/src/comp.tsx'))
  // A file outside the referenced project doesn't get its paths.
  const outside = resolver.resolve('@lib/util.js', context(join(root, 'scripts/outside.ts')))
  assert.equal(outside.type, 'not-found')
})

test('tsconfig: false skips paths', () => {
  const root = writeTree({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['./lib/*'] } } }),
    'lib/util.ts': 'export {}\n',
    'main.ts': '',
  })
  const off = createResolver({ root, mappers: [], extensions: EXTENSIONS, tsconfig: false })
  assert.equal(off.resolve('@lib/util.js', context(join(root, 'main.ts'))).type, 'not-found')
  const on = createResolver({ root, mappers: [], extensions: EXTENSIONS })
  assert.equal(on.resolve('@lib/util.js', context(join(root, 'main.ts'))).type, 'file')
})

test('builtins resolve to node: ids, with or without the prefix', () => {
  const root = writeTree({ 'main.ts': '' })
  const resolver = createResolver({ root, mappers: [], extensions: EXTENSIONS })
  for (const specifier of ['fs', 'node:fs', 'fs/promises']) {
    const result = resolver.resolve(specifier, context(join(root, 'main.ts')))
    assert.deepEqual(
      result,
      { type: 'builtin', id: specifier === 'fs/promises' ? 'node:fs/promises' : 'node:fs' },
      specifier,
    )
  }
})

test('the call kind picks the export condition, and the module type becomes the format', () => {
  const root = writeTree({
    'main.ts': '',
    'node_modules/dual/package.json': JSON.stringify({
      name: 'dual',
      exports: { '.': { import: './esm.mjs', require: './cjs.cjs' }, './data': './data.json' },
    }),
    'node_modules/dual/esm.mjs': 'export default 1\n',
    'node_modules/dual/cjs.cjs': 'module.exports = 1\n',
    'node_modules/dual/data.json': '{}\n',
  })
  const resolver = createResolver({ root, mappers: [], extensions: EXTENSIONS })
  const importer = join(root, 'main.ts')
  const pkg = join(root, 'node_modules/dual')

  const imported = resolver.resolve('dual', context(importer, 'import'))
  assert.deepEqual(imported, {
    type: 'file',
    path: join(pkg, 'esm.mjs'),
    format: 'esm',
    packageJson: join(pkg, 'package.json'),
    mappedBy: null,
  })
  const required = resolver.resolve('dual', context(importer, 'require'))
  assert.equal(required.type === 'file' && required.path, join(pkg, 'cjs.cjs'))
  assert.equal(required.type === 'file' && required.format, 'cjs')
  const dynamic = resolver.resolve('dual', context(importer, 'dynamic-import'))
  assert.equal(dynamic.type === 'file' && dynamic.path, join(pkg, 'esm.mjs'))
  const json = resolver.resolve('dual/data', context(importer))
  assert.equal(json.type === 'file' && json.format, 'json')
})

test('a miss reports the specifier and importer', () => {
  const root = writeTree({ 'main.ts': '' })
  const resolver = createResolver({ root, mappers: [], extensions: EXTENSIONS })
  const importer = join(root, 'main.ts')
  assert.deepEqual(resolver.resolve('./missing.js', context(importer)), {
    type: 'not-found',
    specifier: './missing.js',
    importer,
    tried: [],
    mappedBy: null,
  })
})

test('mappers run first: the first hit wins, its candidates are tried in order', () => {
  const root = writeTree({ 'main.ts': '', 'b.ts': 'export {}\n', 'c.ts': 'export {}\n' })
  const importer = join(root, 'main.ts')
  const toB: ModuleMapper = {
    id: 'to-b',
    map: (specifier) =>
      specifier === 'virtual'
        ? { candidates: ['./missing.ts', './b.ts'], onMiss: 'error', rule: '^virtual$' }
        : null,
  }
  const toC: ModuleMapper = {
    id: 'to-c',
    map: () => ({ candidates: ['./c.ts'], onMiss: 'error', rule: '.*' }),
  }
  const resolver = createResolver({ root, mappers: [toB, toC], extensions: EXTENSIONS })
  const hit = resolver.resolve('virtual', context(importer))
  assert.equal(hit.type === 'file' && hit.path, join(root, 'b.ts'))
  assert.equal(hit.type === 'file' && hit.mappedBy, '^virtual$')
  // `to-b` passes, so `to-c` maps everything else.
  const other = resolver.resolve('anything', context(importer))
  assert.equal(other.type === 'file' && other.path, join(root, 'c.ts'))
})

test("a mapper miss is an error with onMiss 'error' and falls through with 'continue'", () => {
  const root = writeTree({ 'main.ts': '', 'real.ts': 'export {}\n' })
  const importer = join(root, 'main.ts')
  const mapper = (onMiss: 'error' | 'continue'): ModuleMapper => ({
    id: onMiss,
    map: (specifier) =>
      specifier === './real.js' ? { candidates: ['./nowhere.ts'], onMiss, rule: 'real' } : null,
  })
  const strict = createResolver({ root, mappers: [mapper('error')], extensions: EXTENSIONS })
  assert.deepEqual(strict.resolve('./real.js', context(importer)), {
    type: 'not-found',
    specifier: './real.js',
    importer,
    tried: ['./nowhere.ts'],
    mappedBy: 'real',
  })
  const loose = createResolver({ root, mappers: [mapper('continue')], extensions: EXTENSIONS })
  const result = loose.resolve('./real.js', context(importer))
  assert.equal(result.type === 'file' && result.path, join(root, 'real.ts'))
})

test('invalidate drops cached misses', () => {
  const root = writeTree({ 'main.ts': '' })
  const resolver = createResolver({ root, mappers: [], extensions: EXTENSIONS })
  const importer = join(root, 'main.ts')
  assert.equal(resolver.resolve('./late.js', context(importer)).type, 'not-found')
  writeFileSync(join(root, 'late.ts'), 'export {}\n')
  resolver.invalidate([join(root, 'late.ts')])
  assert.equal(resolver.resolve('./late.js', context(importer)).type, 'file')
})

test('the fingerprint changes with the options', () => {
  const root = writeTree({ 'main.ts': '' })
  const a = createResolver({ root, mappers: [], extensions: EXTENSIONS })
  const b = createResolver({ root, mappers: [], extensions: EXTENSIONS })
  const c = createResolver({ root, mappers: [], extensions: ['.js'] })
  assert.equal(a.fingerprint, b.fingerprint)
  assert.notEqual(a.fingerprint, c.fingerprint)
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/)
})

test('options T3.3 adds are rejected, not ignored', () => {
  const root = writeTree({ 'main.ts': '' })
  assert.throws(
    () => createResolver({ root, mappers: [], extensions: EXTENSIONS, modulePaths: ['/x'] }),
    { code: 'RESOLVER_OPTION_UNSUPPORTED' },
  )
  assert.throws(
    () => createResolver({ root, mappers: [], extensions: EXTENSIONS, custom: () => '/x' }),
    { code: 'RESOLVER_OPTION_UNSUPPORTED' },
  )
})
