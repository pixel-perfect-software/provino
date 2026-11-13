// What makes an instruction count repeatable: the same input does the same work in every run. The
// one leg that turned the event loop, `loader-e2e` (a native `import()` of each shared external),
// counted a different number of instructions in identical runs (1.8% over 2 runs in a container,
// under a +1.5% flag line) because V8 finished its incremental marking from a delayed foreground
// task in some runs and not in others: a full Mark-Compact of a 70 MB heap, present or absent by
// wall time. `--predictable` doesn't turn that task off; `V8_FLAGS` does, and this file holds the
// leg to the same collections in every run. Valgrind is Linux only, so the proxy here is V8's own
// `--trace-gc` record of what was collected and why.
import assert from 'node:assert/strict'
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
 * differently from the rest; with the flag, 12 of 12 were identical and none did.
 */
const SOFT_TRIGGER = '--incremental-marking-soft-trigger=50'

/**
 * The collections in V8's `--trace-gc` output, each as its kind and reason (`Mark-Compact (finalize
 * incremental marking via task)`), in order. Heap sizes, times and the process id are left out.
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

test('the trace reader keeps a collection’s kind and reason and drops sizes, times and the pid', () => {
  const trace = [
    '[1:0x1]       66 ms: Scavenge 8.8 (9.2) -> 8.3 (10.2) MB, pooled: 0 MB, 0.42 / 0.00 ms  (average mu = 1.000, current mu = 1.000) allocation failure; ',
    '[1:0x1]      145 ms: Mark-Compact (reduce) 15.1 (20.2) -> 12.2 (21.2) MB, pooled: 0 MB, 5.08 / 0.00 ms  (average mu = 0.964, current mu = 0.964) external memory pressure; GC in old space requested',
    '[1:0x1]      263 ms: Mark-Compact 36.3 (41.0) -> 24.5 (41.2) MB, pooled: 9 MB, 11.83 / 0.00 ms  (+ 9.5 ms in 296 steps since start of marking, biggest step 0.1 ms, walltime since start of marking 90 ms) (average mu = 0.899, current mu = 0.820) finalize incremental marking via task; GC in old space requested',
    'PROVINO_SAMPLE {"ok":true,"ms":9.5,"units":1,"detail":"x"}',
  ].join('\n')
  assert.deepEqual(collections(trace), [
    'Scavenge (allocation failure)',
    'Mark-Compact (reduce) (external memory pressure)',
    'Mark-Compact (finalize incremental marking via task)',
  ])
})

test('the flags leave no delayed task to start or finish a collection', () => {
  assert.ok(V8_FLAGS.includes('--no-incremental-marking-task'))
})

test('loader-e2e collects the same way in every run, and never finishes marking from a task', async () => {
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
        run.filter((entry) => entry.includes('via task')),
        [],
        `run ${index + 1} finished incremental marking from a delayed task`,
      )
      assert.deepEqual(run, first, `run ${index + 1} collected differently from run 1`)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
})
