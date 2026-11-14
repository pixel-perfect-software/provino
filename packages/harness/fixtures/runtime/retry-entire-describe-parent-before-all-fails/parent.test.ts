describe('outer', () => {
  beforeAll(() => {
    trace('beforeAll outer')
    throw new Error('outer beforeAll failed')
  })
  afterAll(() => trace('afterAll outer'))

  describe('inner', () => {
    jest.retryTimes(2, { entireDescribe: true })
    beforeAll(() => trace('beforeAll inner'))
    afterAll(() => trace('afterAll inner'))
    beforeEach(() => trace('beforeEach inner'))
    afterEach(() => trace('afterEach inner'))

    test('a', () => trace('a body'))
  })
})
