import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Reporter, ReporterEvents } from '@provino/types'
import { describe, it } from 'provino'
import { createReporterBus } from '../bus.ts'
import { emitFile, error, fileInfo } from '../internal/test-support.ts'
import { MAX_FAILURE_TEXT, MAX_FAILURES } from './data.ts'
import { htmlReporter } from './reporter.ts'
import {
  clock,
  dataOf,
  playTimed,
  reportFor,
  TIMED_FIXTURE,
  type TimedFile,
} from './test-support.ts'

/** A scratch directory that is removed when `body` is done. */
async function inScratch<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-html-reporter-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('htmlReporter', () => {
  it('writes one file at run:end, atomically, and nothing before', async () => {
    await inScratch(async (dir) => {
      const outputFile = join(dir, 'out', 'report.html')
      const time = clock()
      const seen: boolean[] = []
      // Registered first, so at `run:end` it runs before the reporter writes.
      const probe: Reporter = {
        name: 'probe',
        ...Object.fromEntries(
          (
            [
              'run:start',
              'file:start',
              'file:collected',
              'task:end',
              'file:end',
              'run:end',
            ] as const
          ).map((event) => [event, () => void seen.push(existsSync(outputFile))]),
        ),
      }
      const bus = createReporterBus([probe, htmlReporter({ outputFile, now: time.now })])
      await playTimed(bus, TIMED_FIXTURE, time)
      assert.deepEqual(bus.failures(), [])
      assert.ok(seen.length > 20)
      assert.equal(seen.some(Boolean), false, 'a file existed before run:end')
      // One file in a directory the reporter made, and no temp file left beside it.
      assert.deepEqual(await readdir(join(dir, 'out')), ['report.html'])
      assert.match(await readFile(outputFile, 'utf8'), /^<!doctype html>/)
    })
  })

  it('replaces a file that is there whole, and a failed write leaves the old one and no temp file', async () => {
    await inScratch(async (dir) => {
      const outputFile = join(dir, 'report.html')
      await writeFile(outputFile, 'old')
      const time = clock()
      const bus = createReporterBus([htmlReporter({ outputFile, now: time.now })])
      await playTimed(bus, TIMED_FIXTURE, time)
      assert.match(await readFile(outputFile, 'utf8'), /^<!doctype html>/)
      // A directory where the file should go: the rename fails, and the bus has the error.
      const blocked = join(dir, 'blocked.html')
      await mkdir(join(blocked, 'inside'), { recursive: true })
      const second = clock()
      const failing = createReporterBus([htmlReporter({ outputFile: blocked, now: second.now })])
      await playTimed(failing, TIMED_FIXTURE, second)
      assert.equal(failing.failures().length, 1)
      assert.deepEqual((await readdir(dir)).sort(), ['blocked.html', 'report.html'])
    })
  })

  it('keeps one row per file and test, the file in the order they ended, and each path and title once', async () => {
    const { html } = await reportFor()
    const data = dataOf(html)
    assert.equal(data.version, 1)
    assert.equal(data.title, 'project')
    assert.equal(data.reason, 'failed')
    assert.equal(data.durationMs, 40)
    assert.equal(data.startedAt, '2026-11-19T12:00:00.000Z')
    // The project's directory name stands for the root: the run's path is not in the data.
    assert.equal('root' in data, false)
    // A real run carries no seed and no sample label.
    assert.equal(data.seed, undefined)
    assert.equal(data.sample, undefined)
    const paths = data.files.map((row) => data.strings[row[0]])
    // The order they ended in, not the order they started in.
    assert.deepEqual(paths, [
      'fails.test.ts',
      'math.test.ts',
      'all-skipped.test.ts',
      'todo-only.test.ts',
      'skipped.test.ts',
      'console.test.ts',
      'snapshot.test.ts',
      'broken.test.ts',
    ])
    // path, status, ms, worker, start, end, expected, project
    assert.deepEqual(data.files[1], [
      data.strings.indexOf('math.test.ts'),
      0,
      12,
      0,
      0,
      12,
      10,
      data.strings.indexOf(''),
    ])
    assert.deepEqual(
      data.files.map((row) => row[1]),
      // failed, passed, skipped, todo, passed, passed, failed, failed
      [1, 0, 2, 3, 0, 0, 1, 1],
    )
    assert.deepEqual(
      data.files.map((row) => [row[3], row[4], row[5]]),
      [
        [1, 2, 11],
        [0, 0, 12],
        [1, 13, 14],
        [1, 15, 16],
        [0, 14, 17],
        [0, 18, 24],
        [1, 17, 24],
        [2, 30, 32],
      ],
    )
    assert.equal(data.files[0]?.[6], -1, 'a file with no expected time says so')
    assert.equal(new Set(data.strings).size, data.strings.length, 'a string is in the table once')
    // 13 tests; the title path of each is string ids.
    assert.equal(data.tests.length, 13)
    const nested = data.tests.find((row) => row[1].length === 3)
    assert.deepEqual(
      nested?.[1].map((id) => data.strings[id]),
      ['math', 'nested', 'subtracts'],
    )
    assert.deepEqual(
      data.tests.filter((row) => row[2] === 1).map((row) => data.strings[row[1].at(-1) ?? 0]),
      ['fails', 'matches a stored snapshot'],
    )
    // Each failed test has its text, and the file that failed to collect has its own.
    assert.equal(data.failures.length, 2)
    assert.match(data.failures[0]?.[1] ?? '', /toBe\(expected\)/)
    assert.equal(data.fileErrors.length, 1)
    assert.match(data.fileErrors[0]?.[1] ?? '', /Cannot find module '\.\/missing\.ts'/)
    assert.deepEqual(data.snapshots, {
      total: 1,
      matched: 0,
      unmatched: 1,
      added: 0,
      updated: 0,
      unchecked: 0,
    })
  })

  it('carries the seed and the sample mark it is given, and only then', async () => {
    const { html } = await reportFor(TIMED_FIXTURE, { seed: 1827364, sample: true })
    const data = dataOf(html)
    assert.equal(data.seed, 1827364)
    assert.equal(data.sample, true)
  })

  it('reads the clock once at run:start, once at each file’s start and end, and once at run:end, and nowhere else', async () => {
    const time = clock()
    let reads = 0
    const counting = {
      now: () => {
        reads += 1
        return time.now()
      },
      set: time.set,
    }
    await inScratch(async (dir) => {
      const bus = createReporterBus([
        htmlReporter({ outputFile: join(dir, 'r.html'), now: counting.now }),
      ])
      await playTimed(bus, TIMED_FIXTURE, counting)
    })
    assert.equal(reads, 1 + 2 * TIMED_FIXTURE.length + 1)
  })

  it('counts a replaced worker as one of its own, and the gap shows in the times', async () => {
    const { html } = await reportFor()
    const data = dataOf(html)
    const workers = [...new Set(data.files.map((row) => row[3]))].sort()
    assert.deepEqual(workers, [0, 1, 2])
    const replacement = data.files.filter((row) => row[3] === 2)
    assert.deepEqual(
      replacement.map((row) => [row[4], row[5]]),
      [[30, 32]],
    )
  })

  it('keeps the text of at most 1,000 failures, 16 KB each, and counts the rest', async () => {
    const tests = Array.from({ length: MAX_FAILURES + 5 }, (_, n) => ({
      path: ['suite', `case ${n}`],
      state: 'fail' as const,
      errors: [error('x'.repeat(MAX_FAILURE_TEXT * 2))],
    }))
    const { html } = await reportFor([
      { spec: { path: 'big.test.ts', tests }, workerId: 0, startMs: 0, endMs: 5 },
    ])
    const data = dataOf(html)
    assert.equal(data.tests.length, MAX_FAILURES + 5)
    assert.equal(data.tests.filter((row) => row[2] === 1).length, MAX_FAILURES + 5)
    assert.equal(data.failures.length, MAX_FAILURES)
    assert.equal(data.omitted, 5)
    assert.ok(data.failures.every((row) => row[1].length <= MAX_FAILURE_TEXT))
    // The rows are in order, so the first failures are the ones kept.
    assert.deepEqual(data.failures[0]?.[0], 0)
    assert.deepEqual(data.failures.at(-1)?.[0], MAX_FAILURES - 1)
  })

  it('keeps the text of at most 1,000 file errors and 1,000 run errors, and counts the rest', async () => {
    const files: TimedFile[] = Array.from({ length: 2 * MAX_FAILURES }, (_, n) => ({
      spec: {
        path: `broken-${n}.test.ts`,
        state: 'fail' as const,
        errors: [error('y'.repeat(MAX_FAILURE_TEXT * 2))],
      },
      workerId: 0,
      startMs: n,
      endMs: n + 1,
    }))
    const { html } = await reportFor(files)
    const data = dataOf(html)
    // Every file is still a failed file with its row; the text is kept for the first 1,000.
    assert.equal(data.files.length, 2 * MAX_FAILURES)
    assert.ok(data.files.every((row) => row[1] === 1))
    assert.equal(data.fileErrors.length, 2 * MAX_FAILURES)
    assert.equal(data.fileErrors.filter((row) => row[1] !== '').length, MAX_FAILURES)
    assert.ok(data.fileErrors.every((row) => row[1].length <= MAX_FAILURE_TEXT))
    // The first ones are the ones kept, and the page lists the others without text.
    assert.ok((data.fileErrors[MAX_FAILURES - 1]?.[1] ?? '') !== '')
    assert.equal(data.fileErrors[MAX_FAILURES]?.[1], '')
    assert.equal(data.omitted, MAX_FAILURES)
    assert.ok(html.length < MAX_FAILURES * 1024 * 20, `${html.length} bytes`)
  })

  it('keeps the text of at most 1,000 errors outside the files, and counts the rest', async () => {
    await inScratch(async (dir) => {
      const outputFile = join(dir, 'report.html')
      const time = clock()
      const bus = createReporterBus([htmlReporter({ outputFile, now: time.now })])
      await bus.emit(
        'run:start',
        { root: '/project', projects: [''], startTime: 0, watch: false },
        [],
      )
      for (let n = 0; n < MAX_FAILURES + 3; n++)
        await bus.emit('error', error(`late ${n}`), 'coordinator')
      await bus.emit('run:end', { reason: 'failed', files: [], unhandled: [], durationMs: 1 })
      const data = dataOf(await readFile(outputFile, 'utf8'))
      assert.equal(data.runErrors.length, MAX_FAILURES + 3)
      assert.equal(data.runErrors.filter((text) => text !== '').length, MAX_FAILURES)
      assert.equal(data.runErrors[0], 'late 0')
      assert.equal(data.runErrors.at(-1), '')
      assert.equal(data.omitted, 3)
    })
  })

  it('makes a file the bus never ended from the summary, and a late error one of the run’s', async () => {
    await inScratch(async (dir) => {
      const outputFile = join(dir, 'report.html')
      const time = clock()
      const reporter = htmlReporter({ outputFile, now: time.now })
      const bus = createReporterBus([reporter])
      await bus.emit(
        'run:start',
        { root: '/project', projects: [''], startTime: 0, watch: false },
        [],
      )
      const first = await emitFile(bus, { path: 'first.test.ts', tests: [{ path: ['a'] }] })
      // An error charged to the file after it ended belongs to the run.
      await bus.emit('unhandled', first.file, {
        type: 'unhandled-error',
        ownerId: null,
        lastTestId: null,
        origin: 'uncaughtException',
        error: error('too late'),
        t: 0,
      })
      const never = fileInfo('never-ended.test.ts')
      await bus.emit('error', error('the coordinator said so'), 'coordinator')
      await bus.emit('run:end', {
        reason: 'failed',
        files: [first, { file: never, state: 'fail', durationMs: 3, errors: [error('lost')] }],
        unhandled: [],
        durationMs: 9,
      })
      assert.deepEqual(bus.failures(), [])
      const data = dataOf(await readFile(outputFile, 'utf8'))
      assert.equal(data.files.length, 2)
      assert.equal(data.strings[data.files[1]?.[0] ?? 0], 'never-ended.test.ts')
      // No worker, start or end for it.
      assert.deepEqual(data.files[1]?.slice(3, 6), [-1, -1, -1])
      assert.equal(data.files[1]?.[1], 1)
      assert.equal(data.fileErrors.length, 1)
      assert.deepEqual(
        data.runErrors.map((text) => text.split('\n')[0]),
        ['too late', 'the coordinator said so'],
      )
    })
  })

  it('ends a file that started and never ended at the run’s end, so no row ends before it starts', async () => {
    await inScratch(async (dir) => {
      const outputFile = join(dir, 'report.html')
      const time = clock()
      const bus = createReporterBus([htmlReporter({ outputFile, now: time.now })])
      time.set(100)
      await bus.emit(
        'run:start',
        { root: '/project', projects: [''], startTime: 0, watch: false, workers: 2 },
        [],
      )
      const done = await emitFile(bus, { path: 'done.test.ts', tests: [{ path: ['a'] }] })
      time.set(130)
      // A worker was killed while it ran this file: `file:start`, never `file:end`.
      const cut = fileInfo('killed.test.ts')
      await bus.emit('file:start', cut, 1)
      time.set(175)
      await bus.emit('run:end', {
        reason: 'interrupted',
        files: [done, { file: cut, state: 'fail', durationMs: 20, errors: [] }],
        unhandled: [],
        durationMs: 75,
      })
      assert.deepEqual(bus.failures(), [])
      const data = dataOf(await readFile(outputFile, 'utf8'))
      const row = data.files.find((item) => data.strings[item[0]] === 'killed.test.ts')
      // Its worker, its start (30 ms in) and the run's end (75 ms in); every row has start <= end.
      assert.deepEqual(row?.slice(3, 6), [1, 30, 75])
      for (const item of data.files) {
        if (item[3] >= 0)
          assert.ok(item[5] >= item[4], `${data.strings[item[0]]} ends before it starts`)
      }
    })
  })

  it('leaves out the real path of a root that is a symlink, as the frames of a failure print it', async () => {
    await inScratch(async (dir) => {
      const real = await realpath(await mkdtemp(join(dir, 'real-')))
      const link = join(dir, 'link')
      await symlink(real, link)
      const outputFile = join(dir, 'report.html')
      const time = clock()
      const bus = createReporterBus([htmlReporter({ outputFile, now: time.now })])
      await bus.emit('run:start', { root: link, projects: [''], startTime: 0, watch: false }, [])
      const result = await emitFile(bus, {
        path: 'a.test.ts',
        tests: [
          {
            path: ['fails'],
            state: 'fail',
            errors: [
              error('boom', { stack: `Error: boom\n    at run (${real}/src/a.test.ts:3:5)` }),
            ],
          },
        ],
      })
      await bus.emit('run:end', { reason: 'failed', files: [result], unhandled: [], durationMs: 1 })
      assert.deepEqual(bus.failures(), [])
      const html = await readFile(outputFile, 'utf8')
      assert.deepEqual(
        dataOf(html).failures.map((row) => row[1]),
        ['boom\n  at run (src/a.test.ts:3:5)'],
      )
      assert.equal(html.includes(real), false, 'the real path of the root is in the page')
      assert.equal(html.includes(link), false, 'the root is in the page')
    })
  })

  it('writes the root’s directory name and no other part of its path anywhere in the document', async () => {
    await inScratch(async (dir) => {
      const outputFile = join(dir, 'report.html')
      const time = clock()
      const root = '/home/ci/work/project'
      const bus = createReporterBus([htmlReporter({ outputFile, now: time.now })])
      await bus.emit('run:start', { root, projects: [''], startTime: 0, watch: false }, [])
      const result = await emitFile(bus, {
        path: 'a.test.ts',
        tests: [
          {
            path: ['fails'],
            state: 'fail',
            errors: [
              error('boom', { stack: `Error: boom\n    at run (${root}/src/a.test.ts:3:5)` }),
            ],
          },
        ],
      })
      await bus.emit('run:end', { reason: 'failed', files: [result], unhandled: [], durationMs: 1 })
      const html = await readFile(outputFile, 'utf8')
      assert.equal(html.includes('/home/ci/work'), false)
      assert.equal(html.includes(root), false)
      const data = dataOf(html)
      assert.equal(data.title, 'project')
      assert.match(html, /<title>Provino report: project<\/title>/)
    })
  })

  it('marks a test that never ended, and tells a skipped test from a todo one', async () => {
    const { html } = await reportFor([
      {
        spec: {
          path: 'mixed.test.ts',
          tests: [
            { path: ['ran'] },
            { path: ['never ended'], ran: false },
            { path: ['skipped'], state: 'skip' },
            { path: ['planned'], state: 'todo' },
          ],
        },
        workerId: 0,
        startMs: 0,
        endMs: 1,
      },
    ])
    const data = dataOf(html)
    assert.deepEqual(
      data.tests.map((row) => row[2]),
      [0, 4, 2, 3],
    )
  })

  it('does not change what the other reporters see: it adds no event and drops none', async () => {
    const events: (keyof ReporterEvents)[] = []
    const recorder: Reporter = {
      name: 'recorder',
      'run:start': () => void events.push('run:start'),
      'file:end': () => void events.push('file:end'),
      'run:end': () => void events.push('run:end'),
    }
    await inScratch(async (dir) => {
      const time = clock()
      const bus = createReporterBus([
        htmlReporter({ outputFile: join(dir, 'r.html'), now: time.now }),
        recorder,
      ])
      await playTimed(bus, TIMED_FIXTURE, time)
      assert.deepEqual(bus.failures(), [])
    })
    assert.equal(events.length, 2 + TIMED_FIXTURE.length)
  })
})
