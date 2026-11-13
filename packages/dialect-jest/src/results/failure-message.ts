// Jest's failure text for a file, through `jest-message-util` 30.5.2: `formatResultsErrors` for the
// tests' failures and `formatExecError` for an error that kept the file from running. The package
// loads on first use (its imports cost about 21 ms), so a run that fails nothing never loads it.
import type { AssertionResult, SerializableError } from './types.ts'

/**
 * What `jest-message-util` reads of a project: `rootDir` and `testMatch`.
 * @public
 */
export interface StackTraceConfig {
  readonly rootDir: string
  readonly testMatch: readonly string[]
}

/**
 * `jest-message-util`'s `StackTraceOptions`.
 * @public
 */
export interface StackTraceOptions {
  readonly noStackTrace: boolean
  readonly noCodeFrame?: boolean
}

type MessageUtil = typeof import('jest-message-util')

let loaded: Promise<MessageUtil> | undefined

function messageUtil(): Promise<MessageUtil> {
  loaded ??= import('jest-message-util')
  return loaded
}

/**
 * The text Jest prints for the failures of one file's tests (`formatResultsErrors`), or `null`
 * when none failed.
 * @public
 */
export async function formatTestFailures(
  assertionResults: readonly AssertionResult[],
  config: StackTraceConfig,
  options: StackTraceOptions,
  testPath: string,
): Promise<string | null> {
  if (assertionResults.every((result) => result.failureMessages.length === 0)) return null
  const util = await messageUtil()
  // The package types `AssertionResult` from `@jest/types`, a structural twin of ours.
  return util.formatResultsErrors(
    assertionResults as unknown as Parameters<MessageUtil['formatResultsErrors']>[0],
    { rootDir: config.rootDir, testMatch: [...config.testMatch] } as Parameters<
      MessageUtil['formatResultsErrors']
    >[1],
    options,
    testPath,
  )
}

/**
 * The text Jest prints for an error that ended a file (`formatExecError`).
 * @public
 */
export async function formatFileError(
  error: SerializableError,
  config: StackTraceConfig,
  options: StackTraceOptions,
  testPath: string,
): Promise<string> {
  const util = await messageUtil()
  return util.formatExecError(
    error,
    { rootDir: config.rootDir, testMatch: [...config.testMatch] } as Parameters<
      MessageUtil['formatExecError']
    >[1],
    options,
    testPath,
  )
}

/**
 * One retried attempt's error as Jest prints it (`formatErrorStack`, what `retryMessages` holds).
 * @public
 */
export async function formatRetryError(
  stack: string,
  config: StackTraceConfig,
  options: StackTraceOptions,
  testPath: string,
): Promise<string> {
  const util = await messageUtil()
  return util.formatErrorStack(
    stack,
    { rootDir: config.rootDir, testMatch: [...config.testMatch] } as Parameters<
      MessageUtil['formatErrorStack']
    >[1],
    options,
    testPath,
  )
}
