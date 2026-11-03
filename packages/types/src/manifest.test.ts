import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import * as source from './index.ts'

interface Manifest {
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>
}

const manifest: Manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)

test('every export offers only the provino-source and types conditions', () => {
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    assert.deepEqual(Object.keys(conditions), ['provino-source', 'types'], subpath)
  }
})

test('the source module has no runtime exports', () => {
  assert.deepEqual(Object.keys(source), [])
})

test('the package name resolves to src/ under the provino-source condition', () => {
  assert.equal(import.meta.resolve('@provino/types'), new URL('index.ts', import.meta.url).href)
})

test('every type a module declares is exported from the index', async () => {
  const index = await readFile(new URL('index.ts', import.meta.url), 'utf8')
  const exported = new Set<string>()
  const modules = new Set<string>()
  for (const [, names = '', module = ''] of index.matchAll(/export type \{([^}]*)\} from '\.\/([^']+)'/g)) {
    modules.add(module)
    for (const name of names.split(',')) if (name.trim() !== '') exported.add(name.trim())
  }
  const missing: string[] = []
  for (const module of modules) {
    const source = await readFile(new URL(module, import.meta.url), 'utf8')
    for (const [, name = ''] of source.matchAll(/^export (?:interface|type) (\w+)/gm)) {
      if (!exported.has(name)) missing.push(`${name} (${module})`)
    }
  }
  assert.deepEqual(missing, [])
})
