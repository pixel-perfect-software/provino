let inner = 0
let outer = 0

describe('outer', () => {
  jest.retryTimes(1, { entireDescribe: true })
  beforeAll(() => trace('beforeAll outer'))
  afterAll(() => trace('afterAll outer'))

  describe('inner', () => {
    jest.retryTimes(1, { entireDescribe: true })
    beforeAll(() => trace('beforeAll inner'))
    afterAll(() => trace('afterAll inner'))

    test('inner flaky', () => {
      trace('inner body')
      if (++inner <= 2) throw new Error(`inner failed ${inner}`)
    })
  })

  test('outer flaky', () => {
    trace('outer body')
    if (++outer === 1) throw new Error('outer failed')
  })
})
