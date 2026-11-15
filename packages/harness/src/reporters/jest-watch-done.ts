// The recorder's watch plugin (B23c Phase 3): one line per finished run, written from Jest's
// `onTestRunComplete` hook. The run log (`jest-watch-log.ts`) is a reporter, and Jest's reporters
// finish before `watch.ts` sets `isRunning` back to false (`runJest` calls `onComplete` after the
// scheduler's reporters), so a key sent once the log grows could still reach Jest mid-run and be
// taken as an interrupt. The hook runs inside `onComplete`, after `isRunning = false` and before
// the usage text (`watch.ts` L306-327), so a step waits for both files. Loaded by absolute path
// from `watchPlugins` (after the fixture's own plugins, so its hook runs last), with Node
// builtins only.
import { appendFileSync } from 'node:fs'

/**
 * The environment variable that names the file when the plugin's config gives no `outputFile`.
 * @public
 */
export const WATCH_DONE_ENV: string = 'PROVINO_WATCH_DONE'

/**
 * What Jest hands a watch plugin's `apply`: only the hook this plugin uses.
 * @public
 */
export interface WatchDoneHooks {
  onTestRunComplete(listener: (results: unknown) => void): void
}

/**
 * Appends `done` and a newline to its file at the end of every run. It has no key and no usage
 * row, so Jest's usage text is what it would be without it.
 * @public
 */
export default class JestWatchDonePlugin {
  readonly #file: string

  /** Jest passes `{ config, stdin, stdout }`; `config` is the plugin's entry options. */
  constructor(options?: { readonly config?: { readonly outputFile?: string } }) {
    const file = options?.config?.outputFile ?? process.env[WATCH_DONE_ENV]
    if (file === undefined || file === '') {
      throw new Error(
        `the Provino watch-done plugin needs a file to write: set ${WATCH_DONE_ENV} or pass { outputFile }`,
      )
    }
    this.#file = file
  }

  apply(hooks: WatchDoneHooks): void {
    hooks.onTestRunComplete(() => appendFileSync(this.#file, 'done\n'))
  }
}
