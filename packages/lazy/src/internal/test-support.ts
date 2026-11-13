// A fake `LazyHost` for this package's own tests (not a test file): a small collector and runner that
// keep the four guarantees `LazyHost` documents (one frame per run, the innermost suite, teardowns
// after `afterEach` in the 'cleanup' state, fresh slots per attempt). The whole-policy check on
// the real core lives in `@provino/bench`'s `src/lazy/`.
import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  FileHandle,
  LazyFrame,
  LazyHost,
  LazyPolicy,
  SuiteHandle,
  TaskInfo,
  TestRunHandle,
} from '@provino/types'
import { createLazyRuntime, type LazyCore } from '../runtime/create.ts'

type Fn = (ctx: FakeContext) => unknown

/** What a test or hook receives. */
export interface FakeContext {
  readonly task: TaskInfo
  readonly signal: AbortSignal
}

class FakeSuite implements SuiteHandle {
  readonly name: string
  readonly parent: FakeSuite | undefined
  readonly file: FakeFile
  readonly slots = new Map<symbol, unknown>()
  readonly children: Array<FakeSuite | FakeTest> = []
  readonly hooks = {
    beforeAll: [] as Fn[],
    afterAll: [] as Fn[],
    beforeEach: [] as Fn[],
    afterEach: [] as Fn[],
  }

  constructor(name: string, parent: FakeSuite | undefined, file: FakeFile) {
    this.name = name
    this.parent = parent
    this.file = file
  }
}

class FakeFile implements FileHandle {
  readonly name: string
  readonly slots = new Map<symbol, unknown>()
  readonly teardowns: Array<() => unknown> = []
  readonly controller = new AbortController()
  readonly listeners: Array<(file: FileHandle) => void> = []
  readonly root: FakeSuite

  constructor(name: string) {
    this.name = name
    this.root = new FakeSuite(name, undefined, this)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }
}

interface FakeTest {
  readonly name: string
  readonly suite: FakeSuite
  readonly fn: Fn
  readonly concurrent: boolean
  readonly retry: number
}

class FakeRun implements TestRunHandle {
  readonly test: { readonly suite: SuiteHandle }
  readonly ctx: FakeContext
  readonly slots = new Map<symbol, unknown>()
  readonly controller = new AbortController()
  state: 'running' | 'cleanup' | 'done' = 'running'
  readonly teardowns: Array<() => unknown> = []

  constructor(suite: FakeSuite, task: TaskInfo, signal: AbortSignal) {
    this.test = { suite }
    this.ctx = { task, signal }
    void signal
  }

  get signal(): AbortSignal {
    return this.ctx.signal
  }

  addTeardown(fn: () => unknown): void {
    this.teardowns.push(fn)
  }
}

/** One test's outcome. */
export interface TestOutcome {
  readonly name: string
  readonly error: unknown
}

/** One file's outcome. */
export interface FileOutcome {
  /** What the file's top level, or a collection listener, threw. */
  readonly collectError: unknown
  readonly tests: readonly TestOutcome[]
  /** What a file teardown threw. */
  readonly teardownError: unknown
}

/** The registration functions of a fake file. */
export interface FakeApi {
  describe(name: string, body: () => void): void
  test(name: string, fn: Fn, options?: { concurrent?: boolean; retry?: number }): void
  beforeAll(fn: Fn): void
  afterAll(fn: Fn): void
  beforeEach(fn: Fn): void
  afterEach(fn: Fn): void
}

/** A worker: fake host, lazy runtime over it, and files to run. */
export interface FakeWorld extends FakeApi {
  readonly host: LazyHost
  readonly lazy: LazyCore['lazy']
  readonly runtime: LazyCore
  /** Collects `script` as a file, then runs it. */
  runFile(name: string, script: () => void): Promise<FileOutcome>
  /** Runs the worker teardowns, last first. */
  dispose(): Promise<void>
  /** Runs `fn` where no test is running, but with `describe` bodies collecting under `name`. */
  collectOnly(name: string, script: () => void): unknown
  /** The run handles created so far, in order. */
  readonly runs: readonly TestRunHandle[]
  /** Which test is running in the frame now, by name, or undefined. */
  currentTestName(): string | undefined
}

