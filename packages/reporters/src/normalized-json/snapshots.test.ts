import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import type { NormalizedRun, SnapshotRunSummary } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import { FIXED_ENV, output, playRun } from '../internal/test-support.ts'
import { normalizedJsonReporter } from './reporter.ts'

const counters = {
  added: 1,
  matched: 2,
  unmatched: 0,
  updated: 0,
  unchecked: 0,
  total: 3,
  filesAdded: 1,
  filesRemoved: 0,
  filesUnmatched: 0,
  filesUpdated: 0,
}

function makeReporter(out: ReturnType<typeof output>) {
  return normalizedJsonReporter({
    stream: out,
    runner: 'provino:test',
    runnerVersion: '0.0.0',
    suite: 's',
    env: FIXED_ENV,
  })
}

const parseText = (text: string): NormalizedRun => JSON.parse(text) as NormalizedRun

describe('the normalized-json reporter: snapshots', () => {
  test('holds Jest`s totals and each .snap file with the hash of its bytes, relative to the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provino-reporters-snap-'))
    try {
      const file = join(dir, '__snapshots__', 'a.test.ts.snap')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, 'content\n')
      const out = output()
      const bus = createReporterBus([makeReporter(out)])
      await bus.emit('run:start', { root: dir, projects: [''], startTime: 0, watch: false }, [])
      await bus.emit('run:end', {
        reason: 'passed',
        files: [],
        unhandled: [],
        durationMs: 1,
        snapshots: {
          counters,
          uncheckedKeysByFile: [],
          update: 'new',
          files: [file, join(dir, 'missing.snap')],
        },
      })
      assert.deepEqual(parseText(out.text()).snapshots, {
        counters,
        files: [
          {
            file: '__snapshots__/a.test.ts.snap',
            sha256: createHash('sha256').update('content\n').digest('hex'),
          },
        ],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function play(snapshots: SnapshotRunSummary | undefined, reason?: 'failed') {
    const out = output()
    const bus = createReporterBus([makeReporter(out)])
    await playRun(bus, [{ path: 'a.test.ts', tests: [{ path: ['one'] }] }], {
      ...(snapshots === undefined ? {} : { snapshots }),
      ...(reason === undefined ? {} : { reason }),
    })
    return parseText(out.text())
  }

  test('has no snapshots key for a run with none', async () => {
    assert.equal((await play(undefined)).snapshots, undefined)
  })

  test('is not a success when the run failed on its snapshots, with every file green', async () => {
    const run = await play(
      { counters, uncheckedKeysByFile: [], update: 'new', files: [] },
      'failed',
    )
    assert.equal(run.files[0]?.status, 'passed')
    assert.equal(run.success, false)
  })
})
