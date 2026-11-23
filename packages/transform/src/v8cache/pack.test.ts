// B23e: V8 code cache packs (`openV8Pack`, `compactV8Packs`). Whether V8 read or refused an
// entry is seen in a fresh process only (V8's per-isolate compilation cache serves a source it
// compiled before and ignores `cachedData`), so those tests run through `runChild`; the ones about
// files, counters and the merge run here.
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { afterAll, test } from 'provino'
import { pruneCacheIfWritten } from '../cache/maintenance.ts'
import { WRITTEN_NAME } from '../cache/store.ts'
import { compactV8Packs, openV8Pack, v8CacheTag } from './index.ts'
import { encodeV8Pack, v8PackKey } from './pack.ts'
import {
  manyFunctions,
  manyFunctionsValue,
  runChild,
  SCRIPT_NAME,
  tempDir,
} from './test-helpers.ts'

const dirs: (() => void)[] = []
afterAll(() => {
  for (const remove of dirs) remove()
})
function scratch(): string {
  const { dir, remove } = tempDir()
  dirs.push(remove)
  return dir
}

interface Stats {
  readonly hits: number
  readonly misses: number
  readonly rejected: number
  readonly skipped: number
  readonly packsRead: number
  readonly written: number
  readonly writeFailures: number
}
interface Compiled {
  readonly stats: Stats
  readonly pending: number
  readonly cachedDataRejected: boolean | null
  readonly result: number
  readonly tag: string
}
interface Scenario {
  readonly functions?: number
  readonly variant?: 'same-length'
  readonly filename?: string
  readonly columnOffset?: number
  readonly mode?: 'on' | 'off'
  readonly minLength?: number
  readonly write?: 'after-run' | 'before-run' | 'none'
  readonly execArgv?: readonly string[]
}
function compile(dir: string, scenario: Scenario = {}): Compiled {
  const { execArgv, ...rest } = scenario
  return runChild(
    'pack',
    { dir, functions: 100, ...rest },
    execArgv === undefined ? {} : { execArgv },
  ) as Compiled
}

const ZERO: Stats = {
  hits: 0,
  misses: 0,
  rejected: 0,
  skipped: 0,
  packsRead: 0,
  written: 0,
  writeFailures: 0,
}

/** The packs in `<dir>/v8`, by name (oldest first). */
function packs(dir: string): string[] {
  const packDir = join(dir, 'v8')
  return existsSync(packDir) ? readdirSync(packDir).sort() : []
}

/** What `manyFunctions(count)` with the 'same-length' variant evaluates to: `(i + 2) * 2` each. */
function sameLengthValue(count: number): number {
  let total = 0
  for (let i = 0; i < count; i += 10) total += (i + 2) * 2
  return total
}

test('a miss queues the script, a write leaves one pack named by the tag, and a fresh process compiles from it', () => {
  const dir = scratch()
  const cold = compile(dir)
  assert.deepEqual(cold.stats, { ...ZERO, misses: 1, written: 1 })
  assert.equal(cold.pending, 1)
  assert.equal(cold.result, manyFunctionsValue(100))
  const [pack, ...more] = packs(dir)
  assert.deepEqual(more, [])
  assert.match(pack ?? '', new RegExp(`^${cold.tag}-[0-9a-z-]+\\.pack$`))
  // The transform cache's sentinel, so the coordinator prunes and compacts after the run.
  assert.ok(existsSync(join(dir, WRITTEN_NAME)))

  const warm = compile(dir)
  assert.deepEqual(warm.stats, { ...ZERO, hits: 1, packsRead: 1 })
  // `false` and not `null`: V8 was given the data and accepted it.
  assert.equal(warm.cachedDataRejected, false)
  assert.equal(warm.pending, 0)
  assert.equal(warm.result, manyFunctionsValue(100))
  // A warm process writes nothing.
  assert.deepEqual(packs(dir), [pack])
})

test('an entry written after the script ran holds the functions it compiled lazily', () => {
  const before = scratch()
  const afterRun = scratch()
  compile(before, { write: 'before-run' })
  compile(afterRun, { write: 'after-run' })
  const size = (dir: string): number => statSync(join(dir, 'v8', packs(dir)[0] ?? '')).size
  // The top level calls every tenth of the 100 functions: their 10 bytecode arrays are in the later
  // entry (about 170 bytes each on Node 24), not in the one written before they ran.
  assert.ok(
    size(afterRun) - size(before) > 10 * 50,
    `after the run ${size(afterRun)} bytes, before it ${size(before)}`,
  )
  assert.equal(compile(afterRun).cachedDataRejected, false)
})

