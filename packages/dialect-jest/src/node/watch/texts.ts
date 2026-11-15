// What a watch run's host says and decides as Jest does: the `--watch` refusal without a
// repository, the no-tests line under `--passWithNoTests`, and which changed paths count.
import { createRequire } from 'node:module'
import type { TextStyle } from '@provino/types'
import type { JestGlobalConfig } from '../types.ts'

type MessageUtil = typeof import('jest-message-util')
let messageUtil: MessageUtil | undefined

/**
 * `runJest.ts` L253-L266: `--watch` (selecting by the changed files) where no root is in a git, hg
 * or sl repository. Jest writes it to stderr and exits 1.
 * @beta
 */
export function jestWatchNoScmText(style: TextStyle): string {
  return `\n${style.bold('--watch')} is not supported without git/hg, please use --watchAll\n`
}

/**
 * `getNoTestFoundPassWithNoTests.ts` L10-L12: a watch run (always `passWithNoTests`) with no test
 * and no `-o` or `--onlyFailures` to explain why.
 * @beta
 */
export const JEST_NO_TESTS_PASS_TEXT: string = 'No tests found, exiting with code 0'

/**
 * jest-core `lib/isValidPath.ts` L11-L19: a change that starts a run is never under the coverage
 * directory and never a snapshot file (jest-snapshot's `isSnapshotPath`: the `.snap` extension).
 * @beta
 */
export function jestWatchPathIsValid(
  globalConfig: Pick<JestGlobalConfig, 'coverageDirectory'>,
  path: string,
): boolean {
  return !path.includes(globalConfig.coverageDirectory) && !path.endsWith('.snap')
}

/**
 * `watch.ts` L336-L346: a run that threw, as watch mode prints it before it goes on
 * (`formatExecError(error, contexts[0].config, { noStackTrace: false })`).
 * @beta
 */
export function jestWatchRunErrorText(
  error: unknown,
  projectConfig: { readonly rootDir: string; readonly testMatch: readonly string[] },
): string {
  messageUtil ??= createRequire(import.meta.url)('jest-message-util') as MessageUtil
  const failure = error instanceof Error ? error : new Error(String(error))
  return messageUtil.formatExecError(
    failure,
    { rootDir: projectConfig.rootDir, testMatch: [...projectConfig.testMatch] },
    { noStackTrace: false },
  )
}
