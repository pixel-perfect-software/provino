import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { loadViteBridge, viteJsxSettings } from './index.ts'

// A project inside this package, so `vitest/node` resolves from it as it does from a real project.
const scratch = join(import.meta.dirname, '../../node_modules/.cache')
mkdirSync(scratch, { recursive: true })
const dirs: string[] = []
function project(files: Record<string, string>, parent = scratch): string {
  const dir = mkdtempSync(join(parent, 'vite-bridge-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const CONFIG = `
export default {
  define: { __FLAG__: true, __NAME__: '"x"', 'a.b': 'process.env.X' },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  plugins: [
    {
      name: 'set-globals',
      config() {
        return { test: { globals: true, name: 'from-plugin' } }
      },
    },
  ],
}
`

describe('loadViteBridge', () => {
  test("runs a plugin's config hook through the project's resolveConfig and reads the result", async () => {
    const root = project({ 'vite.config.mjs': CONFIG })
    const configFile = join(root, 'vite.config.mjs')
    const { result, plugins } = await loadViteBridge({ root, configFile, mode: 'test' })
    assert.equal(result.test.globals, true)
    assert.equal(result.test.name, 'from-plugin')
    assert.deepEqual(result.defines, { __FLAG__: true, __NAME__: 'x' })
    assert.deepEqual(result.scriptDefines, { 'a.b': 'process.env.X' })
    assert.deepEqual(result.jsx, {
      runtime: 'automatic',
      importSource: 'preact',
      development: true,
    })
    assert.deepEqual(
      result.plugins.map((entry) => entry.name),
      ['set-globals'],
    )
    assert.match(result.plugins[0]?.codeHash ?? '', /^[0-9a-f]{64}$/)
    assert.match(result.configHash ?? '', /^[0-9a-f]{64}$/)
    assert.deepEqual(result.warnings, [])
    assert.equal(plugins.length, 1)
  })

  test('a config edit changes the hash and a plugin edit changes its code hash', async () => {
    const a = project({ 'vite.config.mjs': CONFIG })
    const b = project({ 'vite.config.mjs': CONFIG.replace('from-plugin', 'edited') })
    const load = (root: string) =>
      loadViteBridge({ root, configFile: join(root, 'vite.config.mjs'), mode: 'test' })
    const [first, second] = [await load(a), await load(b)]
    assert.notEqual(first.result.configHash, second.result.configHash)
    assert.notEqual(first.result.plugins[0]?.codeHash, second.result.plugins[0]?.codeHash)
  })

  test('a user plugin named like a built-in plugin is still a user plugin', async () => {
    const root = project({
      'vite.config.mjs':
        'export default { plugins: [{ name: "vite:css", transform: () => null }] }',
    })
    const { result } = await loadViteBridge({
      root,
      configFile: join(root, 'vite.config.mjs'),
      mode: 'test',
    })
    assert.deepEqual(
      result.plugins.map((entry) => entry.name),
      ['vite:css'],
    )
  })

  test('without Vite installed it warns once and returns no plugins', async () => {
    const root = project({ 'vite.config.mjs': CONFIG }, tmpdir())
    const { result, plugins } = await loadViteBridge({
      root,
      configFile: join(root, 'vite.config.mjs'),
      mode: 'test',
    })
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] ?? '', /plugins are skipped/)
    assert.deepEqual(result.plugins, [])
    assert.deepEqual(plugins, [])
  })
})

describe('the pipeline mapping', () => {
  test('oxc.jsx, esbuild.jsx* and nothing', () => {
    assert.deepEqual(
      viteJsxSettings({ oxc: { jsx: { runtime: 'classic', development: false } } }),
      {
        runtime: 'classic',
        development: false,
      },
    )
    assert.deepEqual(
      viteJsxSettings({ esbuild: { jsx: 'automatic', jsxImportSource: 'vue', jsxDev: true } }),
      { runtime: 'automatic', importSource: 'vue', development: true },
    )
    assert.deepEqual(viteJsxSettings({ esbuild: { jsx: 'transform' } }), { runtime: 'classic' })
    assert.equal(viteJsxSettings({ oxc: { jsx: 'preserve' } }), null)
    assert.equal(viteJsxSettings({}), null)
  })
})