test('a source of the same length never reads another source’s entry (V8 checks only the length)', () => {
  const dir = scratch()
  assert.equal(compile(dir).stats.written, 1)
  const other = compile(dir, { variant: 'same-length' })
  assert.deepEqual(other.stats, { ...ZERO, misses: 1, packsRead: 1, written: 1 })
  // Its own value, not the old script's: the entry for the other text was never offered to V8.
  assert.equal(other.result, sameLengthValue(100))
  assert.notEqual(other.result, manyFunctionsValue(100))
  assert.equal(compile(dir, { variant: 'same-length' }).cachedDataRejected, false)
})

test('another filename or column offset reads no other entry', () => {
  const dir = scratch()
  assert.equal(compile(dir).stats.written, 1)
  assert.equal(compile(dir, { filename: '/virtual/another.js' }).stats.misses, 1)
  assert.equal(compile(dir, { columnOffset: -12 }).stats.misses, 1)
  assert.equal(compile(dir).stats.hits, 1)
})

test('another V8 flag set has another tag: it reads none of this tag’s packs and writes its own', () => {
  const dir = scratch()
  const plain = compile(dir)
  // A V8 flag is part of `cachedDataVersionTag()`, so it moves the tag.
  const flagged = compile(dir, { execArgv: ['--no-flush-bytecode'] })
  assert.notEqual(flagged.tag, plain.tag)
  assert.deepEqual(flagged.stats, { ...ZERO, misses: 1, written: 1 })
  const tags = packs(dir).map((name) => name.slice(0, 16))
  assert.deepEqual(tags.sort(), [plain.tag, flagged.tag].sort())
  assert.equal(compile(dir).stats.hits, 1)
  assert.equal(compile(dir, { execArgv: ['--no-flush-bytecode'] }).stats.hits, 1)
})

/** Flips the byte at `offset` from the end of the pack's data. */
function flipNearEnd(file: string, fromEnd: number): void {
  const data = readFileSync(file)
  const at = data.length - fromEnd
  data[at] = (data[at] as number) ^ 0x55
  writeFileSync(file, data)
}

test('an entry whose checksum fails is never given to V8: rejected, compiled from its source and rewritten', () => {
  const dir = scratch()
  compile(dir)
  const [first] = packs(dir)
  flipNearEnd(join(dir, 'v8', first ?? ''), 100)
  const rejected = compile(dir)
  assert.deepEqual(rejected.stats, { ...ZERO, rejected: 1, packsRead: 1, written: 1 })
  assert.equal(rejected.cachedDataRejected, null)
  assert.equal(rejected.result, manyFunctionsValue(100))
  // The rewrite is a newer pack, and the newer entry wins.
  assert.equal(packs(dir).length, 2)
  const healed = compile(dir)
  assert.deepEqual(healed.stats, { ...ZERO, hits: 1, packsRead: 2 })
  assert.equal(healed.cachedDataRejected, false)
})

test('an entry V8 refuses (its checksum holds) is rejected and rewritten', () => {
  const dir = scratch()
  // The data of another script under this script's key: the checksum is right, the source is not.
  const code = manyFunctions(100)
  const key = v8PackKey(code, { filename: SCRIPT_NAME })
  const data = new Script(manyFunctions(30), { filename: SCRIPT_NAME }).createCachedData()
  mkdirSync(join(dir, 'v8'))
  writeFileSync(
    join(dir, 'v8', `${v8CacheTag()}-000000000-test-0.pack`),
    encodeV8Pack([{ key, data }]),
  )
  const refused = compile(dir)
  assert.deepEqual(refused.stats, { ...ZERO, rejected: 1, packsRead: 1, written: 1 })
  assert.equal(refused.cachedDataRejected, true)
  assert.equal(refused.result, manyFunctionsValue(100))
  const healed = compile(dir)
  assert.equal(healed.stats.hits, 1)
  assert.equal(healed.cachedDataRejected, false)
})

