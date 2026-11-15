// jest-core's `u` and `i` plugins (Jest 30.5.2): `plugins/UpdateSnapshots.ts` L17-L51,
// `UpdateSnapshotsInteractive.ts` L17-L100 and `FailedTestsInteractive.ts` L18-L100. Two plugins
// take `i`: the snapshot one follows the failed-tests one in Jest's order, so when both have a row
// the snapshot one wins (`watchPluginsHelpers.ts` L12-L29).
import type { JestWatchTerminal } from './context.ts'
import {
  type JestAssertionLocation,
  JestFailedTestsInteractiveMode,
} from './failed-tests-interactive-mode.ts'
import type { JestWatchResults } from './hooks.ts'
import { type JestWatchPlugin, nameJestWatchPlugin } from './plugin.ts'
import { JestSnapshotInteractiveMode } from './snapshot-interactive-mode.ts'

/**
 * `getFailedTestAssertions` (`FailedTestsInteractive.ts` L71-L99): every failed test, unless no
 * test failed or a snapshot didn't match.
 */
function failedTestAssertions(results: JestWatchResults): JestAssertionLocation[] {
  const failed: JestAssertionLocation[] = []
  if (results.numFailedTests === 0 || !results.testResults || results.snapshot.unmatched) {
    return failed
  }
  for (const file of results.testResults) {
    for (const test of file.testResults) {
      if (test.status === 'failed')
        failed.push({ fullName: test.fullName, path: file.testFilePath })
    }
  }
  return failed
}

/** `getFailedSnapshotTestAssertions` (`UpdateSnapshotsInteractive.ts` L23-L45). */
function failedSnapshotTestAssertions(results: JestWatchResults): JestAssertionLocation[] {
  const failed: JestAssertionLocation[] = []
  if (results.numFailedTests === 0 || !results.testResults) return failed
  for (const file of results.testResults) {
    if (!file.snapshot?.unmatched) continue
    for (const test of file.testResults) {
      if (test.status === 'failed')
        failed.push({ fullName: test.fullName, path: file.testFilePath })
    }
  }
  return failed
}

/**
 * `FailedTestsInteractivePlugin`: `i`, `run failing tests interactively`, after a run with a
 * failed test and no unmatched snapshot. Not internal (Jest doesn't mark it), so its row sorts
 * after Jest's own.
 * @beta
 */
export function jestFailedTestsInteractivePlugin(terminal: JestWatchTerminal): JestWatchPlugin {
  let assertions: JestAssertionLocation[] | undefined
  const manager = new JestFailedTestsInteractiveMode(terminal)
  return nameJestWatchPlugin('FailedTestsInteractivePlugin', {
    apply: (hooks) =>
      hooks.onTestRunComplete((results) => {
        assertions = failedTestAssertions(results)
        if (manager.isActive()) manager.updateWithResults(results)
      }),
    getUsageInfo: () =>
      assertions?.length ? { key: 'i', prompt: 'run failing tests interactively' } : null,
    onKey: (key) => {
      if (manager.isActive()) manager.put(key)
    },
    run: (_globalConfig, updateConfigAndRun) =>
      new Promise<void>((resolve) => {
        if (assertions === undefined || assertions.length === 0) {
          resolve()
          return
        }
        manager.run(assertions, (failure) => {
          updateConfigAndRun({
            mode: 'watch',
            testNamePattern: failure ? `^${failure.fullName}$` : '',
            testPathPatterns: failure ? [failure.path] : [],
          })
          if (!manager.isActive()) resolve()
        })
      }),
  })
}

/**
 * `UpdateSnapshotsPlugin`: `u`, `update failing snapshots`, after a run with a snapshot failure.
 * The run it starts has `updateSnapshot: 'all'`, which the driver resets after it.
 * @beta
 */
export function jestUpdateSnapshotsPlugin(): JestWatchPlugin {
  let hasSnapshotFailure = false
  return nameJestWatchPlugin('UpdateSnapshotsPlugin', {
    isInternal: true,
    apply: (hooks) =>
      hooks.onTestRunComplete((results) => {
        hasSnapshotFailure = results.snapshot.failure
      }),
    getUsageInfo: () =>
      hasSnapshotFailure ? { key: 'u', prompt: 'update failing snapshots' } : null,
    run: (_globalConfig, updateConfigAndRun) => {
      updateConfigAndRun({ updateSnapshot: 'all' })
      return Promise.resolve(false)
    },
  })
}

/**
 * `UpdateSnapshotInteractivePlugin`: `i`, `update failing snapshots interactively`, after a run
 * with a failed test in a file whose snapshots didn't match.
 * @beta
 */
export function jestUpdateSnapshotsInteractivePlugin(terminal: JestWatchTerminal): JestWatchPlugin {
  const mode = new JestSnapshotInteractiveMode(terminal)
  let assertions: JestAssertionLocation[] = []
  return nameJestWatchPlugin('UpdateSnapshotInteractivePlugin', {
    isInternal: true,
    apply: (hooks) =>
      hooks.onTestRunComplete((results) => {
        assertions = failedSnapshotTestAssertions(results)
        if (mode.isActive()) mode.updateWithResults(results)
      }),
    onKey: (key) => {
      if (mode.isActive()) mode.put(key)
    },
    run: (_globalConfig, updateConfigAndRun) => {
      if (assertions.length === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        mode.run(assertions, (assertion, shouldUpdateSnapshot) => {
          updateConfigAndRun({
            mode: 'watch',
            testNamePattern: assertion ? `^${assertion.fullName}$` : '',
            testPathPatterns: assertion ? [assertion.path] : [],
            updateSnapshot: shouldUpdateSnapshot ? 'all' : 'none',
          })
          if (!mode.isActive()) resolve()
        })
      })
    },
    getUsageInfo: () =>
      assertions.length > 0 ? { key: 'i', prompt: 'update failing snapshots interactively' } : null,
  })
}
