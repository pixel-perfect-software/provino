// A worker that leaves a grandchild behind holding its stderr pipe open, as a test that starts a
// daemon does, and notes the grandchild's pid in `$TMPDIR/provino-grandchild-<coordinator pid>`.
// The worker itself stops cleanly: its exit must not wait for a pipe it no longer holds. Load it only
// through the forks transport, and kill the grandchild afterwards.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker } from '@provino/orchestrator/worker'
import type { WorkerMain } from '@provino/types'

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  detached: true,
})
grandchild.unref()
writeFileSync(join(tmpdir(), `provino-grandchild-${process.ppid}`), `${grandchild.pid}`)

const main: WorkerMain = (port) => startWorker(port, { runFile: async () => undefined })
export default main
