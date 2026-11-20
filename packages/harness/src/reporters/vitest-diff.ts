// The recorder's diff reporter for a fixture with `captureDiff` (B25b, T7.6): Vitest's JSON keeps a
// failure's message and stack, not the `diff` its runner prints under it (`processError` in
// `@vitest/utils/error`), so this reporter writes each failed test's errors' `diff`, one JSON line
// per test, to the file `PROVINO_DIFF_OUT` names. Loaded by absolute path
// (`--reporter=<path>`), so it imports Node builtins and harness files that do the same.
import { appendFileSync, writeFileSync } from 'node:fs'
import type { Reporter } from 'vitest/node'
import { pathText } from '../internal/keys.ts'

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

// The parts of Vitest's reported tasks the reporter reads.
interface ReportedModule {
  readonly type: 'module'
  readonly id: string
  readonly moduleId: string
  readonly children: { allTests(): Iterable<ReportedTest> }
}
interface ReportedSuite {
  readonly type: 'suite'
  readonly name: string
  readonly parent: ReportedSuite | ReportedModule
}
interface ReportedTest {
  readonly type: 'test'
  readonly id: string
  readonly name: string
  readonly module: ReportedModule
  readonly parent: ReportedSuite | ReportedModule
  result(): { readonly state: string; readonly errors?: readonly object[] | undefined }
}

/** A test's title path: its suites' names from the outside in, then its own. */
function titlePath(test: ReportedTest): string[] {
  const path = [test.name]
  for (let parent = test.parent; parent.type === 'suite'; parent = parent.parent) {
    path.unshift(parent.name)
  }
  return path
}

/**
 * Writes every failed test's error diffs.
 * @public
 */
export default class VitestDiffReporter implements Reporter {
  readonly #file: string
  readonly #dupIndex = new Map<string, number>()
  readonly #indexedModules = new Set<string>()

  constructor() {
    const file = process.env[DIFF_ENV]
    if (file === undefined || file === '') {
      throw new Error(`the Provino diff reporter needs a file to write: set ${DIFF_ENV}`)
    }
    this.#file = file
    writeFileSync(file, '')
  }

  onTestCaseResult(testCase: ReportedTest): void {
    const result = testCase.result()
    if (result.state !== 'failed') return
    const entry: DiffEntry = {
      file: testCase.module.moduleId,
      path: titlePath(testCase),
      dupIndex: this.#indexOf(testCase),
      diffs: (result.errors ?? []).map((error) => {
        const diff: unknown = Reflect.get(error, 'diff')
        return typeof diff === 'string' ? diff : null
      }),
    }
    appendFileSync(this.#file, `${JSON.stringify(entry)}\n`)
  }

  #indexOf(test: ReportedTest): number {
    const { module } = test
    if (!this.#indexedModules.has(module.id)) {
      this.#indexedModules.add(module.id)
      const seen = new Map<string, number>()
      for (const each of module.children.allTests()) {
        // The converters' own key, so the reporter and the converter count alike by construction.
        const key = pathText(titlePath(each))
        const dupIndex = seen.get(key) ?? 0
        seen.set(key, dupIndex + 1)
        this.#dupIndex.set(each.id, dupIndex)
      }
    }
    return this.#dupIndex.get(test.id) ?? 0
  }
}
