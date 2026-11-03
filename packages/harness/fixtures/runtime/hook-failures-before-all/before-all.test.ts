describe('beforeAll throws', () => {
  beforeAll(() => {
    trace('beforeAll #1')
    throw new Error('beforeAll #1 failed')
  })
  beforeAll(() => trace('beforeAll #2'))
  beforeEach(() => trace('beforeEach'))
  afterEach(() => trace('afterEach'))
  afterAll(() => trace('afterAll'))

  test('test 1', () => trace('test 1'))

  describe('nested', () => {
    beforeAll(() => trace('beforeAll nested'))
    afterAll(() => trace('afterAll nested'))

    test('test 2', () => trace('test 2'))
  })
})
