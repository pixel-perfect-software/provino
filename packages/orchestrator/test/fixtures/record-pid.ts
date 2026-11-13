// One line in `$TMPDIR/provino-pids-<parent pid>` for the process that calls it: its pid. The
// fixtures that stand in for a worker entry call it, and `takeWorkerPids` (`test/support.ts`) reads
// the file back, so a test can check afterwards that no worker is left running. Only a forked
// worker is a process of its own: call it only from an entry loaded through the forks transport (an
// inline worker would record the test process itself).
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Notes this process's pid for its parent, the coordinator. */
export function recordPid(): void {
  appendFileSync(join(tmpdir(), `provino-pids-${process.ppid}`), `${process.pid}\n`)
}
