// The circus mirror behind `handleTestEvent` (T8.5's rest, B23d), driven by core's real lifecycle
// events. The order of every event against real Jest 30.5.2 is `provino`'s `jest-environments.test.ts`
// (`env/handle-test-event*`); these hold what a handler can read of the state and the objects.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createRuntime, type RuntimeApi } from '@provino/core'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import { type CircusConfig, createCircusMirror, type HandleTestEvent } from './circus-mirror.ts'

interface Seen {
  readonly name: string
  readonly event: Record<string, unknown>
  /** The state's fields at the time, copied. */
  readonly state: Record<string, unknown>
}

/** Runs one file under the Jest dialect's core policy; returns what a handler saw. */
async function observe(
  register: (api: RuntimeApi) => void,
  config: CircusConfig = {},
  handler?: (
    event: Record<string, unknown>,
    state: Record<string, unknown>,
  ) => void | Promise<void>,
): Promise<Seen[]> {
  const seen: Seen[] = []
  const handle = (event: Record<string, unknown>, state: Record<string, unknown>) => {
    seen.push({
      name: String(event.name),
      event,
      state: { ...state, unhandledErrors: (state.unhandledErrors as unknown[]).length },
    })
    return handler?.(event, state)
  }
  const mirror = createCircusMirror(handle as unknown as HandleTestEvent, config)
  const runtime = await createRuntime({
    policy: resolvePolicy({ core: { hooks: { beforeAllError: 'attach-to-tests' } } }).core,
    behaviours: createBehaviourLoader(),
    sink: { emit: () => undefined },
    importFile: async () => register(runtime.api),
    rootDir: '/mirror',
  })
  try {
    await runtime.runFile('/mirror/a.test.ts', { lifecycle: mirror })
  } finally {
    await runtime.dispose()
  }
  return seen
}

const names = (seen: readonly Seen[]): string[] => seen.map((entry) => entry.name)

