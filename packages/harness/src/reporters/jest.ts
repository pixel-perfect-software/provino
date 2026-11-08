// Jest's sidecar reporter (Track 12 T12.4). Loaded by absolute path (`--reporters=<path>`), so it
// imports Node builtins and harness files that do the same, never a package: see
// `internal/sidecar-format.ts`.
import type { Test, TestResult } from '@jest/test-result'
import {
  openSidecar,
  type SidecarEntry,
  type SidecarOptions,
  streamOfLevel,
} from '../internal/sidecar-format.ts'

/**
 * Writes the console output Jest buffered for each test file to the sidecar file, one entry per
 * console call, with its level and its stream. Jest attributes console output to a file only, so
 * no entry names a test. Jest drops `testResult.console` once the reporters have seen it, so a
 * reporter is the only place it can be read. Nothing is written under `--silent` (Jest buffers
 * nothing then), so a run needs `--silent=false`.
 * @public
 */
export default class JestSidecarReporter {
  readonly #write: (entry: SidecarEntry) => void

  /** Jest passes its global config, then the reporter's options. */
  constructor(_globalConfig?: unknown, options?: SidecarOptions) {
    this.#write = openSidecar(options)
  }

  onTestResult(_test: Test, result: TestResult): void {
    for (const entry of result.console ?? []) {
      this.#write({
        file: result.testFilePath,
        stream: streamOfLevel(entry.type),
        level: entry.type,
        text: String(entry.message),
      })
    }
  }

  /** Jest asks every reporter for a failure that should fail the run; writing never fails one. */
  getLastError(): undefined {
    return undefined
  }
}
