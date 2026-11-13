import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import { allowedDeps, loadManifest, type Manifest, validateManifest } from './manifest.ts'
import { MANIFEST_PATH } from './paths.ts'
import { manifestOf } from './test-support.ts'

function manifest(nodes: Readonly<Record<string, Readonly<Record<string, unknown>>>>): Manifest {
  return manifestOf(nodes, { core: 'CorePolicy', mock: 'MockPolicy' })
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
    assert.deepEqual(validateManifest(await loadManifest(MANIFEST_PATH)), [])
  })

  test("its slices are exactly the neutral policy's slices", async () => {
    const { slices } = await loadManifest(MANIFEST_PATH)
    assert.deepEqual(Object.keys(slices).sort(), Object.keys(neutralPolicy).sort())
  })

  test('lists every package build-plan §6 added to the map', async () => {
    const names = new Set((await loadManifest(MANIFEST_PATH)).nodes.map((n) => n.name))
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

describe('the rules the real manifest must keep (CLAUDE.md non-negotiables 1 and 3)', async () => {
  const real = await loadManifest(MANIFEST_PATH)
  const top = real.nodes.filter((n) => n.parent === undefined)
  const nodeNamed = (name: string) => real.nodes.find((n) => n.name === name) ?? assert.fail(name)
  const reaches = (from: string, to: string): boolean =>
    allowedDeps(real, nodeNamed(from)).some((dep) => dep.name === to || dep.parent === to)

  test('the neutral packages are exactly the eleven in non-negotiable 1', () => {
    const neutral = top.filter((n) => n.neutral).map((n) => n.name.replace('@provino/', ''))
    assert.deepEqual(neutral.sort(), [
      'config',
      'core',
      'coverage',
      'expect',
      'lazy',
      'loader',
      'mock',
      'orchestrator',
      'reporters',
      'snapshot',
      'timers',
    ])
  })

  test('only policy, config, orchestrator, the dialects and non-shipped packages skip slice discipline', () => {
    const exempt = top.filter((n) => n.slices === 'all' && typeof n.layer === 'number')
    assert.deepEqual(exempt.map((n) => n.name).sort(), [
      '@provino/config',
      '@provino/dialect-jest',
      '@provino/dialect-node-test',
      '@provino/dialect-vitest',
      '@provino/orchestrator',
      '@provino/policy',
      '@provino/types',
    ])
  })

  test('no neutral node may import a dialect', () => {
    const dialects = real.nodes.filter((n) => n.name.startsWith('@provino/dialect-'))
    for (const from of real.nodes.filter((n) => n.neutral)) {
      for (const to of dialects)
        assert.ok(!reaches(from.name, to.name), `${from.name} → ${to.name}`)
    }
  })

  test('core imports neither the loader nor lazy; lazy builds on core', () => {
    assert.ok(!reaches('@provino/core', '@provino/loader'))
    assert.ok(!reaches('@provino/core', '@provino/lazy'))
    assert.ok(reaches('@provino/lazy', '@provino/core'))
  })

  test("the orchestrator's coordinator and worker entries never import each other", () => {
    assert.ok(!reaches('@provino/orchestrator', '@provino/orchestrator/worker'))
    assert.ok(!reaches('@provino/orchestrator/worker', '@provino/orchestrator'))
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

  test("a subpath entry must carry its package's ban list (T7.12)", () => {
    const problems = validateManifest(
      manifest({
        pkg: node(2, 'both', [], { dir: 'packages/pkg', bannedPackages: ['expect'] }),
        'pkg/runtime': node(2, 'worker', [], { dir: 'packages/pkg/src/runtime' }),
      }),
    )
    assert.deepEqual(
      problems.map((p) => p.rule),
      ['manifest-subpath'],
    )
  })

  test('bannedPackages must be a list of names', () => {
    assert.throws(
      () => manifest({ a: node(1, 'both', [], { bannedPackages: 'expect' }) }),
      /nodes\["a"\]\.bannedPackages must be an array/,
    )
  })

  test('the real manifest bans the engines Provino replaces from expect and snapshot', async () => {
    const { nodes } = await loadManifest(MANIFEST_PATH)
    for (const name of ['@provino/expect', '@provino/snapshot', '@provino/snapshot/runtime']) {
      assert.deepEqual(
        nodes.find((n) => n.name === name)?.bannedPackages,
        ['expect', '@vitest/expect', 'jest-snapshot', '@vitest/snapshot', '@babel/*'],
        name,
      )
    }
  })

  test('malformed fields throw, naming the field', () => {
    assert.throws(() => manifest({ a: node(1, 'nowhere') }), /nodes\["a"\]\.runsIn/)
    assert.throws(() => manifest({ a: node(-1, 'both') }), /nodes\["a"\]\.layer/)
  })

  test('an unknown key throws, so a typo like "neutal" cannot switch a lint off', () => {
    assert.throws(
      () => manifest({ a: node(1, 'both', [], { neutal: true }) }),
      /unknown key "neutal"/,
    )
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
