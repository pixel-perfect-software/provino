// "No child survives" (T9.5, T9.10): what is left of a process group after the process that led it
// is gone. A copy of `@provino/orchestrator`'s `test/sweep.ts` (its `sweep.test.ts` tests it): the
// two test projects can't share a file, because `pnpm boundaries` allows a package only another's
// public entry, and the type-test project refuses a relative import across projects (TS2878). Two
// sweeps, because the first needs `ps` and this sandbox, like some CI images, may not allow it:
//
// - `psSweep`: `ps -axo pid=,pgid=`, the processes whose group is the one asked about. The same
//   command runs on macOS and on Linux. `undefined` when `ps` cannot run.
// - `groupAlive`: `kill(-pgid, 0)`, which fails with ESRCH exactly when no process is left in the
//   group. It needs no `ps`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * The pids in the output of `ps -axo pid=,pgid=` (one `pid pgid` pair per line, padded the way
 * macOS and Linux each pad it) that belong to process group `pgid`.
 */
export function pidsInGroup(psOutput: string, pgid: number): number[] {
  const found: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match !== null && Number(match[2]) === pgid) found.push(Number(match[1]))
  }
  return found
}

/** The pids `ps` lists in process group `pgid`; `undefined` when `ps` isn't available here. */
export function psSweep(pgid: number): readonly number[] | undefined {
  const ran = spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
  if (ran.error !== undefined || ran.status !== 0 || ran.stdout.trim() === '') return undefined
  return pidsInGroup(ran.stdout, pgid)
}

/** Whether any process is left in process group `pgid`. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // ESRCH: no such process group. EPERM: there is one, owned by someone else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** What a sweep of the group found. */
export interface Sweep {
  /** The pids `ps` listed, or `undefined` when `ps` could not run (then only the probe ran). */
  readonly ps: readonly number[] | undefined
  /** Whether the group still has a process, by `kill(-pgid, 0)`. */
  readonly alive: boolean
}

/**
 * Sweeps the group, after letting a just-killed process finish exiting. Where `ps` cannot run the
 * result says so (`ps: undefined`), and a CI run (`CI` set) refuses that: the check is meant to
 * run there, where it can.
 */
export async function sweep(pgid: number, settleMs = 500): Promise<Sweep> {
  const deadline = Date.now() + settleMs
  let result: Sweep
  do {
    result = { ps: psSweep(pgid), alive: groupAlive(pgid) }
    if (!result.alive && (result.ps === undefined || result.ps.length === 0)) break
    await sleep(25)
  } while (Date.now() < deadline)
  if (result.ps === undefined && process.env.CI !== undefined && process.env.CI !== '') {
    throw new Error('`ps` cannot run here, and in CI the sweep must: the check would be skipped')
  }
  return result
}

/**
 * Asserts nothing of the group is left: not by `kill(-pgid, 0)`, and not by `ps` where it runs
 * (elsewhere it warns, naming `label`, that only the probe swept the group).
 */
export async function assertGroupEmpty(pgid: number, label: string): Promise<void> {
  const swept = await sweep(pgid)
  assert.equal(swept.alive, false, 'kill(-pgid, 0): nothing is left in the process group')
  if (swept.ps === undefined) {
    console.warn(`${label}: \`ps\` cannot run here; only the kill(-pgid, 0) probe swept the group`)
  } else {
    assert.deepEqual(swept.ps, [], 'ps: no process of the group is left')
  }
}

/** Kills everything left in the group (a failed check must not leave processes behind). */
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // Nothing left in it.
  }
}
