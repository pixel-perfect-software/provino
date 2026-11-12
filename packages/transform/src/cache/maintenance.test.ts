import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { lockfileHash, prepareCache, pruneCache, pruneCacheIfWritten } from './maintenance.ts'
import { createTransformCache } from './store.ts'
import { entryFor, keyFor } from './test-entries.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-cache-m-'))
  dirs.push(dir)
  return dir
}

function put(dir: string, n: number): void {
  createTransformCache(dir).set(keyFor(n), {
    ...entryFor(n),
    cacheKey: keyFor(n),
    fromCache: false,
  })
}

test('lockfileHash finds the nearest lockfile above the root and follows its content', () => {
  const top = tempDir()
  const root = join(top, 'packages', 'app')
  mkdirSync(root, { recursive: true })
  assert.equal(lockfileHash(root), null)
  writeFileSync(join(top, 'pnpm-lock.yaml'), 'a')
  const first = lockfileHash(root)
  assert.match(first ?? '', /^[0-9a-f]{64}$/)
  assert.equal(lockfileHash(root), first)
  writeFileSync(join(top, 'pnpm-lock.yaml'), 'b')
  assert.notEqual(lockfileHash(root), first)
  // A closer lockfile wins.
  writeFileSync(join(root, 'yarn.lock'), 'a')
  assert.notEqual(lockfileHash(root), lockfileHash(top))
})

test('prepareCache keeps the entries while the lockfile hash is the same, and wipes them when it changes', () => {
  const dir = join(tempDir(), 't')
  prepareCache(dir, 'one')
  assert.ok(existsSync(join(dir, 'CACHEDIR.TAG')))
  put(dir, 1)
  prepareCache(dir, 'one')
  assert.notEqual(createTransformCache(dir).get(keyFor(1)), undefined)
  prepareCache(dir, 'two')
  assert.equal(createTransformCache(dir).get(keyFor(1)), undefined)
  assert.ok(existsSync(join(dir, 'CACHEDIR.TAG')))
  assert.equal(readFileSync(join(dir, 'lockfile-hash'), 'utf8'), 'two')
})

test('a wipe that fails is retried once, and a second failure means no cache for this run', () => {
  const dir = join(tempDir(), 't')
  prepareCache(dir, 'one')
  put(dir, 1)
  let calls = 0
  const failing = (): void => {
    calls++
    throw new Error('EBUSY')
  }
  assert.equal(prepareCache(dir, 'two', { rm: failing }), false)
  assert.equal(calls, 2, 'retried once')
  // The stamp keeps the old hash, so the next run wipes again.
  assert.equal(readFileSync(join(dir, 'lockfile-hash'), 'utf8'), 'one')
  // A wipe that works the second time is a ready cache.
  let first = true
  const flaky = (path: string, options: { recursive: true; force: true }): void => {
    if (first) {
      first = false
      throw new Error('EBUSY')
    }
    rmSync(path, options)
  }
  assert.equal(prepareCache(dir, 'two', { rm: flaky }), true)
  assert.equal(createTransformCache(dir).get(keyFor(1)), undefined)
  assert.equal(readFileSync(join(dir, 'lockfile-hash'), 'utf8'), 'two')
})

test('prepareCache with no lockfile leaves the entries alone', () => {
  const dir = join(tempDir(), 't')
  prepareCache(dir, 'one')
  put(dir, 1)
  prepareCache(dir, null)
  assert.notEqual(createTransformCache(dir).get(keyFor(1)), undefined)
})

test('pruneCache evicts the oldest entries down to the cap and leaves a smaller cache alone', () => {
  const dir = tempDir()
  for (let n = 0; n < 6; n++) {
    put(dir, n)
    const file = join(dir, keyFor(n).slice(0, 2), keyFor(n))
    // Entry 0 is the oldest.
    utimesSync(file, new Date(1_000_000 + n * 1000), new Date(1_000_000 + n * 1000))
  }
  assert.equal(pruneCache(dir, 1 << 30).removed, 0)
  const cache = createTransformCache(dir)
  const size = (n: number) => Buffer.byteLength(entryFor(n).code)
  const keep = size(4) + size(5) + 4000 // the two newest plus their headers
  const result = pruneCache(dir, keep)
  assert.ok(result.removed >= 3 && result.removed <= 4, String(result.removed))
  assert.ok(result.bytesAfter <= keep)
  assert.equal(cache.get(keyFor(0)), undefined)
  assert.notEqual(cache.get(keyFor(5)), undefined)
})

test('pruneCache removes a stale temporary file and survives a missing directory', () => {
  const dir = tempDir()
  put(dir, 1)
  const shard = join(dir, keyFor(1).slice(0, 2))
  const stale = join(shard, `${keyFor(1)}.1.abcd.0.tmp`)
  writeFileSync(stale, 'half')
  utimesSync(stale, new Date(1000), new Date(1000))
  pruneCache(dir)
  assert.equal(existsSync(stale), false)
  assert.deepEqual(pruneCache(join(dir, 'missing')), { removed: 0, bytesBefore: 0, bytesAfter: 0 })
})

test('pruneCacheIfWritten skips until an entry is written, then prunes', () => {
  const dir = tempDir()
  put(dir, 1)
  put(dir, 2)
  // The first call has no stamp: it prunes (here, to nothing, as the cap is not reached).
  assert.equal(pruneCacheIfWritten(dir)?.removed, 0)
  assert.equal(pruneCacheIfWritten(dir), undefined)
  put(dir, 3)
  assert.equal(pruneCacheIfWritten(dir, 1)?.removed, 3)
  assert.equal(pruneCacheIfWritten(dir), undefined)
})

test('lockfileHash reads a lockfile once for a shared memo', () => {
  const top = tempDir()
  const root = join(top, 'a')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(top, 'pnpm-lock.yaml'), 'a')
  const memo = new Map<string, string>()
  const first = lockfileHash(root, memo)
  assert.equal(memo.size, 1)
  writeFileSync(join(top, 'pnpm-lock.yaml'), 'b')
  assert.equal(lockfileHash(root, memo), first)
  assert.notEqual(lockfileHash(root), first)
})
