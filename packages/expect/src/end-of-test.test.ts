// The end-of-test check and unawaited-assertion tracking (T7.8): what an attempt owes when it ends.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createEndOfTest, type EndOfTest } from './end-of-test.ts'
import { MatcherResultError } from './expect.ts'
import { testEngine, testTable, testTask } from './internal/test-support.ts'

const run = (failed = false, attempt = 0) => ({ test: { id: 't' }, attempt, repeat: 0, failed })

/** An engine, a running test `t`, and its end-of-test check. */
function setup(
  options: {
    readonly requireAssertions?: boolean
    readonly hasAssertionsWhenFailed?: 'skip' | 'check'
    readonly unawaited?: 'ignore' | 'fail'
  } = {},
) {
  const table = testTable()
  const requireAssertions = options.requireAssertions ?? false
  const engine = testEngine({
    table,
    policy: { requireAssertions },
    ...(options.unawaited === undefined ? {} : { unawaited: options.unawaited }),
  })
  engine.current.enter(testTask('t'))
  const endOfTest: EndOfTest = createEndOfTest({
    source: engine.source,
    messages: table.messages,
    policy: { requireAssertions },
    hasAssertionsWhenFailed: options.hasAssertionsWhenFailed ?? 'skip',
  })
  const messages = (failed = false): string[] => endOfTest(run(failed)).map((e) => e.message)
  return { ...engine, endOfTest, messages }
}

describe('expect.assertions(n)', () => {
  test('met: no error, whatever the count was made of', () => {
    const { expect, messages } = setup()
    expect.assertions(2)
    expect(1).toBe(1)
    expect(2).toBe(2)
    assert.deepEqual(messages(), [])
  })

  test('missed or exceeded: the table text, on the error expect.assertions made', () => {
    const { expect, endOfTest } = setup()
    expect.assertions(2)
    expect(1).toBe(1)
    const [error] = endOfTest(run())
    assert.equal(error?.message, 'expected 2 assertions, made 1')
    assert.match(String(error?.stack).split('\n')[1] ?? '', /end-of-test\.test\.ts/)
  })

  test('assertions(0) holds with none made, and fails with one', () => {
    const { expect, messages } = setup()
    expect.assertions(0)
    assert.deepEqual(messages(), [])
    expect(1).toBe(1)
    assert.deepEqual(messages(), ['expected 0 assertions, made 1'])
  })

  test('a failed assertion counts as a call', () => {
    const { expect, messages } = setup()
    expect.assertions(1)
    assert.throws(() => expect(1).toBe(2))
    assert.deepEqual(messages(true), [])
  })

  test('is checked on a test that already failed, as Jest does', () => {
    const { expect, messages } = setup()
    expect.assertions(2)
    assert.throws(() => expect(1).toBe(2))
    assert.deepEqual(messages(true), ['expected 2 assertions, made 1'])
  })

  test('counts each run of a test on its own, which is the fix for test.concurrent', () => {
    const { expect, current, endOfTest } = setup()
    const task = testTask('t')
    expect.assertions(1)
    expect(1).toBe(1)
    current.enter(task, 1)
    expect.assertions(1)
    assert.deepEqual(endOfTest(run(false, 0)), [])
    assert.equal(endOfTest(run(false, 1)).length, 1)
  })
})

describe('expect.hasAssertions()', () => {
  test('none made: the table text', () => {
    const { expect, messages } = setup()
    expect.hasAssertions()
    assert.deepEqual(messages(), ['expected an assertion, made none'])
  })

  test('one made, even after the call: fine', () => {
    const { expect, messages } = setup()
    expect.hasAssertions()
    expect(1).toBe(1)
    assert.deepEqual(messages(), [])
  })

  test('under hasAssertionsWhenFailed skip, a failed test gets no count error at all', () => {
    const { expect, messages } = setup({ hasAssertionsWhenFailed: 'skip' })
    expect.hasAssertions()
    expect.assertions(3)
    assert.deepEqual(messages(true), [])
  })

  test('under check, it does', () => {
    const { expect, messages } = setup({ hasAssertionsWhenFailed: 'check' })
    expect.hasAssertions()
    assert.deepEqual(messages(true), ['expected an assertion, made none'])
  })

  test('both checks, count first, as Jest orders them', () => {
    const { expect, messages } = setup()
    expect.assertions(2)
    expect.hasAssertions()
    assert.deepEqual(messages(), [
      'expected 2 assertions, made 0',
      'expected an assertion, made none',
    ])
  })
})

