/**
 * Error codes the worker runtime throws. They share the `ORCH_` prefix with the coordinator's
 * `OrchestratorErrorCode`, and cross to the coordinator as the `code` of a serialized error.
 * @public
 */
export type WorkerErrorCode =
  | 'ORCH_BAD_CONFIG'
  | 'ORCH_BAD_ENVIRONMENT'
  | 'ORCH_BAD_GLOBALS'
  | 'ORCH_NOT_STARTED'
  | 'ORCH_NO_ACTIVE_FILE'

/**
 * A worker-side error with a stable code: the project config, the environment or the globals
 * factory is malformed, a file was run before `start` finished, or something asked for the running
 * file when none was. The worker node cannot import the coordinator's `OrchestratorError` (the two
 * nodes never meet), so the runtime has its own class under the same code namespace.
 * @public
 */
export class WorkerError extends Error {
  readonly code: WorkerErrorCode

  constructor(code: WorkerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkerError'
    this.code = code
  }
}