const damage: readonly (readonly [string, (file: string) => void])[] = [
  ['garbage bytes', (file) => writeFileSync(file, Buffer.from('not a pack'.repeat(40)))],
  ['a truncated pack', (file) => truncateSync(file, Math.floor(statSync(file).size / 2))],
  ['an empty file', (file) => truncateSync(file, 0)],
  // A byte of the index: its checksum fails, so the whole pack is ignored.
  ['a byte flipped in the index', (file) => flipAt(file, 20)],
]
function flipAt(file: string, offset: number): void {
  const data = readFileSync(file)
  data[offset] = (data[offset] as number) ^ 0x55
  writeFileSync(file, data)
}
for (const [name, damaged] of damage) {
  test(`${name} is a pack that is not read: a miss, never an error, and a new pack is written`, () => {
    const dir = scratch()
    compile(dir)
    damaged(join(dir, 'v8', packs(dir)[0] ?? ''))
    const again = compile(dir)
    assert.deepEqual(again.stats, { ...ZERO, misses: 1, written: 1 })
    assert.equal(again.result, manyFunctionsValue(100))
    assert.equal(compile(dir).stats.hits, 1)
  })
}

test('a directory that cannot be made is a pack that misses: no throw, writeFailures counted', () => {
  const dir = scratch()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'a file')
  const pack = openV8Pack({ dir: blocker })
  const script = pack.compile(manyFunctions(30), { filename: SCRIPT_NAME })
  assert.equal(script.runInThisContext(), manyFunctionsValue(30))
  pack.write()
  assert.deepEqual(pack.stats, { ...ZERO, misses: 1, writeFailures: 1 })
  assert.equal(readFileSync(blocker, 'utf8'), 'a file')
})

test("mode 'off' compiles and touches nothing: no directory, no read of a warm pack", () => {
  const dir = scratch()
  compile(dir)
  const before = packs(dir)
  const off = compile(dir, { mode: 'off' })
  assert.deepEqual(off.stats, { ...ZERO, skipped: 1 })
  assert.equal(off.cachedDataRejected, null)
  assert.equal(off.result, manyFunctionsValue(100))
  assert.deepEqual(packs(dir), before)
  const fresh = scratch()
  const pack = openV8Pack({ dir: fresh, mode: 'off' })
  pack.compile('1', { filename: SCRIPT_NAME })
  pack.write()
  assert.deepEqual(readdirSync(fresh), [])
})

test('a script shorter than minLength is compiled with no lookup and never written', () => {
  const dir = scratch()
  const short = compile(dir, { minLength: 1_000_000 })
  assert.deepEqual(short.stats, { ...ZERO, skipped: 1 })
  assert.deepEqual(packs(dir), [])
})

test('a script compiled twice before a write is written once; close drops what is queued', () => {
  const dir = scratch()
  const pack = openV8Pack({ dir })
  pack.compile(manyFunctions(20), { filename: SCRIPT_NAME })
  pack.compile(manyFunctions(20), { filename: SCRIPT_NAME })
  assert.equal(pack.pending, 1)
  pack.write()
  assert.equal(pack.stats.written, 1)
  pack.compile(manyFunctions(21), { filename: SCRIPT_NAME })
  pack.close()
  pack.write()
  assert.equal(pack.stats.written, 1)
  assert.equal(packs(dir).length, 1)
})

/** Writes a pack of `entries` (code text → data of that text) under the parent's tag. */
function writePack(dir: string, stamp: string, codes: readonly string[]): string {
  const name = `${v8CacheTag()}-${stamp}-test-0.pack`
  const entries = codes.map((code) => ({
    key: v8PackKey(code, { filename: SCRIPT_NAME }),
    data: new Script(code, { filename: SCRIPT_NAME }).createCachedData(),
  }))
  mkdirSync(join(dir, 'v8'), { recursive: true })
  writeFileSync(join(dir, 'v8', name), encodeV8Pack(entries))
  return name
}

