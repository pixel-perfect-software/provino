let calls = 0

jest.retryTimes(1, { entireDescribe: true })
beforeAll(() => trace('beforeAll root'))
afterAll(() => trace('afterAll root'))

test('top level', () => trace('top level body'))

describe('inside', () => {
  beforeAll(() => trace('beforeAll inside'))

  test('flaky', () => {
    trace('flaky body')
    if (++calls === 1) throw new Error('flaky failed')
  })
})
