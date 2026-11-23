import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'provino'
import { isRecord } from './internal/guards.ts'

async function readExports(): Promise<Record<string, unknown>> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  assert.ok(isRecord(manifest) && isRecord(manifest.exports), 'package.json has exports')
  return manifest.exports
}

test('the package exports only its public entries, the sidecar reporters and the watch run log; the Jest transformer and the watch done plugin are loaded by path', async () => {
  const exports = await readExports()
  assert.deepEqual(Object.keys(exports), [
    '.',
    './site',
    './corpus',
    './reporters/jest',
    './reporters/vitest',
    // B23c: the run log `provino jest --reporters` writes beside a watch golden's.
    './reporters/jest-watch-log',
  ])
})

test('every export points the provino-source condition at src/', async () => {
  for (const [subpath, target] of Object.entries(await readExports())) {
    assert.ok(isRecord(target), subpath)
    const source = target['provino-source']
    assert.ok(typeof source === 'string' && source.startsWith('./src/'), subpath)
  }
})
