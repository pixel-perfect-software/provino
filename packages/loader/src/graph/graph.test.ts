// T2.6's graph contract (B13d): the scan (ESM, CommonJS, re-exports, dynamic specifiers), the
// graph over a temp tree, and the disk cache (a hit, a miss on a lockfile change, no lockfile, a
// corrupt file, atomic writes).
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createResolver } from '@provino/resolver'
import { buildThirdPartyGraph, graphCacheKey, importersOf, initLexer, scanSource } from './index.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Writes `files` into a fresh temp directory (its real path), removed after the test file. */
function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-graph-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function resolverFor(root: string) {
  return createResolver({
    root,
    mappers: [],
    extensions: ['.js', '.mjs', '.cjs', '.json'],
    tsconfig: false,
  })
}

describe('scanSource', () => {
  before(async () => {
    await initLexer()
  })

  test('finds ES static imports, re-exports and import() with a literal', () => {
    const scan = scanSource(
      [
        "import a from './a.js'",
        "import { b } from 'b'",
        "export * from './c.js'",
        "export { d } from 'd'",
        "const e = await import('e')",
        "import type { T } from 't'",
      ].join('\n'),
    )
    assert.deepEqual(scan.edges.map((edge) => `${edge.kind} ${edge.specifier}`).sort(), [
      'import ./a.js',
      'import ./c.js',
      'import b',
      'import d',
      'import e',
    ])
    assert.equal(scan.dynamic, false)
  })

  test('finds CommonJS requires, in each quote style', () => {
    const scan = scanSource(
      "const a = require('a'); const b = require(\"./b\"); const c = require(`c`)\nfoo.require('no')",
    )
    assert.deepEqual(
      scan.edges.map((edge) => `${edge.kind} ${edge.specifier}`),
      ['require a', 'require ./b', 'require c'],
    )
    assert.equal(scan.dynamic, false)
  })

  test('flags a computed specifier, for require and for import()', () => {
    assert.equal(scanSource('require(name)').dynamic, true)
    assert.equal(scanSource("require('a' + b)").dynamic, true)
    assert.equal(scanSource('await import(name)').dynamic, true)
    assert.equal(scanSource(['await import(`./locales/$', '{l}.js`)'].join('')).dynamic, true)
    assert.equal(scanSource("require('literal')").dynamic, false)
  })

  test('a file the lexer rejects still gets its requires', () => {
    const scan = scanSource("import {{{ broken\nrequire('still-here')")
    assert.deepEqual(
      scan.edges.map((edge) => edge.specifier),
      ['still-here'],
    )
  })

  test('lists an edge once', () => {
    const scan = scanSource("require('a'); require('a'); import('a'); import('a')")
    assert.deepEqual(
      scan.edges.map((edge) => `${edge.kind} ${edge.specifier}`),
      ['import a', 'require a'],
    )
  })
})

describe('scanSource: what it must not lose', () => {
  before(async () => {
    await initLexer()
  })

  test('a file the lexer cannot parse is dynamic, and keeps its requires', () => {
    const scan = scanSource("import x from 'x'; }}}\nrequire('still-here')")
    assert.equal(scan.dynamic, true)
    assert.deepEqual(
      scan.edges.map((edge) => edge.specifier),
      ['still-here'],
    )
  })

  test('a file with no module syntax is never reported as unparseable', () => {
    assert.equal(scanSource('module.exports = { exports: 1 } }}}').dynamic, false)
  })

  test('module.require is a require', () => {
    const scan = scanSource("const a = module.require('a'); other.require('no')")
    assert.deepEqual(
      scan.edges.map((edge) => `${edge.kind} ${edge.specifier}`),
      ['require a'],
    )
    assert.equal(scan.dynamic, false)
  })

  test('createRequire and an alias of require are dynamic', () => {
    assert.equal(scanSource("const { createRequire } = require('node:module')").dynamic, true)
    assert.equal(scanSource("const r = require; r('x')").dynamic, true)
    assert.equal(scanSource("foo(require); require('x')").dynamic, true)
  })

  test('require.resolve, require.cache and typeof require are not aliases', () => {
    assert.equal(scanSource("require.resolve('x'); require.cache; require.main").dynamic, false)
    assert.equal(scanSource("if (typeof require === 'function') module.exports = 1").dynamic, false)
  })

  test('a comment before the literal still yields the edge', () => {
    const scan = scanSource("require(/* c */ 'a'); require( // line\n 'b' /* d */ )")
    assert.deepEqual(
      scan.edges.map((edge) => edge.specifier),
      ['a', 'b'],
    )
    assert.equal(scan.dynamic, false)
  })
})

