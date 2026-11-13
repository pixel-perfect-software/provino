import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { collectRequests, type NodeAnswer, withoutMissingTargets } from './requests.ts'

/** A pnpm-like layout: `repo/node_modules/.pnpm/node_modules` (the store) and `repo/packages`. */
function layout() {
  const repo = mkdtempSync(join(tmpdir(), 'resolve-corpus-'))
  const store = join(repo, 'node_modules', '.pnpm', 'node_modules')
  mkdirSync(store, { recursive: true })
  /** A package: `<where>/<name>/package.json`, with `manifest` fields. */
  const make = (where: string, name: string, manifest: Record<string, unknown> = {}) => {
    const dir = join(where, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...manifest }),
    )
    return dir
  }
  return { repo, store, make }
}

describe('collectRequests: third-party packages only', () => {
  test('lists each package and its literal exports subpaths, scoped names included', () => {
    const { store, make } = layout()
    make(store, 'plain', { exports: { '.': './i.js', './sub': './s.js', './wild/*': './w/*.js' } })
    make(join(store, '@scope'), 'pkg', { exports: { './deep/file.js': './d.js' } })
    make(store, 'no-exports')
    mkdirSync(join(store, 'not-a-package'))
    const { requests, workspace } = collectRequests(store)
    assert.deepEqual(requests, [
      '@scope/pkg',
      '@scope/pkg/deep/file.js',
      'no-exports',
      'plain',
      'plain/sub',
    ])
    assert.deepEqual(workspace, [])
  })

  test("leaves out the workspace's own packages, which pnpm links into the store, built or not", () => {
    const { repo, store, make } = layout()
    // The workspace package is a real directory under packages/, linked into the store as pnpm does.
    const own = make(join(repo, 'packages'), 'core', {
      exports: { '.': { 'provino-source': './src/index.ts', import: './dist/index.js' } },
    })
    mkdirSync(join(store, '@provino'), { recursive: true })
    symlinkSync(own, join(store, '@provino', 'core'), 'dir')
    const tooling = make(join(repo, 'tooling'), 'tool')
    symlinkSync(tooling, join(store, 'tool'), 'dir')
    // A third-party package linked the same way, but into the content-addressable store.
    const real = make(join(repo, 'node_modules', '.pnpm', 'lib@1.0.0', 'node_modules'), 'lib')
    symlinkSync(real, join(store, 'lib'), 'dir')

    const first = collectRequests(store)
    assert.deepEqual(first.requests, ['lib'])
    assert.deepEqual(first.workspace, ['@provino/core', 'tool'])
    // The same whether `dist/` exists or not: nothing in the answer depends on it.
    mkdirSync(join(own, 'dist'))
    writeFileSync(join(own, 'dist', 'index.js'), 'export {}\n')
    assert.deepEqual(collectRequests(store), first)
  })
})

describe('withoutMissingTargets: a path Node answers for a file that is not there is not an answer', () => {
  const answers: NodeAnswer[] = [
    { request: 'there', path: '/x/there.js', error: null },
    { request: 'missing', path: '/x/missing.js', error: null },
    { request: 'builtin', path: 'node:fs', error: null },
    { request: 'refused', path: null, error: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
  ]

  test('turns a missing file into the error `import` would throw, and keeps the rest', () => {
    const out = withoutMissingTargets(answers, (path) => path === '/x/there.js')
    assert.deepEqual(
      out.map(({ request, path, error }) => [request, path, error]),
      [
        ['there', '/x/there.js', null],
        ['missing', null, 'ERR_MODULE_NOT_FOUND'],
        ['builtin', 'node:fs', null],
        ['refused', null, 'ERR_PACKAGE_PATH_NOT_EXPORTED'],
      ],
    )
  })

  test('does not look for a builtin or a failed request on disk', () => {
    const asked: string[] = []
    withoutMissingTargets(answers, (path) => {
      asked.push(path)
      return true
    })
    assert.deepEqual(asked, ['/x/there.js', '/x/missing.js'])
  })
})
