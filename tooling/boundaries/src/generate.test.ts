import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BIOME_PLUGINS, DEPCRUISE_CONFIG, generate } from './generate.ts'
import { loadManifest } from './manifest.ts'
import { readWorkspace } from './workspace.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const manifest = await loadManifest(join(root, 'tooling/boundaries/packages.json'))
const { roots } = await readWorkspace(root)
const files = generate(manifest, roots)

interface Rule {
  readonly name: string
  readonly from: { readonly path?: string | readonly string[] }
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
    const onDisk = await readFile(join(root, path), 'utf8')
    assert.equal(onDisk.replaceAll('\r\n', '\n'), content, path)
  }
})

test("a package's rule owns its files but not its subpath entries' files or their tests", () => {
  assert.ok(from('boundary-orchestrator').test('packages/orchestrator/src/run.ts'))
  assert.ok(!from('boundary-orchestrator').test('packages/orchestrator/src/worker/entry.ts'))
  assert.ok(!from('boundary-orchestrator').test('packages/orchestrator/test/run.test-d.ts'))
  assert.ok(from('boundary-orchestrator-worker').test('packages/orchestrator/src/worker/entry.ts'))
  assert.ok(from('boundary-orchestrator-tests').test('packages/orchestrator/test/run.test-d.ts'))
  assert.ok(!from('boundary-snapshot').test('packages/snapshot/src/runtime/state.ts'))
  assert.ok(from('boundary-snapshot').test('packages/snapshot/src/runtime-utils/x.ts'))
  assert.ok(from('boundary-native-x').test('packages/native-linux-x64/index.ts'))
  assert.ok(!from('boundary-core').test('packages/core-extra/src/index.ts'))
  // A package without entries keeps its tests under its own rule.
  assert.ok(from('boundary-core').test('packages/core/test/core.test-d.ts'))
})

test("a package's tests may import its own entries; the package itself may not", () => {
  const runtime = 'packages/snapshot/src/runtime/index.ts'
  assert.ok(allows('boundary-snapshot-tests', runtime))
  assert.ok(!allows('boundary-snapshot', runtime))
  assert.ok(!allows('boundary-snapshot-tests', 'packages/dialect-jest/src/index.ts'))
})

test('placed nodes get a rule; unplaced ones (dir null) do not', () => {
  const names = new Set(config.forbidden.map((rule) => rule.name))
  assert.ok(names.has('boundary-core'))
  assert.ok(names.has('boundary-provino'))
  assert.ok(!names.has('boundary-provino-site'))
})

test('the boundary lints skip test files', () => {
  const plugins = JSON.parse(files.get(BIOME_PLUGINS) ?? '{}') as {
    readonly plugins: readonly { readonly includes: readonly string[] }[]
  }
  for (const plugin of plugins.plugins) {
    assert.deepEqual(plugin.includes.slice(-2), ['!**/*.test.ts', '!**/*.test-d.ts'])
  }
})
