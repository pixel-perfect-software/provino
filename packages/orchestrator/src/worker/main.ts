// The worker entry (U1): what a transport loads and calls with the worker's port. Its default
// export is a `WorkerMain` running the real runtime behind `startWorker`. Everything it needs
// comes from the `WorkerInit` the coordinator sends: the policy, and the environment and globals
// by ref.
import { currentTest, serializeError } from '@provino/core'
import type { TaskId, WorkerMain } from '@provino/types'
import { createRuntimeRunner } from './runtime/runner.ts'
import { startWorker } from './start.ts'

/**
 * The task running now, for console attribution: the test (also during its each-hooks), else the
 * suite or file whose `beforeAll`/`afterAll` is running, else `null`.
 */
function currentTaskId(): TaskId | null {
  const frame = currentTest.get()
  if (frame === undefined) return null
  return frame.test?.id ?? frame.hook?.ownerId ?? frame.fileId
}

/**
 * The real worker: `startWorker` with the runtime runner, core's `serializeError` (so errors keep
 * `code` and `matcherResult` across the link) and console attribution from core's current test.
 * @public
 */
const main: WorkerMain = (port) =>
  startWorker(port, createRuntimeRunner(), {
    serializeError,
    console: { currentTaskId },
  })

export default main