/** Builds a world; `policy` is the `lazy` policy slice. */
export function createWorld(policy: LazyPolicy = { readInBeforeAll: 'error' }): FakeWorld {
  const als = new AsyncLocalStorage<LazyFrame>()
  const workerSlots = new Map<symbol, unknown>()
  const workerTeardowns: Array<() => unknown> = []
  const contexts = new WeakMap<object, FakeRun>()
  const runs: FakeRun[] = []
  let file: FakeFile | undefined
  let collecting: FakeSuite | undefined
  const names = new WeakMap<FakeRun, string>()

  const host: LazyHost = {
    collecting: () => collecting,
    current: () => als.getStore(),
    addHook(suite, kind, fn) {
      ;(suite as FakeSuite).hooks[kind].push(fn)
    },
    runOf: (ctx) => contexts.get(ctx),
    onCollected(fn) {
      if (file === undefined) throw new Error('no file is collecting')
      file.listeners.push(fn)
    },
    addWorkerTeardown: (fn) => {
      workerTeardowns.push(fn)
    },
    workerSlots,
  }

  const api: FakeApi = {
    describe(name, body) {
      const parent = collecting
      if (parent === undefined) throw new Error('describe outside collection')
      const suite = new FakeSuite(name, parent, parent.file)
      parent.children.push(suite)
      collecting = suite
      try {
        body()
      } finally {
        collecting = parent
      }
    },
    test(name, fn, options) {
      if (collecting === undefined) throw new Error('test outside collection')
      collecting.children.push({
        name,
        suite: collecting,
        fn,
        concurrent: options?.concurrent === true,
        retry: options?.retry ?? 0,
      })
    },
    beforeAll: (fn) => void collecting?.hooks.beforeAll.push(fn),
    afterAll: (fn) => void collecting?.hooks.afterAll.push(fn),
    beforeEach: (fn) => void collecting?.hooks.beforeEach.push(fn),
    afterEach: (fn) => void collecting?.hooks.afterEach.push(fn),
  }

  const runtime = createLazyRuntime({ host, policy, describe: api.describe })

  function chain(suite: FakeSuite): FakeSuite[] {
    const list: FakeSuite[] = []
    for (let s: FakeSuite | undefined = suite; s !== undefined; s = s.parent) list.unshift(s)
    return list
  }

  async function attempt(test: FakeTest, retry: number): Promise<unknown> {
    const owner = test.suite.file
    const fullName = [
      ...chain(test.suite)
        .slice(1)
        .map((s) => s.name),
      test.name,
    ].join(' > ')
    const task: TaskInfo = { name: test.name, fullName, file: owner.name, retry, repeat: 0 }
    const run = new FakeRun(test.suite, task, new AbortController().signal)
    names.set(run, test.name)
    runs.push(run)
    contexts.set(run.ctx, run)
    const frame: LazyFrame = { kind: 'test', run, suite: test.suite, file: owner }
    let failure: unknown
    let failed = false
    const guard = async (fn: () => unknown): Promise<void> => {
      try {
        await fn()
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
    await als.run(frame, async () => {
      const suites = chain(test.suite)
      for (const suite of suites) {
        for (const hook of suite.hooks.beforeEach) {
          if (!failed) await guard(() => hook(run.ctx))
        }
      }
      if (!failed) await guard(() => test.fn(run.ctx))
      for (const suite of suites.toReversed()) {
        for (const hook of suite.hooks.afterEach) await guard(() => hook(run.ctx))
      }
      run.state = 'cleanup'
      while (run.teardowns.length > 0) {
        const teardown = run.teardowns.pop()
        if (teardown !== undefined) await guard(teardown)
      }
      run.state = 'done'
    })
    if (failed) throw failure
    return undefined
  }

  async function runTest(test: FakeTest): Promise<TestOutcome> {
    let error: unknown
    for (let retry = 0; retry <= test.retry; retry++) {
      error = undefined
      try {
        await attempt(test, retry)
        break
      } catch (thrown) {
        error = thrown
      }
    }
    return { name: test.name, error }
  }

  async function runSuite(suite: FakeSuite, out: TestOutcome[]): Promise<void> {
    const frame: LazyFrame = { kind: 'suite', hook: 'beforeAll', suite, file: suite.file }
    const hooks = async (kind: 'beforeAll' | 'afterAll'): Promise<unknown> => {
      const inFrame: LazyFrame = { ...frame, hook: kind }
      for (const hook of suite.hooks[kind]) {
        try {
          await als.run(inFrame, async () =>
            hook({ task: undefined as never, signal: suite.file.signal }),
          )
        } catch (error) {
          return error
        }
      }
      return undefined
    }
    const before = await hooks('beforeAll')
    if (before !== undefined) {
      for (const child of suite.children) {
        if ('fn' in child) out.push({ name: child.name, error: before })
      }
    } else {
      let i = 0
      while (i < suite.children.length) {
        const child = suite.children[i]
        if (child === undefined) break
        if (!('fn' in child)) {
          await runSuite(child, out)
          i++
        } else if (child.concurrent) {
          const group: FakeTest[] = []
          while (i < suite.children.length) {
            const next = suite.children[i]
            if (next === undefined || !('fn' in next) || !next.concurrent) break
            group.push(next)
            i++
          }
          out.push(...(await Promise.all(group.map(runTest))))
        } else {
          out.push(await runTest(child))
          i++
        }
      }
    }
    const after = await hooks('afterAll')
    if (before === undefined && after !== undefined)
      out.push({ name: `${suite.name} afterAll`, error: after })
  }

  return {
    ...api,
    host,
    lazy: runtime.lazy,
    runtime,
    runs,
    currentTestName() {
      const frame = als.getStore()
      return frame?.kind === 'test' ? names.get(frame.run as FakeRun) : undefined
    },
    collectOnly(name, script) {
      const created = new FakeFile(name)
      file = created
      collecting = created.root
      try {
        return script()
      } finally {
        collecting = undefined
        file = undefined
      }
    },
    async runFile(name, script) {
      const created = new FakeFile(name)
      file = created
      collecting = created.root
      let collectError: unknown
      try {
        script()
      } catch (error) {
        collectError = error
      } finally {
        collecting = undefined
      }
      if (collectError === undefined) {
        for (const listener of created.listeners) {
          try {
            listener(created)
          } catch (error) {
            collectError ??= error
          }
        }
      }
      file = undefined
      const tests: TestOutcome[] = []
      let teardownError: unknown
      if (collectError === undefined) await runSuite(created.root, tests)
      while (created.teardowns.length > 0) {
        const teardown = created.teardowns.pop()
        try {
          await teardown?.()
        } catch (error) {
          teardownError ??= error
        }
      }
      return { collectError, tests, teardownError }
    },
    async dispose() {
      while (workerTeardowns.length > 0) await workerTeardowns.pop()?.()
    },
  }
}
