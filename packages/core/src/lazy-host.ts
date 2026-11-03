// The executor's side of `LazyHost` (Track 6 §Module boundaries; B07 checks it with a type test,
// build-plan §4 D.23). The four guarantees it keeps:
// 1. One AsyncLocalStorage frame per test run: each-hooks, the body and teardowns share one
//    `LazyFrame` (and its `run.slots` memo); suite hooks get a `suite` frame.
// 2. `frame.suite` is the test's innermost suite, never the suite a hook was declared on.
// 3. Teardowns run after `afterEach`, and `run.state` is `'cleanup'` while they do.
// 4. `run.slots` is a fresh map for every attempt (retry and repeat).
import type { FileHandle, LazyFrame, LazyHost, SuiteHandle, TestRunHandle } from '@provino/types'
import type { Collector } from './collector/collector.ts'
import { walk } from './collector/finalize.ts'
import { currentStore } from './current/current-test.ts'
import { CoreError } from './errors.ts'
import type { SuiteNode } from './internal/model.ts'

/** What the host needs from the runtime. */
export interface HostParts {
  readonly collector: Collector
  readonly runs: WeakMap<object, TestRunHandle>
  readonly workerTeardowns: Array<() => unknown>
  readonly workerSlots: Map<symbol, unknown>
}

/** Builds the runtime's `LazyHost`. */
export function createLazyHost(parts: HostParts): LazyHost {
  const { collector } = parts
  /** The suite node behind a handle: only suites of the file collecting now can take hooks. */
  const nodeOf = (handle: SuiteHandle): SuiteNode | undefined => {
    const file = collector.file
    if (file === undefined) return undefined
    if (file.root.handle === handle) return file.root
    for (const node of walk(file.root)) {
      if (node.type !== 'test' && node.handle === handle) return node
    }
    return undefined
  }
  return {
    collecting(): SuiteHandle | undefined {
      return collector.collecting()?.handle
    },
    current(): LazyFrame | undefined {
      return currentStore()?.lazy
    },
    addHook(suite: SuiteHandle, kind: 'beforeEach' | 'beforeAll', fn: () => unknown): void {
      const node = nodeOf(suite)
      if (node === undefined) {
        throw new CoreError(
          'CORE_INVALID_ARGUMENT',
          'LazyHost.addHook: the suite is not part of the file being collected',
        )
      }
      collector.appendHook(node, kind, fn)
    },
    runOf(ctx: object): TestRunHandle | undefined {
      return parts.runs.get(ctx)
    },
    onCollected(fn: (file: FileHandle) => void): void {
      const file = collector.file
      if (file === undefined || file.collected) {
        throw new CoreError('CORE_INVALID_ARGUMENT', 'LazyHost.onCollected: no file is collecting')
      }
      file.onCollected.push(fn)
    },
    addWorkerTeardown(fn: () => unknown): void {
      parts.workerTeardowns.push(fn)
    },
    get workerSlots(): Map<symbol, unknown> {
      return parts.workerSlots
    },
  }
}