describe('the circus mirror', () => {
  test('a handler sees the tree as circus builds it: names, parents, modes, hooks', async () => {
    const seen = await observe(({ describe, test, beforeEach }) => {
      describe('outer', () => {
        beforeEach(() => undefined)
        describe.skip('inner', () => {
          test('a', () => undefined)
        })
        test('b', () => undefined)
      })
    })
    const start = seen.find((entry) => entry.name === 'run_describe_start')
    const block = start?.event.describeBlock as { name: string; children: unknown[] }
    assert.equal(block.name, 'ROOT_DESCRIBE_BLOCK')
    assert.equal(block.children.length, 1)
    const added = seen.filter((entry) => entry.name === 'add_test')
    const a = added.find((entry) => entry.event.testName === 'a')
    assert.equal(a?.event.mode, undefined)
    const tests = seen.filter((entry) => entry.name === 'test_start')
    const first = tests[0]?.event.test as {
      name: string
      mode: string
      parent: { name: string; mode: string }
    }
    // The skipped block's mode was passed down to the test it holds when the block was finished.
    assert.equal(first.name, 'a')
    assert.equal(first.mode, 'skip')
    assert.equal(first.parent.name, 'inner')
  })

  test("the adapter's own root beforeEach is registered first and runs before every test's hooks", async () => {
    const seen = await observe(({ test, beforeEach }) => {
      beforeEach(() => undefined)
      test('a', () => undefined)
    })
    const added = seen
      .filter((entry) => entry.name === 'add_hook')
      .map((entry) => entry.event.hookType)
    assert.deepEqual(added, ['beforeEach', 'beforeEach'])
    const run = names(seen).slice(names(seen).indexOf('test_started'))
    assert.deepEqual(run.slice(0, 7), [
      'test_started',
      'hook_start',
      'hook_success',
      'hook_start',
      'hook_success',
      'test_fn_start',
      'test_fn_success',
    ])
  })

  test('test fields move as circus moves them: invocations, status, errors, startedAt, duration', async () => {
    const frames: Record<
      string,
      { invocations: number; status: unknown; errors: number; startedAt: string; duration: string }
    > = {}
    const seen = await observe(
      ({ test }) => {
        test('fails', () => {
          throw new Error('boom')
        })
      },
      {},
      (event) => {
        const found = event.test as
          | {
              invocations: number
              status: unknown
              errors: unknown[]
              startedAt: unknown
              duration: unknown
            }
          | undefined
        if (found === undefined) return
        frames[String(event.name)] = {
          invocations: found.invocations,
          status: found.status,
          errors: found.errors.length,
          startedAt: typeof found.startedAt,
          duration: typeof found.duration,
        }
      },
    )
    assert.deepEqual(frames.test_start, {
      invocations: 1,
      status: null,
      errors: 0,
      startedAt: 'number',
      duration: 'object',
    })
    assert.equal(frames.test_fn_failure?.errors, 1)
    assert.deepEqual(frames.test_done, {
      invocations: 1,
      status: 'done',
      errors: 1,
      startedAt: 'number',
      duration: 'number',
    })
    const failure = seen.find((entry) => entry.name === 'test_fn_failure')
    assert.equal((failure?.event.error as Error | undefined)?.message, 'boom')
  })

  test('state: hasStarted and the timeout come with run_start, the running test is null after test_done', async () => {
    const seen = await observe(({ test }) => test('a', () => undefined), {
      maxConcurrency: 7,
      randomize: true,
      seed: 12,
    })
    const setup = seen.find((entry) => entry.name === 'setup')
    assert.equal(setup?.state.hasStarted, false)
    assert.equal(setup?.event.parentProcess, process)
    assert.equal(setup?.state.maxConcurrency, 7)
    assert.equal(setup?.state.randomize, true)
    assert.equal(setup?.state.seed, 12)
    const start = seen.find((entry) => entry.name === 'run_start')
    assert.equal(start?.state.hasStarted, true)
    const during = seen.find((entry) => entry.name === 'test_fn_start')
    assert.equal((during?.state.currentlyRunningTest as { name: string } | null)?.name, 'a')
    const done = seen.find((entry) => entry.name === 'test_done')
    assert.equal(done?.state.currentlyRunningTest, null)
  })

  test('location results are announced only when the config asks', async () => {
    const without = await observe(({ test }) => test('a', () => undefined))
    assert.ok(!names(without).includes('include_test_location_in_result'))
    const withIt = await observe(({ test }) => test('a', () => undefined), {
      testLocationInResults: true,
    })
    assert.equal(names(withIt)[1], 'include_test_location_in_result')
    assert.equal(withIt[1]?.state.includeTestLocationInResult, true)
  })

  test('hasFocusedTests is set while the file is defined when a test is only', async () => {
    const seen = await observe(({ test }) => {
      test.only('a', () => undefined)
      test('b', () => undefined)
    })
    const added = seen.filter((entry) => entry.name === 'add_test')
    assert.equal(added[0]?.state.hasFocusedTests, true)
    assert.deepEqual(
      seen
        .filter((entry) => entry.name === 'test_skip')
        .map((entry) => (entry.event.test as { name: string }).name),
      ['b'],
    )
  })

  test("a failing beforeAll puts its error on every test below; an afterAll failure is the file's", async () => {
    const seen = await observe(({ describe, test, beforeAll, afterAll }) => {
      describe('block', () => {
        beforeAll(() => {
          throw new Error('setup boom')
        })
        afterAll(() => {
          throw new Error('teardown boom')
        })
        test('a', () => undefined)
      })
    })
    const attached = seen.find((entry) => entry.name === 'test_start')?.event.test as {
      errors: unknown[]
    }
    assert.equal(attached.errors.length, 1)
    const failures = seen.filter((entry) => entry.name === 'hook_failure')
    assert.equal(failures.length, 2)
    assert.equal(failures[1]?.state.unhandledErrors, 1)
  })

  test('test_retry clears the errors and keeps them as retryReasons when asked', async () => {
    const seen: Seen[] = []
    const mirror = createCircusMirror(
      ((event: { name: string }, state: object) => {
        seen.push({ name: event.name, event: event as never, state: { ...state } })
      }) as unknown as HandleTestEvent,
      {},
    )
    const runtime = await createRuntime({
      policy: resolvePolicy({ core: {} }).core,
      behaviours: createBehaviourLoader(),
      sink: { emit: () => undefined },
      importFile: async () => {
        runtime.setDefaultRetry({ count: 1, delay: 0, keepEarlierErrors: true })
        let calls = 0
        runtime.api.test('flaky', () => {
          if (++calls === 1) throw new Error('first')
        })
      },
      rootDir: '/mirror',
    })
    await runtime.runFile('/mirror/a.test.ts', { lifecycle: mirror })
    await runtime.dispose()
    const retry = seen.find((entry) => entry.name === 'test_retry')?.event.test as {
      errors: unknown[]
      retryReasons: unknown[]
    }
    assert.equal(retry.errors.length, 0)
    assert.equal(retry.retryReasons.length, 1)
    const starts = seen.filter((entry) => entry.name === 'test_start')
    assert.equal(starts.length, 2)
  })

  test('an async handler is awaited at the run events', async () => {
    const order: string[] = []
    await observe(
      ({ test }) => test('a', () => order.push('body')),
      {},
      async (event) => {
        if (event.name === 'test_fn_start') {
          await new Promise((resolve) => setTimeout(resolve, 2))
          order.push('fn_start done')
        }
      },
    )
    assert.deepEqual(order, ['fn_start done', 'body'])
  })
})
