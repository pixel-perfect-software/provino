// What Jest prints under a console entry: `getConsoleOutput`'s `formatStackTrace(origin, config,
// options)` (jest-console 30.5.2 `getConsoleOutput.ts` L34-L58). A `warn` or `error` entry gets a
// code frame and, unless `--noStackTrace`, its frame; every other kind gets its top frame only.
// `jest-message-util` loads the first time an entry is rendered, through a synchronous
// `createRequire`, since a reporter's text is built without waiting.
import { createRequire } from 'node:module'
import type { StackTraceConfig } from '../../results/failure-message.ts'

type MessageUtil = typeof import('jest-message-util')

let loaded: MessageUtil | undefined

/**
 * The text under a console entry of kind `level` whose call site is `origin`.
 * @public
 */
export function jestConsoleTrace(
  origin: string,
  level: string | null,
  config: StackTraceConfig,
  globalConfig: { readonly noStackTrace?: boolean },
): string {
  loaded ??= createRequire(import.meta.url)('jest-message-util') as MessageUtil
  const loud = level === 'warn' || level === 'error'
  return loaded.formatStackTrace(origin, config as Parameters<MessageUtil['formatStackTrace']>[1], {
    noCodeFrame: !loud,
    noStackTrace: loud ? (globalConfig.noStackTrace ?? false) : true,
  })
}
