// T5.6 acceptance, part 4: `retry` and `repeats` (test options), `retry.keepEarlierErrors` and
// `retry.timing`.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { eventLog, runScript, type Script } from '../internal/test-support.ts'

/** The test and attempt lines of an event log (hooks left out). */
const lifecycle = (lines: readonly string[]): string[] =>
  lines.filter((line) => /^(test-|attempt-)/.test(line))

/** A test that fails its first `failures` calls with "fail 1", "fail 2", … */
function flaky(failures: number, options: { retry?: number; repeats?: number }): Script {
  return ({ test }, step) => {
    let calls = 0
    test('flaky', options, () => {
      calls++
      step(`call ${calls}`)
      if (calls <= failures) throw new Error(`fail ${calls}`)
    })
  }
}

describe('retry', () => {
  test('a failing test runs again until it passes, and reports every attempt', async () => {
    const run = await runScript(flaky(2, { retry: 2 }), {})
    assert.deepEqual(lifecycle(eventLog(run)), [
      'test-start flaky',
      'attempt-start flaky 0/0',
      'attempt-end flaky 0/0 fail will-retry',
      'attempt-start flaky 1/0',
      'attempt-end flaky 1/0 fail will-retry',
      'attempt-start flaky 2/0',
      'attempt-end flaky 2/0 pass',
      'test-end flaky pass',
    ])
    assert.equal(run.results.flaky?.attempts, 3)
    assert.deepEqual(run.errors.flaky, [])
  })

  test('the last attempt failing is not marked willRetry, and fails the test with its error alone', async () => {
    const run = await runScript(flaky(5, { retry: 1 }), {})
    assert.deepEqual(lifecycle(eventLog(run)).slice(-3), [
      'attempt-start flaky 1/0',
      'attempt-end flaky 1/0 fail',
      'test-end flaky fail',
    ])
    assert.deepEqual(run.errors.flaky, ['fail 2'])
  })

  test('a test that passes first time reports one attempt and no retry', async () => {
    const run = await runScript(flaky(0, { retry: 3 }), {})
    assert.deepEqual(run.trace, ['call 1'])
    assert.equal(run.results.flaky?.attempts, 1)
    assert.ok(!eventLog(run).some((line) => line.includes('will-retry')))
  })

  test('with no retry a failing test runs once', async () => {
    const run = await runScript(flaky(5, {}), {})
    assert.deepEqual(run.trace, ['call 1'])
    assert.equal(run.states.flaky, 'fail')
  })

  test('each attempt runs the each-hooks again, and the beforeAll once', async () => {
    const run = await runScript(({ test, beforeAll, beforeEach, afterEach }, step) => {
      let calls = 0
      beforeAll(() => step('beforeAll'))
      beforeEach(() => step('beforeEach'))
      afterEach(() => step('afterEach'))
      test('flaky', { retry: 1 }, () => {
        step('body')
        if (++calls === 1) throw new Error('first attempt fails')
      })
    })
    assert.deepEqual(run.trace, [
      'beforeAll',
      'beforeEach',
      'body',
      'afterEach',
      'beforeEach',
      'body',
      'afterEach',
    ])
  })

  test('a describe can give its tests a retry count', async () => {
    const run = await runScript(({ describe, test }, step) => {
      let calls = 0
      describe('d', { retry: 1 }, () => {
        test('flaky', () => {
          step('call')
          if (++calls === 1) throw new Error('first attempt fails')
        })
      })
    })
    assert.equal(run.states['d > flaky'], 'pass')
    assert.deepEqual(run.trace, ['call', 'call'])
  })
})

