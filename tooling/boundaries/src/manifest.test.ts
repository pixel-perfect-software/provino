import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { neutralPolicy } from '@provino/policy'
import {
  allowedDeps,
  loadManifest,
  type Manifest,
  parseManifest,
  validateManifest,
} from './manifest.ts'

const manifestPath = fileURLToPath(new URL('../packages.json', import.meta.url))

function manifest(nodes: Readonly<Record<string, Readonly<Record<string, unknown>>>>): Manifest {
  return parseManifest({
    slices: { core: 'CorePolicy', mock: 'MockPolicy' },
    wholePolicyTypes: ['Policy'],
    nodes,
  })
}

const node = (
  layer: number | string,
  runsIn: string,
  deps: readonly string[] = [],
  extra = {},
) => ({
  dir: null,
  layer,
  runsIn,
  deps,
  slices: [],
  ...extra,
})

describe('the real manifest', () => {
  test('has no problems', async () => {
    assert.deepEqual(validateManifest(await loadManifest(manifestPath)), [])
  })

  test("its slices are exactly the neutral policy's slices", async () => {
    const { slices } = await loadManifest(manifestPath)
    assert.deepEqual(Object.keys(slices).sort(), Object.keys(neutralPolicy).sort())
  })

  test('lists every package build-plan §6 added to the map', async () => {
    const names = new Set((await loadManifest(manifestPath)).nodes.map((n) => n.name))
    for (const name of [
      '@provino/eslint-plugin',
      '@provino/codemod-lazy',
      '@provino/vitest-compat',
      '@provino/jest-globals',
      '@provino/orchestrator/worker',
      '@provino/dialect-node-test',
      'provino-site',
      '@provino/env-shared',
    ]) {
      assert.ok(names.has(name), name)
    }
  })
})

describe('validateManifest', () => {
  test('layers point down', () => {
    const problems = validateManifest(
      manifest({ low: node(1, 'both', ['high']), high: node(2, 'both') }),
    )
    assert.deepEqual(
      problems.map((p) => p.rule),
      ['manifest-layer'],
    )
  })

  test('a same-layer edge is allowed when listed', () => {
    assert.deepEqual(
      validateManifest(manifest({ a: node(2, 'worker', ['b']), b: node(2, 'worker') })),
      [],
    )
  })

  test('worker and coordinator code never meet', () => {
    const problems = validateManifest(
      manifest({
        w: node(3, 'worker', ['c']),
        c: node(2, 'coordinator', ['w2']),
        w2: node(1, 'worker'),
        both: node(3, 'both', ['w2']),
      }),
    )
    assert.deepEqual(
      problems.map((p) => p.rule),
      ['manifest-runs-in', 'manifest-runs-in', 'manifest-runs-in'],
    )
  })

  test('a composition root may combine both sides', () => {
    const m = manifest({
      top: node(6, 'both', ['w', 'c'], { compositionRoot: true }),
      w: node(3, 'worker'),
      c: node(3, 'coordinator'),
    })
    assert.deepEqual(validateManifest(m), [])
  })

  test('shipped packages never depend on dev or tooling packages', () => {
    const problems = validateManifest(
      manifest({ a: node(3, 'both', ['h']), h: node('dev', 'dev') }),
    )
    assert.deepEqual(
      problems.map((p) => p.rule),
      ['manifest-layer', 'manifest-runs-in'],
    )
  })

  test('unknown deps, self deps and unknown slices are reported', () => {
    const problems = validateManifest(
      manifest({ a: node(1, 'both', ['ghost', 'a'], { slices: ['reporter'] }) }),
    )
    assert.deepEqual(
      problems.map((p) => p.rule),
      ['manifest-slices', 'manifest-deps', 'manifest-deps'],
    )
  })

  test('a subpath entry sits inside its package and shares its lint settings', () => {
    const problems = validateManifest(
      manifest({
        pkg: node(2, 'both', [], { dir: 'packages/pkg', slices: ['core'] }),
        'pkg/runtime': node(2, 'worker', [], { dir: 'packages/other/src', slices: ['mock'] }),
      }),
    )
    assert.deepEqual(
      problems.map((p) => p.rule),
      ['manifest-subpath', 'manifest-subpath'],
    )
  })

  test('malformed fields throw, naming the field', () => {
    assert.throws(() => manifest({ a: node(1, 'nowhere') }), /nodes\["a"\]\.runsIn/)
    assert.throws(() => manifest({ a: node(-1, 'both') }), /nodes\["a"\]\.layer/)
  })
})

describe('allowedDeps', () => {
  test('@provino/* expands to shipped nodes in lower layers', () => {
    const m = manifest({
      top: node(3, 'both', ['@provino/*'], { compositionRoot: true }),
      a: node(1, 'both'),
      b: node(2, 'both'),
      peer: node(3, 'both'),
      dev: node('dev', 'dev', ['@provino/*']),
    })
    const names = (name: string): string[] =>
      allowedDeps(m, m.nodes.find((n) => n.name === name) ?? assert.fail(name)).map((n) => n.name)
    assert.deepEqual(names('top'), ['a', 'b'])
    assert.deepEqual(names('dev'), ['top', 'a', 'b', 'peer'])
  })
})