test('compaction merges the packs of a cold run whose workers wrote the same entries, and the result is read', () => {
  const dir = scratch()
  const codes = [manyFunctions(10), manyFunctions(11), manyFunctions(12)]
  for (const stamp of ['000000001', '000000002', '000000003']) writePack(dir, stamp, codes)
  const result = compactV8Packs(dir)
  assert.deepEqual(result, { merged: 3, written: 1, packs: 3 })
  const [merged, ...rest] = packs(dir)
  assert.deepEqual(rest, [])
  const pack = openV8Pack({ dir })
  for (const code of codes) pack.compile(code, { filename: SCRIPT_NAME })
  // Read in this process, so V8's own cache answers; the entries were found, none was rejected.
  assert.equal(pack.stats.packsRead, 1)
  assert.equal(pack.stats.misses + pack.stats.rejected, 0)
  pack.close()
  assert.ok(merged !== undefined && statSync(join(dir, 'v8', merged)).size > 0)
})

test('compaction leaves a few packs with distinct entries alone, and merges more than maxPacks', () => {
  const dir = scratch()
  writePack(dir, '000000001', [manyFunctions(10)])
  writePack(dir, '000000002', [manyFunctions(11)])
  assert.deepEqual(compactV8Packs(dir), { merged: 0, written: 0, packs: 2 })
  for (let n = 3; n <= 9; n++) writePack(dir, `00000000${n}`, [manyFunctions(10 + n)])
  assert.deepEqual(compactV8Packs(dir), { merged: 9, written: 1, packs: 9 })
  assert.equal(packs(dir).length, 1)
})

test('compaction keeps the newest entry of a key, drops an entry whose checksum fails, and leaves other tags', () => {
  const dir = scratch()
  const code = manyFunctions(10)
  const key = v8PackKey(code, { filename: SCRIPT_NAME })
  const older = Buffer.from('older data, not V8 data')
  const newer = Buffer.from('newer data, not V8 data either')
  const other = `${'f'.repeat(16)}-000000001-test-0.pack`
  mkdirSync(join(dir, 'v8'), { recursive: true })
  writeFileSync(
    join(dir, 'v8', `${v8CacheTag()}-000000001-test-0.pack`),
    encodeV8Pack([{ key, data: older }]),
  )
  const broken = encodeV8Pack([{ key: v8PackKey('x', { filename: SCRIPT_NAME }), data: newer }])
  // The last byte is the entry's data: its checksum no longer holds.
  broken[broken.length - 1] = 0
  writeFileSync(join(dir, 'v8', `${v8CacheTag()}-000000002-test-0.pack`), broken)
  writeFileSync(
    join(dir, 'v8', `${v8CacheTag()}-000000003-test-0.pack`),
    encodeV8Pack([{ key, data: newer }]),
  )
  writeFileSync(join(dir, 'v8', other), encodeV8Pack([{ key, data: older }]))
  // Three of this tag with one key repeated: more than a quarter of the bytes repeat.
  const result = compactV8Packs(dir)
  assert.deepEqual(result, { merged: 3, written: 1, packs: 4 })
  const left = packs(dir)
  assert.equal(left.length, 2)
  assert.ok(left.includes(other))
  const merged = readFileSync(join(dir, 'v8', left.find((name) => name !== other) ?? ''))
  // One entry, the newer data.
  assert.equal(merged.readUInt32LE(8), 1)
  assert.ok(merged.subarray(merged.length - newer.length).equals(newer))
})

test('pruneCacheIfWritten compacts the packs, and the pruner counts a pack as one entry', () => {
  const dir = scratch()
  const codes = [manyFunctions(10), manyFunctions(11)]
  for (const stamp of ['000000001', '000000002']) writePack(dir, stamp, codes)
  writeFileSync(join(dir, WRITTEN_NAME), '')
  const pruned = pruneCacheIfWritten(dir, 1)
  // Merged to one pack, which a cap of one byte then evicts as the oldest entry.
  assert.equal(pruned?.removed, 1)
  assert.deepEqual(packs(dir), [])

  const kept = scratch()
  for (const stamp of ['000000001', '000000002']) writePack(kept, stamp, codes)
  writeFileSync(join(kept, WRITTEN_NAME), '')
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const stale = join(kept, 'v8', 'leftover.pack.tmp')
  writeFileSync(stale, 'a writer died')
  utimesSync(stale, old, old)
  assert.equal(pruneCacheIfWritten(kept)?.removed, 0)
  assert.equal(packs(kept).length, 1)
  // A temporary file a writer that died left an hour ago is swept, as in the transform's shards.
  assert.equal(existsSync(stale), false)
})
