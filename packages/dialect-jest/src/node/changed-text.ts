// What Jest 30.5.2 prints for the changed-file flags (B23c, T9.16): the no-tests texts of
// `-o`/`--changedSince`/`--lastCommit` and `--onlyFailures`, the line for a project with no
// repository, and a failing SCM command. Each cites its file and lines in jest-core.
import { createRequire } from 'node:module'
import type { TextStyle } from '@provino/types'
import type { JestGlobalConfig } from './types.ts'

type MessageUtil = typeof import('jest-message-util')
let messageUtil: MessageUtil | undefined

/**
 * `runJest.ts` L113-L119 (`getTestPaths`): what Jest logs for a project with no test under `-o`
 * when no root is in a git, hg or sl repository.
 * @public
 */
export const JEST_NO_SCM_TEXT: string =
  'Jest can only find uncommitted changed files in a git or hg ' +
  'repository. If you make your project a git or hg ' +
  'repository (`git init` or `hg init`), Jest will be able ' +
  'to only run tests related to files changed since the last ' +
  'commit.'

/**
 * `getNoTestsFoundMessage.ts` L16-L34, for the flags this file is about: under `--onlyFailures`
 * `getNoTestFoundFailed.ts`, under `-o` (and the flags that set it) `getNoTestFoundRelatedToChangedFiles.ts`,
 * each with its hint line only on an interactive terminal (jest-util `isInteractive`). `exitWith0`
 * is `passWithNoTests || lastCommit || onlyChanged`. `undefined` when neither flag is on: the
 * other texts are not this file's.
 * @public
 */
export function jestChangedNoTestsMessage(
  globalConfig: Pick<
    JestGlobalConfig,
    'passWithNoTests' | 'lastCommit' | 'onlyChanged' | 'onlyFailures' | 'changedSince' | 'watch'
  >,
  options: { readonly interactive: boolean; readonly style: TextStyle },
): { readonly exitWith0: boolean; readonly message: string } | undefined {
  const { style, interactive } = options
  const exitWith0 =
    globalConfig.passWithNoTests || globalConfig.lastCommit || globalConfig.onlyChanged
  if (globalConfig.onlyFailures) {
    let message = style.bold('No failed test found.')
    if (interactive) {
      message += style.dim(
        `\n${
          globalConfig.watch
            ? 'Press `f` to quit "only failed tests" mode.'
            : 'Run Jest without `--onlyFailures` or with `--all` to run all tests.'
        }`,
      )
    }
    return { exitWith0, message }
  }
  if (globalConfig.onlyChanged) {
    const ref =
      globalConfig.changedSince !== undefined && globalConfig.changedSince !== ''
        ? `"${globalConfig.changedSince}"`
        : 'last commit'
    let message = style.bold(`No tests found related to files changed since ${ref}.`)
    if (interactive) {
      message += style.dim(
        `\n${
          globalConfig.watch
            ? 'Press `a` to run all tests, or run Jest with `--watchAll`.'
            : 'Run Jest without `-o` or with `--all` to run all tests.'
        }`,
      )
    }
    return { exitWith0, message }
  }
  return undefined
}

/**
 * `getChangedFilesPromise.ts` L28-L37: a changed-files lookup that failed, as Jest prints it before
 * it exits 1: `formatExecError` without the stack, the lines that hold `Command failed:` left out,
 * after two blank lines, in red. The caller writes it to stderr (`console.error`).
 * @public
 */
export function jestChangedFilesErrorText(
  error: unknown,
  projectConfig: { readonly rootDir: string; readonly testMatch: readonly string[] },
  style: Pick<TextStyle, 'red'>,
): string {
  messageUtil ??= createRequire(import.meta.url)('jest-message-util') as MessageUtil
  const failure = error instanceof Error ? error : new Error(String(error))
  const message = messageUtil
    .formatExecError(
      failure,
      { rootDir: projectConfig.rootDir, testMatch: [...projectConfig.testMatch] },
      { noStackTrace: true },
    )
    .split('\n')
    .filter((line) => !line.includes('Command failed:'))
    .join('\n')
  return style.red(`\n\n${message}`)
}
