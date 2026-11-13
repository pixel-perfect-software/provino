// What makes an instruction count repeatable: the same input does the same work in every run. Two
// things in V8 start a collection from a delayed foreground task, on a turn of the event loop that
// wall time decides, and `V8_FLAGS` turns both off (`--predictable` leaves them on):
//   - incremental marking (`--no-incremental-marking-task`): `loader-e2e` (a native `import()` of
//     each shared external, the one leg that turned the event loop) counted a different number of
//     instructions in identical runs (1.8% over 2 runs in a container, under a +1.5% flag line)
//     because V8 finished its marking from a task in some runs and not in others: a full
//     Mark-Compact of a 70 MB heap, present or absent by wall time;
//   - scavenges (`--no-minor-gc-task`): on V8 12.4 (Node 22.15) a scavenge also runs from a task,
//     so the same input collected `Scavenge (task)` at a different place in each run (CI run
//     43448228930, intermittent: one more `Scavenge (task)` and one fewer `Scavenge (allocation
//     failure)` than the first run). Node 24 and 26 never ran one in this leg.
// And not V8 at all: on Node 22.15 the ES-module loader reads files through libuv's thread pool,
// and the order the reads finish in moved where collections fell, so `childEnv` pins one thread.
// This file holds the leg to the same collections in every run, with no collection from any task.
// Valgrind is Linux only, so the proxy here is V8's own `--trace-gc` record of what was collected
// and why.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@provino/harness'
import { writeLoaderFixture } from '../loader/fixture.ts'
import { PACKAGE_DIR } from '../suites.ts'
import { childEnv, readWorkload, stripTypesArgs, V8_FLAGS } from './run.ts'
import { WORK_PATHS } from './workloads.ts'

const CHILD = fileURLToPath(new URL('child.ts', import.meta.url))

/** Runs of the leg compared with each other. */
const RUNS = 3

/**
 * Starts incremental marking from a task at 50% of the free space, in every run. From source the
 * leg's own heap rarely has a marking cycle open at the end (the built packages did in 7 of 8 plain
 * runs), so without this the test would pass for any flags. With it, and without
 * `--no-incremental-marking-task`, 11 of 12 runs finished marking "via task" and 3 of 12 collected
 * differently from the rest; with the flag, 12 of 12 were identical and none did. Scavenges need no
 * such help: on Node 22.15 without `--no-minor-gc-task`, 12 of 12 runs had a `(task)` collection
 * and 7 different sequences came out of 12 (5 of 5 test runs failed on the first run's `(task)`).
 */
const SOFT_TRIGGER = '--incremental-marking-soft-trigger=50'

/**
 * The collections in V8's `--trace-gc` output, each as its kind and reason (`Mark-Compact (finalize
 * incremental marking via task)`, `Scavenge (task)`), in order. Heap sizes, times and the process
 * id are left out.
 */
function collections(output: string): string[] {
  const found: string[] = []
  for (const line of output.split('\n')) {
    const kind = /\bms: (\S+(?: \([a-z]+\))?) \d/.exec(line)?.[1]
    if (kind === undefined) continue
    const reason = /(?:\)|\bms) +([a-z][a-z ]*?)(?:;|$)/.exec(line)?.[1] ?? 'no reason'
    found.push(`${kind} (${reason})`)
  }
  return found
}

/** The entries a delayed task started, whatever their kind: any with `task` in its reason. */
function fromTasks(found: readonly string[]): string[] {
  return found.filter((entry) => /\btask\b/.test(entry))
}

