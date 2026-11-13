// A package's `build` runs the shared tsdown config in `tooling/packaging`, so a change to a file
// that config reads must change the build's Turborepo hash, or a stale `dist/` is replayed from the
// cache. And a file it doesn't read must not: an edit to `hygiene.ts` would otherwise rebuild all
// 20 packages and rerun `provino`'s tests. So the inputs are exactly the import closure of the
// two tsdown configs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { describe, test } from 'node:test'
import { ROOT } from './workspace.ts'

const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
  readonly tasks: Readonly<Record<string, { readonly inputs?: readonly string[] }>>
}
const inputs = turbo.tasks.build?.inputs ?? []
const PACKAGING = '$TURBO_ROOT$/tooling/packaging/'
const CONFIGS = ['tsdown.config.ts', 'tsdown.umbrella.config.ts']

/** A relative `.ts` import, static or dynamic, type-only or not. */
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+\.ts)['"]/g

/** The files `entries` import, directly or not, and the entries, relative to `tooling/packaging`. */
function importClosure(entries: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const queue = [...entries]
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(join(ROOT, 'tooling/packaging', file), 'utf8')
    for (const match of text.matchAll(IMPORT)) {
      queue.push(posix.join(dirname(file), match[1] ?? ''))
    }
  }
  return [...seen].sort()
}

describe('the build task hashes exactly what the tsdown configs read (turbo.json)', () => {
  const rooted = inputs
    .filter((input) => input.startsWith(PACKAGING))
    .map((input) => input.slice(PACKAGING.length))
    .sort()

  test('the closure is what we think: the preset, the manifest reader and the umbrella', () => {
    assert.deepEqual(importClosure(CONFIGS), [
      'src/package-json.ts',
      'src/preset.ts',
      'src/umbrella.ts',
      'tsdown.config.ts',
      'tsdown.umbrella.config.ts',
    ])
  })

  test('the inputs under tooling/packaging are that closure and its package.json, each named', () => {
    assert.deepEqual(rooted, [...importClosure(CONFIGS), 'package.json'].sort())
  })

  test('no input is a glob over the packaging sources or a test', () => {
    for (const input of inputs.filter((input) => input.includes('tooling/packaging'))) {
      assert.doesNotMatch(input, /\*|^!/, input)
    }
  })
})
