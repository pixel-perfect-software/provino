import { ConfigError } from '@provino/config'
import { OrchestratorError } from '@provino/orchestrator'
import { UsageError } from './usage-error.ts'

/** How many `cause`s deep an error's text goes. */
const MAX_CAUSES = 3

/** An error's message, then what caused it and, for a config error, each problem found. */
function describeError(error: Error): string {
  const lines = [error.message]
  if (error instanceof ConfigError) {
    for (const issue of error.issues) {
      lines.push(`  - ${issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`}`)
    }
  }
  let cause: unknown = error.cause
  for (let depth = 0; depth < MAX_CAUSES && cause instanceof Error; depth++) {
    lines.push(`  caused by: ${cause.message}`)
    cause = cause.cause
  }
  return lines.join('\n')
}

/**
 * What to tell the user about an error that means their input is wrong (a usage error, a config
 * error, a test name pattern that isn't a regular expression), or `undefined` for any other error:
 * those are bugs, and are rethrown.
 * @internal
 */
export function usageMessage(error: unknown): string | undefined {
  if (error instanceof UsageError || error instanceof ConfigError) {
    return `Provino: ${describeError(error)}`
  }
  // The pattern error's message already carries the regular expression's own complaint.
  if (error instanceof OrchestratorError && error.code === 'ORCH_BAD_PATTERN') {
    return `Provino: ${error.message}`
  }
  return undefined
}
