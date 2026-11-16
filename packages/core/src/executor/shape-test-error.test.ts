// `core.shapeTestError`: every error attached to a test's result is shaped once, wherever it was
// attached, and a shaper that throws leaves the error as thrown. Jest maps every entry of
// `test.errors` at `test_done` (jest-circus `formatNodeAssertErrors`): what is charged to the test
// later is not in it, and stays as thrown (`cli/node-assert-unhandled`).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import {
  type BehaviourLoader,
  createBehaviourLoader,
  isModuleRef,
  moduleRef,
} from '@provino/policy'
import type { AnyFunction, Behaviour, ShapeTestError } from '@provino/types'
import { eventsOf, runScript } from '../internal/test-support.ts'

const REF = moduleRef<ShapeTestError>('test:shape-test-error', 'shapeTestError')
const OWNER = { lateErrors: 'fail-owner', hasAssertionsWhenFailed: 'skip' } as const

function withShaper(shape: ShapeTestError): BehaviourLoader {
  const real = createBehaviourLoader()
  return {
    async load<Fn extends AnyFunction>(behaviour: Behaviour<Fn>): Promise<Fn> {
      if (isModuleRef(behaviour) && behaviour.module === REF.module) return shape as unknown as Fn
      return real.load(behaviour)
    },
  }
}

/** A shaper that counts its calls and replaces an error by `{ message: 'shaped <message>' }`. */
function counting(): { readonly shape: ShapeTestError; readonly seen: string[] } {
  const seen: string[] = []
  const shape: ShapeTestError = (error) => {
    const message = (error as Error).message
    seen.push(message)
    return new Error(`shaped ${message}`)
  }
  return { shape, seen }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A fresh error, remembered by a `WeakRef` in `held`. */
function thrown(held: WeakRef<object>[]): Error {
  const error = new Error('thrown')
  held.push(new WeakRef(error))
  return error
}

/** Collects garbage until every error in `held` is gone, and fails when one stays. */
async function collected(held: readonly WeakRef<object>[]): Promise<void> {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  for (let round = 0; round < 10 && held.some((ref) => ref.deref() !== undefined); round++) {
    await new Promise((resolve) => setImmediate(resolve))
    gc()
  }
  assert.deepEqual(
    held.map((ref) => ref.deref() === undefined),
    held.map(() => true),
    'every thrown error was collected',
  )
}

describe('shapeTestError', () => {
  test('a retried test shapes each attempt error once, for the attempt and the result', async () => {
    const { shape, seen } = counting()
    let attempt = 0
    const run = await runScript(
      ({ test }) => {
        test('t', { retry: 1 }, () => {
          throw new Error(`attempt ${++attempt}`)
        })
      },
      { shapeTestError: REF, retry: { keepEarlierErrors: true } },
      { behaviours: withShaper(shape) },
    )
    assert.deepEqual(seen, ['attempt 1', 'attempt 2'])
    const [end] = eventsOf(run.events, 'test-end')
    assert.deepEqual(
      end?.result.errors.map((error) => error.message),
      ['shaped attempt 2'],
    )
    const attempts = eventsOf(run.events, 'test-attempt-end')
    assert.deepEqual(
      attempts.flatMap((event) => event.errors.map((error) => error.message)),
      ['shaped attempt 1', 'shaped attempt 2'],
    )
  })

  test('an error charged to a test after it ended is left as thrown, as Jest leaves it', async () => {
    const { shape, seen } = counting()
    const process = new EventEmitter()
    const run = await runScript(
      ({ test }, _step, runtime) => {
        runtime.captureProcessErrors(process)
        test('owner', () => {
          setTimeout(
            () => process.emit('uncaughtException', new Error('late'), 'uncaughtException'),
            5,
          )
        })
        test('running when it fires', () => sleep(40))
      },
      { shapeTestError: REF, errors: OWNER },
      { behaviours: withShaper(shape) },
    )
    assert.deepEqual(seen, [])
    const [event] = eventsOf(run.events, 'unhandled-error')
    assert.equal(event?.error.message, 'late')
  })

  test('an error no test owns is not shaped', async () => {
    const { shape, seen } = counting()
    const process = new EventEmitter()
    const run = await runScript(
      ({ test }, _step, runtime) => {
        runtime.captureProcessErrors(process)
        test('t', () => {})
      },
      { shapeTestError: REF, errors: OWNER },
      { behaviours: withShaper(shape) },
    )
    process.emit('uncaughtException', new Error('between files'), 'uncaughtException')
    assert.deepEqual(seen, [])
    const [event] = eventsOf(run.events, 'unhandled-error')
    assert.equal(event?.error.message, 'between files')
  })

  test('a shaper that throws leaves the error as thrown', async () => {
    const run = await runScript(
      ({ test }) => {
        test('t', () => {
          throw new Error('as thrown')
        })
      },
      { shapeTestError: REF },
      {
        behaviours: withShaper(() => {
          throw new Error('the shaper broke')
        }),
      },
    )
    const [end] = eventsOf(run.events, 'test-end')
    assert.deepEqual(
      end?.result.errors.map((error) => error.message),
      ['as thrown'],
    )
  })

  test('a failed test`s thrown value is not kept once its file has run', async () => {
    const held: WeakRef<object>[] = []
    // The runtime outlives the file, as a worker's does: nothing it keeps may hold the thrown value
    // (`--detectLeaks` reads a file's leftovers, and the heap after a file counts them).
    const run = await runScript(
      ({ test }) => {
        test('t', { retry: 1 }, () => {
          throw thrown(held)
        })
      },
      { shapeTestError: REF, retry: { keepEarlierErrors: true } },
      { behaviours: withShaper((error) => error) },
    )
    await collected(held)
    assert.equal(eventsOf(run.events, 'test-end')[0]?.result.errors[0]?.message, 'thrown')
  })

  test('nor is one a describe retry held for an error charged to it later', async () => {
    const held: WeakRef<object>[] = []
    // A describe attempt keeps what its tests failed with until the block settles, and the runtime
    // remembers each test's last attempt for a late error: both go with the file.
    const run = await runScript(
      (_api, _step, runtime) => {
        runtime.api.describe('block', () => {
          runtime.setDescribeRetry({ numRetries: 2 })
          runtime.api.test('t', () => {
            throw thrown(held)
          })
        })
      },
      { shapeTestError: REF, errors: OWNER },
      { behaviours: withShaper((error) => error) },
    )
    assert.equal(held.length, 3, 'the block ran in three attempts')
    await collected(held)
    assert.equal(eventsOf(run.events, 'test-end')[0]?.result.errors[0]?.message, 'thrown')
  })

  test('the shaper is told the run`s expand', async () => {
    const told: boolean[] = []
    await runScript(
      ({ test }) => {
        test('t', () => {
          throw new Error('x')
        })
      },
      { shapeTestError: REF },
      {
        behaviours: withShaper((error, options) => {
          told.push(options.expand)
          return error
        }),
        expand: true,
      },
    )
    assert.deepEqual(told, [true])
  })
})
