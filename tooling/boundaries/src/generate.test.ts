import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BIOME_PLUGINS, DEPCRUISE_CONFIG, generate } from './generate.ts'
import { loadManifest } from './manifest.ts'
import { MANIFEST_PATH, ROOT } from './paths.ts'
import { readWorkspace } from './workspace.ts'

const manifest = await loadManifest(MANIFEST_PATH)
const { roots } = await readWorkspace(ROOT)
const files = generate(manifest, roots)

interface Rule {
  readonly name: string
  readonly from: {
    readonly path?: string | readonly string[]
    readonly pathNot?: string | readonly string[]
  }
  readonly to: { readonly pathNot?: string | readonly string[] }
}
const config = JSON.parse(files.get(DEPCRUISE_CONFIG) ?? '{}') as {
  readonly forbidden: readonly Rule[]
}
const ruleNamed = (name: string): Rule =>
  config.forbidden.find((rule) => rule.name === name) ?? assert.fail(`no rule ${name}`)
const from = (name: string): RegExp => new RegExp(String(ruleNamed(name).from.path))
const allows = (name: string, path: string): boolean =>
  [ruleNamed(name).to.pathNot ?? []].flat().some((re) => new RegExp(re).test(path))

test('the generated files on disk are current (else run `pnpm boundaries:write`)', async () => {
  for (const [path, content] of files) {
    const onDisk = await readFile(join(ROOT, path), 'utf8')
    assert.equal(onDisk.replaceAll('\r\n', '\n'), content, path)
  }
})

test("a package's rule owns its files but not its subpath entries' files or their tests", () => {
  assert.ok(from('boundary-orchestrator').test('packages/orchestrator/src/run.ts'))
  assert.ok(!from('boundary-orchestrator').test('packages/orchestrator/src/worker/entry.ts'))
  assert.ok(!from('boundary-orchestrator').test('packages/orchestrator/test/run.test-d.ts'))
  assert.ok(from('boundary-orchestrator-worker').test('packages/orchestrator/src/worker/entry.ts'))
  assert.ok(from('boundary-orchestrator-test').test('packages/orchestrator/test/run.test-d.ts'))
  assert.ok(!from('boundary-snapshot').test('packages/snapshot/src/runtime/state.ts'))
  assert.ok(from('boundary-snapshot').test('packages/snapshot/src/runtime-utils/x.ts'))
  assert.ok(from('boundary-native-x').test('packages/native-linux-x64/index.ts'))
  assert.ok(!from('boundary-core').test('packages/core-extra/src/index.ts'))
  // A package without entries keeps its tests under its own rule.
  assert.ok(from('boundary-core').test('packages/core/test/core.test-d.ts'))
})

test("a package's tests may import its own entries; the package itself may not", () => {
  const runtime = 'packages/snapshot/src/runtime/index.ts'
  assert.ok(allows('boundary-snapshot-test', runtime))
  assert.ok(!allows('boundary-snapshot', runtime))
  assert.ok(!allows('boundary-snapshot-test', 'packages/dialect-jest/src/index.ts'))
})

test('placed nodes get a rule; unplaced ones (dir null) do not', () => {
  const names = new Set(config.forbidden.map((rule) => rule.name))
  assert.ok(names.has('boundary-core'))
  assert.ok(names.has('boundary-provino'))
  assert.ok(!names.has('boundary-provino-site'))
})

test('the boundary lints skip test files and test-support modules', () => {
  const plugins = JSON.parse(files.get(BIOME_PLUGINS) ?? '{}') as {
    readonly plugins: readonly { readonly includes: readonly string[] }[]
  }
  for (const plugin of plugins.plugins) {
    assert.deepEqual(plugin.includes.slice(-3), [
      '!**/*.test.ts',
      '!**/*.test-d.ts',
      '!**/src/internal/test-support.ts',
    ])
  }
})

test('T7.12: a ban list becomes a rule that skips tests and type imports, and matches pnpm and flat paths', () => {
  const rule = config.forbidden.find((r) => r.name === 'banned-packages-expect') as
    | (Rule & {
        readonly to: { readonly path: string; readonly dependencyTypesNot: readonly string[] }
      })
    | undefined
  assert.ok(rule, 'no banned-packages-expect rule')
  assert.ok(from('banned-packages-expect').test('packages/expect/src/expect.ts'))
  assert.ok(!new RegExp(String(rule.from.pathNot)).test('packages/expect/src/expect.ts'))
  assert.ok(new RegExp(String(rule.from.pathNot)).test('packages/expect/src/interop.test.ts'))
  const to = new RegExp(rule.to.path)
  for (const banned of [
    'node_modules/expect/build/index.js',
    'node_modules/.pnpm/expect@30.5.2/node_modules/expect/build/index.js',
    'node_modules/@vitest/expect/dist/index.js',
    'node_modules/jest-snapshot/build/index.js',
    'node_modules/@vitest/snapshot/dist/index.js',
    'node_modules/@babel/core/lib/index.js',
  ]) {
    assert.ok(to.test(banned), banned)
  }
  for (const fine of [
    'node_modules/@jest/expect-utils/build/index.js',
    'node_modules/expect-type/dist/index.js',
    'node_modules/jest-snapshot-serializer/index.js',
    'packages/expect/src/expect.ts',
  ]) {
    assert.ok(!to.test(fine), fine)
  }
  assert.deepEqual(rule.to.dependencyTypesNot, ['type-only'])
  // The package's tests node has none: it would only say again what tests are exempt from.
  assert.ok(
    !config.forbidden.some((r) => r.name.startsWith('banned-packages') && r.name.endsWith('-test')),
  )
})
