// @provino/dialect-jest/global-setup: what the coordinator loads when a Jest global hook fails
// (T9.15). A leaf of its own, so the coordinator never imports the whole `./runtime` entry (about
// 57 ms in source mode, before the first worker) to report a failing hook: this one imports
// `pretty-format` and types only.
import type { GlobalSetupFailure } from '@provino/types'
import { format } from 'pretty-format'

/**
 * Whether an error's `message` can be rewritten: Jest rewrites it in place to say which hook
 * failed and keeps the error (its class and stack). It is writable as its own property, or as the
 * prototype's, which an assignment then shadows.
 */
function hasWritableMessage(error: Error): boolean {
  return (
    Object.getOwnPropertyDescriptor(error, 'message')?.writable === true ||
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error), 'message')?.writable === true
  )
}

/** A value as pretty-format prints it three levels deep, or as text when pretty-format throws. */
function printed(value: unknown): string {
  try {
    return format(value, { maxDepth: 3 })
  } catch {
    return String(value)
  }
}

/**
 * Reports a Jest global hook that threw (`orchestrator.globalSetup.failure`), as `runGlobalHook`
 * does (jest-core 30.5.2): an `Error` whose message can be rewritten is rewritten in place to
 * `Jest: Got error running <hook> - <path>, reason: <message>` and kept, so its class and frames
 * stay (`cli/global-setup-throws`, `-typeerror`). Any other value, or an error whose message is
 * fixed, becomes a new `Error` with the same text and the value printed by pretty-format three
 * levels deep (`-object`, `-string`); its stack is the header alone, so no frame of ours shows.
 * @public
 */
export const globalSetupFailure: GlobalSetupFailure = (thrown, { hook, path }) => {
  const text = (reason: string): string =>
    `Jest: Got error running ${hook} - ${path}, reason: ${reason}`
  if (thrown instanceof Error && hasWritableMessage(thrown)) {
    thrown.message = text(thrown.message)
    return thrown
  }
  const error = new Error(text(printed(thrown)))
  error.stack = `Error: ${error.message}`
  return error
}
