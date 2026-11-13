// T9.6's shard: Jest's sha1 split, the contiguous cuts by predicted time, and that every file lands
// in exactly one shard, whatever order the files come in.
import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { ScheduleInput } from '@provino/types'
import type { DiscoveredFile } from './discover.ts'
import { seededRandom } from './schedule-sim.ts'
import { createHistorySequencer } from './sequencer.ts'
import { checkShard, predictedWeights, sha1Shard, shardFiles, sliceShard } from './shard.ts'

function file(path: string, timingMs?: number, project = 'p'): ScheduleInput {
  return { path, project, sizeBytes: 1, ...(timingMs === undefined ? {} : { timingMs }) }
}

function paths(files: readonly ScheduleInput[]): string[] {
  return files.map((f) => f.path)
}

/** A seeded shuffle, so a property test reads the files in many orders. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

describe('sha1Shard (Jest 30.5.2 `TestSequencer.shard`)', () => {
  const names = Array.from({ length: 7 }, (_, i) => `dir/file-${i}.test.ts`)
  /** Jest's own algorithm, written the way jest-test-sequencer writes it. */
  function jestShard(all: readonly string[], shardIndex: number, shardCount: number): string[] {
    const position = (index: number): number => {
      const rest = all.length % shardCount
      const ratio = all.length / shardCount
      let sum = 0
      for (let i = 0; i < index; i++) sum += i < rest ? Math.ceil(ratio) : Math.floor(ratio)
      return sum
    }
    return all
      .map((path) => ({ path, hash: hash('sha1', path) }))
      .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
      .slice(position(shardIndex - 1), position(shardIndex))
      .map((entry) => entry.path)
  }

  it('gives the files Jest gives each shard, in its order (the sha1 order)', () => {
    for (const count of [1, 2, 3, 4, 7, 9]) {
      for (let index = 1; index <= count; index++) {
        assert.deepEqual(
          paths(
            sha1Shard(
              names.map((n) => file(n)),
              { index, count },
            ),
          ),
          jestShard(names, index, count),
          `${index}/${count}`,
        )
      }
    }
  })

  it('makes the first `length % count` shards one file longer', () => {
    const sizes = [1, 2, 3].map(
      (index) =>
        sha1Shard(
          names.map((n) => file(n)),
          { index, count: 3 },
        ).length,
    )
    assert.deepEqual(sizes, [3, 2, 2])
  })

  it('ignores timings: it is the split a dialect asks for when no file has one', () => {
    const timed = names.map((n, i) => file(n, 100 * (i + 1)))
    assert.deepEqual(
      paths(sha1Shard(timed, { index: 2, count: 3 })),
      paths(
        sha1Shard(
          names.map((n) => file(n)),
          { index: 2, count: 3 },
        ),
      ),
    )
  })

  it('hashes the path as given: the root-relative path, the same for equal paths of two projects', () => {
    const a = file('same.test.ts', undefined, 'a')
    const b = file('same.test.ts', undefined, 'b')
    // The tie is broken by project, so the order is total: swapping the input changes nothing.
    assert.deepEqual(
      sha1Shard([b, a], { index: 1, count: 1 }).map((f) => f.project),
      ['a', 'b'],
    )
  })
})

