// The real worker entry, plus a line in `$TMPDIR/provino-pids-<coordinator pid>` for each worker
// that loads it: the pid. A test that starts workers through it can check afterwards that none is
// left running (`takeWorkerPids` in `test/support.ts` reads the file). Load this entry only through
// the forks transport (see `record-pid.ts`).
import main from '@provino/orchestrator/worker/main'
import { recordPid } from './record-pid.ts'

recordPid()

export default main
