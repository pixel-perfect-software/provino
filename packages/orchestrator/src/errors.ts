/**
 * Error codes `@provino/orchestrator` throws.
 * @public
 */
export type OrchestratorErrorCode =
  | 'ORCH_WORKER_START_TIMEOUT'
  | 'ORCH_WORKER_EXITED'
  | 'ORCH_BAD_ENTRY'

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