const TREE = {
  'package.json': '{"name":"app"}',
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  'node_modules/.modules.yaml': 'layoutVersion: 5\n',
  'node_modules/pkg-a/package.json': '{"name":"pkg-a","main":"index.js"}',
  'node_modules/pkg-a/index.js':
    "const b = require('pkg-b'); const os = require('os'); module.exports = { b, os }",
  'node_modules/pkg-b/package.json': '{"name":"pkg-b","main":"index.js"}',
  'node_modules/pkg-b/index.js': "module.exports = require('./lib/c.js')",
  'node_modules/pkg-b/lib/c.js': "module.exports = 'c'; try { require('not-installed') } catch {}",
  'node_modules/pkg-esm/package.json': '{"name":"pkg-esm","type":"module","exports":"./index.js"}',
  'node_modules/pkg-esm/index.js': "export * from 'pkg-b'\nexport { x } from './x.js'",
  'node_modules/pkg-esm/x.js': 'export const x = 1',
  'node_modules/pkg-dyn/package.json': '{"name":"pkg-dyn","main":"index.js"}',
  'node_modules/pkg-dyn/index.js': 'module.exports = (n) => require(n)',
  'node_modules/pkg-cycle/package.json': '{"name":"pkg-cycle","main":"index.js"}',
  'node_modules/pkg-cycle/index.js': "exports.b = require('./b.js')",
  'node_modules/pkg-cycle/b.js': "exports.a = require('./index.js')",
  'src/user.js': "require('pkg-a')",
}

describe('buildThirdPartyGraph', () => {
  test('follows CommonJS and ESM edges through node_modules, with builtins and misses as targets', () => {
    const root = writeTree(TREE)
    const graph = buildThirdPartyGraph({ root, resolver: resolverFor(root) })
    graph.add(join(root, 'node_modules/pkg-a/index.js'))
    const a = graph.nodeOf(join(root, 'node_modules/pkg-a/index.js'))
    assert.deepEqual(
      a?.edges.map((edge) => [edge.specifier, edge.target]),
      [
        ['pkg-b', join(root, 'node_modules/pkg-b/index.js')],
        ['os', 'node:os'],
      ],
    )
    const c = graph.nodeOf(join(root, 'node_modules/pkg-b/lib/c.js'))
    assert.deepEqual(
      c?.edges.map((edge) => [edge.specifier, edge.target]),
      [['not-installed', null]],
    )
    assert.deepEqual(
      graph
        .reachable(join(root, 'node_modules/pkg-a/index.js'))
        .map((entry) => entry.path.slice(root.length + 1))
        .sort(),
      ['node_modules/pkg-a/index.js', 'node_modules/pkg-b/index.js', 'node_modules/pkg-b/lib/c.js'],
    )
    // `os` is a builtin, not a node.
    assert.equal(graph.has('node:os'), false)
  })

  test('follows ES re-exports and finishes on a cycle', () => {
    const root = writeTree(TREE)
    const graph = buildThirdPartyGraph({ root, resolver: resolverFor(root) })
    graph.add(join(root, 'node_modules/pkg-esm/index.js'))
    graph.add(join(root, 'node_modules/pkg-cycle/index.js'))
    const esm = graph
      .reachable(join(root, 'node_modules/pkg-esm/index.js'))
      .map((entry) => entry.path.slice(root.length + 1))
      .sort()
    assert.deepEqual(esm, [
      'node_modules/pkg-b/index.js',
      'node_modules/pkg-b/lib/c.js',
      'node_modules/pkg-esm/index.js',
      'node_modules/pkg-esm/x.js',
    ])
    assert.equal(graph.reachable(join(root, 'node_modules/pkg-cycle/index.js')).length, 2)
  })

  test('marks a file with a computed require', () => {
    const root = writeTree(TREE)
    const graph = buildThirdPartyGraph({ root, resolver: resolverFor(root) })
    graph.add(join(root, 'node_modules/pkg-dyn/index.js'))
    assert.equal(graph.nodeOf(join(root, 'node_modules/pkg-dyn/index.js'))?.dynamic, true)
  })

  test('never scans a file outside node_modules', () => {
    const root = writeTree(TREE)
    const graph = buildThirdPartyGraph({ root, resolver: resolverFor(root) })
    graph.add(join(root, 'src/user.js'))
    assert.equal(graph.size, 0)
  })

  test('importersOf answers who reaches a file, through others', () => {
    const root = writeTree(TREE)
    const graph = buildThirdPartyGraph({ root, resolver: resolverFor(root) })
    graph.add(join(root, 'node_modules/pkg-a/index.js'))
    graph.add(join(root, 'node_modules/pkg-esm/index.js'))
    const importers = importersOf(graph, join(root, 'node_modules/pkg-b/lib/c.js'))
      .map((path) => path.slice(root.length + 1))
      .sort()
    assert.deepEqual(importers, [
      'node_modules/pkg-a/index.js',
      'node_modules/pkg-b/index.js',
      'node_modules/pkg-esm/index.js',
    ])
  })
})

