// jest-watcher `JestHooks.ts` L19-L79: the hooks a watch plugin subscribes to and the driver emits.

/**
 * The part of Jest's `AggregatedResult` the watch mode reads: the failed-tests cache, the
 * interactive plugins' usage rows and the run's own `onTestRunComplete` listeners.
 * @beta
 */
export interface JestWatchResults {
  readonly numFailedTests: number
  readonly snapshot: { readonly failure: boolean; readonly unmatched: number }
  readonly testResults: readonly {
    readonly testFilePath: string
    readonly numFailingTests: number
    readonly testExecError?: unknown
    readonly snapshot?: { readonly unmatched: number }
    readonly testResults: readonly { readonly fullName: string; readonly status: string }[]
  }[]
}

/**
 * What `onFileChange` listeners get: each project's test paths (`watch.ts` L231-L245).
 * @beta
 */
export interface JestFileChange {
  readonly projects: readonly { readonly config: unknown; readonly testPaths: readonly string[] }[]
}

/**
 * What `shouldRunTestSuite` listeners get (`runJest.ts` L149-L157).
 * @beta
 */
export interface JestTestSuiteInfo {
  readonly config: unknown
  readonly duration: number | undefined
  readonly testPath: string
}

/**
 * What a plugin's `apply` gets (`JestHookSubscriber`).
 * @beta
 */
export interface JestHookSubscriber {
  onFileChange(listener: (change: JestFileChange) => void): void
  onTestRunComplete(listener: (results: JestWatchResults) => void): void
  shouldRunTestSuite(listener: (info: JestTestSuiteInfo) => boolean | Promise<boolean>): void
}

/**
 * What the driver calls (`JestHookEmitter`).
 * @beta
 */
export interface JestHookEmitter {
  onFileChange(change: JestFileChange): void
  onTestRunComplete(results: JestWatchResults): void
  shouldRunTestSuite(info: JestTestSuiteInfo): Promise<boolean>
}

/**
 * One session's hooks (`new JestHooks()`).
 * @beta
 */
export interface JestHooks {
  readonly subscriber: JestHookSubscriber
  readonly emitter: JestHookEmitter
  isUsed(hook: 'onFileChange' | 'onTestRunComplete' | 'shouldRunTestSuite'): boolean
}

/**
 * Makes the hooks of one watch session.
 * @beta
 */
export function createJestHooks(): JestHooks {
  const listeners = {
    onFileChange: [] as ((change: JestFileChange) => void)[],
    onTestRunComplete: [] as ((results: JestWatchResults) => void)[],
    shouldRunTestSuite: [] as ((info: JestTestSuiteInfo) => boolean | Promise<boolean>)[],
  }
  return {
    subscriber: {
      onFileChange: (listener) => {
        listeners.onFileChange.push(listener)
      },
      onTestRunComplete: (listener) => {
        listeners.onTestRunComplete.push(listener)
      },
      shouldRunTestSuite: (listener) => {
        listeners.shouldRunTestSuite.push(listener)
      },
    },
    emitter: {
      onFileChange: (change) => {
        for (const listener of listeners.onFileChange) listener(change)
      },
      onTestRunComplete: (results) => {
        for (const listener of listeners.onTestRunComplete) listener(results)
      },
      shouldRunTestSuite: async (info) => {
        const answers = await Promise.all(
          listeners.shouldRunTestSuite.map((listener) => listener(info)),
        )
        return answers.every(Boolean)
      },
    },
    isUsed: (hook) => listeners[hook].length > 0,
  }
}
