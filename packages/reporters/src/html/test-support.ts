// Test helpers for the HTML report's tests (not a test file): the fixture run with workers and
// times, a player that moves the reporter's clock to each file's start and end, and the page the
// reporter writes for it.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReporterBus, RunSummary } from '@provino/types'
import { createReporterBus } from '../bus.ts'
import {
  buildFile,
  collectedEvent,
  FIXTURE_FILES,
  FIXTURE_SNAPSHOTS,
  type FileSpec,
  resultOf,
  taskResult,
  testEndEvent,
} from '../internal/test-support.ts'
import type { ReportData } from './data.ts'
import { type HtmlReporterOptions, htmlReporter } from './reporter.ts'

/** The data a page carries: its `<script type="application/json">`, parsed. */
export function dataOf(html: string): ReportData {
  const found = /<script type="application\/json" id="provino-data">([\s\S]*?)<\/script>/.exec(html)
  if (found?.[1] === undefined) throw new Error('the document has no data script')
  return JSON.parse(found[1]) as ReportData
}

/** A file with where and when it ran. */
export interface TimedFile {
  readonly spec: FileSpec
  readonly workerId: number
  readonly startMs: number
  readonly endMs: number
  readonly expectedMs?: number
}

/** The fixture run's files on three workers, one of them (2) a replacement for a worker that died. */
export const TIMED_FIXTURE: readonly TimedFile[] = [
  { spec: file('math.test.ts'), workerId: 0, startMs: 0, endMs: 12, expectedMs: 10 },
  { spec: file('fails.test.ts'), workerId: 1, startMs: 2, endMs: 11 },
  { spec: file('skipped.test.ts'), workerId: 0, startMs: 14, endMs: 17 },
  { spec: file('all-skipped.test.ts'), workerId: 1, startMs: 13, endMs: 14 },
  { spec: file('todo-only.test.ts'), workerId: 1, startMs: 15, endMs: 16 },
  { spec: file('console.test.ts'), workerId: 0, startMs: 18, endMs: 24 },
  { spec: file('snapshot.test.ts'), workerId: 1, startMs: 17, endMs: 24 },
  { spec: file('broken.test.ts'), workerId: 2, startMs: 30, endMs: 32 },
]

function file(path: string): FileSpec {
  const found = FIXTURE_FILES.find((spec) => spec.path === path)
  if (found === undefined) throw new Error(`no fixture file ${path}`)
  return found
}

/** A clock the player moves. */
export interface Clock {
  readonly now: () => number
  set(ms: number): void
}

export function clock(): Clock {
  let time = 0
  return {
    now: () => time,
    set(ms) {
      time = ms
    },
  }
}

/**
 * Plays `files` through `bus` in time order: a file's events at its start, `file:end` at its end,
 * `clock` set to each. `run:end` carries the fixture's snapshots.
 */
export async function playTimed(
  bus: ReporterBus,
  files: readonly TimedFile[],
  time: Clock,
): Promise<RunSummary> {
  const built = files.map((timed) => ({
    timed,
    file: buildFile({
      ...timed.spec,
      ...(timed.spec.durationMs === undefined ? { durationMs: timed.endMs - timed.startMs } : {}),
    }),
  }))
  time.set(0)
  await bus.emit(
    'run:start',
    { root: '/project', projects: [''], startTime: 0, watch: false, workers: 4 },
    built.map(({ file: built, timed }) => ({
      ...built.info,
      ...(timed.expectedMs === undefined ? {} : { expectedMs: timed.expectedMs }),
    })),
  )
  const steps = built
    .flatMap((entry) => [
      { t: entry.timed.startMs, order: 1, kind: 'start' as const, entry },
      { t: entry.timed.endMs, order: 0, kind: 'end' as const, entry },
    ])
    .sort((a, b) => a.t - b.t || a.order - b.order)
  for (const { t, kind, entry } of steps) {
    time.set(t)
    const { file: built, timed } = entry
    const info = {
      ...built.info,
      ...(timed.expectedMs === undefined ? {} : { expectedMs: timed.expectedMs }),
    }
    if (kind === 'end') {
      await bus.emit('file:end', { ...built.result, file: info })
      continue
    }
    await bus.emit('file:start', info, timed.workerId)
    await bus.emit('file:collected', info, collectedEvent(built))
    for (const { task, spec } of built.tests) {
      if (spec.ran === false) continue
      await bus.emit('task:end', task, testEndEvent(task, resultOf(spec)))
    }
    for (const { task, errors } of built.suiteEnds) {
      await bus.emit('task:end', task, {
        type: 'suite-end',
        id: task.id,
        result: taskResult('fail', { errors }),
        t: 2,
      })
    }
  }
  const summary: RunSummary = {
    reason: built.some(({ file: item }) => item.result.state === 'fail') ? 'failed' : 'passed',
    files: built.map(({ file: item }) => item.result),
    unhandled: [],
    durationMs: 40,
    snapshots: FIXTURE_SNAPSHOTS,
  }
  await bus.emit('run:end', summary)
  return summary
}

/** The page the reporter writes for `files`, read back from its file, and no reporter failed. */
export async function reportFor(
  files: readonly TimedFile[] = TIMED_FIXTURE,
  options: Partial<HtmlReporterOptions> = {},
): Promise<{ readonly html: string; readonly summary: RunSummary }> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-html-'))
  try {
    const time = clock()
    const outputFile = join(dir, 'report.html')
    const bus = createReporterBus([
      htmlReporter({
        outputFile,
        root: '/project',
        now: time.now,
        wallClock: () => Date.UTC(2026, 10, 19, 12, 0, 0),
        ...options,
      }),
    ])
    const summary = await playTimed(bus, files, time)
    const failures = bus.failures()
    if (failures.length > 0) throw new Error(failures.map((failure) => failure.message).join('; '))
    return { html: await readFile(outputFile, 'utf8'), summary }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
