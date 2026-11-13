// T3.7: the V8 code cache. Whether V8 read or refused an entry is seen in a fresh process only
// (V8's own per-isolate compilation cache serves a source it compiled before and ignores
// `cachedData`), so the tests that depend on it run through `runChild`; the ones about files,
// counters and errors run here.
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createV8Cache, V8CacheError, v8CacheTag } from './index.ts'
import {
  manyFunctions,
  manyFunctionsValue,
  runChild,
  SCRIPT_NAME,
  tempDir,
} from './test-helpers.ts'

const dirs: (() => void)[] = []
after(() => {
  for (const remove of dirs) remove()
})
function scratch(): string {
  const { dir, remove } = tempDir()
  dirs.push(remove)
  return dir
}

interface Loaded {
  readonly stats: {
    readonly hits: number
    readonly misses: number
    readonly rejected: number
    readonly written: number
    readonly writeFailures: number
  }
  readonly cachedDataRejected: boolean | null
  readonly result: number
  readonly tag: string
}
function load(
  dir: string,
  key: string,
  extra: { readonly execArgv?: readonly string[]; readonly mode?: 'on' | 'off' } = {},
): Loaded {
  return runChild(
    'load',
    { dir, key, functions: 100, mode: extra.mode },
    extra.execArgv === undefined ? {} : { execArgv: extra.execArgv },
  ) as Loaded
}

/** The entry `load` wrote for `key` under the parent's tag. */
function entryOf(dir: string, key: string): string {
  return join(dir, v8CacheTag(), key.slice(0, 2), key)
}

const ZERO = { hits: 0, misses: 0, rejected: 0, written: 0, writeFailures: 0 }

test('v8CacheTag is 16 hex characters and the same on every call', () => {
  assert.match(v8CacheTag(), /^[0-9a-f]{16}$/)
  assert.equal(v8CacheTag(), v8CacheTag())
})

test('a miss compiles, writes in the background, and flush waits for it: the entry is at <dir>/<tag>/<2 hex>/<key>', async () => {
  const dir = scratch()
  const key = 'a1b2c3d4e5f60718'
  const cache = createV8Cache({ dir })
  const script = cache.loadScript(manyFunctions(100), SCRIPT_NAME, key)
  assert.equal(script.runInThisContext(), manyFunctionsValue(100))
  assert.deepEqual(cache.stats, { ...ZERO, misses: 1 })
  // Nothing is written in the turn that compiled.
  assert.equal(existsSync(entryOf(dir, key)), false)
  await cache.flush()
  assert.deepEqual(cache.stats, { ...ZERO, misses: 1, written: 1 })
  assert.ok(statSync(entryOf(dir, key)).size > 0)
  // The directory is a cache directory for backup tools, and no temporary file is left behind.
  assert.ok(existsSync(join(dir, 'CACHEDIR.TAG')))
  const leftovers = readdirSync(join(dir, v8CacheTag(), 'a1')).filter((name) => name !== key)
  assert.deepEqual(leftovers, [])
})

test('round trip in one process: a second cache on the same directory hits, and the script runs', async () => {
  const dir = scratch()
  const key = 'b1b2c3d4e5f60718'
  const first = createV8Cache({ dir })
  first.loadScript(manyFunctions(100), SCRIPT_NAME, key)
  await first.flush()
  const second = createV8Cache({ dir })
  const script = second.loadScript(manyFunctions(100), SCRIPT_NAME, key)
  assert.notEqual(script.cachedDataRejected, true)
  assert.deepEqual(second.stats, { ...ZERO, hits: 1 })
  assert.equal(script.runInThisContext(), manyFunctionsValue(100))
  await second.flush()
  assert.deepEqual(second.stats, { ...ZERO, hits: 1 })
})

