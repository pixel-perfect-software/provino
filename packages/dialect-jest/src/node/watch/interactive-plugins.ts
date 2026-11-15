// The usage rows of jest-core's `u` and `i` plugins (`plugins/UpdateSnapshots.ts` L33-L48,
// `UpdateSnapshotsInteractive.ts` L22-L48 and L91-L100, `FailedTestsInteractive.ts` L20-L36 and
// L74-L104), so Watch Usage lists what Jest lists after a run. What the keys do (update the
// snapshots, the interactive modes) is B23c Phase 9's: until then a key says so and runs nothing.
import type { JestWatchTerminal } from './context.ts'
import type { JestWatchResults } from './hooks.ts'
import type { JestWatchPlugin } from './plugin.ts'

/** Where the keys' behaviour is built. */
const OWNER = 'B23c Phase 9'

function notBuilt(terminal: JestWatchTerminal, what: string): Promise<boolean> {
  terminal.out.write(`\nProvino: watch mode's ${what} is not supported yet (${OWNER}).\n`)
  return Promise.resolve(false)
}

/** `getFailedTestAssertions` (`FailedTestsInteractive.ts` L74-L104): the failed tests, unless a snapshot didn't match. */
function failedTests(results: JestWatchResults): number {
  if (results.numFailedTests === 0 || results.snapshot.unmatched) return 0
  let count = 0
  for (const file of results.testResults) {
    for (const test of file.testResults) if (test.status === 'failed') count += 1
  }
  return count
}

/** `getFailedSnapshotTestAssertions` (`UpdateSnapshotsInteractive.ts` L22-L44). */
function failedSnapshotTests(results: JestWatchResults): number {
  if (results.numFailedTests === 0) return 0
  let count = 0
  for (const file of results.testResults) {
    if (!file.snapshot?.unmatched) continue
    for (const test of file.testResults) if (test.status === 'failed') count += 1
  }
  return count
}

/**
 * `FailedTestsInteractivePlugin`'s row: `i`, `run failing tests interactively`, after a run with a
 * failed test. Not internal (Jest doesn't mark it), so it sorts after Jest's own rows.
 * @beta
 */
export function jestFailedTestsInteractivePlugin(terminal: JestWatchTerminal): JestWatchPlugin {
  let failed = 0
  return {
    apply: (hooks) =>
      hooks.onTestRunComplete((results) => {
        failed = failedTests(results)
      }),
    getUsageInfo: () =>
      failed > 0 ? { key: 'i', prompt: 'run failing tests interactively' } : null,
    run: () => notBuilt(terminal, 'interactive failed-tests mode (`i`)'),
  }
}

/**
 * `UpdateSnapshotsPlugin`'s row: `u`, `update failing snapshots`, after a run with a snapshot failure.
 * @beta
 */
export function jestUpdateSnapshotsPlugin(terminal: JestWatchTerminal): JestWatchPlugin {
  let failure = false
  return {
    isInternal: true,
    apply: (hooks) =>
      hooks.onTestRunComplete((results) => {
        failure = results.snapshot.failure
      }),
    getUsageInfo: () => (failure ? { key: 'u', prompt: 'update failing snapshots' } : null),
    run: () => notBuilt(terminal, 'snapshot update (`u`)'),
  }
}

/**
 * `UpdateSnapshotInteractivePlugin`'s row: `i`, `update failing snapshots interactively`.
 * @beta
 */
export function jestUpdateSnapshotsInteractivePlugin(terminal: JestWatchTerminal): JestWatchPlugin {
  let failed = 0
  return {
    isInternal: true,
    apply: (hooks) =>
      hooks.onTestRunComplete((results) => {
        failed = failedSnapshotTests(results)
      }),
    getUsageInfo: () =>
      failed > 0 ? { key: 'i', prompt: 'update failing snapshots interactively' } : null,
    run: () => notBuilt(terminal, 'interactive snapshot mode (`i`)'),
  }
}