describe('sliceShard (contiguous cuts by predicted time)', () => {
  it('cuts the path-sorted files where the cumulative time crosses each share', () => {
    const files = [file('a', 100), file('b', 100), file('c', 100), file('d', 100), file('e', 400)]
    // Total 800, two shards: the cut is at 400. a, b, c, d add up to exactly that; e (400) is the second.
    assert.deepEqual(paths(sliceShard(files, { index: 1, count: 2 })), ['a', 'b', 'c', 'd'])
    assert.deepEqual(paths(sliceShard(files, { index: 2, count: 2 })), ['e'])
  })

  it('returns neighbours: a shard is one run of the path-sorted files', () => {
    const random = seededRandom(7)
    const files = Array.from({ length: 80 }, (_, i) =>
      file(`f${String(i).padStart(3, '0')}`, 1 + random() * 900),
    )
    const sorted = paths(files.toSorted((a, b) => (a.path < b.path ? -1 : 1)))
    let next = 0
    for (let index = 1; index <= 5; index++) {
      const mine = paths(sliceShard(files, { index, count: 5 }))
      assert.deepEqual(mine, sorted.slice(next, next + mine.length), `shard ${index}`)
      next += mine.length
    }
    assert.equal(next, sorted.length)
  })

  it('gives a file with no time the median of the others, so it takes a typical place', () => {
    const files = [file('a', 10), file('b', 20), file('c', 30), file('d'), file('e', 40)]
    assert.equal(predictedWeights(files).get(files[3] as ScheduleInput), 25)
  })

  it('counts every file the same when no file has a time: slices by file count', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((p) => file(p))
    const sizes = [1, 2, 3].map((index) => sliceShard(files, { index, count: 3 }).length)
    assert.deepEqual(sizes.toSorted(), [2, 2, 3])
    assert.deepEqual(paths(sliceShard(files, { index: 1, count: 1 })), paths(files))
  })

  it('does not change the files around one that is added with no time', () => {
    const base = Array.from({ length: 40 }, (_, i) =>
      file(`f${String(i).padStart(2, '0')}`, 100 + (i % 7) * 40),
    )
    const before = new Map<string, number>()
    for (let index = 1; index <= 4; index++) {
      for (const f of sliceShard(base, { index, count: 4 })) before.set(f.path, index)
    }
    const more = [...base, file('f20x')]
    const after = new Map<string, number>()
    for (let index = 1; index <= 4; index++) {
      for (const f of sliceShard(more, { index, count: 4 })) after.set(f.path, index)
    }
    const moved = base.filter((f) => before.get(f.path) !== after.get(f.path)).length
    assert.ok(moved <= 2, `${moved} files moved`)
  })

  it('treats a 0 ms time as the 1 ms floor, so a file of zeros still has a place', () => {
    const files = ['a', 'b', 'c', 'd'].map((p) => file(p, 0))
    assert.deepEqual(
      [1, 2].map((index) => sliceShard(files, { index, count: 2 }).length),
      [2, 2],
    )
  })

  it('keeps every file in a shard when the times are huge: the cumulative sum must not overflow', () => {
    // 1e308 passes the timings file's checks (finite, not negative) but two of them sum to Infinity.
    const files = [file('a.test.ts', 1e308), file('b.test.ts', 1e308), file('c.test.ts', 5)]
    const all = [1, 2].flatMap((index) => paths(sliceShard(files, { index, count: 2 })))
    assert.deepEqual(all.toSorted(), ['a.test.ts', 'b.test.ts', 'c.test.ts'])
    const infinite = [file('a.test.ts', Infinity), file('b.test.ts', 7), file('c.test.ts', 7)]
    const every = [1, 2].flatMap((index) => paths(sliceShard(infinite, { index, count: 2 })))
    assert.deepEqual(every.toSorted(), ['a.test.ts', 'b.test.ts', 'c.test.ts'])
  })

  it('treats a time that is not a number as no time', () => {
    const files = [file('a.test.ts', Number.NaN), file('b.test.ts', 4), file('c.test.ts', 4)]
    const all = [1, 2].flatMap((index) => paths(sliceShard(files, { index, count: 2 })))
    assert.deepEqual(all.toSorted(), ['a.test.ts', 'b.test.ts', 'c.test.ts'])
  })
})

