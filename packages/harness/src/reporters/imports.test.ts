// T12.4: the sidecar reporters load by absolute path from any repository's config, which can't
// resolve `@provino/*` (no default export condition, no node_modules link). So nothing they load
// at run time may be a package: every value import, followed through relative files, is a Node
// builtin. A type-only import is erased before Node or Vitest load the file.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { WATCH_DONE_PLUGIN_PATH, WATCH_LOG_REPORTER_PATH } from '../internal/watch-record.ts'
import { sidecarReporterPath } from '../sidecar.ts'

const IMPORT = /^\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm

async function runtimeImports(file: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(file)) return []
  seen.add(file)
  const source = await readFile(file, 'utf8')
  const found: string[] = []
  for (const match of source.matchAll(IMPORT)) {
    const [, , typeOnly, specifier] = match
    if (typeOnly !== undefined || specifier === undefined) continue
    if (specifier.startsWith('.')) {
      found.push(...(await runtimeImports(path.resolve(path.dirname(file), specifier), seen)))
    } else {
      found.push(specifier)
    }
  }
  return found
}

for (const runner of ['jest', 'vitest'] as const) {
  test(`the ${runner} sidecar loads Node builtins only`, async () => {
    const file = sidecarReporterPath(runner)
    assert.ok(path.isAbsolute(file) && file.endsWith(`${runner}.ts`), file)
    const imports = await runtimeImports(file)
    assert.ok(imports.length > 0, 'it imports node:fs at least')
    for (const specifier of imports) assert.match(specifier, /^node:/, specifier)
  })
}

// B23c: the watch run log is loaded the same way, from the recorder's config and from
// `provino jest --reporters`.
for (const [name, file] of [
  ['run-log reporter', WATCH_LOG_REPORTER_PATH],
  ['done plugin', WATCH_DONE_PLUGIN_PATH],
] as const) {
  test(`the watch ${name} loads Node builtins only`, async () => {
    const imports = await runtimeImports(file)
    assert.ok(imports.length > 0, 'it imports node:fs at least')
    for (const specifier of imports) assert.match(specifier, /^node:/, specifier)
  })
}

// B25b: the diff reporter a `captureDiff` fixture's Vitest run loads by absolute path.
test('the vitest diff reporter loads Node builtins only', async () => {
  const imports = await runtimeImports(path.join(import.meta.dirname, 'vitest-diff.ts'))
  assert.ok(imports.length > 0, 'it imports node:fs at least')
  for (const specifier of imports) assert.match(specifier, /^node:/, specifier)
})
