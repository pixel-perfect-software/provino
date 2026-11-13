// T3.7: `@provino/transform/v8cache` is a leaf: the `provino` bin imports it without loading Oxc,
// `magic-string` or anything else the pipeline needs. The boundary manifest lets the node import
// its package (for the transform cache's `CACHEDIR.TAG` writer) and can't say which files, so this
// reads the import closure from `index.ts` and holds every run-time import in it to Node's own.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// `import … from 'x'`, `export … from 'x'` and `import 'x'`, across lines, and not `import type`.
const IMPORT = /^(?:import|export)\s+(type\s+)?(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/gm

test('every run-time import reachable from index.ts is a node: built-in or a file of this package', () => {
  const seen = new Set<string>()
  const builtins = new Set<string>()
  const queue = [fileURLToPath(new URL('./index.ts', import.meta.url))]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = match[2] as string
      if (match[1] !== undefined) continue
      if (specifier.startsWith('node:')) builtins.add(specifier)
      else if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier))
      else assert.fail(`${file} imports "${specifier}", which is not a node: built-in`)
    }
  }
  // The closure is what it should be: this directory, and the transform cache's store.
  const names = [...seen].map((file) => file.slice(file.indexOf('/src/') + 5)).sort()
  assert.deepEqual(names, [
    'cache/store.ts',
    'v8cache/cache.ts',
    'v8cache/errors.ts',
    'v8cache/index.ts',
    'v8cache/mode.ts',
    'v8cache/native.ts',
  ])
  assert.ok(builtins.has('node:vm') && builtins.has('node:module'))
})