describe('the graph cache', () => {
  function cacheFiles(dir: string): string[] {
    return existsSync(join(dir, 'graph')) ? readdirSync(join(dir, 'graph')).sort() : []
  }

  test('a second graph reads what the first saved, and scans nothing', () => {
    const root = writeTree(TREE)
    const cacheDir = join(root, 'node_modules/.cache/provino')
    const entry = join(root, 'node_modules/pkg-a/index.js')
    const first = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    first.add(entry)
    assert.equal(first.fromCache, false)
    assert.equal(first.scanned, 3)
    first.save()
    assert.equal(cacheFiles(cacheDir).length, 1)
    assert.ok(!cacheFiles(cacheDir)[0]?.endsWith('.tmp'))

    const second = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    second.add(entry)
    assert.equal(second.fromCache, true)
    assert.equal(second.scanned, 0)
    assert.equal(second.size, 3)
    assert.deepEqual(second.nodeOf(entry), first.nodeOf(entry))
  })

  test('a lockfile change is a miss', () => {
    const root = writeTree(TREE)
    const cacheDir = join(root, 'node_modules/.cache/provino')
    const entry = join(root, 'node_modules/pkg-a/index.js')
    const first = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    first.add(entry)
    first.save()
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# changed\n')
    const second = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    second.add(entry)
    assert.equal(second.fromCache, false)
    assert.equal(second.scanned, 3)
  })

  test('the resolver and the conditions are part of the key', () => {
    const root = writeTree(TREE)
    assert.notEqual(graphCacheKey(root, 'a'), graphCacheKey(root, 'b'))
    assert.equal(graphCacheKey(root, 'a'), graphCacheKey(root, 'a'))
  })

  test('no lockfile: the graph stays in memory', () => {
    const root = writeTree({
      'node_modules/pkg-b/package.json': '{"name":"pkg-b","main":"index.js"}',
      'node_modules/pkg-b/index.js': 'module.exports = 1',
    })
    // The temp directory's parents have no lockfile either.
    assert.equal(graphCacheKey(root, 'x'), null)
    const cacheDir = join(root, 'node_modules/.cache/provino')
    const graph = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    graph.add(join(root, 'node_modules/pkg-b/index.js'))
    graph.save()
    assert.deepEqual(cacheFiles(cacheDir), [])
  })

  test('a corrupt file is ignored, then rebuilt', () => {
    const root = writeTree(TREE)
    const cacheDir = join(root, 'node_modules/.cache/provino')
    const entry = join(root, 'node_modules/pkg-a/index.js')
    const first = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    first.add(entry)
    first.save()
    const [name] = cacheFiles(cacheDir)
    assert.ok(name !== undefined)
    writeFileSync(join(cacheDir, 'graph', name), '{"format":1,"nodes":{"x":[9')
    const second = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    second.add(entry)
    assert.equal(second.fromCache, false)
    assert.equal(second.scanned, 3)
    second.save()
    const third = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    third.add(entry)
    assert.equal(third.fromCache, true)
  })

  test('a save merges with what another worker wrote, and leaves no temp file', () => {
    const root = writeTree(TREE)
    const cacheDir = join(root, 'node_modules/.cache/provino')
    const one = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    const two = buildThirdPartyGraph({ root, resolver: resolverFor(root), cacheDir })
    one.add(join(root, 'node_modules/pkg-a/index.js'))
    two.add(join(root, 'node_modules/pkg-esm/index.js'))
    one.save()
    two.save()
    const names = cacheFiles(cacheDir)
    assert.equal(names.length, 1)
    assert.ok(names.every((name) => name.endsWith('.json')))
    const body: unknown = JSON.parse(readFileSync(join(cacheDir, 'graph', names[0] ?? ''), 'utf8'))
    const stored = body !== null && typeof body === 'object' ? Reflect.get(body, 'nodes') : null
    const paths = Object.keys(stored ?? {}).map((path) => path.slice(root.length + 1))
    assert.ok(paths.includes('node_modules/pkg-a/index.js'))
    assert.ok(paths.includes('node_modules/pkg-esm/x.js'))
  })
})