test('the trace reader keeps a collection’s kind and reason and drops sizes, times and the pid', () => {
  const trace = [
    '[1:0x1]       66 ms: Scavenge 8.8 (9.2) -> 8.3 (10.2) MB, pooled: 0 MB, 0.42 / 0.00 ms  (average mu = 1.000, current mu = 1.000) allocation failure; ',
    '[1:0x1]      145 ms: Mark-Compact (reduce) 15.1 (20.2) -> 12.2 (21.2) MB, pooled: 0 MB, 5.08 / 0.00 ms  (average mu = 0.964, current mu = 0.964) external memory pressure; GC in old space requested',
    '[1:0x1]      263 ms: Mark-Compact 36.3 (41.0) -> 24.5 (41.2) MB, pooled: 9 MB, 11.83 / 0.00 ms  (+ 9.5 ms in 296 steps since start of marking, biggest step 0.1 ms, walltime since start of marking 90 ms) (average mu = 0.899, current mu = 0.820) finalize incremental marking via task; GC in old space requested',
    '[1:0x1]      156 ms: Scavenge 12.4 (15.3) -> 11.5 (20.0) MB, pooled: 0 MB, 0.71 / 0.00 ms  (average mu = 1.000, current mu = 1.000) task; ',
    '[1:0x1]      650 ms: Scavenge (interleaved) 58.4 (76.4) -> 47.5 (78.6) MB, pooled: 0 MB, 3.79 / 0.04 ms  (average mu = 0.980, current mu = 0.980) task; ',
    'PROVINO_SAMPLE {"ok":true,"ms":9.5,"units":1,"detail":"x"}',
  ].join('\n')
  assert.deepEqual(collections(trace), [
    'Scavenge (allocation failure)',
    'Mark-Compact (reduce) (external memory pressure)',
    'Mark-Compact (finalize incremental marking via task)',
    'Scavenge (task)',
    'Scavenge (interleaved) (task)',
  ])
})

test('a collection from a task is told apart from one that allocation started, whatever its kind', () => {
  assert.deepEqual(fromTasks(['Scavenge (allocation failure)', 'Scavenge (interleaved) (task)']), [
    'Scavenge (interleaved) (task)',
  ])
  assert.deepEqual(
    fromTasks([
      'Scavenge (task)',
      'Mark-Compact (finalize incremental marking via task)',
      'Mark-Compact (reduce) (external memory pressure)',
      'Scavenge (allocation failure)',
    ]),
    ['Scavenge (task)', 'Mark-Compact (finalize incremental marking via task)'],
  )
  assert.deepEqual(
    fromTasks(['Scavenge (allocation failure)', 'Mark-Compact (allocation failure)']),
    [],
  )
})

test('the flags leave no delayed task to start or finish a collection', () => {
  assert.ok(V8_FLAGS.includes('--no-incremental-marking-task'))
  assert.ok(V8_FLAGS.includes('--no-minor-gc-task'))
})

test('this Node accepts every flag, and under them neither GC task is on', () => {
  // A flag V8 doesn't know ends the process ("bad option"), so a rename in a later V8 fails here,
  // on the Node that has it. `--print-flag-values` lists each flag after its implications.
  const printed = execFileSync(process.execPath, [...V8_FLAGS, '--print-flag-values', '-e', '0'], {
    encoding: 'utf8',
    env: childEnv(),
  })
    .split('\n')
    .map((line) => line.trim())
  for (const flag of ['--no-incremental-marking-task', '--no-minor-gc-task']) {
    assert.ok(printed.includes(flag), `${flag} is not in effect on Node ${process.version}`)
  }
})

test('loader-e2e collects the same way in every run, and no collection comes from a task', async () => {
  const work = await mkdtemp(join(tmpdir(), 'provino-determinism-'))
  try {
    const fixture = join(work, WORK_PATHS.loaderFixture)
    await mkdir(fixture, { recursive: true })
    writeLoaderFixture(fixture, { heavy: false })
    const args = [
      ...V8_FLAGS,
      SOFT_TRIGGER,
      '--trace-gc',
      ...stripTypesArgs(),
      '--conditions=provino-source',
      CHILD,
      'loader-e2e',
      work,
    ]
    const runs: string[][] = []
    for (let run = 0; run < RUNS; run++) {
      const result = await runProcess(process.execPath, args, {
        cwd: PACKAGE_DIR,
        env: childEnv(),
        timeoutMs: 5 * 60_000,
        keepStreams: true,
      })
      const stdout = result.streams?.stdout ?? ''
      assert.equal(
        readWorkload(stdout)?.ok,
        true,
        `run ${run + 1} did its work wrong:\n${result.output}`,
      )
      runs.push(collections(stdout))
    }
    const [first = []] = runs
    // A trace with no full collection would pass for any flags: the leg allocates tens of MB.
    assert.ok(
      first.some((entry) => entry.startsWith('Mark-Compact')),
      `no Mark-Compact in the trace: ${first.join(', ')}`,
    )
    for (const [index, run] of runs.entries()) {
      assert.deepEqual(
        fromTasks(run),
        [],
        `run ${index + 1} had a collection started from a delayed task`,
      )
      assert.deepEqual(run, first, `run ${index + 1} collected differently from run 1`)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})
