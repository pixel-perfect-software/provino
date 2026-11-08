// What the runtime's events tell a file's snapshot state: a retry or a repeat takes back what the
// attempt before it did (Jest 30.5 #16344), and a test that was skipped, is a todo or failed
// leaves its stored snapshots alone, instead of having them reported obsolete (#16348).
import type { RuntimeEvent, SnapshotFileReport, TaskId, TestTask } from '@provino/types'
import type { SnapshotState } from './state.ts'

/**
 * Follows one test file's events for its snapshot state.
 * @public
 */
export interface SnapshotLifecycle {
  /** Feeds one runtime event of the file. */
  observe(event: RuntimeEvent): void
  /**
   * Ends the file: marks the snapshots of the tests that didn't pass as checked, then settles
   * what is obsolete, saves and reports (`SnapshotState.finish`).
   */
  finish(): SnapshotFileReport
}

/**
 * Builds the lifecycle of a file's state. `keyJoin` joins a test's title path into the name its
 * snapshots' keys start with.
 * @public
 */
export function trackSnapshots(
  state: SnapshotState,
  options: { readonly keyJoin: string },
): SnapshotLifecycle {
  const tests = new Map<TaskId, TestTask>()
  /** Tests that ended well and may be the reason a snapshot is obsolete. */
  const passed = new Set<TaskId>()

  return {
    observe(event: RuntimeEvent): void {
      switch (event.type) {
        case 'file-collect-end':
          for (const task of event.tasks) {
            if (task.type === 'test') tests.set(task.id, task)
          }
          break
        case 'test-attempt-start':
          // A later attempt or repeat starts from what the test's first one left.
          if (event.attempt > 0 || event.repeat > 0) state.clearTest(event.id)
          break
        case 'test-end': {
          const task = tests.get(event.id)
          // `test.failing` passes by failing; what it stored before the error stays valid.
          if (event.result.state === 'pass' && task?.expectFail !== true) passed.add(event.id)
          state.forgetTest(event.id)
          break
        }
        default:
          break
      }
    },
    finish(): SnapshotFileReport {
      for (const [id, task] of tests) {
        if (!passed.has(id)) state.markCheckedForTest(task.fullName.join(options.keyJoin))
      }
      return state.finish()
    },
  }
}
