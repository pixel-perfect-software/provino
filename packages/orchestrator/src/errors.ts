import type { WorkerExit } from '@provino/types'

/**
 * Error codes `@provino/orchestrator` throws.
 * @public
 */
export type OrchestratorErrorCode =
  | 'ORCH_WORKER_START_TIMEOUT'
  | 'ORCH_WORKER_EXITED'
  | 'ORCH_BAD_ENTRY'
  | 'ORCH_BAD_INIT'
  /** A run option names something the coordinator doesn't do yet (the message says what). */
  | 'ORCH_NOT_IMPLEMENTED'
  /** The test name pattern isn't a valid regular expression. */
  | 'ORCH_BAD_PATTERN'
  /** A pool or run option has a value that makes no sense (a `maxFilesPerWorker` of 0, a negative deadline). */
  | 'ORCH_BAD_OPTION'
  /** `runProjects` was given no project. */
  | 'ORCH_NO_PROJECTS'
  /** A worker sent an event the coordinator can't place (a task id it never announced). */
  | 'ORCH_BAD_EVENT'
  /** `provino.timings.json` can't be read, isn't JSON, or isn't a version 1 timings file (T9.6). */
  | 'ORCH_BAD_TIMINGS'
  /** A global setup or teardown hook threw, or isn't a function (T9.15); the `cause` is what it threw. */
  | 'ORCH_GLOBAL_SETUP_FAILED'

/**
 * A coordinator error with a stable code. For `ORCH_WORKER_EXITED` and `ORCH_WORKER_START_TIMEOUT`,
 * `exit` is how the worker ended. It is a field of its own and not the `cause`: a `WorkerExit` is
 * plain data, no error, and a reporter prints a `cause` as an error.
 * @public
 */
export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode
  readonly exit: WorkerExit | undefined

  constructor(
    code: OrchestratorErrorCode,
    message: string,
    options?: ErrorOptions & { readonly exit?: WorkerExit | undefined },
  ) {
    super(message, options)
    this.name = 'OrchestratorError'
    this.code = code
    this.exit = options?.exit
  }
}
