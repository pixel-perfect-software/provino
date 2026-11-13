/**
 * Error codes `@provino/orchestrator` throws.
 * @public
 */
export type OrchestratorErrorCode =
  | 'ORCH_WORKER_START_TIMEOUT'
  | 'ORCH_WORKER_EXITED'
  | 'ORCH_BAD_ENTRY'
  | 'ORCH_BAD_INIT'
  /** A run option names something the coordinator doesn't do yet (the message names the task that will). */
  | 'ORCH_NOT_IMPLEMENTED'
  /** The test name pattern isn't a valid regular expression. */
  | 'ORCH_BAD_PATTERN'
  /** A pool or run option has a value that makes no sense (a `maxFilesPerWorker` of 0, a negative deadline). */
  | 'ORCH_BAD_OPTION'
  /** `runProjects` was given no project. */
  | 'ORCH_NO_PROJECTS'
  /** A worker sent an event the coordinator can't place (a task id it never announced). */
  | 'ORCH_BAD_EVENT'
  /** A global setup or teardown hook threw, or isn't a function (T9.15); the `cause` is what it threw. */
  | 'ORCH_GLOBAL_SETUP_FAILED'

/**
 * A coordinator error with a stable code. For `ORCH_WORKER_EXITED` the `cause` is the
 * `WorkerExit`.
 * @public
 */
export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode

  constructor(code: OrchestratorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OrchestratorError'
    this.code = code
  }
}
