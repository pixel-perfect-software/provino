// The probe reporter `bench:watch` hands both runners (`--reporters`). It runs in the runner's own
// process and writes one line per event to fd 3, which the bench holds the other end of:
// `<kind> <epoch ms>`, where the time is `performance.timeOrigin + performance.now()`, the same
// clock the bench stamps a save with. `start` is the first file of a run (Jest 30 calls
// `onTestFileStart`; `onTestStart` is its older name, so whichever comes first counts and the
// other is ignored), `done` is the end of the run.
import { writeSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

/** The descriptor the bench passes as the child's fourth stdio entry. */
export const PROBE_FD = 3

function emit(kind: string): void {
  writeSync(PROBE_FD, `${kind} ${performance.timeOrigin + performance.now()}\n`)
}

/** A Jest reporter: the hooks both runners call, nothing else. */
export class ProbeReporter {
  #waiting = false

  onRunStart(): void {
    this.#waiting = true
    emit('run')
  }

  onTestFileStart(): void {
    this.#first()
  }

  onTestStart(): void {
    this.#first()
  }

  onRunComplete(): void {
    this.#waiting = false
    emit('done')
  }

  #first(): void {
    if (!this.#waiting) return
    this.#waiting = false
    emit('start')
  }
}

export default ProbeReporter
