import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TransformRecord } from '@provino/types'
import { createTransformCache } from './store.ts'
import { entryFor, KEY_COUNT, keyFor } from './test-entries.ts'

const run = promisify(execFile)
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-cache-'))
  dirs.push(dir)
  return dir
}

function record(extra: Partial<TransformRecord> = {}): TransformRecord {
  return { ...entryFor(3), cacheKey: keyFor(3), fromCache: false, ...extra }
}

test('a stored record comes back whole, with staticMocks and lateDeps, from another cache object', () => {
  const dir = tempDir()
  const full = record({
    code: 'const π = "é"\n',
    map: { version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA' },
    staticMocks: [
      {
        method: 'mock',
        specifier: './a',
        hasFactory: true,
        automock: false,
        factoryLoadsOriginal: false,
        loc: { line: 2, column: 0 },
      },
    ],
    lateDeps: ['./a', './b'],
    hasTopLevelAwait: true,
    format: 'cjs',
  })
  createTransformCache(dir).set(full.cacheKey, full)
  const hit = createTransformCache(dir).get(full.cacheKey)
  assert.deepEqual(hit, { ...full, fromCache: true })
})

test('an unknown key misses, and so does an entry of the wrong length or version', () => {
  const dir = tempDir()
  const cache = createTransformCache(dir)
  assert.equal(cache.get(keyFor(1)), undefined)
  cache.set(keyFor(1), record())
  const key = keyFor(1)
  const file = join(dir, key.slice(0, 2), key)
  assert.notEqual(cache.get(key), undefined)
  // A header that promises more code than the file holds is a torn entry.
  writeFileSync(file, `${JSON.stringify({ v: 1, codeBytes: 99, format: 'esm' })}\nshort`)
  assert.equal(cache.get(key), undefined)
  writeFileSync(file, 'not json at all')
  assert.equal(cache.get(key), undefined)
  writeFileSync(file, `${JSON.stringify({ v: 999, codeBytes: 0 })}\n`)
  assert.equal(cache.get(key), undefined)
})

test('a record with an error diagnostic is not stored, and one with a warning is, with it', () => {
  const dir = tempDir()
  const cache = createTransformCache(dir)
  cache.set(
    keyFor(2),
    record({ diagnostics: [{ severity: 'error', code: 'PARSE_ERROR', message: 'x' }] }),
  )
  assert.equal(cache.get(keyFor(2)), undefined)
  const warning = { severity: 'warning', code: 'TSCONFIG_EXTENDS_NOT_FOUND', message: 'w' } as const
  cache.set(keyFor(2), record({ diagnostics: [warning] }))
  assert.deepEqual(cache.get(keyFor(2))?.diagnostics, [warning])
})

test('the directory gets a CACHEDIR.TAG, and no temporary file is left behind', () => {
  const dir = tempDir()
  const cache = createTransformCache(join(dir, 'nested', 't'))
  cache.set(keyFor(4), record())
  const tag = join(dir, 'nested', 't', 'CACHEDIR.TAG')
  assert.ok(existsSync(tag))
  const leftovers = readdirSync(join(dir, 'nested', 't', keyFor(4).slice(0, 2))).filter((name) =>
    name.endsWith('.tmp'),
  )
  assert.deepEqual(leftovers, [])
})

test('a write into a shard that was removed makes the shard again', () => {
  const dir = tempDir()
  const cache = createTransformCache(dir)
  cache.set(keyFor(5), record())
  rmSync(join(dir, keyFor(5).slice(0, 2)), { recursive: true })
  cache.set(keyFor(5), record()) // lost to the missing directory
  cache.set(keyFor(5), record())
  assert.notEqual(cache.get(keyFor(5)), undefined)
})

test('a directory that cannot be written is a cache that misses', () => {
  const dir = tempDir()
  const blocker = join(dir, 'file')
  writeFileSync(blocker, '')
  const cache = createTransformCache(join(blocker, 'sub'))
  cache.set(keyFor(6), record())
  assert.equal(cache.get(keyFor(6)), undefined)
  mkdirSync(join(dir, 'ok'))
})

test('8 processes writing the same 500 keys give no torn reads', async () => {
  const dir = tempDir()
  const hammer = fileURLToPath(new URL('./hammer.ts', import.meta.url))
  const children = Array.from({ length: 8 }, (_, index) =>
    run(process.execPath, ['--conditions=provino-source', hammer, dir, String(index)], {
      maxBuffer: 1 << 20,
    }),
  )
  const reports = await Promise.all(children)
  let hits = 0
  for (const { stdout } of reports) {
    const report: { torn: number; hits: number } = JSON.parse(stdout)
    assert.equal(report.torn, 0)
    hits += report.hits
  }
  // They did overlap: every later round of every process reads what an earlier write left.
  assert.ok(hits > KEY_COUNT)
  const cache = createTransformCache(dir)
  for (let n = 0; n < KEY_COUNT; n++) {
    const hit = cache.get(keyFor(n))
    assert.equal(hit?.code, entryFor(n).code)
  }
  const stray = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readdirSync(join(dir, entry.name)))
    .filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(stray, [])
})
