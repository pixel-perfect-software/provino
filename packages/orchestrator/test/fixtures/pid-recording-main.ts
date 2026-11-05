// The real worker entry, plus a line in `$TMPDIR/provino-pids-<coordinator pid>` for each worker
// that loads it: the pid. A test that starts workers through it can check afterwards that none is
// left running (`pidsOf` in `test/support.ts` reads the file). Only a forked worker is a process
// of its own, so only forks are recorded: load this entry only through the forks transport (an
// inline worker would record the test process itself).
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import main from '@provino/orchestrator/worker/main'

appendFileSync(join(tmpdir(), `provino-pids-${process.ppid}`), `${process.pid}\n`)

export default main