test('round trip across processes: the second process hits, V8 accepts the data, and the script runs', () => {
  const dir = scratch()
  const key = 'c1b2c3d4e5f60718'
  const first = load(dir, key)
  assert.deepEqual(first.stats, { ...ZERO, misses: 1, written: 1 })
  assert.equal(first.result, manyFunctionsValue(100))
  const second = load(dir, key)
  assert.deepEqual(second.stats, { ...ZERO, hits: 1 })
  // `false` and not `null`: V8 was given the data and accepted it.
  assert.equal(second.cachedDataRejected, false)
  assert.equal(second.result, manyFunctionsValue(100))
})

test('a script loaded twice before its write runs queues one write', async () => {
  const dir = scratch()
  const cache = createV8Cache({ dir })
  cache.loadScript(manyFunctions(20), SCRIPT_NAME, 'd1b2c3d4e5f60718')
  cache.loadScript(manyFunctions(20), SCRIPT_NAME, 'd1b2c3d4e5f60718')
  await cache.flush()
  assert.deepEqual(cache.stats, { ...ZERO, misses: 2, written: 1 })
})

const damage: readonly (readonly [string, (file: string) => void])[] = [
  [
    'garbage bytes',
    (file) => writeFileSync(file, Buffer.from('not v8 data, only text'.repeat(40))),
  ],
  ['a truncated entry', (file) => truncateSync(file, Math.floor(statSync(file).size / 2))],
  ['an empty file', (file) => truncateSync(file, 0)],
]
for (const [name, damaged] of damage) {
  test(`${name} is rejected, never an error, and replaced: the next process hits`, () => {
    const dir = scratch()
    const key = 'e1b2c3d4e5f60718'
    assert.equal(load(dir, key).stats.written, 1)
    damaged(entryOf(dir, key))

    const rejected = load(dir, key)
    assert.deepEqual(rejected.stats, { ...ZERO, rejected: 1, written: 1 })
    assert.equal(rejected.result, manyFunctionsValue(100))

    const healed = load(dir, key)
    assert.deepEqual(healed.stats, { ...ZERO, hits: 1 })
    assert.equal(healed.cachedDataRejected, false)
    assert.equal(healed.result, manyFunctionsValue(100))
  })
}

test('another key never reads this key’s entry, although the code is the same', () => {
  const dir = scratch()
  assert.equal(load(dir, 'f1b2c3d4e5f60718').stats.written, 1)
  const other = load(dir, 'f2b2c3d4e5f60718')
  assert.deepEqual(other.stats, { ...ZERO, misses: 1, written: 1 })
  assert.deepEqual(load(dir, 'f1b2c3d4e5f60718').stats, { ...ZERO, hits: 1 })
})

test('another V8 flag set reads another tag directory: its process misses and writes there', () => {
  const dir = scratch()
  const key = '01b2c3d4e5f60718'
  const plain = load(dir, key)
  assert.equal(plain.tag, v8CacheTag())
  // A V8 flag is part of `cachedDataVersionTag()`, so it moves the tag.
  const flagged = load(dir, key, { execArgv: ['--no-flush-bytecode'] })
  assert.match(flagged.tag, /^[0-9a-f]{16}$/)
  assert.notEqual(flagged.tag, plain.tag)
  assert.deepEqual(flagged.stats, { ...ZERO, misses: 1, written: 1 })
  assert.deepEqual(
    readdirSync(dir)
      .filter((name) => name !== 'CACHEDIR.TAG')
      .sort(),
    [plain.tag, flagged.tag].sort(),
  )
  // Each flag set hits its own entry.
  assert.deepEqual(load(dir, key).stats, { ...ZERO, hits: 1 })
  assert.deepEqual(load(dir, key, { execArgv: ['--no-flush-bytecode'] }).stats, {
    ...ZERO,
    hits: 1,
  })
})

