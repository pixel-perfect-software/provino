// The save loop of a `bench:watch` session, apart from the processes: it talks to a `SessionDriver`
// (the real one is in `run.ts`, a fake is the tests'). Two parts. Arming: the first run says the
// runner started, not that its file watcher is watching, so unmeasured warm-up saves are made,
// each waiting a growing while for a run, until one starts (bounded). Then the measured saves, each
// after the run the last one caused has ended and `settleMs` has passed (Jest drops a change that
// lands as a run finishes, `watch.ts` L284-287).
import type { ProbeEvent } from './report.ts'

/** An event the driver found, and the index of the event after it (where the next search starts). */
export interface Found {
  readonly event: ProbeEvent
  readonly next: number
}

/** What the loop needs from the session. */
export interface SessionDriver {
  /** Writes the leaf's text for save number `save` as one atomic replace. `stamp` is called just before it takes effect. */
  readonly write: (save: number, stamp: (at: number) => void) => Promise<void>
  /** The first event of `kind` at index `from` or later, at or after time `atLeast`, within `ms`: `undefined` on a timeout; a rejection when the runner is gone. */
  readonly waitFor: (
    kind: ProbeEvent['kind'],
    from: number,
    atLeast: number,
    ms: number,
    what: string,
  ) => Promise<Found | undefined>
  readonly settle: (ms: number) => Promise<void>
  /** How many events have arrived. */
  readonly count: () => number
}

/** How a session is measured. */
export interface SaveOptions {
  readonly saves: number
  readonly settleMs: number
  /** How long the first run and each measured save's run may take. */
  readonly timeoutMs: number
  /** The most the arming step spends, in all (default 10 s). */
  readonly armBudgetMs?: number
  /** How long the first warm-up save waits for a run; each retry waits twice as long, up to 2 s (default 250). */
  readonly armFirstWaitMs?: number
}

export const DEFAULT_ARM_BUDGET_MS = 10_000
export const DEFAULT_ARM_FIRST_WAIT_MS = 250
const ARM_MAX_WAIT_MS = 2_000

/**
 * Waits for the first run, arms the watcher, then makes `saves` measured saves and returns each
 * one's latency: the first file start of its run, less the stamp taken just before the write took
 * effect. Save numbers count from 2 (the project starts with save 1 written).
 */
export async function measureSaves(driver: SessionDriver, options: SaveOptions): Promise<number[]> {
  const { saves, settleMs, timeoutMs } = options
  const first = await driver.waitFor('done', 0, 0, timeoutMs, 'the first run to end')
  if (first === undefined) throw new Error('timed out waiting for the first run to end')
  let seen = first.next
  let save = 2

  // Arming: warm-up saves, retried with backoff until one causes a run. Not measured.
  const budget = options.armBudgetMs ?? DEFAULT_ARM_BUDGET_MS
  let wait = options.armFirstWaitMs ?? DEFAULT_ARM_FIRST_WAIT_MS
  let spent = 0
  for (;;) {
    await driver.settle(settleMs)
    let savedAt = 0
    await driver.write(save++, (at) => {
      savedAt = at
    })
    const started = await driver.waitFor(
      'start',
      seen,
      savedAt,
      wait,
      'the arming save to start a run',
    )
    spent += wait
    if (started !== undefined) {
      const ended = await driver.waitFor(
        'done',
        started.next - 1,
        started.event.at,
        timeoutMs,
        'the arming run to end',
      )
      if (ended === undefined) throw new Error('timed out waiting for the arming run to end')
      await driver.settle(settleMs)
      // Whatever a retried warm-up save started late is over or ignored from here on.
      seen = driver.count()
      break
    }
    if (spent >= budget) {
      throw new Error(
        `the watcher did not start a run for ${save - 2} warm-up saves in ${budget} ms`,
      )
    }
    wait = Math.min(wait * 2, ARM_MAX_WAIT_MS)
  }

  const latencies: number[] = []
  for (let measured = 1; measured <= saves; measured++) {
    await driver.settle(settleMs)
    let savedAt = 0
    await driver.write(save++, (at) => {
      savedAt = at
    })
    const what = `save ${measured}`
    const started = await driver.waitFor(
      'start',
      seen,
      savedAt,
      timeoutMs,
      `${what}'s run to start`,
    )
    if (started === undefined) throw new Error(`timed out waiting for ${what}'s run to start`)
    const ended = await driver.waitFor(
      'done',
      started.next - 1,
      started.event.at,
      timeoutMs,
      `${what}'s run to end`,
    )
    if (ended === undefined) throw new Error(`timed out waiting for ${what}'s run to end`)
    latencies.push(started.event.at - savedAt)
    seen = ended.next
  }
  return latencies
}
