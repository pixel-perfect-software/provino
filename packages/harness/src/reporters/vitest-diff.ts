// The recorder's diff reporter for a fixture with `captureDiff` (B25b, T7.6): Vitest's JSON keeps a
// failure's message and stack, not the `diff` its runner prints under it (`processError` in
// `@vitest/utils/error`), so this reporter writes each failed test's errors' `diff`, one JSON line
// per test, to the file `PROVINO_DIFF_OUT` names. Loaded by absolute path
// (`--reporter=<path>`), so it imports Node builtins and harness files that do the same.
import { appendFileSync, writeFileSync } from 'node:fs'
import type { Reporter, TestCase } from 'vitest/node'
import { dupIndexer, titlePath } from '../internal/vitest-reported.ts'

/**
 * The environment variable that names the file the diff reporter writes.
 * @public
 */
export const DIFF_ENV: string = 'PROVINO_DIFF_OUT'

/**
 * One failed test's diffs, as the reporter writes them: its file, title path and index among tests
 * with the same path (counted as the converters count), and each error's `diff` in order, `null`
 * for an error that has none.
 * @public
 */
export interface DiffEntry {
  readonly file: string
  readonly path: readonly string[]
  readonly dupIndex: number
  readonly diffs: readonly (string | null)[]
}

/**
 * Writes every failed test's error diffs.
 * @public
 */
export default class VitestDiffReporter implements Reporter {
  readonly #file: string
  readonly #dupIndexOf = dupIndexer()

  constructor() {
    const file = process.env[DIFF_ENV]
    if (file === undefined || file === '') {
      throw new Error(`the Provino diff reporter needs a file to write: set ${DIFF_ENV}`)
    }
    this.#file = file
    writeFileSync(file, '')
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result()
    if (result.state !== 'failed') return
    const entry: DiffEntry = {
      file: testCase.module.moduleId,
      path: titlePath(testCase),
      dupIndex: this.#dupIndexOf(testCase),
      diffs: (result.errors ?? []).map((error) => {
        const diff: unknown = Reflect.get(error, 'diff')
        return typeof diff === 'string' ? diff : null
      }),
    }
    appendFileSync(this.#file, `${JSON.stringify(entry)}\n`)
  }
}
