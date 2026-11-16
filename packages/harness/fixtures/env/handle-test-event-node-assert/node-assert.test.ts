import assert from 'node:assert'

jest.retryTimes(1, { logErrorsBeforeRetry: true })

test('strictEqual', () => {
  assert.strictEqual(1, 2)
})

test('a plain error', () => {
  throw new Error('plain')
})

describe('an afterEach', () => {
  afterEach(() => {
    assert.ok(false)
  })

  test('whose body passes', () => {})
})
