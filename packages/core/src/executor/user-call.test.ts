// Every function a file registers is called through the one frame `USER_CALL_FRAME` names: the
// first of core's frames outward from it, which a stack reader (the Jest dialect's window timers)
// tells apart from the rest of Provino's code by its name.
import assert from 'node:assert/strict'
import type { TestContext } from '@provino/types'
import { test } from 'provino'
import { USER_CALL_FRAME } from '../index.ts'
import { runScript } from '../internal/test-support.ts'

type Done = (reason?: unknown) => void

/**
 * The name of the first frame with a file outward from `fn`, read inside `fn`: a built-in's frame
 * (a generator's `next`) has none, and a stack walk passes it as the window timers' does.
 */
function callerOf(fn: object): string | null {
  const previous = Error.prepareStackTrace
  Error.prepareStackTrace = (_error, frames) => frames
  try {
    const holder: { stack?: unknown } = {}
    Error.captureStackTrace(holder, fn as (...args: unknown[]) => unknown)
    const frames = (holder.stack ?? []) as readonly NodeJS.CallSite[]
    return frames.find((frame) => frame.getFileName() != null)?.getFunctionName() ?? null
  } finally {
    Error.prepareStackTrace = previous
  }
}

test('a describe body, the hooks, a test, a teardown and a test callback are each called through it', async () => {
  const seen: Record<string, string | null> = {}
  const run = await runScript(
    ({ describe, test, beforeAll, beforeEach, afterEach, afterAll }) => {
      describe('d', function body() {
        seen.describe = callerOf(body)
        beforeAll(function beforeAllHook() {
          seen.beforeAll = callerOf(beforeAllHook)
        })
        beforeEach(function beforeEachHook() {
          seen.beforeEach = callerOf(beforeEachHook)
          return function teardown() {
            seen.teardown = callerOf(teardown)
          }
        })
        test('t', function testBody(ctx: TestContext) {
          seen.test = callerOf(testBody)
          ctx.onTestFinished(function finished() {
            seen.onTestFinished = callerOf(finished)
          })
        })
        afterEach(function afterEachHook() {
          seen.afterEach = callerOf(afterEachHook)
        })
        afterAll(function afterAllHook() {
          seen.afterAll = callerOf(afterAllHook)
        })
      })
    },
    { firstArg: 'context' },
  )
  assert.equal(run.states['d > t'], 'pass')
  const every = Object.fromEntries(Object.keys(seen).map((key) => [key, USER_CALL_FRAME]))
  assert.deepEqual(seen, every)
  assert.equal(Object.keys(seen).length, 8)
})

test('a test that takes done, and each step of a generator test, are called through it too', async () => {
  const seen: Record<string, string | null> = {}
  const run = await runScript(
    ({ test }) => {
      test('done', function withDone(done: Done) {
        seen.done = callerOf(withDone)
        done()
      } as never)
      test('generator', function* generatorBody() {
        yield Promise.resolve()
        // A step after the first: resumed by `next`, which core calls through the frame.
        seen.generator = callerOf(generatorBody)
      } as never)
    },
    { firstArg: 'done-if-arity', allowGeneratorFns: true },
  )
  assert.equal(run.states.done, 'pass')
  assert.equal(run.states.generator, 'pass')
  assert.deepEqual(seen, { done: USER_CALL_FRAME, generator: USER_CALL_FRAME })
})