describe('ExpectPolicy.requireAssertions', () => {
  test('a test with no assertion fails, even one that never touched expect', () => {
    const { messages } = setup({ requireAssertions: true })
    assert.deepEqual(messages(), ['every test must make an assertion'])
  })

  test('one assertion is enough, and it is not added on top of hasAssertions', () => {
    const { expect, messages } = setup({ requireAssertions: true })
    expect(1).toBe(1)
    assert.deepEqual(messages(), [])
    const second = setup({ requireAssertions: true })
    second.expect.hasAssertions()
    assert.deepEqual(second.messages(), ['expected an assertion, made none'])
  })

  test('a test that failed already is not told it also made no assertion, under skip', () => {
    assert.deepEqual(setup({ requireAssertions: true }).messages(true), [])
    const check = setup({ requireAssertions: true, hasAssertionsWhenFailed: 'check' })
    assert.deepEqual(check.messages(true), ['every test must make an assertion'])
  })

  test('off, a test with no assertion is fine', () => {
    assert.deepEqual(setup().messages(), [])
  })
})

describe('unawaited async assertions', () => {
  test('under fail, an assertion nobody awaited is reported with the table text and its call', () => {
    const { expect, endOfTest } = setup({ unawaited: 'fail' })
    expect(Promise.resolve(1)).resolves.toBe(1)
    const [error] = endOfTest(run())
    assert.ok(error instanceof MatcherResultError)
    assert.equal(error.message, 'settled resolves.toBe was not awaited')
    assert.match(String(error.stack).split('\n')[1] ?? '', /end-of-test\.test\.ts/)
  })

  test('an awaited one, and one awaited late, are not', async () => {
    const { expect, source, messages } = setup({ unawaited: 'fail' })
    await expect(Promise.resolve(1)).resolves.toBe(1)
    const late = expect(Promise.resolve(2))
      .rejects.toBe(2)
      .catch(() => undefined)
    assert.equal(source.current().pendingAsync.size, 0, '.catch is taking the result')
    await late
    await Promise.all([expect(Promise.resolve(3)).resolves.toBe(3)])
    assert.deepEqual(messages(), [])
  })

  test('the assertion still fails when awaited, and does not become an unhandled rejection when not', async () => {
    const { expect, messages } = setup({ unawaited: 'fail' })
    await assert.rejects(
      expect(Promise.resolve(1)).resolves.toBe(2) as unknown as Promise<void>,
      /settled toBe: 1/,
    )
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      expect(Promise.resolve(1)).resolves.toBe(2)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', record)
    }
    assert.deepEqual(unhandled, [])
    assert.equal(messages().length, 1)
  })

  test('under ignore, it is the promise it always was and nothing is tracked', () => {
    const { expect, source, messages } = setup({ unawaited: 'ignore' })
    const result = expect(Promise.resolve(1)).resolves.toBe(1)
    assert.ok(result instanceof Promise)
    assert.equal(source.current().pendingAsync.size, 0)
    assert.deepEqual(messages(), [])
  })

  test('reports the unawaited ones after the soft failures and the counts', () => {
    const { expect, endOfTest } = setup({ unawaited: 'fail' })
    expect.assertions(5)
    expect(Promise.resolve(1)).resolves.toBe(1)
    const messages = endOfTest(run()).map((error) => error.message)
    assert.deepEqual(messages, [
      'expected 5 assertions, made 0',
      'settled resolves.toBe was not awaited',
    ])
  })
})

describe('a test that never used expect', () => {
  test('has nothing to report', () => {
    const table = testTable()
    const { source } = testEngine({ table })
    const endOfTest = createEndOfTest({
      source,
      messages: table.messages,
      policy: { requireAssertions: false },
      hasAssertionsWhenFailed: 'skip',
    })
    assert.deepEqual(endOfTest(run()), [])
  })
})
