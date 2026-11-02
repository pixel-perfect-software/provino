import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEPCRUISE_CONFIG, generate } from './generate.ts'
import { loadManifest } from './manifest.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const manifest = await loadManifest(join(root, 'tooling/boundaries/packages.json'))

test('the generated files on disk are current (else run `pnpm boundaries:write`)', async () => {
  for (const [path, content] of generate(manifest)) {
    assert.equal(await readFile(join(root, path), 'utf8'), content, path)
  }
})

interface Rule {
  readonly name: string
  readonly from: { readonly path?: string | readonly string[] }
}

test("a package's rule owns its files but not its subpath entries' files", () => {
  const config = JSON.parse(generate(manifest).get(DEPCRUISE_CONFIG) ?? '{}') as {
    readonly forbidden: readonly Rule[]
  }
  const from = (name: string): RegExp => {
    const path = config.forbidden.find((rule) => rule.name === name)?.from.path
    assert.equal(typeof path, 'string', name)
    return new RegExp(String(path))
  }
  assert.ok(from('boundary-orchestrator').test('packages/orchestrator/src/run.ts'))
  assert.ok(!from('boundary-orchestrator').test('packages/orchestrator/src/worker/entry.ts'))
  assert.ok(from('boundary-orchestrator-worker').test('packages/orchestrator/src/worker/entry.ts'))
  assert.ok(!from('boundary-snapshot').test('packages/snapshot/src/runtime/state.ts'))
  assert.ok(from('boundary-native-x').test('packages/native-linux-x64/index.ts'))
  assert.ok(!from('boundary-core').test('packages/core-extra/src/index.ts'))
})

test('placed nodes get a rule; unplaced ones (dir null) do not', () => {
  const names = new Set(
    (
      JSON.parse(generate(manifest).get(DEPCRUISE_CONFIG) ?? '{}') as { forbidden: Rule[] }
    ).forbidden.map((rule) => rule.name),
  )
  assert.ok(names.has('boundary-core'))
  assert.ok(names.has('boundary-provino'))
  assert.ok(!names.has('boundary-provino-site'))
})