describe('every file lands in exactly one shard (seeded property test)', () => {
  const strategies = {
    sha1: sha1Shard,
    slice: sliceShard,
    'sequencer, no timings (sha1-slice)': (
      files: readonly ScheduleInput[],
      shard: { index: number; count: number },
    ) =>
      createHistorySequencer({ unknownFirst: true, shardFallback: 'sha1-slice' }).shard(
        files,
        shard,
      ),
    'sequencer, no timings (path-slice)': (
      files: readonly ScheduleInput[],
      shard: { index: number; count: number },
    ) =>
      createHistorySequencer({ unknownFirst: true, shardFallback: 'path-slice' }).shard(
        files,
        shard,
      ),
  }

  for (const [name, shardOf] of Object.entries(strategies)) {
    it(`${name}: shards partition the files, and the input order changes nothing`, () => {
      const random = seededRandom(2026)
      for (let trial = 0; trial < 60; trial++) {
        const total = Math.floor(random() * 70)
        const count = 1 + Math.floor(random() * 9)
        const timed = random() < 0.5
        const files = Array.from({ length: total }, (_, i) =>
          file(
            `${random() < 0.3 ? 'a/' : 'b/'}f${i}.test.ts`,
            timed && random() < 0.8 ? Math.floor(random() * 900) : undefined,
            random() < 0.2 ? 'q' : 'p',
          ),
        )
        const reference = new Map<string, number>()
        for (let index = 1; index <= count; index++) {
          for (const f of shardOf(files, { index, count })) {
            const key = `${f.project}\0${f.path}`
            assert.equal(reference.has(key), false, `${key} is in two shards (trial ${trial})`)
            reference.set(key, index)
          }
        }
        assert.equal(
          reference.size,
          files.length,
          `every file is in a shard (trial ${trial}, ${total} files, ${count} shards)`,
        )
        // Any other input order puts every file in the same shard.
        const other = shuffled(files, random)
        for (let index = 1; index <= count; index++) {
          for (const f of shardOf(other, { index, count })) {
            assert.equal(
              reference.get(`${f.project}\0${f.path}`),
              index,
              `${f.path} moved with the input order`,
            )
          }
        }
      }
    })
  }

  it('the sequencer cuts by time as soon as one file has a time, and by the fallback otherwise', () => {
    const files = ['a', 'b', 'c', 'd'].map((p) => file(p))
    const sha1 = createHistorySequencer({ unknownFirst: true, shardFallback: 'sha1-slice' })
    const slice = createHistorySequencer({ unknownFirst: true, shardFallback: 'path-slice' })
    assert.deepEqual(
      paths(sha1.shard(files, { index: 1, count: 2 })),
      paths(sha1Shard(files, { index: 1, count: 2 })),
    )
    assert.deepEqual(paths(slice.shard(files, { index: 1, count: 2 })), ['a', 'b'])
    const timed = [file('a', 900), ...files.slice(1)]
    // Timings win over the fallback: contiguous cuts, even for the sha1 dialect.
    assert.deepEqual(
      paths(sha1.shard(timed, { index: 1, count: 2 })),
      paths(sliceShard(timed, { index: 1, count: 2 })),
    )
  })
})

describe('shardFiles', () => {
  const found = (relativePath: string): DiscoveredFile => ({
    path: `/root/${relativePath}`,
    relativePath,
    sizeBytes: 1,
  })

  it('looks a file up in the timings by its own entries: a path named like an Object.prototype member has no time', () => {
    // `files['constructor']` is a function on an ordinary object; it is no time, so the file counts
    // as one with none and still lands in exactly one shard.
    const members = [
      { rootDir: '/root', files: [found('constructor'), found('toString'), found('b')] },
    ]
    const options = {
      fallback: 'path-slice',
      runRoot: '/root',
      timings: { version: 1, files: { b: 10 } },
    } as const
    const all = [1, 2].flatMap((index) =>
      (shardFiles(members, { ...options, shard: { index, count: 2 } })[0] ?? []).map(
        (file) => file.relativePath,
      ),
    )
    assert.deepEqual(all.toSorted(), ['b', 'constructor', 'toString'])
  })
})

describe('checkShard', () => {
  it('accepts index of count, 1-based', () => {
    for (const [index, count] of [
      [1, 1],
      [1, 3],
      [3, 3],
    ] as const)
      checkShard({ index, count })
  })

  it('refuses anything else, as a coded error naming the value', () => {
    for (const [index, count] of [
      [0, 3],
      [4, 3],
      [1, 0],
      [-1, 2],
      [1.5, 3],
      [1, Number.NaN],
      [Number.POSITIVE_INFINITY, 3],
    ] as const) {
      assert.throws(
        () => checkShard({ index, count }),
        { code: 'ORCH_BAD_OPTION' },
        `${index}/${count}`,
      )
    }
  })
})
