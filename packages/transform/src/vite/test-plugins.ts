// Test support: a fixture's user plugins, resolved the way the Vite bridge does (the project's own
// `vitest/node` `resolveConfig`, Vitest's and Vite's plugins left out). Not part of the package.
import { join } from 'node:path'
import { resolveConfig } from 'vitest/node'
import type { VitePlugin } from './host.ts'

export async function fixturePlugins(name: string): Promise<{
  readonly root: string
  readonly plugins: readonly VitePlugin[]
}> {
  const root = join(import.meta.dirname, '../../fixtures/vite', name)
  const options = { root, mode: 'test' }
  const resolved = await resolveConfig({ ...options, config: join(root, 'vite.config.mjs') })
  const base = await resolveConfig({ ...options, config: false })
  const baseline = new Set(base.plugins.map((plugin) => plugin.name))
  const plugins = resolved.plugins.filter((plugin) => !baseline.has(plugin.name))
  return { root, plugins: plugins as unknown as readonly VitePlugin[] }
}
