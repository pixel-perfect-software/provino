import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadManifest, parseManifest } from './manifest.ts'
import { checkWorkspace, matches, readWorkspace } from './workspace.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))

const m = parseManifest({
  slices: {},
  wholePolicyTypes: [],
  nodes: {
    '@provino/types': { dir: 'packages/types', layer: 0, runsIn: 'types', deps: [], slices: [] },
    '@provino/core': {
      dir: 'packages/core',
      layer: 3,
      runsIn: 'worker',
      deps: ['@provino/types'],
      slices: [],
    },
    '@provino/native-*': {
      dir: 'packages/native-*',
      layer: 1,
      runsIn: 'both',
      deps: [],
      slices: [],
    },
  },
})

describe('checkWorkspace', () => {
  test('the real workspace matches the real manifest', async () => {
    const manifest = await loadManifest(new URL('../packages.json', import.meta.url))
    assert.deepEqual(checkWorkspace(manifest, await readWorkspace(root)), [])
  })

  test('a package missing from the manifest is reported', () => {
    const problems = checkWorkspace(m, [
      { dir: 'packages/extra', name: '@provino/extra', deps: [] },
    ])
    assert.deepEqual(
      problems.map((p) => p.rule),
      ['manifest-unknown-package'],
    )
  })

  test('a package named differently from its manifest node is reported', () => {
    const problems = checkWorkspace(m, [
      { dir: 'packages/core', name: '@provino/kernel', deps: [] },
    ])
    assert.deepEqual(
      problems.map((p) => p.rule),
      ['manifest-name'],
    )
  })

  test("a package.json dependency the manifest doesn't allow is reported", () => {
    const problems = checkWorkspace(m, [
      { dir: 'packages/types', name: '@provino/types', deps: ['@provino/core', 'some-lib'] },
      { dir: 'packages/core', name: '@provino/core', deps: ['@provino/types'] },
    ])
    assert.deepEqual(
      problems.map((p) => p.message),
      [
        "@provino/types depends on @provino/core in package.json, but the manifest doesn't allow it",
      ],
    )
  })

  test('pattern nodes match their packages', () => {
    const problems = checkWorkspace(m, [
      { dir: 'packages/native-linux-x64', name: '@provino/native-linux-x64', deps: [] },
    ])
    assert.deepEqual(problems, [])
  })
})

test('matches: `*` is one path segment', () => {
  assert.ok(matches('packages/native-*', 'packages/native-darwin-arm64'))
  assert.ok(!matches('packages/native-*', 'packages/native-a/b'))
  assert.ok(matches('@provino/core', '@provino/core'))
  assert.ok(!matches('@provino/core', '@provino/core2'))
})
