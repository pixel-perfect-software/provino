describe('from a test', () => {
  test('called in the body', () => {
    jest.retryTimes(1, { entireDescribe: true })
  })
})

describe('from a hook', () => {
  beforeAll(() => {
    jest.retryTimes(1, { entireDescribe: true })
  })

  test('below the hook', () => trace('below the hook'))
})