describe('retry.keepEarlierErrors', () => {
  test('true keeps the errors of the attempts that were retried on the result', async () => {
    const run = await runScript(flaky(2, { retry: 2 }), { retry: { keepEarlierErrors: true } })
    assert.deepEqual(
      run.results.flaky?.retryErrors.map((error) => error.message),
      ['fail 1', 'fail 2'],
    )
    assert.deepEqual(run.errors.flaky, [])
  })

  test('true keeps them for a test that still fails, apart from its last error', async () => {
    const run = await runScript(flaky(5, { retry: 1 }), { retry: { keepEarlierErrors: true } })
    assert.deepEqual(
      run.results.flaky?.retryErrors.map((error) => error.message),
      ['fail 1'],
    )
    assert.deepEqual(run.errors.flaky, ['fail 2'])
  })

  test('false drops them', async () => {
    const run = await runScript(flaky(2, { retry: 2 }), { retry: { keepEarlierErrors: false } })
    assert.deepEqual(run.results.flaky?.retryErrors, [])
  })

  test('false still reports each failed attempt in its event', async () => {
    const run = await runScript(flaky(1, { retry: 1 }), { retry: { keepEarlierErrors: false } })
    const attempts = run.events.filter((event) => event.type === 'test-attempt-end')
    assert.deepEqual(
      attempts.map((event) => event.errors.map((error) => error.message)),
      [['fail 1'], []],
    )
  })
})

describe('retry.timing', () => {
  test('deferred fails a test that has a retry with CORE_NOT_IMPLEMENTED, without running it', async () => {
    const run = await runScript(flaky(0, { retry: 1 }), { retry: { timing: 'deferred' } })
    assert.equal(run.states.flaky, 'fail')
    assert.equal(run.results.flaky?.errors[0]?.code, 'CORE_NOT_IMPLEMENTED')
    assert.deepEqual(run.trace, [])
    assert.deepEqual(lifecycle(eventLog(run)), ['test-start flaky', 'test-end flaky fail'])
  })

  test('deferred leaves a test with no retry alone', async () => {
    const run = await runScript(flaky(0, {}), { retry: { timing: 'deferred' } })
    assert.equal(run.states.flaky, 'pass')
  })

  test('immediate retries the test where it is', async () => {
    const run = await runScript(flaky(1, { retry: 1 }), { retry: { timing: 'immediate' } })
    assert.equal(run.states.flaky, 'pass')
  })
})

describe('repeats', () => {
  test('a test with repeats runs once more for each, each reported as its own attempt', async () => {
    const run = await runScript(flaky(0, { repeats: 2 }), {})
    assert.deepEqual(run.trace, ['call 1', 'call 2', 'call 3'])
    assert.deepEqual(
      lifecycle(eventLog(run)).filter((line) => line.startsWith('attempt-')),
      [
        'attempt-start flaky 0/0',
        'attempt-end flaky 0/0 pass',
        'attempt-start flaky 0/1',
        'attempt-end flaky 0/1 pass',
        'attempt-start flaky 0/2',
        'attempt-end flaky 0/2 pass',
      ],
    )
    assert.equal(run.results.flaky?.attempts, 3)
    assert.equal(run.results.flaky?.repeatIndex, 2)
  })

  test('each repeat has its own retries', async () => {
    const run = await runScript(({ test }, step) => {
      let calls = 0
      test('flaky', { retry: 1, repeats: 1 }, () => {
        step(`call ${++calls}`)
        // The first attempt of each repeat fails (calls 1 and 3), the retry passes.
        if (calls % 2 === 1) throw new Error(`fail ${calls}`)
      })
    })
    assert.deepEqual(
      lifecycle(eventLog(run)).filter((line) => line.startsWith('attempt-end')),
      [
        'attempt-end flaky 0/0 fail will-retry',
        'attempt-end flaky 1/0 pass',
        'attempt-end flaky 0/1 fail will-retry',
        'attempt-end flaky 1/1 pass',
      ],
    )
    assert.equal(run.states.flaky, 'pass')
    assert.equal(run.results.flaky?.attempts, 4)
  })

  test('each repeat runs the each-hooks', async () => {
    const run = await runScript(({ test, beforeEach }, step) => {
      beforeEach(() => step('beforeEach'))
      test('t', { repeats: 1 }, () => step('body'))
    })
    assert.deepEqual(run.trace, ['beforeEach', 'body', 'beforeEach', 'body'])
  })
})