for (const key of ['', 'a', '../x', 'ab/cd', 'ab\\cd', '..', 'ab.cd', 'ab\0cd', 'x'.repeat(129)]) {
  test(`a key that is not a plain token throws V8_CACHE_KEY_INVALID: ${JSON.stringify(key)}`, () => {
    const dir = scratch()
    for (const mode of ['on', 'off'] as const) {
      assert.throws(
        () => createV8Cache({ dir, mode }).loadScript('1', SCRIPT_NAME, key),
        (error: unknown) => error instanceof V8CacheError && error.code === 'V8_CACHE_KEY_INVALID',
      )
    }
    assert.deepEqual(readdirSync(dir), [])
  })
}

test('code that does not compile throws its SyntaxError, not a cache error, and counts nothing', () => {
  const cache = createV8Cache({ dir: scratch() })
  assert.throws(() => cache.loadScript('let = = 1', SCRIPT_NAME, 'ab12cd34'), SyntaxError)
  assert.deepEqual(cache.stats, ZERO)
})

test('a directory that cannot be created is a cache that misses: no throw, writeFailures counted', async () => {
  const dir = scratch()
  // A regular file where the directory should be: `mkdir` fails with ENOTDIR on every platform
  // and for every user, root included.
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'a file')
  const cache = createV8Cache({ dir: join(blocker, 'cache') })
  const script = cache.loadScript(manyFunctions(30), SCRIPT_NAME, '11b2c3d4e5f60718')
  assert.equal(script.runInThisContext(), manyFunctionsValue(30))
  await cache.flush()
  assert.deepEqual(cache.stats, { ...ZERO, misses: 1, writeFailures: 1 })
  assert.equal(readFileSync(blocker, 'utf8'), 'a file')
})

test('a read-only directory is a cache that misses: no throw, writeFailures counted, nothing written', {
  skip:
    process.platform === 'win32' || process.getuid?.() === 0
      ? 'file modes do not stop this user'
      : false,
}, async () => {
  const dir = scratch()
  chmodSync(dir, 0o500)
  try {
    const cache = createV8Cache({ dir })
    const script = cache.loadScript(manyFunctions(30), SCRIPT_NAME, '21b2c3d4e5f60718')
    assert.equal(script.runInThisContext(), manyFunctionsValue(30))
    await cache.flush()
    assert.deepEqual(cache.stats, { ...ZERO, misses: 1, writeFailures: 1 })
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    chmodSync(dir, 0o700)
  }
})

test("mode 'off' compiles and touches nothing: no directory, no read of a warm entry, stats unmoved", async () => {
  const missing = join(scratch(), 'never-made')
  const off = createV8Cache({ dir: missing, mode: 'off' })
  const script = off.loadScript(manyFunctions(40), SCRIPT_NAME, '31b2c3d4e5f60718')
  assert.equal(script.runInThisContext(), manyFunctionsValue(40))
  await off.flush()
  assert.equal(existsSync(missing), false)
  assert.deepEqual(off.stats, ZERO)

  // With a warm entry on disk, off reads none of it and changes none of it.
  const dir = scratch()
  const key = '41b2c3d4e5f60718'
  assert.equal(load(dir, key).stats.written, 1)
  const files = (): string[] => readdirSync(dir, { recursive: true }).map(String).sort()
  const before = files()
  const stamp = statSync(entryOf(dir, key)).mtimeMs
  const viaChild = load(dir, key, { mode: 'off' })
  assert.deepEqual(viaChild.stats, ZERO)
  assert.equal(viaChild.cachedDataRejected, null)
  assert.equal(viaChild.result, manyFunctionsValue(100))
  assert.deepEqual(files(), before)
  assert.equal(statSync(entryOf(dir, key)).mtimeMs, stamp)
})

test("mode 'on' is the default", async () => {
  const dir = scratch()
  const cache = createV8Cache({ dir })
  cache.loadScript(manyFunctions(10), SCRIPT_NAME, '51b2c3d4e5f60718')
  await cache.flush()
  assert.equal(cache.stats.written, 1)
})
